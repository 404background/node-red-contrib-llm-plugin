// Client half of the apply queue: ask for a turn, wait, apply, report back.
// The rules live on the server; the apply has to stay here.
// See docs/{en,jp}/design.md §13.
(function() {
    let Common = window.LLMPlugin.Common;
    let ApplyQueue = {};

    const TOPIC = 'llm-plugin/apply-queue';

    // Identifies THIS editor session, so a pushed state says which entries are
    // ours to act on. Per page load: a reload is a new session, and its old
    // grants expire on the server rather than being inherited.
    let clientId = Common.randomId('client_');

    // Last state pushed by the server. The panel renders this, so it shows
    // every editor's requests, not just this one's.
    let lastState = { entries: [], heldFlows: [], heldEverything: false, holding: false };

    let listeners = [];
    let pending = {};   // entryId -> { resolve, reject, apply, started }

    function notifyChanged() {
        listeners.forEach(function(fn) {
            try { fn(ApplyQueue.list()); } catch (e) { /* a bad listener must not stall the queue */ }
        });
    }

    function post(path, body) {
        return Common.apiFetch('llm-plugin/apply-queue/' + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        }).then(function(res) {
            return res.json().catch(function() { return {}; });
        });
    }

    function adoptState(next) {
        if (!next || !Array.isArray(next.entries)) return;
        lastState = next;
        notifyChanged();
        runGrantedEntries();
    }

    // Run every entry of OURS that the server has granted and that is not
    // already running. Guarded by `started` because the grant appears in every
    // pushed state until we report completion, not just the first.
    function runGrantedEntries() {
        lastState.entries.forEach(function(e) {
            if (e.clientId !== clientId || e.state !== 'granted') return;
            let p = pending[e.id];
            if (!p || p.started) return;
            p.started = true;

            let result;
            try {
                result = p.apply();
            } catch (err) {
                finish(e.id, false, null, err);
                return;
            }
            Promise.resolve(result).then(function(value) {
                finish(e.id, !!(value && value.ok), value, null);
            }, function(err) {
                finish(e.id, false, null, err);
            });
        });
    }

    // The server is told even when the apply threw: an entry that never
    // completes holds everyone up until its grant expires.
    function finish(entryId, ok, value, err) {
        let p = pending[entryId];
        delete pending[entryId];
        post('complete', { entryId: entryId, ok: ok })
            .then(function(out) { if (out && out.queue) adoptState(out.queue); })
            .catch(function() { /* reported below regardless */ })
            .finally(function() {
                if (!p) return;
                if (err) p.reject(err); else p.resolve(value);
            });
    }

    // Queue one flow-modifying apply. `apply` runs when the turn is granted
    // and returns the importer's result; the queue reads `ok` off it.
    // `targetFlowIds` is the write scope — empty means unknown.
    ApplyQueue.enqueue = function(options) {
        options = options || {};
        let targets = Array.isArray(options.targetFlowIds) ? options.targetFlowIds : [];

        return post('request', {
            clientId: clientId,
            source: options.source || 'sidebar',
            label: options.label || 'Flow edit',
            targetFlowIds: targets
        }).then(function(out) {
            if (!out || !out.entryId) {
                // Tagged so a caller can tell "never got a turn" from
                // "ran and failed" — only the first needs reporting here.
                let err = new Error((out && out.error) || 'Could not join the apply queue');
                err.queueError = true;
                throw err;
            }
            let settled = new Promise(function(resolve, reject) {
                pending[out.entryId] = {
                    resolve: resolve,
                    reject: reject,
                    apply: typeof options.apply === 'function' ? options.apply : function() { return null; },
                    started: false
                };
            });
            if (out.queue) adoptState(out.queue);
            announceWait(out);
            return settled;
        });
    };

    // A turn that is not granted at once has no other announcement — Agent
    // mode applies with no click, so the canvas simply does not change and
    // only the panel says why. Said once, here, because every caller enqueues.
    function announceWait(out) {
        if (!out || out.state !== 'waiting') return;
        let mine = ((out.queue && out.queue.entries) || []).filter(function(e) {
            return e && e.id === out.entryId;
        })[0];
        let why = (mine && mine.blockedBy === 'queue')
            ? 'an earlier request'
            : 'a deploy';
        Common.notify('Flow edit queued — waiting for ' + why +
            '. See the queue at the top of the LLM sidebar.', 'warning');
    }

    /** The whole queue, every editor's entries, for the sidebar panel. */
    ApplyQueue.list = function() {
        return (lastState.entries || []).map(function(e) {
            return {
                id: e.id,
                source: e.source,
                label: e.label,
                targets: (e.targets || []).slice(),
                queuedAt: e.queuedAt,
                state: e.state,
                blockedBy: e.blockedBy,
                // Whether this browser is the one that asked, so the panel can
                // say so rather than implying every entry is the user's own.
                mine: e.clientId === clientId
            };
        });
    };

    ApplyQueue.heldFlows = function() {
        return lastState.heldEverything ? null : (lastState.heldFlows || []).slice();
    };

    ApplyQueue.isHolding = function() { return !!lastState.holding; };

    /** Drop a waiting entry. An entry already granted is mid-apply and is left alone. */
    ApplyQueue.cancel = function(entryId) {
        return post('cancel', { entryId: entryId }).then(function(out) {
            if (out && out.queue) adoptState(out.queue);
            let p = pending[entryId];
            if (p && out && out.ok) {
                delete pending[entryId];
                p.reject(new Error('Cancelled while waiting for a deploy'));
            }
            return !!(out && out.ok);
        });
    };

    /** End the hold without a deploy — for an edit undone or restored instead. */
    ApplyQueue.releaseHold = function() {
        return post('release', {}).then(function(out) {
            if (out && out.queue) adoptState(out.queue);
            return !!(out && out.ok);
        });
    };

    ApplyQueue.onChange = function(fn) {
        if (typeof fn !== 'function') return function() {};
        listeners.push(fn);
        return function() {
            let i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
        };
    };

    // Subscribe, then take the current state once: the retained comms message
    // does not exist until something has been published.
    ApplyQueue.connect = function() {
        if (ApplyQueue._connected) return;
        ApplyQueue._connected = true;

        if (typeof RED !== 'undefined' && RED.comms && typeof RED.comms.subscribe === 'function') {
            RED.comms.subscribe(TOPIC, function(topic, payload) { adoptState(payload); });
        }
        Common.apiFetch('llm-plugin/apply-queue')
            .then(function(res) { return res.json(); })
            .then(adoptState)
            .catch(function() { /* the panel simply stays empty until the first push */ });
    };

    // Test seam: the module holds per-session state.
    ApplyQueue._reset = function() {
        lastState = { entries: [], heldFlows: [], heldEverything: false, holding: false };
        listeners = [];
        pending = {};
        ApplyQueue._connected = false;
        clientId = Common.randomId('client_');
    };
    ApplyQueue._clientId = function() { return clientId; };
    ApplyQueue._adoptState = adoptState;

    window.LLMPlugin.ApplyQueue = ApplyQueue;
})();
