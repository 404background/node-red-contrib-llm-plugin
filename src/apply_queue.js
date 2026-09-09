// Serialises flow-modifying applies against the flows they touch.
//
// Two producers write to the same canvas: the sidebar's Import button and the
// Agent node, whose reply arrives over comms at a moment nobody chose. Left
// alone they interleave, and the loser is not the second apply but the first:
// its edit is still on the canvas, undeployed, when the second one takes its
// snapshot, merges against it, and applies on top. The checkpoint the second
// apply saved then rewinds to a state that already contains the first edit,
// so neither change can be undone cleanly any more.
//
// The rule here is the one the runtime already implies: a flow that has been
// applied but NOT yet deployed is *held*, and anything else targeting that
// flow waits. Applies that touch different flows never wait for each other.
//
// The release signal is the editor's own `deploy` event, which Node-RED emits
// only after a deploy actually succeeds. That covers both cases with one
// listener: the Agent node's auto deploy goes through `core:deploy-flows`,
// which is the same code path as the user clicking Deploy.
//
// SCOPE — this queue is per editor session. It fully orders the sidebar
// against the Agent node in one browser, which is where the two producers
// actually collide. It does NOT coordinate between two people with the editor
// open: each browser holds its own queue, and the Agent node's comms message
// is broadcast to every connected editor, so each applies it locally.
// Node-RED itself is what guards that case, at deploy time: the flows POST
// carries a revision, and a deploy against a stale one comes back 409 and
// raises the editor's merge-conflict dialog.
(function() {
    let ApplyQueue = {};

    // Flows applied but not yet deployed. Nothing may write to these until a
    // deploy clears them.
    let heldFlows = {};
    // Set when an apply had no declared scope: it may have written anywhere,
    // so everything waits for it rather than guessing.
    let heldEverything = false;

    let queue = [];      // entries waiting for a deploy
    let running = false; // an apply is in flight right now
    let seq = 0;
    let listeners = [];

    function notifyChanged() {
        listeners.forEach(function(fn) {
            try { fn(ApplyQueue.list()); } catch (e) { /* a bad listener must not stall the queue */ }
        });
    }

    function normaliseTargets(ids) {
        if (!Array.isArray(ids)) return [];
        return ids.filter(function(id) { return typeof id === 'string' && id; });
    }

    // An entry with no declared scope conflicts with everything, in both
    // directions: it may read or write any flow, so it can neither run beside
    // another apply nor let one run beside it.
    function conflictsWithHeld(targets) {
        if (heldEverything) return true;
        if (targets.length === 0) {
            return Object.keys(heldFlows).length > 0;
        }
        return targets.some(function(id) { return heldFlows[id]; });
    }

    function targetsOverlap(a, b) {
        if (a.length === 0 || b.length === 0) return true;   // unknown scope
        return a.some(function(id) { return b.indexOf(id) !== -1; });
    }

    // Only the entries AHEAD of this one in the queue matter: a later arrival
    // never displaces an earlier one, which is what "first come, first served"
    // means when two requests want the same flow.
    function blockedByEarlier(entry) {
        for (let i = 0; i < queue.length; i++) {
            if (queue[i] === entry) return false;
            if (targetsOverlap(queue[i].targets, entry.targets)) return true;
        }
        return false;
    }

    function canRunNow(entry) {
        return !running && !conflictsWithHeld(entry.targets) && !blockedByEarlier(entry);
    }

    function holdTargets(targets) {
        if (targets.length === 0) { heldEverything = true; return; }
        targets.forEach(function(id) { heldFlows[id] = true; });
    }

    // Run one entry, then hold the flows it wrote to until a deploy.
    //
    // A FAILED apply holds nothing: nothing was committed to the canvas (the
    // importer rolls back), so making the next request wait for a deploy that
    // has no reason to happen would deadlock the queue on an error.
    function runEntry(entry) {
        running = true;
        entry.state = 'running';
        notifyChanged();

        let result;
        try {
            result = entry.apply();
        } catch (e) {
            running = false;
            queue.splice(queue.indexOf(entry), 1);
            entry.reject(e);
            notifyChanged();
            drain();
            return;
        }

        Promise.resolve(result).then(function(value) {
            running = false;
            queue.splice(queue.indexOf(entry), 1);
            if (value && value.ok) holdTargets(entry.targets);
            entry.resolve(value);
            notifyChanged();
            drain();
        }, function(err) {
            running = false;
            queue.splice(queue.indexOf(entry), 1);
            entry.reject(err);
            notifyChanged();
            drain();
        });
    }

    function drain() {
        if (running) return;
        for (let i = 0; i < queue.length; i++) {
            if (queue[i].state === 'waiting' && canRunNow(queue[i])) {
                runEntry(queue[i]);
                return;
            }
        }
    }

    /**
     * Queue one flow-modifying apply.
     *
     * `apply` is invoked when the entry's turn comes and must return the
     * importer's result (or a promise for it). The returned promise settles
     * with whatever `apply` produced, so a caller can stay written as though
     * it had applied directly.
     *
     * `targetFlowIds` is the scope the apply is allowed to write to — the same
     * list passed to the importer, so "what waits for what" and "what may be
     * written" can never disagree. An empty list means the scope is unknown.
     */
    ApplyQueue.enqueue = function(options) {
        options = options || {};
        let entry = {
            id: 'q_' + (++seq),
            targets: normaliseTargets(options.targetFlowIds),
            source: options.source || 'sidebar',
            label: options.label || 'Flow edit',
            queuedAt: new Date().toISOString(),
            apply: typeof options.apply === 'function' ? options.apply : function() { return null; },
            state: 'waiting'
        };
        let promise = new Promise(function(resolve, reject) {
            entry.resolve = resolve;
            entry.reject = reject;
        });
        entry.promise = promise;
        queue.push(entry);
        notifyChanged();
        drain();
        return promise;
    };

    /** What is waiting, and why — the sidebar's queue panel renders this. */
    ApplyQueue.list = function() {
        return queue.map(function(e) {
            return {
                id: e.id,
                source: e.source,
                label: e.label,
                targets: e.targets.slice(),
                queuedAt: e.queuedAt,
                state: e.state,
                // Why it is not running, in the terms the user can act on.
                blockedBy: e.state === 'running'
                    ? null
                    : (conflictsWithHeld(e.targets) ? 'deploy' : (blockedByEarlier(e) ? 'queue' : null))
            };
        });
    };

    /** Flows applied but not yet deployed. */
    ApplyQueue.heldFlows = function() {
        return heldEverything ? null : Object.keys(heldFlows);
    };

    ApplyQueue.isHolding = function() {
        return heldEverything || Object.keys(heldFlows).length > 0;
    };

    /**
     * Drop a waiting entry. The promise rejects, so the caller reports it the
     * same way it would report any other failure to apply.
     *
     * An entry already running cannot be cancelled: it is mid-apply, and
     * abandoning it there is what leaves a half-changed canvas.
     */
    ApplyQueue.cancel = function(id) {
        let i = queue.findIndex(function(e) { return e.id === id && e.state === 'waiting'; });
        if (i === -1) return false;
        let entry = queue[i];
        queue.splice(i, 1);
        entry.reject(new Error('Cancelled while waiting for a deploy'));
        notifyChanged();
        drain();
        return true;
    };

    /**
     * Release the hold without a deploy.
     *
     * The hold exists because an undeployed edit is still on the canvas, and
     * the usual way it leaves is a deploy. It is not the only way: the user
     * can restore a checkpoint, or undo the edit by hand, and then no deploy
     * is coming and the queue would wait forever. This is the manual way out,
     * surfaced in the queue panel.
     */
    ApplyQueue.releaseHold = function() {
        heldFlows = {};
        heldEverything = false;
        notifyChanged();
        drain();
    };

    /** Subscribe to queue changes; returns an unsubscribe function. */
    ApplyQueue.onChange = function(fn) {
        if (typeof fn !== 'function') return function() {};
        listeners.push(fn);
        return function() {
            let i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
        };
    };

    // Node-RED emits `deploy` only from the success path of a deploy, so this
    // fires for the user's Deploy button and for the Agent node's auto deploy
    // alike — one signal, no need to tell the two apart.
    ApplyQueue.bindDeployListener = function() {
        if (typeof RED === 'undefined' || !RED.events || typeof RED.events.on !== 'function') return;
        if (ApplyQueue._bound) return;
        ApplyQueue._bound = true;
        RED.events.on('deploy', function() {
            heldFlows = {};
            heldEverything = false;
            notifyChanged();
            drain();
        });
    };

    // Test seam: the module holds process-wide state, and a suite needs each
    // scenario to start from a known one.
    ApplyQueue._reset = function() {
        heldFlows = {};
        heldEverything = false;
        queue = [];
        running = false;
        listeners = [];
    };

    window.LLMPlugin.ApplyQueue = ApplyQueue;
})();
