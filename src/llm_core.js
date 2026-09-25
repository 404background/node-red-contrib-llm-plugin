// LLM Plugin  -  shared LLM engine: storage, encrypted credentials, settings,
// provider adapters, prompt construction, redaction. One store for the sidebar
// and the llm-request node both. See docs/{en,jp}/architecture.md.
//
// Usage:  const core = require('./llm_core.js')(RED);
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { OpenAI } = require('openai');
const FlowConverterCore = require('./core/flow_converter_core');

// No fallback prompt: a failure here means the file did not ship, and a
// stand-in would keep generating flows while silently dropping the rules the
// importer depends on. Failing to load is the honest answer.
const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompt_system.txt'), 'utf8');
// Ask is a different job, not a milder version of the same one: it reads the
// flow and explains it, and is told NOT to propose one. Two prompts rather
// than one with a flag, because the schema rules are most of the other file
// and none of them apply here.
const ASK_PROMPT_TEMPLATE = fs.readFileSync(path.join(__dirname, 'prompt_ask.txt'), 'utf8');

// Per-process singleton: two instances would cache credentials separately (a
// key saved in the sidebar would never reach the node) and could encrypt with
// different in-memory secrets.
let sharedInstance = null;

function createLLMCore(RED) {
    if (sharedInstance) return sharedInstance;

    // `userDir/llm-plugin`, or memory only. There is deliberately no second
    // location: the OS temp dir is world-readable on some hosts and cleared on
    // no schedule, and npm replaces the plugin's own directory on upgrade.
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

    // Write-then-rename, so a reader never sees a half-written file. The temp
    // name is unique per call, and `mode` is applied to the TEMP file — that
    // is what makes it stick across the rename.
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
    // Everything the plugin keeps is in `<userDir>/llm-plugin`, beside the
    // chats and checkpoints: `settings.json`, the API keys encrypted in
    // `credentials.json`, and `credential.key` they are encrypted with.
    // Removing that one folder resets the plugin.
    // See docs/{en,jp}/architecture.md — Security measures.
    const credsFile = persistenceEnabled ? path.join(baseDir, 'credentials.json') : null;
    const settingsFile = persistenceEnabled ? path.join(baseDir, 'settings.json') : null;
    const secretFile = persistenceEnabled ? path.join(baseDir, 'credential.key') : null;
    let credsCache = null;
    let settingsCache = null;

    function readRuntimeSetting(name) {
        try { return RED.settings.get(name); } catch (e) { return undefined; }
    }

    function dropRuntimeSetting(name) {
        try {
            if (typeof RED.settings.delete !== 'function') return;
            const result = RED.settings.delete(name);
            if (result && typeof result.catch === 'function') result.catch(function() { /* left in place */ });
        } catch (e) { /* left in place */ }
    }

    // An older build kept the settings and the key in Node-RED's runtime
    // settings (`.config.runtime.json`). They move into the folder once, and
    // leave the runtime settings only once they are written here.
    (function moveFromRuntimeSettings() {
        if (!persistenceEnabled) return;
        try {
            const settings = readRuntimeSetting('llmPluginSettings');
            if (settings && typeof settings === 'object') {
                if (!fs.existsSync(settingsFile)) writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2));
                dropRuntimeSetting('llmPluginSettings');
            }
            const secret = readRuntimeSetting('llmPluginCredentialSecret');
            if (typeof secret === 'string' && secret) {
                if (!fs.existsSync(secretFile)) writeFileAtomic(secretFile, secret, 0o600);
                dropRuntimeSetting('llmPluginCredentialSecret');
            }
        } catch (e) {
            RED.log.warn('[LLM Plugin] Could not move settings into ' + baseDir + ': ' + (e && e.message ? e.message : e));
        }
    })();

    // With no writable folder the settings live in memory, starting from
    // whatever an older build left in the runtime settings.
    function loadPlainSettings() {
        if (settingsCache) return settingsCache;
        settingsCache = {};
        if (settingsFile) {
            try {
                if (fs.existsSync(settingsFile)) settingsCache = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {};
            } catch (e) {
                RED.log.warn('[LLM Plugin] Failed to read settings file: ' + (e && e.message ? e.message : e));
            }
        } else {
            const legacy = readRuntimeSetting('llmPluginSettings');
            if (legacy && typeof legacy === 'object') settingsCache = Object.assign({}, legacy);
        }
        return settingsCache;
    }

    function persistPlainSettings(value) {
        const next = Object.assign({}, value);
        try {
            if (settingsFile) writeFileAtomic(settingsFile, JSON.stringify(next, null, 2));
        } catch (e) {
            return Promise.reject(e);
        }
        settingsCache = next;
        return Promise.resolve();
    }

    // The plugin keeps its OWN secret rather than deriving from Node-RED's.
    // Node-RED's are read only to decrypt blobs an older build wrote.
    const LEGACY_SECRET_SETTINGS = ['credentialSecret', '_credentialSecret'];

    let credentialSecret = null;

    function resolveCredentialSecret() {
        if (credentialSecret) return credentialSecret;
        try {
            if (secretFile && fs.existsSync(secretFile)) credentialSecret = fs.readFileSync(secretFile, 'utf8').trim() || null;
        } catch (e) { /* minted below */ }
        if (credentialSecret) return credentialSecret;

        // Nothing stored yet: mint one. It is used for this session either
        // way, so a failed write costs the keys only on restart — and says so.
        credentialSecret = crypto.randomBytes(32).toString('hex');
        if (secretFile) {
            try {
                writeFileAtomic(secretFile, credentialSecret, 0o600);
            } catch (e) {
                RED.log.warn('[LLM Plugin] Could not persist the credential key (' +
                    (e && e.message ? e.message : e) + '). Stored API keys will not ' +
                    'survive a restart.');
            }
        }
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
            const s = readRuntimeSetting(name);
            if (typeof s === 'string' && s) keys.push(keyFrom(s));
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
        let s = Object.assign({}, loadPlainSettings());
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
        return persistPlainSettings(plain);
    }

    // One-time migration out of the old plaintext store and the earlier
    // broken `addCredentials` attempt.
    (function migrateLegacyApiKey() {
        let raw = Object.assign({}, loadPlainSettings());
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
            persistPlainSettings(raw).catch(function(e) {
                RED.log.warn('[LLM Plugin] Could not clear the plaintext API key from settings: ' +
                    (e && e.message ? e.message : e));
            });
        }
        if (migrated) persistCreds();
    })();

    // A stored key must ALWAYS mask to something non-empty: the form reads an
    // empty mask as "no key" and the next save would delete it.
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
        // The stored key VALUES go first, matched literally; the patterns
        // below are only a net for keys that were never stored here.
        // See docs/{en,jp}/architecture.md — Security measures.
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

    // A lighter touch than redactSecrets for a log line that has to stay
    // useful: the URL survives, the `user:pass@` in it does not.
    function scrubUrlCredentials(text) {
        return String(text).replace(/(\bhttps?:\/\/)[^\s/@"']*@/gi, '$1');
    }

    // ------------------------------------------------------------------ //
    //  Prompt construction & flow context                                  //
    // ------------------------------------------------------------------ //

    // The selected tabs plus the config nodes they reference, transitively,
    // out of a whole `/flows` export. Null when nothing is selected. What
    // this returns is what leaves the machine. See docs/{en,jp}/design.md §6.
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

        // Tabs in the order they were selected and config nodes in id order,
        // as the editor's UI.getFlowsByIds has them: the importer reads the
        // reply against the alias numbering it rebuilds from that.
        const rank = function(n) { return ids.indexOf(n.type === 'tab' ? n.id : n.z) * 2 + (n.type === 'tab' ? 0 : 1); };
        selected.sort(function(a, b) { return rank(a) - rank(b); });
        const configs = Array.from(wanted).sort().map(function(id) { return configById.get(id); });
        const ctx = selected.concat(configs);
        return ctx.length > 0 ? ctx : null;
    }

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

        // Multi-flow: ONE flat Vibe Schema, every canvas node carrying a
        // `flow` field, grouped tab-by-tab so the alias numbering matches what
        // the client resolves against. See docs/{en,jp}/design.md §6.
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
            if (!alias) continue;
            const label = tabLabelById[n.z] || n.z;
            if (inter.nodes[alias]) inter.nodes[alias].flow = label;
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

    // Build the system prompt. It asks for Vibe Schema rather than Node-RED
    // JSON (docs/{en,jp}/vibe-schema.md). `settings` is optional — pass an
    // already-resolved object to avoid a second settings read per generation.
    // `options.mode`: 'ask' reads the flow and explains it; anything else
    // builds one. The flow context is the same either way — you cannot answer
    // "what does this do" without it — but the instructions are not.
    function buildMessages(userPrompt, flowContext, activeWorkspaceId, settings, options) {
        const userSystemPrompt = getUserSystemPrompt(settings);
        const asking = !!(options && options.mode === 'ask');

        let system = '';
        if (userSystemPrompt) {
            system += userSystemPrompt + '\n\n';
        }
        system += asking ? ASK_PROMPT_TEMPLATE : SYSTEM_PROMPT_TEMPLATE;

        if (flowContext) {
            const ctx = buildFlowContextDescription(flowContext, activeWorkspaceId);
            system += '\n' + ctx.header + '\n' + ctx.body + '\n';
        } else if (asking) {
            // The Ask prompt opens with "the flow below": with nothing
            // selected there is no flow below, and a model told to read one
            // will invent it. Say what actually happened instead.
            system += '\nNO FLOW WAS SENT — the flow selector is empty, so there is ' +
                'nothing below to read. Say that, and that selecting a flow in the ' +
                'sidebar is what lets you answer. Do not guess at a flow you cannot see.\n';
        }

        return [
            { role: 'system', content: system },
            { role: 'user', content: String(userPrompt || '') }
        ];
    }

    // Plain chat messages (no flow context, no Vibe Schema instructions) for
    // the llm-request node's "Ask" mode: just pass the payload through, honoring
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
    // One hour: local LLMs are slow. Shared by the sidebar and the node.
    const DEFAULT_TIMEOUT_MS = 3600 * 1000;

    // `options.timeoutMs` (0 = none) bounds the wait; `options.signal` lets
    // the caller give up earlier, e.g. when the requester went away.
    function generateWithProvider(provider, settings, model, messages, options) {
        const timeoutMs = (options && typeof options.timeoutMs === 'number' && options.timeoutMs > 0)
            ? Math.floor(options.timeoutMs)
            : 0;
        const signal = (options && options.signal) || undefined;
        if (provider === 'openai') {
            if (!settings.openaiApiKey) {
                return Promise.reject(new Error('OpenAI API key is not configured. Please set it in LLM Plugin settings.'));
            }
            return generateWithOpenAICompatible(settings.openaiApiKey, null, model, messages, timeoutMs, signal);
        }
        if (provider === 'custom') {
            let baseUrl = (settings.customBaseUrl && String(settings.customBaseUrl).trim()) || '';
            if (!baseUrl) {
                return Promise.reject(new Error('Custom endpoint Base URL is not configured. Please set it in LLM Plugin settings.'));
            }
            return generateWithOpenAICompatible(settings.customApiKey, baseUrl, model, messages, timeoutMs, signal);
        }
        return generateWithOllamaChat(settings, model, messages, timeoutMs, signal);
    }

    // Ollama chat generation (timeout 0 = wait indefinitely). `fetch` rather
    // than http/https: one code path for both schemes.
    async function generateWithOllamaChat(settings, model, messages, timeout = 0, callerSignal) {
        const ollamaUrlStr = (settings && settings.ollamaUrl) || 'http://localhost:11434';
        // No fallback to localhost: the settings endpoint already rejects
        // unparseable URLs, and a silent redirect would be unexplainable.
        const ollamaUrl = new URL(ollamaUrlStr);

        let basePath = ollamaUrl.pathname;
        if (basePath.endsWith('/')) basePath = basePath.slice(0, -1);
        const endpoint = ollamaUrl.origin + basePath + '/api/chat';

        // Streamed: unstreamed, Ollama sends no headers until the reply is
        // done, and fetch gives up on headers after 300 s whatever the
        // timeout says. A stream sends them at once and a line per token.
        const body = JSON.stringify({
            model: model,
            messages: Array.isArray(messages) ? messages : [],
            stream: true
        });

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: body,
                // Bounds the total wait, which is what the setting means.
                signal: combineSignals(
                    (timeout && timeout > 0) ? AbortSignal.timeout(timeout) : null, callerSignal)
            });
            if (res.status >= 400) {
                const responseData = await res.text();
                throw new Error(`Ollama API error (${res.status}): ${responseData.substring(0, 200)}`);
            }
            return await readOllamaStream(res.body);
        } catch (e) {
            if (callerSignal && callerSignal.aborted) throw e;
            // Callers detect a timeout by `err.code === 'ETIMEDOUT'` rather
            // than by parsing the message (llm-request's status display),
            // and an aborted fetch carries no such code. Put it back.
            if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                const timedOut = new Error('Request timed out');
                timedOut.code = 'ETIMEDOUT';
                throw timedOut;
            }
            throw e;
        }
    }

    // One JSON object per line; the reply is the `message.content` pieces
    // joined. An `error` line is Ollama failing mid-generation.
    async function readOllamaStream(stream) {
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let sawMessage = false;
        function take(line) {
            line = line.trim();
            if (!line) return;
            let obj;
            try { obj = JSON.parse(line); } catch (e) { throw new Error('Invalid response format'); }
            if (obj && obj.error) throw new Error('Ollama API error: ' + String(obj.error).substring(0, 200));
            if (obj && obj.message && typeof obj.message.content === 'string') {
                content += obj.message.content;
                sawMessage = true;
            }
        }
        for await (const chunk of stream) {
            buffer += decoder.decode(chunk, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
                take(buffer.slice(0, nl));
                buffer = buffer.slice(nl + 1);
            }
        }
        take(buffer + decoder.decode());
        if (!sawMessage) throw new Error('No response from model');
        return content;
    }

    function combineSignals(a, b) {
        if (a && b) return AbortSignal.any([a, b]);
        return a || b || undefined;
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

    // One adapter for OpenAI (`baseURL` null) and OpenAI-compatible
    // endpoints. A blank key becomes a placeholder: the SDK insists on one.
    async function generateWithOpenAICompatible(apiKey, baseURL, model, messages, timeoutMs, signal) {
        const effectiveKey = (apiKey && String(apiKey).trim()) ? String(apiKey).trim() : 'no-key';
        const openai = new OpenAI(baseURL ? { apiKey: effectiveKey, baseURL: baseURL } : { apiKey: effectiveKey });
        // Streamed for the reason the Ollama adapter is: unstreamed, a reply
        // over 300 s dies waiting for headers, and the SDK retries it whole.
        const timer = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
        let content = '';
        let sawChoice = false;
        try {
            const stream = await openai.chat.completions.create({
                messages: Array.isArray(messages) ? messages : [],
                model: model,
                stream: true,
            }, { timeout: timeoutMs > 0 ? timeoutMs : 2147483647, signal: combineSignals(timer, signal) });
            for await (const part of stream) {
                const choice = part && part.choices && part.choices[0];
                if (!choice) continue;
                sawChoice = true;
                if (choice.delta && typeof choice.delta.content === 'string') content += choice.delta.content;
            }
            // The SDK ends an aborted stream quietly; a cut-off reply must not
            // pass for a whole one.
            if ((timer && timer.aborted) || (signal && signal.aborted)) {
                throw (signal && signal.aborted) ? signal.reason : timer.reason;
            }
        } catch (e) {
            // Normalize the SDK's timeout error to the same code the Ollama
            // adapter uses, so callers detect timeouts without message parsing.
            if (e && e.name === 'APIConnectionTimeoutError') e.code = 'ETIMEDOUT';
            if (timer && timer.aborted && !(signal && signal.aborted)) {
                const timedOut = new Error('Request timed out');
                timedOut.code = 'ETIMEDOUT';
                throw timedOut;
            }
            throw wrapProviderError(e);
        }
        if (!sawChoice) {
            throw new Error('The LLM endpoint returned no message content. Verify the Base URL points to an ' +
                'OpenAI-compatible chat-completions API (e.g. ends in /v1) and that the model name is valid.');
        }
        return content;
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
        scrubUrlCredentials: scrubUrlCredentials,
        // prompt construction
        flowContextFor: flowContextFor,
        buildMessages: buildMessages,
        buildChatMessages: buildChatMessages,
        // generation
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        generateWithProvider: generateWithProvider
    };
    return sharedInstance;
}

module.exports = createLLMCore;
