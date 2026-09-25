// Agent mode's editor half for the `llm-request` node: the runtime publishes a
// reply over comms, and this applies it through the plugin's own importer.
// It lives with the plugin rather than in the node's html because
// everything it touches is the plugin's. See docs/{en,jp}/llm-request.md.
(function() {
    let P = window.LLMPlugin = window.LLMPlugin || {};
    if (typeof RED === 'undefined' || !RED.comms || typeof RED.comms.subscribe !== 'function') return;
    if (P._agentApplyBound) return;
    P._agentApplyBound = true;

    function notice(text, level) { if (P.Common) P.Common.notice(text, level); }

    function flowNames(ids) {
        return (P.Common && P.Common.flowLabels(ids)) || 'the flow';
    }

    function applyAgentResult(payload) {
        let ids = Array.isArray(payload.targetFlows) ? payload.targetFlows : [];
        // One target: show it, so the edit lands in view.
        if (ids.length === 1 && RED.workspaces && typeof RED.workspaces.show === 'function') {
            try { RED.workspaces.show(ids[0]); } catch (e) { /* tab may be gone */ }
        }
        // Undo for a node-driven edit. A failed save is reported, not fatal.
        let cpPromise = (P.ChatManager && typeof P.ChatManager.saveNodeApplyCheckpoint === 'function')
            ? P.ChatManager.saveNodeApplyCheckpoint(
                { id: payload.nodeId, name: payload.nodeName }, ids)
            : Promise.resolve(null);

        cpPromise.then(function(checkpointId) {
            return P.Importer.importFlowFromMessage(payload.response, {
                mode: 'agent',
                // The flows sent to the model are the only ones it may
                // write to. Empty = no context was sent.
                allowedWorkspaceIds: ids
            })
            .then(function(result) {
                if (result && result.ok) {
                    let applied = 'llm-request node applied changes to ' + flowNames(ids);
                    if (!checkpointId) {
                        notice(applied + ', but no restore point could be saved.', 'warning');
                    }
                    if (!payload.autoDeploy) return;
                    if (RED.actions && typeof RED.actions.invoke === 'function') {
                        // The editor's own Deploy, async; `true` is
                        // save()'s skipValidation flag, so an unattended
                        // loop cannot stall on a confirm dialog.
                        try {
                            RED.actions.invoke('core:deploy-flows', true);
                        } catch (e) {
                            notice(applied + ', but auto deploy failed to start: ' + (e && e.message ? e.message : e), 'warning');
                        }
                    } else {
                        notice(applied + ', but this editor does not support auto deploy — deploy manually.', 'warning');
                    }
                } else if (result && result.error) {
                    notice('llm-request node: ' + result.error, 'warning');
                }
            });
        }).catch(function(e) {
            notice('llm-request node import error: ' + (e && e.message ? e.message : e), 'error');
        });
    }

    // Every open editor receives the reply; only the one whose claim the
    // server grants applies it. A refused claim (another editor took it, or
    // this user may not write) is silent.
    function claim(dispatchId) {
        return P.Common.apiFetch('llm-plugin/agent-apply/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dispatchId: dispatchId })
        })
            .then(function(res) { return res.ok ? res.json() : {}; })
            .then(function(out) { return !!(out && out.granted); })
            .catch(function() { return false; });
    }

    RED.comms.subscribe('llm-plugin/agent-apply', function(topic, payload) {
        if (!payload || typeof payload.response !== 'string' || !payload.dispatchId) return;
        claim(payload.dispatchId).then(function(granted) {
            if (granted) applyAgentResult(payload);
        }).catch(function(e) {
            if (window.console) console.error('[llm-request] agent-apply failed', e);
        });
    });
})();
