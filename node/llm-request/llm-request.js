// LLM Plugin  -  "LLM" node (llm-request)
//
// A workflow node (NOT the sidebar) for automating LLM interactions:
//   - Ask   : send msg.payload (+ selected flows as context) to the LLM and
//             output the text reply.
//   - Agent : same, then apply the proposed changes LIVE in the open editor —
//             what the sidebar does, triggered from a flow.
//
// Selected flows are sent to the LLM as context in BOTH modes (zero or more).
// Agent mode reaches the editor over Node-RED's comms channel: a subscriber in
// this node's .html (running in the editor) applies the reply with the plugin's
// importer (LLMPlugin.Importer) — the same path as the sidebar. An editor must
// be open. Node interactions are NOT saved to chat history and do NOT create a
// Restore Checkpoint.
//
// Provider / API-key / endpoint are inherited from the LLM Plugin settings
// dialog via the shared engine (src/llm_core.js).
const path = require('path');

module.exports = function(RED) {
    const createLLMCore = require(path.join(__dirname, '..', '..', 'src', 'llm_core.js'));
    const createAdminApi = require(path.join(__dirname, '..', 'lib', 'admin_api.js'));

    const core = createLLMCore(RED);
    const adminApi = createAdminApi(RED);

    // Comms topic shared with the editor-side subscriber in llm-request.html.
    const AGENT_APPLY_TOPIC = 'llm-plugin/agent-apply';

    // Normalise line endings so multi-line prompts behave consistently
    // regardless of source (Windows CRLF, lone CR). Interior newlines kept.
    function normaliseText(text) {
        return String(text)
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\s+$/, '');
    }

    function payloadToPrompt(payload) {
        if (payload === undefined || payload === null) return '';
        if (typeof payload === 'string') return normaliseText(payload);
        if (Buffer.isBuffer(payload)) return normaliseText(payload.toString('utf8'));
        if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
        try { return normaliseText(JSON.stringify(payload, null, 2)); }
        catch (e) { return normaliseText(String(payload)); }
    }

    // Reduce the full flow set to just the selected tabs (their canvas nodes
    // and tab definitions) plus all config nodes (global). Returns null when
    // nothing is selected so the prompt carries no flow context.
    function flowContextFor(allFlows, ids) {
        if (!Array.isArray(ids) || ids.length === 0 || !Array.isArray(allFlows)) return null;
        const set = new Set(ids);
        const ctx = allFlows.filter(function(n) {
            if (!n || !n.type) return false;
            if (n.type === 'tab') return set.has(n.id);
            if (n.z) return set.has(n.z);
            return true; // config node (no z)
        });
        return ctx.length > 0 ? ctx : null;
    }

    function LLMRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const mode = (config.mode === 'agent') ? 'agent' : 'ask';
        const providerOverride = config.provider || '';
        const configModel = config.model || '';
        const configEditorUrl = config.editorUrl || '';
        // Multi-select flow ids; tolerate the legacy single-string field.
        const targetFlows = Array.isArray(config.targetFlows)
            ? config.targetFlows.slice()
            : (config.targetFlow ? [config.targetFlow] : []);

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                const settings = core.getPluginSettings();
                const provider = providerOverride || settings.provider || 'ollama';
                const model = (typeof msg.model === 'string' && msg.model.trim()) ? msg.model.trim() : configModel;
                if (!model) {
                    throw new Error('No model configured. Set a model on the node or via msg.model.');
                }

                const prompt = payloadToPrompt(msg.payload);
                if (!prompt) {
                    throw new Error('msg.payload is empty; nothing to send to the LLM.');
                }

                const maxLen = parseInt(settings.maxPromptLength, 10) || 10000;
                if (prompt.length > maxLen) {
                    throw new Error('Prompt exceeds maximum length (' + maxLen + ' characters).');
                }

                node.status({ fill: 'blue', shape: 'dot', text: 'requesting…' });
                const started = Date.now();

                // Best-effort flow context for the selected flows (both modes).
                let context = null;
                if (targetFlows.length > 0) {
                    try {
                        const editorUrl = (typeof msg.editorUrl === 'string' && msg.editorUrl.trim())
                            ? msg.editorUrl.trim()
                            : configEditorUrl;
                        const apiOpts = editorUrl ? { url: editorUrl } : undefined;
                        const current = await adminApi.getFlows(apiOpts);
                        if (current && Array.isArray(current.flows)) {
                            context = flowContextFor(current.flows, targetFlows);
                        }
                    } catch (e) {
                        node.warn('[llm-request] Could not fetch flow context (' +
                            (e && e.message ? e.message : e) + '); continuing without it.');
                    }
                }

                let response;
                if (context) {
                    response = await core.generateWithProvider(provider, settings, model,
                        core.buildMessages(prompt, context, targetFlows[0]));
                } else if (mode === 'agent') {
                    // No context selected: still use the flow-building prompt so
                    // the model can propose a new flow from scratch.
                    response = await core.generateWithProvider(provider, settings, model,
                        core.buildMessages(prompt, null, null));
                } else {
                    // Ask with no flows selected: plain chat.
                    response = await core.generateWithProvider(provider, settings, model,
                        core.buildChatMessages(prompt));
                }

                msg.payload = response;
                msg.llm = { mode: mode, provider: provider, model: model, elapsed: Date.now() - started };

                if (mode === 'agent') {
                    // Hand the reply to the open editor to apply live. Fire-and-
                    // forget: the node can't know if an editor is connected.
                    if (RED.comms && typeof RED.comms.publish === 'function') {
                        RED.comms.publish(AGENT_APPLY_TOPIC, {
                            response: response,
                            targetFlows: targetFlows,
                            nodeId: node.id,
                            ts: Date.now()
                        }, false);
                        msg.flow = { targetFlows: targetFlows, dispatchedToEditor: true };
                        node.status({ fill: 'green', shape: 'dot', text: 'sent to editor' });
                    } else {
                        msg.flow = { targetFlows: targetFlows, dispatchedToEditor: false };
                        node.status({ fill: 'yellow', shape: 'ring', text: 'no editor channel' });
                    }
                } else {
                    node.status({ fill: 'green', shape: 'dot', text: 'done (' + (Date.now() - started) + 'ms)' });
                }
                send(msg);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                done(err);
            }
        });
    }

    RED.nodes.registerType('llm-request', LLMRequestNode);
};
