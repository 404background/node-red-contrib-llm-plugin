// LLM Plugin  -  the `llm-request` node, runtime half.
// Ask returns the reply; Agent also publishes it for the editor half to apply.
// See docs/{en,jp}/llm-request.md.
const path = require('path');

module.exports = function(RED) {
    const createLLMCore = require(path.join(__dirname, '..', '..', 'src', 'llm_core.js'));
    const createAdminApi = require(path.join(__dirname, '..', 'lib', 'admin_api.js'));

    const core = createLLMCore(RED);
    const adminApi = createAdminApi(RED);

    // Comms topic shared with the editor-side subscriber in llm-request.html.
    const AGENT_APPLY_TOPIC = 'llm-plugin/agent-apply';

    // The API URL may carry `user:pass@`; the log is not the place for it.
    function scrubUrlCredentials(text) {
        return String(text).replace(/(\bhttps?:\/\/)[^\s/@"']*@/gi, '$1');
    }

    // `done(err)` is a flow-visible exit and a provider error can carry the
    // API key. `code` survives so timeouts stay detectable.
    // See docs/{en,jp}/architecture.md — Security measures.
    function redactedError(err) {
        const safe = new Error(core.redactSecrets(err && err.message ? err.message : err));
        if (err && err.code) safe.code = err.code;
        return safe;
    }

    // CRLF / lone CR from any source; interior newlines kept.
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

    // The selected tabs plus the config nodes they reference, transitively.
    // Null when nothing is selected. What this returns is what leaves the
    // machine. See docs/{en,jp}/design.md §6.
    function flowContextFor(allFlows, ids) {
        if (!Array.isArray(ids) || ids.length === 0 || !Array.isArray(allFlows)) return null;
        const set = new Set(ids);
        const selected = [];
        const configById = new Map();
        allFlows.forEach(function(n) {
            if (!n || !n.type) return;
            if (n.type === 'tab') { if (set.has(n.id)) selected.push(n); }
            else if (n.z) { if (set.has(n.z)) selected.push(n); }
            else configById.set(n.id, n);
        });

        const wanted = new Set();
        const queue = selected.slice();
        while (queue.length > 0) {
            const node = queue.pop();
            Object.keys(node).forEach(function(key) {
                const value = node[key];
                const candidates = Array.isArray(value) ? value : [value];
                candidates.forEach(function(v) {
                    if (typeof v !== 'string' || wanted.has(v) || !configById.has(v)) return;
                    wanted.add(v);
                    queue.push(configById.get(v));
                });
            });
        }

        const ctx = selected.concat(Array.from(wanted).map(function(id) { return configById.get(id); }));
        return ctx.length > 0 ? ctx : null;
    }

    // Seconds, 0 = no limit. An hour by default: local LLMs are slow.
    const DEFAULT_TIMEOUT_SEC = 3600;
    function toTimeoutSec(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        const n = parseInt(value, 10);
        return (isNaN(n) || n < 0) ? fallback : n;
    }

    function LLMRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const mode = (config.mode === 'agent') ? 'agent' : 'ask';
        const providerOverride = config.provider || '';
        const configModel = config.model || '';
        // A literal URL, or the name of a flow/global holding one.
        const configEditorUrl = config.editorUrl || '';
        const configEditorUrlType = config.editorUrlType || 'str';
        const configTimeoutSec = toTimeoutSec(config.timeout, DEFAULT_TIMEOUT_SEC);
        const autoDeploy = config.autoDeploy === true;
        const targetFlows = Array.isArray(config.targetFlows) ? config.targetFlows.slice() : [];

        // Ticks the elapsed time, so a long local-LLM run looks alive.
        let statusTimer = null;
        function stopStatusTicker() {
            if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
        }
        function startStatusTicker(started) {
            stopStatusTicker();
            statusTimer = setInterval(function() {
                const secs = Math.round((Date.now() - started) / 1000);
                node.status({ fill: 'blue', shape: 'dot', text: 'waiting ' + secs + 's' });
            }, 5000);
        }
        node.on('close', function() {
            stopStatusTicker();
            node.status({});
        });

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            const timeoutSec = toTimeoutSec(msg.timeout, configTimeoutSec);

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
                startStatusTicker(started);
                const genOptions = { timeoutMs: timeoutSec * 1000 };

                // Best effort: no context is better than no reply.
                let context = null;
                if (targetFlows.length > 0) {
                    try {
                        let editorUrl = '';
                        if (typeof msg.editorUrl === 'string' && msg.editorUrl.trim()) {
                            editorUrl = msg.editorUrl.trim();
                        } else if (configEditorUrlType === 'flow' || configEditorUrlType === 'global') {
                            const v = node.context()[configEditorUrlType].get(configEditorUrl);
                            if (typeof v === 'string') editorUrl = v.trim();
                        } else {
                            editorUrl = configEditorUrl.trim();
                        }
                        let current;
                        try {
                            current = await adminApi.getFlows(editorUrl ? { url: editorUrl } : undefined);
                        } catch (e) {
                            if (!editorUrl) throw e;
                            // A URL that doesn't serve the admin API, e.g. the
                            // httpNodeRoot base. Retry auto-detection.
                            node.warn(scrubUrlCredentials('[llm-request] Flow context fetch failed for "' +
                                editorUrl + '" (' + (e && e.message ? e.message : e) +
                                '); retrying with auto-detection.'));
                            current = await adminApi.getFlows();
                        }
                        if (current && Array.isArray(current.flows)) {
                            context = flowContextFor(current.flows, targetFlows);
                        }
                    } catch (e) {
                        node.warn(scrubUrlCredentials('[llm-request] Could not fetch flow context (' +
                            (e && e.message ? e.message : e) + '); continuing without it.'));
                    }
                }

                // Agent always builds flows, with or without context;
                // Ask without selected flows is plain chat.
                const messages = (context || mode === 'agent')
                    ? core.buildMessages(prompt, context, targetFlows[0] || null, settings)
                    : core.buildChatMessages(prompt, settings);
                const response = await core.generateWithProvider(provider, settings, model, messages, genOptions);
                stopStatusTicker();

                msg.payload = response;
                msg.llm = { mode: mode, provider: provider, model: model, elapsed: Date.now() - started };

                if (mode === 'agent') {
                    // Fire-and-forget: whether an editor is listening is
                    // not knowable from here.
                    if (RED.comms && typeof RED.comms.publish === 'function') {
                        RED.comms.publish(AGENT_APPLY_TOPIC, {
                            response: response,
                            targetFlows: targetFlows,
                            autoDeploy: autoDeploy,
                            nodeId: node.id,
                            // Names the checkpoint the editor takes.
                            nodeName: node.name || null,
                            ts: Date.now()
                        }, false);
                        msg.flow = { targetFlows: targetFlows, dispatchedToEditor: true, autoDeploy: autoDeploy };
                        node.status({ fill: 'green', shape: 'dot', text: 'sent to editor' });
                    } else {
                        msg.flow = { targetFlows: targetFlows, dispatchedToEditor: false, autoDeploy: autoDeploy };
                        node.status({ fill: 'yellow', shape: 'ring', text: 'no editor channel' });
                    }
                } else {
                    const elapsedMs = Date.now() - started;
                    const elapsedText = elapsedMs < 10000
                        ? elapsedMs + 'ms'
                        : Math.round(elapsedMs / 1000) + 's';
                    node.status({ fill: 'green', shape: 'dot', text: 'done (' + elapsedText + ')' });
                }
                send(msg);
                done();
            } catch (err) {
                stopStatusTicker();
                const text = (err && err.code === 'ETIMEDOUT') ? 'timeout' : 'error';
                node.status({ fill: 'red', shape: 'ring', text: text });
                done(redactedError(err));
            }
        });
    }

    RED.nodes.registerType('llm-request', LLMRequestNode);

    // Test seams: cross_flow_isolation, node_secret_exit.
    module.exports._flowContextFor = flowContextFor;
    module.exports._scrubUrlCredentials = scrubUrlCredentials;
};
