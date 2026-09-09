// LLM Plugin  -  Apply queue (server side)
//
// Orders the flow-modifying applies that the editors perform, so two of them
// never merge into each other's uncommitted work.
//
// The APPLY itself stays in the browser — that is a design pillar, because
// writing back through the Admin API cannot clear the open editor's unsaved
// state. Only the ORDERING lives here. The client asks for its turn, waits to
// be granted it, applies, and reports back.
//
// Why the server rather than each browser:
//
//  - One queue for everyone. Two people with the editor open are two browsers,
//    and a per-browser queue orders neither against the other. The Agent
//    node's reply is broadcast to every connected editor, so without this they
//    would each apply it against their own view of the flow.
//  - The deploy is visible here directly. The runtime emits `runtime-event`
//    with id `runtime-deploy` after a deploy completes — whoever triggered it,
//    including a deploy made through the Admin API by something that is not an
//    editor at all. A browser can only see its own.
//  - A closed tab stops being a problem. A grant that is never completed
//    expires; a browser that vanishes mid-wait cannot wedge everyone else.
//
// The rule is unchanged: a flow that has been applied but NOT yet deployed is
// held, anything else targeting it waits, and among those waiting the earlier
// request goes first. Applies to different flows never wait for each other.

const COMMS_TOPIC = 'llm-plugin/apply-queue';

// How long a client has to run its apply and report back before the grant is
// assumed lost. Generous: an apply is layout plus a canvas rebuild, not a
// network round trip. The cost of being wrong is one duplicate apply attempt;
// the cost of no timeout at all is a queue that never moves again.
const GRANT_TIMEOUT_MS = 120000;

// A hold normally ends at the next deploy, which may legitimately be a long
// time. This is only a backstop for the browser that applied and then went
// away for good, so it is far longer than any review would take.
const HOLD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Only while something is outstanding, and unref'd so it never holds the
// process open.
const SWEEP_INTERVAL_MS = 15000;

function createApplyQueue(RED) {
    let entries = [];        // requests, in arrival order
    let holds = {};          // flowId -> { entryId, clientId, source, label, since }
    let holdAll = null;      // set by an apply whose scope was unknown
    let seq = 0;
    let sweepTimer = null;

    function now() { return Date.now(); }

    function normaliseTargets(ids) {
        if (!Array.isArray(ids)) return [];
        let seen = {};
        return ids.filter(function(id) {
            if (typeof id !== 'string' || !id || seen[id]) return false;
            seen[id] = true;
            return true;
        });
    }

    // An entry with no declared scope may read or write any flow, so it
    // conflicts with everything in both directions. Guessing otherwise is how
    // an edit lands in a flow nobody was looking at.
    function heldConflict(targets) {
        if (holdAll) return true;
        if (targets.length === 0) return Object.keys(holds).length > 0;
        return targets.some(function(id) { return !!holds[id]; });
    }

    function overlaps(a, b) {
        if (a.length === 0 || b.length === 0) return true;
        return a.some(function(id) { return b.indexOf(id) !== -1; });
    }

    // Only entries AHEAD of this one can block it. That is what "first come,
    // first served" means when two requests want the same flow.
    function blockedByEarlier(entry) {
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].id === entry.id) return false;
            if (overlaps(entries[i].targets, entry.targets)) return true;
        }
        return false;
    }

    function blockedReason(entry) {
        if (entry.state === 'granted') return null;
        if (heldConflict(entry.targets)) return 'deploy';
        if (blockedByEarlier(entry)) return 'queue';
        return null;
    }

    function holdTargets(entry) {
        let record = {
            entryId: entry.id, clientId: entry.clientId,
            source: entry.source, label: entry.label, since: now()
        };
        if (entry.targets.length === 0) { holdAll = record; return; }
        entry.targets.forEach(function(id) { holds[id] = record; });
    }

    function releaseHolds() {
        holds = {};
        holdAll = null;
    }

    // Drop grants whose client never came back, and holds old enough that the
    // browser behind them is certainly gone.
    function sweep() {
        let t = now();
        let changed = false;

        entries = entries.filter(function(e) {
            if (e.state === 'granted' && (t - e.grantedAt) > GRANT_TIMEOUT_MS) {
                RED.log.warn('[LLM Plugin] Apply grant ' + e.id + ' (' + e.source +
                    ') expired without completing; releasing its turn.');
                changed = true;
                return false;
            }
            return true;
        });

        Object.keys(holds).forEach(function(id) {
            if ((t - holds[id].since) > HOLD_MAX_AGE_MS) { delete holds[id]; changed = true; }
        });
        if (holdAll && (t - holdAll.since) > HOLD_MAX_AGE_MS) { holdAll = null; changed = true; }

        return changed;
    }

    // Grant the turn to as many waiting entries as the rule allows. More than
    // one can be granted at a time when their flows do not overlap — that is
    // the point of scoping by flow rather than one global lock.
    function promote() {
        let granted = [];
        for (let i = 0; i < entries.length; i++) {
            let e = entries[i];
            if (e.state !== 'waiting') continue;
            if (heldConflict(e.targets)) continue;
            if (blockedByEarlier(e)) continue;
            e.state = 'granted';
            e.grantedAt = now();
            granted.push(e);
        }
        return granted;
    }

    function state() {
        let heldFlows = Object.keys(holds);
        return {
            entries: entries.map(function(e) {
                return {
                    id: e.id,
                    clientId: e.clientId,
                    source: e.source,
                    label: e.label,
                    targets: e.targets.slice(),
                    queuedAt: e.queuedAt,
                    state: e.state,
                    blockedBy: blockedReason(e)
                };
            }),
            heldFlows: heldFlows,
            heldEverything: !!holdAll,
            holding: !!holdAll || heldFlows.length > 0
        };
    }

    // Retained, so an editor opened later immediately sees what is waiting
    // rather than an empty panel that fills in only on the next change.
    function publish() {
        try {
            if (RED.comms && typeof RED.comms.publish === 'function') {
                RED.comms.publish(COMMS_TOPIC, state(), true);
            }
        } catch (e) { /* a broken comms channel must not stall the queue */ }
    }

    function scheduleSweep() {
        let outstanding = entries.length > 0 || Object.keys(holds).length > 0 || !!holdAll;
        if (outstanding && !sweepTimer) {
            sweepTimer = setInterval(function() {
                if (sweep()) { promote(); publish(); }
                scheduleSweep();
            }, SWEEP_INTERVAL_MS);
            // Never keep the process (or a test run) alive for this.
            if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
        } else if (!outstanding && sweepTimer) {
            clearInterval(sweepTimer);
            sweepTimer = null;
        }
    }

    // Every mutation goes through here, so "sweep, promote, publish, rearm"
    // can never be half-done.
    function settle() {
        sweep();
        promote();
        publish();
        scheduleSweep();
        return state();
    }

    const api = {
        COMMS_TOPIC: COMMS_TOPIC,

        /** Ask for a turn. Returns the entry, already granted when nothing blocks it. */
        request: function(opts) {
            opts = opts || {};
            let entry = {
                id: 'aq_' + (++seq) + '_' + now().toString(36),
                clientId: String(opts.clientId || 'unknown'),
                source: opts.source === 'node' ? 'node' : 'sidebar',
                label: String(opts.label || 'Flow edit').slice(0, 120),
                targets: normaliseTargets(opts.targetFlowIds),
                queuedAt: new Date().toISOString(),
                state: 'waiting'
            };
            entries.push(entry);
            settle();
            return { entryId: entry.id, state: entry.state, queue: state() };
        },

        /**
         * The client has finished (or failed).
         *
         * A FAILED apply holds nothing: the importer rolled back, so nothing
         * was committed, and holding its flows would make the next request
         * wait for a deploy that has no reason to happen.
         */
        complete: function(entryId, ok) {
            let i = entries.findIndex(function(e) { return e.id === entryId; });
            if (i === -1) return { ok: false, error: 'Unknown queue entry' };
            let entry = entries[i];
            entries.splice(i, 1);
            if (ok) holdTargets(entry);
            return { ok: true, queue: settle() };
        },

        /** Drop a waiting entry. An entry already granted is mid-apply and is left alone. */
        cancel: function(entryId) {
            let i = entries.findIndex(function(e) {
                return e.id === entryId && e.state === 'waiting';
            });
            if (i === -1) return { ok: false, error: 'No waiting entry with that id' };
            entries.splice(i, 1);
            return { ok: true, queue: settle() };
        },

        /**
         * End the hold without a deploy.
         *
         * The hold exists because an undeployed edit is still on a canvas, and
         * the usual way that ends is a deploy. It is not the only way: the
         * edit can be undone by hand or a checkpoint restored, and then no
         * deploy is coming and the queue would wait for one forever.
         */
        releaseHold: function() {
            releaseHolds();
            return { ok: true, queue: settle() };
        },

        state: function() { return settle(); },

        /**
         * Release every hold when the runtime reports a completed deploy.
         *
         * `runtime-deploy` is emitted by the flow engine itself, so this fires
         * for a Deploy from any editor, for the Agent node's auto deploy, and
         * for a deploy driven through the Admin API by something that is not
         * an editor at all — none of which a browser-side queue could see.
         */
        bindDeployListener: function() {
            if (!RED.events || typeof RED.events.on !== 'function') return;
            if (api._bound) return;
            api._bound = true;
            api._onRuntimeEvent = function(event) {
                if (!event || event.id !== 'runtime-deploy') return;
                releaseHolds();
                settle();
            };
            RED.events.on('runtime-event', api._onRuntimeEvent);
        },

        // Test seam.
        _reset: function() {
            entries = [];
            holds = {};
            holdAll = null;
            if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
        },
        _constants: {
            GRANT_TIMEOUT_MS: GRANT_TIMEOUT_MS,
            HOLD_MAX_AGE_MS: HOLD_MAX_AGE_MS
        }
    };

    return api;
}

module.exports = createApplyQueue;
