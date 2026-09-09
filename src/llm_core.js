// LLM Plugin  -  Shared LLM Engine
//
// Everything needed to talk to an LLM: storage resolution, encrypted
// credentials, settings, provider adapters, prompt construction, redaction.
//
// The sidebar (src/server.js) and the runtime node (node/llm-request) both
// consume it, so there is ONE settings + credentials store — which is what
// lets a node inherit the provider and API key set in the sidebar.
//
// Usage:  const core = require('./llm_core.js')(RED);
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const FlowConverterCore = require('./core/flow_converter_core');

// No fallback prompt: a failure here means the file did not ship, and a
// stand-in would keep generating flows while silently dropping the rules the
// importer depends on. Failing to load is the honest answer.
const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompt_system.txt'), 'utf8');

// Per-process singleton: two instances would cache credentials separately (a
// key saved in the sidebar would never reach the node) and could encrypt with
// different in-memory secrets.
let sharedInstance = null;

function createLLMCore(RED) {
    if (sharedInstance) return sharedInstance;

    // `userDir/llm-plugin`, or memory only. There is deliberately no second
    // location to fall back to:
    //
    //  - The OS temp dir was one, and should not have been. It is where the
    //    encrypted `credentials.json` ended up on any host with a read-only
    //    userDir — a world-readable directory on some systems, cleared by the
    //    OS on no schedule this plugin controls, and left behind on uninstall.
    //  - The plugin's own install directory is not one either, however
    //    tempting: npm replaces that whole tree on a version upgrade, so it
    //    would lose the history on exactly the event that must preserve it.
    //
    // userDir is what gives the intended lifecycle — history survives a
    // plugin update, and removing `userDir/llm-plugin` resets it — and it is
    // where Node-RED keeps its own settings and credentials, so the plugin's
    // non-secret settings and the credential secret (both in RED.settings,
    // i.e. `userDir/.config.runtime.json`) already live alongside it.
    let baseDir = null;
    let chatsDir = null;
    let checkpointsDir = null;
    let persistenceEnabled = false;

    (function setupStorage() {
        let root = RED.settings && RED.settings.userDir;
        if (root) {
            let base = path.join(root, 'llm-plugin');
            try {
                fs.ensureDirSync(base);
                fs.ensureDirSync(path.join(base, 'chats'));
                fs.ensureDirSync(path.join(base, 'checkpoints'));
                baseDir = base;
                chatsDir = path.join(base, 'chats');
                checkpointsDir = path.join(base, 'checkpoints');
                persistenceEnabled = true;
                RED.log.info('[LLM Plugin] Storage: ' + base);
                return;
            } catch (e) {
                RED.log.warn('[LLM Plugin] Could not use ' + base + ': ' + (e && e.message ? e.message : e));
            }
        }
        // Everything still works from here — chats and checkpoints are held
        // in memory and API keys stay in the process — but none of it
        // outlives a restart, so say so once rather than failing later.
        RED.log.warn('[LLM Plugin] No writable storage under userDir; chat history, ' +
            'checkpoints and API keys will be kept in memory only and lost on restart.');
    })();

    // Write-then-rename so a reader never sees a half-written file. The temp
    // name is unique per call: a fixed `.tmp` suffix makes two concurrent
    // saves of the SAME document (two editor tabs, or a node and the sidebar)
    // write over each other's temp file and rename a spliced result into
    // place. A failed write leaves no debris behind either.
    // `mode` is applied to the TEMP file, which the rename then becomes. That
    // is what makes it stick: passing a mode to a plain write is ignored when
    // the target already exists, so a credentials file created by an older
    // build would keep its original permissions forever.
    function writeFileAtomic(filepath, content, mode) {
        const tmpPath = filepath + '.' + process.pid + '.' +
            crypto.randomBytes(4).toString('hex') + '.tmp';
        try {
            fs.writeFileSync(tmpPath, content, mode ? { encoding: 'utf8', mode: mode } : 'utf8');
            fs.renameSync(tmpPath, filepath);
        } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch (e2) { /* already gone */ }
            throw e;
        }
    }

    // ------------------------------------------------------------------ //
    //  Settings + credential persistence                                  //
    // ------------------------------------------------------------------ //
    //
    // API keys are encrypted into the plugin's own `credentials.json` rather
    // than `RED.nodes.addCredentials`, whose cleanCredentials wipes entries
    // no flow node references — on every deploy. Non-secret settings stay in
    // `RED.settings`.

    const credsFile = persistenceEnabled ? path.join(baseDir, 'credentials.json') : null;
    let credsCache = null;

    // `RED.settings.set` returns a Promise and throws synchronously when the
    // runtime has no settings storage, so both failure modes are normalised
    // here. An ignored rejection is an unhandled rejection in the Node-RED
    // process, and a silently dropped write is a setting the user believes
    // they saved.
    function persistSetting(name, value) {
        try {
            const result = RED.settings.set(name, value);
            return (result && typeof result.then === 'function') ? result : Promise.resolve();
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function readSetting(name) {
        try {
            const s = RED.settings.get(name);
            return (typeof s === 'string' && s.length > 0) ? s : null;
        } catch (e) {
            return null;
        }
    }

    // The plugin keeps its OWN secret rather than deriving from Node-RED's.
    // `_credentialSecret` belongs to the runtime: it generates that key, and
    // it DELETES it as soon as the user sets their own `credentialSecret` in
    // settings.js — a documented, encouraged change that would otherwise make
    // every stored API key here permanently undecryptable. Writing to it was
    // doubly wrong, since the runtime would then adopt the plugin's key for
    // the user's flow credentials.
    const SECRET_SETTING = 'llmPluginCredentialSecret';
    // Read-only, and only to decrypt blobs an older build wrote.
    const LEGACY_SECRET_SETTINGS = ['credentialSecret', '_credentialSecret'];

    let credentialSecret = null;

    function resolveCredentialSecret() {
        if (credentialSecret) return credentialSecret;

        credentialSecret = readSetting(SECRET_SETTING);
        if (credentialSecret) return credentialSecret;

        // Nothing stored yet: mint one and persist it. The generated value is
        // used for this session either way, so a failed write costs the keys
        // only on restart — and says so.
        credentialSecret = crypto.randomBytes(32).toString('hex');
        persistSetting(SECRET_SETTING, credentialSecret).catch(function(e) {
            RED.log.warn('[LLM Plugin] Could not persist the credential key (' +
                (e && e.message ? e.message : e) + '). Stored API keys will not ' +
                'survive a restart.');
        });
        return credentialSecret;
    }

    function keyFrom(secret) {
        return crypto.createHash('sha256').update(secret).digest();
    }

    // Encrypt with the plugin's key; decrypt with it or any legacy secret an
    // older build may have used, so an existing install keeps its keys.
    function encryptionKey() {
        return keyFrom(resolveCredentialSecret());
    }

    function decryptionKeys() {
        const keys = [encryptionKey()];
        LEGACY_SECRET_SETTINGS.forEach(function(name) {
            const s = readSetting(name);
            if (s) keys.push(keyFrom(s));
        });
        return keys;
    }

    // `g1:<iv hex>:<tag hex>:<ciphertext b64>`. GCM, not the CTR used before:
    // CTR is unauthenticated, so a tampered file decrypts to attacker-chosen
    // bits without error. Old blobs still read; the next save rewrites them.
    const GCM_PREFIX = 'g1:';

    function encryptBlob(plain) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
        const encrypted = cipher.update(JSON.stringify(plain), 'utf8', 'base64') + cipher.final('base64');
        const tag = cipher.getAuthTag();
        return GCM_PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
    }

    function decryptWith(blob, key) {
        if (blob.startsWith(GCM_PREFIX)) {
            const parts = blob.substring(GCM_PREFIX.length).split(':');
            if (parts.length !== 3) throw new Error('Malformed credentials blob');
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[0], 'hex'));
            decipher.setAuthTag(Buffer.from(parts[1], 'hex'));
            // final() throws if the tag does not verify.
            return JSON.parse(decipher.update(parts[2], 'base64', 'utf8') + decipher.final('utf8'));
        }
        // Legacy AES-256-CTR blob from before the GCM migration. CTR never
        // fails on a wrong key, so the JSON.parse is what rejects one.
        const iv = Buffer.from(blob.substring(0, 32), 'hex');
        const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
        return JSON.parse(decipher.update(blob.substring(32), 'base64', 'utf8') + decipher.final('utf8'));
    }

    function decryptBlob(blob) {
        const keys = decryptionKeys();
        for (let i = 0; i < keys.length; i++) {
            try { return decryptWith(blob, keys[i]); } catch (e) { /* try the next key */ }
        }
        throw new Error('Credentials could not be decrypted with any known key');
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
            // Atomic: a crash mid-write would otherwise leave a truncated
            // blob, which is every stored key gone.
            writeFileAtomic(credsFile, JSON.stringify({ $: encryptBlob(credsCache || {}) }), 0o600);
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
        return persistSetting('llmPluginSettings', plain);
    }

    // One-time migration out of the old plaintext store and the earlier
    // broken `addCredentials` attempt.
    (function migrateLegacyApiKey() {
        let raw = RED.settings.get('llmPluginSettings') || {};
        let creds = loadCreds();
        let migrated = false;
        let plaintextCleared = false;

        // Both secret fields are handled, not just the OpenAI one: an install
        // predating the encrypted store keeps whichever it had in plaintext,
        // and a field left out here stays in plaintext settings forever.
        ['openaiApiKey', 'customApiKey'].forEach(function(field) {
            if (!raw[field]) return;
            if (!creds[field]) {
                creds[field] = raw[field];
                migrated = true;
                RED.log.info('[LLM Plugin] Migrated ' + field +
                    ' from plaintext settings to the encrypted credentials file.');
            }
            delete raw[field];
            plaintextCleared = true;
        });

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

        if (plaintextCleared) {
            persistSetting('llmPluginSettings', raw).catch(function(e) {
                RED.log.warn('[LLM Plugin] Could not clear the plaintext API key from settings: ' +
                    (e && e.message ? e.message : e));
            });
        }
        if (migrated) persistCreds();
    })();

    // A stored key must ALWAYS produce a non-empty mask: the settings form
    // reads an empty one as "no key stored", shows a blank field, and the next
    // save deletes the key it meant to keep. Short keys get a fixed
    // placeholder rather than a prefix/suffix that would reveal most of them.
    function maskApiKey(key) {
        if (!key) return '';
        let s = String(key);
        // Fixed width for a key too short to show ends of: repeating by
        // length would publish the length of the secret.
        if (s.length < 12) return '********';
        return s.substring(0, 5) + '...' + s.substring(s.length - 4);
    }

    function redactSecrets(input) {
        let text = String(input || '');
        // The stored key VALUES go first, matched literally. A custom
        // endpoint's key can be any shape at all — a UUID, a bare token — so
        // no pattern will catch it, and an endpoint that echoes the
        // Authorization header into its error body would otherwise put it
        // straight in the Node-RED log. The patterns below stay as a net for
        // keys that were never stored here.
        try {
            const creds = loadCreds();
            Object.keys(creds).forEach(function(field) {
                const value = creds[field];
                if (typeof value === 'string' && value.length >= 8) {
                    text = text.split(value).join('***REDACTED***');
                }
            });
        } catch (e) { /* patterns still apply */ }
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

        // Normalize input. Both shapes get the same validity filter — the
        // `{nodes: […]}` branch used to pass its entries through unchecked,
        // so a null / typeless entry threw on the first `n.type` read below.
        let nodes = [];
        if (Array.isArray(flow)) {
            nodes = flow.filter(n => n && n.type);
        } else if (Array.isArray(flow.nodes)) {
            nodes = flow.nodes.filter(n => n && n.type);
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
                body: JSON.stringify(FlowConverterCore.toIntermediate(nodes), null, 2)
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
        const inter = FlowConverterCore.toIntermediate(allNodes, { includeIdMap: true });
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
        // No try/catch fallback to localhost: the settings endpoint already
        // rejects anything that is not a parseable http(s) URL, and quietly
        // redirecting an unparseable one to localhost would answer "why is my
        // remote Ollama not being used?" with silence.
        const ollamaUrl = new URL(ollamaUrlStr);

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
