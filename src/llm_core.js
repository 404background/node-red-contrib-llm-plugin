// LLM Plugin  -  Shared LLM Engine
//
// Single source of truth for everything the plugin needs to TALK to an LLM:
// storage resolution, encrypted credential handling, plugin-settings access,
// provider adapters (Ollama / OpenAI / Custom OpenAI-compatible), prompt
// construction (Vibe Schema flow context) and secret redaction.
//
// Both the editor sidebar (`src/server.js`, via its HTTP admin endpoints) AND
// the runtime node (`node/llm-request`) consume this module
// so they share ONE settings + credentials store. That is what lets a node
// "inherit" the provider/API-key the user configured in the sidebar settings
// dialog — there is no second place to keep them.
//
// Usage:  const core = require('./llm_core.js')(RED);
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const Configurator = require('./core/flow_converter_core');

// Fall back to a minimal embedded prompt if the bundled file is
// unreadable (sandboxed cloud environments occasionally restrict reads).
const FALLBACK_PROMPT = 'You are a Node-RED expert. Be concise; reply in the user\'s language. ' +
    'When modifying flows, output one ```json``` block in Vibe Schema with `nodes` and/or `connections` (either may be omitted; merge semantics: list to add/update, map alias to null to delete). Otherwise plain text.\n';
let SYSTEM_PROMPT_TEMPLATE;
try {
    SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompt_system.txt'), 'utf8');
} catch (e) {
    SYSTEM_PROMPT_TEMPLATE = FALLBACK_PROMPT;
}

// Per-process singleton: sidebar (server.js) and runtime node MUST share one
// instance — separate instances would cache credentials independently (a key
// saved in the sidebar wouldn't reach the node) and could encrypt with
// different in-memory secrets. Either RED object can serve both.
let sharedInstance = null;

function createLLMCore(RED) {
    if (sharedInstance) return sharedInstance;

    // --- Storage location resolution ---
    // Try, in order:
    //   1) <userDir>/llm-plugin/   (Node-RED's standard writable user dir)
    //   2) <os.tmpdir>/llm-plugin/  (ephemeral, but writable on sandboxed
    //                                cloud Node-REDs like enebular)
    //   3) in-memory only           (no persistence; chats / checkpoints
    //                                live in RAM until the server restarts)
    let baseDir = null;
    let chatsDir = null;
    let checkpointsDir = null;
    let clientEventsLog = null;
    let persistenceEnabled = false;

    (function setupStorage() {
        let candidates = [];
        if (RED.settings && RED.settings.userDir) candidates.push({ root: RED.settings.userDir, label: 'userDir' });
        try { candidates.push({ root: os.tmpdir(), label: 'tmpdir' }); } catch (e) {}
        for (let i = 0; i < candidates.length; i++) {
            let base = path.join(candidates[i].root, 'llm-plugin');
            try {
                fs.ensureDirSync(base);
                fs.ensureDirSync(path.join(base, 'chats'));
                fs.ensureDirSync(path.join(base, 'checkpoints'));
                baseDir = base;
                chatsDir = path.join(base, 'chats');
                checkpointsDir = path.join(base, 'checkpoints');
                clientEventsLog = path.join(base, 'client-events.log');
                persistenceEnabled = true;
                RED.log.info('[LLM Plugin] Storage: ' + base + ' (' + candidates[i].label + ')');
                return;
            } catch (e) { /* try next */ }
        }
        RED.log.warn('[LLM Plugin] No writable storage; chat history and checkpoints will be kept in memory only.');
    })();

    function writeFileAtomic(filepath, content) {
        const tmpPath = filepath + '.tmp';
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, filepath);
    }

    // ------------------------------------------------------------------ //
    //  Settings + credential persistence                                  //
    // ------------------------------------------------------------------ //
    //
    // API keys are AES-256-CTR-encrypted in `<baseDir>/credentials.json`
    // using Node-RED's own credentialSecret. NOT stored via
    // `RED.nodes.addCredentials`: cleanCredentials wipes entries whose id
    // no flow node references, on every deploy. Non-secret settings stay
    // in `RED.settings` (plain JSON).

    const credsFile = persistenceEnabled ? path.join(baseDir, 'credentials.json') : null;
    let credsCache = null;
    let inMemoryCredentialSecret = null; // fallback when RED.settings can't persist one

    function resolveCredentialSecret() {
        try {
            let s = RED.settings.get('credentialSecret');
            if (typeof s === 'string' && s.length > 0) return s;
        } catch (e) { /* ignore */ }
        try {
            let s = RED.settings.get('_credentialSecret');
            if (typeof s === 'string' && s.length > 0) return s;
        } catch (e) { /* ignore */ }
        // Try to auto-generate and persist, mirroring Node-RED's behavior
        // when the user hasn't configured `credentialSecret` themselves.
        try {
            if (RED.settings && typeof RED.settings.set === 'function') {
                let generated = crypto.randomBytes(32).toString('hex');
                RED.settings.set('_credentialSecret', generated);
                return generated;
            }
        } catch (e) { /* ignore */ }
        // Last resort: per-process key. Credentials become unreadable on
        // restart, but the plugin keeps working in the current session.
        if (!inMemoryCredentialSecret) {
            inMemoryCredentialSecret = crypto.randomBytes(32).toString('hex');
            RED.log.warn('[LLM Plugin] Could not resolve credentialSecret; using an in-memory key. ' +
                'Stored credentials will not survive restart. Set `credentialSecret` in settings.js to fix.');
        }
        return inMemoryCredentialSecret;
    }

    function deriveKey() {
        return crypto.createHash('sha256').update(resolveCredentialSecret()).digest();
    }

    // AES-256-GCM, written as `g1:<iv hex>:<tag hex>:<ciphertext b64>`.
    // The previous format was raw AES-256-CTR (`<iv hex><ciphertext b64>`),
    // which is unauthenticated: anyone able to touch credentials.json could
    // flip plaintext bits undetectably, since CTR decryption never fails.
    // GCM rejects a tampered file instead. Old blobs are still readable so
    // existing installs keep working; the next save rewrites them as GCM.
    const GCM_PREFIX = 'g1:';

    function encryptBlob(plain) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
        const encrypted = cipher.update(JSON.stringify(plain), 'utf8', 'base64') + cipher.final('base64');
        const tag = cipher.getAuthTag();
        return GCM_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
    }

    function decryptBlob(blob) {
        if (blob.startsWith(GCM_PREFIX)) {
            const parts = blob.substring(GCM_PREFIX.length).split(':');
            if (parts.length !== 3) throw new Error('Malformed credentials blob');
            const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(parts[0], 'hex'));
            decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
            // final() throws if the tag does not verify.
            const decrypted = decipher.update(parts[2], 'base64', 'utf8') + decipher.final('utf8');
            return JSON.parse(decrypted);
        }
        // Legacy AES-256-CTR blob from before the GCM migration.
        const iv = Buffer.from(blob.substring(0, 32), 'hex');
        const ciphertext = blob.substring(32);
        const decipher = crypto.createDecipheriv('aes-256-ctr', deriveKey(), iv);
        const decrypted = decipher.update(ciphertext, 'base64', 'utf8') + decipher.final('utf8');
        return JSON.parse(decrypted);
    }

    function loadCredsFromFile() {
        if (!credsFile) return {};
        try {
            if (!fs.existsSync(credsFile)) return {};
            const raw = fs.readFileSync(credsFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed.$ === 'string') return decryptBlob(parsed.$) || {};
            return {};
        } catch (e) {
            RED.log.warn('[LLM Plugin] Failed to read credentials file: ' + (e && e.message ? e.message : e));
            return {};
        }
    }

    function loadCreds() {
        if (credsCache === null) credsCache = loadCredsFromFile();
        return credsCache;
    }

    function persistCreds() {
        if (!credsFile) return; // no writable storage; in-memory only
        try {
            const body = JSON.stringify({ $: encryptBlob(credsCache || {}) });
            fs.writeFileSync(credsFile, body, { encoding: 'utf8', mode: 0o600 });
        } catch (e) {
            RED.log.warn('[LLM Plugin] Failed to persist credentials: ' + (e && e.message ? e.message : e));
        }
    }

    function setCredField(key, value) {
        let creds = loadCreds();
        if (value === '' || value === null || value === undefined) delete creds[key];
        else creds[key] = value;
        persistCreds();
    }

    // Merge secrets back in for runtime use; the client GET handler will
    // mask the API key separately before responding.
    function getPluginSettings() {
        let s = Object.assign({}, RED.settings.get('llmPluginSettings') || {});
        let creds = loadCreds();
        if (creds.openaiApiKey) s.openaiApiKey = creds.openaiApiKey;
        if (creds.customApiKey) s.customApiKey = creds.customApiKey;
        return s;
    }

    // Strips secret fields from `settings` (routed to encrypted creds
    // instead) and persists the rest as plain settings.
    function savePluginSettings(settings) {
        let plain = Object.assign({}, settings);
        if ('openaiApiKey' in plain) {
            setCredField('openaiApiKey', plain.openaiApiKey);
            delete plain.openaiApiKey;
        }
        if ('customApiKey' in plain) {
            setCredField('customApiKey', plain.customApiKey);
            delete plain.customApiKey;
        }
        RED.settings.set('llmPluginSettings', plain);
    }

    // One-time migration: pull an API key out of either the old plaintext
    // `llmPluginSettings` store OR the previous broken `addCredentials`
    // attempt, and write it into the new encrypted file.
    (function migrateLegacyApiKey() {
        let raw = RED.settings.get('llmPluginSettings') || {};
        let creds = loadCreds();
        let migrated = false;

        if (raw.openaiApiKey && !creds.openaiApiKey) {
            creds.openaiApiKey = raw.openaiApiKey;
            migrated = true;
            RED.log.info('[LLM Plugin] Migrated API key from plaintext settings to encrypted credentials file.');
        }

        if (!creds.openaiApiKey && RED.nodes && typeof RED.nodes.getCredentials === 'function') {
            try {
                let legacy = RED.nodes.getCredentials('llm-plugin-credentials');
                if (legacy && legacy.openaiApiKey) {
                    creds.openaiApiKey = legacy.openaiApiKey;
                    migrated = true;
                    RED.log.info('[LLM Plugin] Recovered API key from legacy synthetic-id credentials store.');
                }
            } catch (e) { /* ignore */ }
        }

        if (raw.openaiApiKey) {
            delete raw.openaiApiKey;
            RED.settings.set('llmPluginSettings', raw);
        }
        if (migrated) persistCreds();
    })();

    // Mask API key for safe client-side display (never expose full key)
    function maskApiKey(key) {
        if (!key || key.length < 8) return '';
        return key.substring(0, 5) + '...' + key.substring(key.length - 4);
    }

    function redactSecrets(input) {
        let text = String(input || '');
        text = text.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***REDACTED***');
        text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***REDACTED***');
        text = text.replace(/("(?:openai|custom)ApiKey"\s*:\s*")([^"]+)(")/gi, '$1***REDACTED***$3');
        text = text.replace(/https?:\/\/[^\s'"`]+/gi, '***URL_REDACTED***');
        text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '***IP_REDACTED***');
        return text;
    }

    // ------------------------------------------------------------------ //
    //  Prompt construction & flow context                                  //
    // ------------------------------------------------------------------ //

    // Build a flow context description for the prompt.
    // Converts the Node-RED flow to Vibe Schema (intermediate JSON) so the LLM
    // sees a clean, alias-based representation without random IDs or coordinates.
    function buildFlowContextDescription(flow, activeWorkspaceId) {
        const empty = { header: 'CURRENT FLOW (Vibe Schema):', body: 'No current flow context available.' };
        if (!flow) return empty;

        // Normalize input
        let nodes = [];
        if (Array.isArray(flow)) {
            nodes = flow.filter(n => n && n.type);
        } else if (flow.nodes) {
            nodes = (flow.nodes || []);
        }

        if (!nodes || nodes.length === 0) return empty;

        // Defensive credential stripping
        nodes = nodes.map(n => {
            const out = Object.assign({}, n);
            delete out.credentials;
            return out;
        });

        // Index tab labels and split nodes by category.
        const tabLabelById = {};
        const canvasNodes = [];
        const configById = {};
        for (const n of nodes) {
            if (n.type === 'tab') {
                tabLabelById[n.id] = n.label || n.id;
            } else if (n.z) {
                canvasNodes.push(n);
            } else {
                configById[n.id] = n;
            }
        }

        // Group canvas nodes by their workspace (z).
        const byTab = {};
        for (const n of canvasNodes) {
            (byTab[n.z] = byTab[n.z] || []).push(n);
        }
        const tabIdSet = new Set(Object.keys(tabLabelById));
        Object.keys(byTab).forEach(z => tabIdSet.add(z));
        const tabIds = Array.from(tabIdSet);

        // Single-flow case: keep the original single-schema output for prompt
        // continuity (existing prompt template references "CURRENT FLOW").
        if (tabIds.length <= 1) {
            let flowDisplay = 'Vibe Schema';
            if (tabIds.length === 1) {
                flowDisplay += ' - ' + JSON.stringify(tabLabelById[tabIds[0]] || tabIds[0]);
            }
            return {
                header: 'CURRENT FLOW (' + flowDisplay + '):',
                body: JSON.stringify(Configurator.toIntermediate(nodes), null, 2)
            };
        }

        // Multi-flow case: ONE flat Vibe Schema; every canvas node carries a
        // `flow` field (tab label). A single toIntermediate pass keeps
        // aliases globally unique (no cross-flow collisions). Config nodes
        // get no `flow` field — they live outside canvases. Canvas nodes are
        // grouped tab-by-tab (NOT raw input order): alias numbering follows
        // this order, and the client's alias resolution mirrors it.
        const allCanvas = [];
        for (const z of tabIds) {
            const flowNodes = byTab[z] || [];
            for (const n of flowNodes) allCanvas.push(n);
        }
        const allNodes = allCanvas.concat(Object.values(configById));
        const inter = Configurator.toIntermediate(allNodes, { includeIdMap: true });
        const idToAlias = (inter._meta && inter._meta.idToAlias) || {};
        delete inter._meta;

        // Annotate each canvas node's intermediate entry with its flow label.
        // Config nodes get no flow tag (shared/global scope).
        for (const n of allCanvas) {
            const alias = idToAlias[n.id];
            if (alias && inter.nodes[alias]) {
                inter.nodes[alias].flow = tabLabelById[n.z] || n.z;
            }
        }

        const flowNames = [];
        let activeLabel = null;
        for (const z of tabIds) {
            const label = tabLabelById[z] || z;
            if (flowNames.indexOf(label) === -1) flowNames.push(label);
            if (activeWorkspaceId && z === activeWorkspaceId) activeLabel = label;
        }

        let header = 'CURRENT FLOWS (Vibe Schema - each canvas node has a "flow" field naming its home flow tab). Aliases are globally unique across all flows; do not rename existing aliases.';
        header += '\nFLOWS: ' + flowNames.map(n => JSON.stringify(n)).join(', ');
        if (activeLabel) header += '\nACTIVE FLOW: ' + JSON.stringify(activeLabel);
        header += '\nAll listed flows are editable. When adding a new node, set its "flow" field to one of the FLOWS names to choose its target flow. DO NOT output tab (workflow/canvas) definition nodes yourself.';

        return {
            header: header,
            body: JSON.stringify(inter, null, 2)
        };
    }

    // The user's custom system prompt from plugin settings (trimmed; '' when
    // unset). Single definition so buildMessages and buildChatMessages can
    // never drift apart on how the setting is read.
    function getUserSystemPrompt(settings) {
        const s = settings || getPluginSettings();
        return (s.systemPrompt !== undefined && s.systemPrompt !== null)
            ? String(s.systemPrompt).trim()
            : '';
    }

    // Build the system prompt.
    // Instructs the LLM to output Vibe Schema (intermediate JSON) instead of
    // raw Node-RED JSON, which avoids the need for random IDs and coordinates.
    // `settings` is optional — pass an already-resolved settings object to
    // avoid a second settings/credentials read per generation.
    function buildMessages(userPrompt, flowContext, activeWorkspaceId, settings) {
        const userSystemPrompt = getUserSystemPrompt(settings);

        let system = '';
        if (userSystemPrompt) {
            system += userSystemPrompt + '\n\n';
        }
        system += SYSTEM_PROMPT_TEMPLATE;

        if (flowContext) {
            const ctx = buildFlowContextDescription(flowContext, activeWorkspaceId);
            system += '\n' + ctx.header + '\n' + ctx.body + '\n';
        }

        return [
            { role: 'system', content: system },
            { role: 'user', content: String(userPrompt || '') }
        ];
    }

    // Plain chat messages (no flow context, no Vibe Schema instructions) for
    // the runtime node's "Ask" mode: just pass the payload through, honoring
    // the user's custom system prompt from settings if one is configured.
    function buildChatMessages(userPrompt, settings) {
        const userSystemPrompt = getUserSystemPrompt(settings);
        const messages = [];
        if (userSystemPrompt) {
            messages.push({ role: 'system', content: userSystemPrompt });
        }
        messages.push({ role: 'user', content: String(userPrompt || '') });
        return messages;
    }

    // ------------------------------------------------------------------ //
    //  LLM provider adapters                                              //
    // ------------------------------------------------------------------ //

    // `options.timeoutMs` bounds one generation (0 / omitted = no limit).
    // The node passes its configured timeout; the sidebar passes nothing.
    function generateWithProvider(provider, settings, model, messages, options) {
        const timeoutMs = (options && typeof options.timeoutMs === 'number' && options.timeoutMs > 0)
            ? Math.floor(options.timeoutMs)
            : 0;
        if (provider === 'openai') {
            if (!settings.openaiApiKey) {
                return Promise.reject(new Error('OpenAI API key is not configured. Please set it in LLM Plugin settings.'));
            }
            return generateWithOpenAICompatible(settings.openaiApiKey, null, model, messages, timeoutMs);
        }
        if (provider === 'custom') {
            let baseUrl = (settings.customBaseUrl && String(settings.customBaseUrl).trim()) || '';
            if (!baseUrl) {
                return Promise.reject(new Error('Custom endpoint Base URL is not configured. Please set it in LLM Plugin settings.'));
            }
            return generateWithOpenAICompatible(settings.customApiKey, baseUrl, model, messages, timeoutMs);
        }
        return generateWithOllamaChat(settings, model, messages, timeoutMs);
    }

    // Ollama chat generation (timeout 0 = wait indefinitely).
    // `timeout` maps to http.request's socket-inactivity timer; since the
    // non-streaming /api/chat sends nothing until generation completes,
    // it effectively bounds the total wait. `settings` is passed in like
    // the other adapters (single settings read per generation).
    function generateWithOllamaChat(settings, model, messages, timeout = 0) {
        const ollamaUrlStr = (settings && settings.ollamaUrl) || 'http://localhost:11434';
        let ollamaUrl;
        try {
            ollamaUrl = new URL(ollamaUrlStr);
        } catch (e) {
            ollamaUrl = new URL('http://localhost:11434');
        }

        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                model: model,
                messages: Array.isArray(messages) ? messages : [],
                stream: false
            });
            const isHttps = ollamaUrl.protocol === 'https:';
            let basePath = ollamaUrl.pathname === '/' ? '' : ollamaUrl.pathname;
            if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
            const options = {
                hostname: ollamaUrl.hostname,
                port: ollamaUrl.port || (isHttps ? 443 : 80),
                path: basePath + '/api/chat',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Content-Length': Buffer.byteLength(data)
                }
            };
            if (timeout && timeout > 0) {
                options.timeout = timeout;
            }
            const httpModule = isHttps ? https : http;
            const req = httpModule.request(options, (res) => {
                const chunks = [];
                res.on('data', (chunk) => {
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    const responseData = Buffer.concat(chunks).toString('utf8');
                    if (res.statusCode && res.statusCode >= 400) {
                        return reject(new Error(`Ollama API error (${res.statusCode}): ${responseData.substring(0, 200)}`));
                    }
                    try {
                        const response = JSON.parse(responseData);
                        const content = response && response.message && typeof response.message.content === 'string'
                            ? response.message.content
                            : null;
                        if (content !== null) {
                            resolve(content);
                        } else {
                            reject(new Error('No response from model'));
                        }
                    } catch (parseError) {
                        reject(new Error('Invalid response format'));
                    }
                });
            });
            req.on('error', (error) => {
                reject(error);
            });
            if (timeout && timeout > 0) {
                req.on('timeout', () => {
                    req.destroy();
                    // code ETIMEDOUT lets callers detect timeouts without
                    // parsing the message (llm-request's status display).
                    const e = new Error('Request timed out');
                    e.code = 'ETIMEDOUT';
                    reject(e);
                });
            }
            req.write(data);
            req.end();
        });
    }

    // Re-label the OpenAI SDK's cryptic "… is not valid JSON" error (an
    // endpoint that answered with plain text) into an actionable message.
    function wrapProviderError(err) {
        const m = (err && err.message) ? String(err.message) : String(err);
        if (/is not valid JSON|Unexpected token/.test(m)) {
            const e = new Error('The LLM endpoint returned a non-JSON response. Verify the Base URL points ' +
                'to an OpenAI-compatible chat-completions API (e.g. ends in /v1) and that the model name is ' +
                'valid. Endpoint said: ' + m.slice(0, 200));
            e.cause = err;
            return e;
        }
        return err;
    }

    function extractContent(completion) {
        const content = completion && completion.choices && completion.choices[0] &&
            completion.choices[0].message && completion.choices[0].message.content;
        if (typeof content !== 'string') {
            throw new Error('The LLM endpoint returned no message content (unexpected response shape).');
        }
        return content;
    }

    // One adapter for OpenAI (`baseURL` null) and OpenAI-compatible
    // endpoints (llama.cpp / LM Studio / vLLM / LocalAI). Blank key becomes
    // a placeholder — the SDK insists on one, auth-less endpoints ignore
    // it. `timeoutMs` > 0 → per-request SDK timeout (0 = SDK default).
    async function generateWithOpenAICompatible(apiKey, baseURL, model, messages, timeoutMs) {
        const effectiveKey = (apiKey && String(apiKey).trim()) ? String(apiKey).trim() : 'no-key';
        const openai = new OpenAI(baseURL ? { apiKey: effectiveKey, baseURL: baseURL } : { apiKey: effectiveKey });
        let completion;
        try {
            completion = await openai.chat.completions.create({
                messages: Array.isArray(messages) ? messages : [],
                model: model,
            }, (timeoutMs > 0) ? { timeout: timeoutMs } : undefined);
        } catch (e) {
            // Normalize the SDK's timeout error to the same code the Ollama
            // adapter uses, so callers detect timeouts without message parsing.
            if (e && e.name === 'APIConnectionTimeoutError') e.code = 'ETIMEDOUT';
            throw wrapProviderError(e);
        }
        return extractContent(completion);
    }

    sharedInstance = {
        // storage (consumed by server.js for chat / checkpoint persistence)
        chatsDir: chatsDir,
        checkpointsDir: checkpointsDir,
        clientEventsLog: clientEventsLog,
        persistenceEnabled: persistenceEnabled,
        writeFileAtomic: writeFileAtomic,
        // settings + credentials
        getPluginSettings: getPluginSettings,
        savePluginSettings: savePluginSettings,
        maskApiKey: maskApiKey,
        redactSecrets: redactSecrets,
        // prompt construction
        buildMessages: buildMessages,
        buildChatMessages: buildChatMessages,
        // generation
        generateWithProvider: generateWithProvider
    };
    return sharedInstance;
}

module.exports = createLLMCore;
