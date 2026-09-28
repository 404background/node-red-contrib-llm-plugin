// LLM Plugin  -  the `llm-request` node, runtime half.
// msg.payload in, the model's reply out. See docs/{en,jp}/llm-request.md.
const path = require('path');

module.exports = function(RED) {
    const createLLMCore = require(path.join(__dirname, '..', '..', 'src', 'llm_core.js'));

    const core = createLLMCore(RED);

    // `done(err)` is a flow-visible exit and a provider error can carry the
    // API key. `code` survives so timeouts stay detectable.
    // See docs/{en,jp}/architecture.md — Security measures.
    function redactedError(err) {
        const safe = new Error(core.redactSecrets(err && err.message ? err.message : err));
        if (err && err.code) safe.code = err.code;
        return safe;
    }

    // Sent as given; only what is not text is turned into text.
    function payloadToPrompt(payload) {
        if (payload === undefined || payload === null) return '';
        if (typeof payload === 'string') return payload;
        if (Buffer.isBuffer(payload)) return payload.toString('utf8');
        if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload);
        try { return JSON.stringify(payload, null, 2); }
        catch (e) { return String(payload); }
    }

    // Seconds, 0 = no limit.
    const DEFAULT_TIMEOUT_SEC = core.DEFAULT_TIMEOUT_MS / 1000;
    function toTimeoutSec(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        const n = parseInt(value, 10);
        return (isNaN(n) || n < 0) ? fallback : n;
    }

    function LLMRequestNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const providerOverride = config.provider || '';
        const configModel = config.model || '';
        const configSystem = config.systemPrompt || '';
        const configTimeoutSec = toTimeoutSec(config.timeout, DEFAULT_TIMEOUT_SEC);

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
                if (!prompt.trim()) {
                    throw new Error('msg.payload is empty; nothing to send to the LLM.');
                }

                // The node's own, not the sidebar's: that one is about editing flows.
                const system = typeof msg.system === 'string' ? msg.system : configSystem;
                const messages = system.trim()
                    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
                    : [{ role: 'user', content: prompt }];

                node.status({ fill: 'blue', shape: 'dot', text: 'requesting…' });
                const started = Date.now();
                startStatusTicker(started);
                const response = await core.generateWithProvider(provider, settings, model, messages,
                    { timeoutMs: timeoutSec * 1000 });
                stopStatusTicker();

                const elapsedMs = Date.now() - started;
                msg.payload = response;
                msg.llm = { provider: provider, model: model, elapsed: elapsedMs };
                const elapsedText = elapsedMs < 10000
                    ? elapsedMs + 'ms'
                    : Math.round(elapsedMs / 1000) + 's';
                node.status({ fill: 'green', shape: 'dot', text: 'done (' + elapsedText + ')' });
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
};
