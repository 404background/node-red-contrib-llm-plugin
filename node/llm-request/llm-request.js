// LLM Plugin  -  "LLM" node (llm-request)
//
// Workflow node for automating LLM interactions. Ask: msg.payload (+ selected
// flows as context) → text reply. Agent: same, then the reply is applied LIVE
// in the open editor — published over comms, applied by the subscriber in
// llm-request.html via LLMPlugin.Importer (same path as the sidebar; an
// editor must be open). Node interactions are NOT saved to chat history and
// create no Restore Checkpoint. Provider / API key / endpoint are inherited
// from the sidebar settings via the shared engine (src/llm_core.js).
const path = require('path');

module.exports = function(RED) {
    const createLLMCore = require(path.join(__dirname, '..', '..', 'src', 'llm_core.js'));
    const createAdminApi = require(path.join(__dirname, '..', 'lib', 'admin_api.js'));

    const core = createLLMCore(RED);
    const adminApi = createAdminApi(RED);

    // Comms topic shared with the editor-side subscriber in llm-request.html.
    const AGENT_APPLY_TOPIC = 'llm-plugin/agent-apply';

    // Strip `user:pass@` out of any URL in a log line. The API URL is
    // operator- or flow-supplied and may carry userinfo; the Node-RED log is
    // not the place for it. Everything else in the URL stays readable, which
    // is the point of the warning.
    function scrubUrlCredentials(text) {
        return String(text).replace(/(\bhttps?:\/\/)[^\s/@"']*@/gi, '$1');
    }

    // The error a provider hands back can carry the API key straight back out:
    // an endpoint that echoes the Authorization header puts it in the message,
    // and `done(err)` is a flow-visible exit — the Node-RED log, `msg.error`
    // on the Catch route, and from there any debug or http response node. The
    // sidebar's /generate handler already redacts its equivalent; this is the
    // one exit from the shared engine that did not. `code` is preserved so
    // callers keep detecting timeouts without parsing the message.
    function redactedError(err) {
        const safe = new Error(core.redactSecrets(err && err.message ? err.message : err));
        if (err && err.code) safe.code = err.code;
        return safe;
    }

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

    // The selected tabs plus only the config nodes they reference, followed
    // transitively. Null when nothing is selected, so the prompt carries no
    // flow context. The selection is the user's statement of what may leave
    // the machine — including config nodes wholesale sent every broker and
    // credential-holder in the instance to the provider.
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

    // Timeout in whole seconds. Deliberately long by default (1 hour):
    // local LLMs routinely take many minutes on modest hardware, and a
    // short default would break the primary use case. 0 = no limit.
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
        // API URL (admin API base). Literal string, or the name of a
        // flow/global context variable holding it. Empty = auto-detect.
        const configEditorUrl = config.editorUrl || '';
        const configEditorUrlType = config.editorUrlType || 'str';
        const configTimeoutSec = toTimeoutSec(config.timeout, DEFAULT_TIMEOUT_SEC);
        // Developer feature: the editor deploys right after applying (Agent).
        const autoDeploy = config.autoDeploy === true;
        // Multi-select flow ids (the edit dialog always writes an array).
        const targetFlows = Array.isArray(config.targetFlows) ? config.targetFlows.slice() : [];

        // While a request is in flight, tick the node status with the
        // elapsed time so long local-LLM runs are visibly alive (status
        // text stays under the ~20-char guideline). Last writer wins if
        // several messages are in flight at once.
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
                // 0 stays 0 (= no limit); the engine owns that interpretation.
                const genOptions = { timeoutMs: timeoutSec * 1000 };

                // Best-effort flow context for the selected flows (both modes).
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
                            // A configured URL that doesn't serve the admin API
                            // (e.g. the httpNodeRoot base) — retry auto-detection.
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

                // Agent always gets the flow-building prompt (even without
                // context, so the model can propose a flow from scratch);
                // Ask without selected flows is plain chat.
                const messages = (context || mode === 'agent')
                    ? core.buildMessages(prompt, context, targetFlows[0] || null, settings)
                    : core.buildChatMessages(prompt, settings);
                const response = await core.generateWithProvider(provider, settings, model, messages, genOptions);
                stopStatusTicker();

                msg.payload = response;
                msg.llm = { mode: mode, provider: provider, model: model, elapsed: Date.now() - started };

                if (mode === 'agent') {
                    // Hand the reply to the open editor to apply live. Fire-and-
                    // forget: the node can't know if an editor is connected.
                    if (RED.comms && typeof RED.comms.publish === 'function') {
                        RED.comms.publish(AGENT_APPLY_TOPIC, {
                            response: response,
                            targetFlows: targetFlows,
                            autoDeploy: autoDeploy,
                            nodeId: node.id,
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
                    // Keep the status text short (<20 chars per the docs);
                    // hour-long local runs read better in seconds.
                    const elapsedText = elapsedMs < 10000
                        ? elapsedMs + 'ms'
                        : Math.round(elapsedMs / 1000) + 's';
                    node.status({ fill: 'green', shape: 'dot', text: 'done (' + elapsedText + ')' });
                }
                send(msg);
                done();
            } catch (err) {
                stopStatusTicker();
                // The engine tags timeouts with code ETIMEDOUT (both adapters).
                const text = (err && err.code === 'ETIMEDOUT') ? 'timeout' : 'error';
                node.status({ fill: 'red', shape: 'ring', text: text });
                done(redactedError(err));
            }
        });
    }

    RED.nodes.registerType('llm-request', LLMRequestNode);

    // Exposed for test/cross_flow_isolation.test.js — what this returns is what
    // leaves the machine, so it is covered by a regression test.
    module.exports._flowContextFor = flowContextFor;
    // Exposed for test/node_secret_exit.test.js.
    module.exports._scrubUrlCredentials = scrubUrlCredentials;
};
