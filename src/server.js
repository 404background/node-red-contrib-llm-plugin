// LLM Plugin  -  Server Side
// Registers all HTTP admin endpoints used by the client sidebar.
//
// The LLM engine (settings, credentials, provider adapters, prompt building,
// secret redaction) lives in `./llm_core.js`
// so the runtime nodes can share the exact same settings + credentials store.
// This file keeps the HTTP admin layer plus chat-history / checkpoint
// persistence, both of which are specific to the editor sidebar.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const createLLMCore = require('./llm_core');

function createLLMPluginServer(RED) {
    const core = createLLMCore(RED);

    // Storage locations resolved once by the shared core.
    const chatsDir = core.chatsDir;
    const checkpointsDir = core.checkpointsDir;
    const clientEventsLog = core.clientEventsLog;
    const persistenceEnabled = core.persistenceEnabled;
    const writeFileAtomic = core.writeFileAtomic;

    // Shorthand for the engine helpers used by the endpoints below.
    const getPluginSettings = core.getPluginSettings;
    const savePluginSettings = core.savePluginSettings;
    const generateWithProvider = core.generateWithProvider;
    const buildMessages = core.buildMessages;
    const maskApiKey = core.maskApiKey;
    const redactSecrets = core.redactSecrets;

    // In-memory fallback stores when no writable storage is available.
    let memChats = {};
    let memCheckpoints = {};

    // ------------------------------------------------------------------ //
    //  Resource limits                                                    //
    // ------------------------------------------------------------------ //
    //
    // Every endpoint below writes to disk or spends money on the user's
    // behalf, so each input that reaches storage or a provider is bounded.
    // Node-RED's own `apiMaxLength` caps the raw request body, but that
    // still permits unbounded *accumulation* across requests.

    // The flow context is concatenated into the same system message as the
    // prompt. Without its own bound, `maxPromptLength` is bypassable by
    // moving the payload into `currentFlow`.
    const MAX_FLOW_CONTEXT_CHARS = 1024 * 1024;
    // Ceiling for anything persisted as a JSON file (chat, checkpoint).
    const MAX_STORED_JSON_CHARS = 5 * 1024 * 1024;
    // Client event log: per-field clip, and rotation of the whole file.
    const MAX_CLIENT_LOG_BYTES = 5 * 1024 * 1024;
    const MAX_EVENT_FIELD_CHARS = 4096;
    // Checkpoints are pruned oldest-first past this count.
    const MAX_CHECKPOINT_FILES = 200;

    function clip(text, max) {
        const s = String(text === undefined || text === null ? '' : text);
        return s.length > max ? s.substring(0, max) + '[truncated]' : s;
    }

    function assertStorableSize(value, label) {
        let text;
        try {
            text = JSON.stringify(value);
        } catch (e) {
            throw badRequest(label + ' is not serialisable');
        }
        if (text && text.length > MAX_STORED_JSON_CHARS) {
            throw badRequest(label + ' exceeds the ' + MAX_STORED_JSON_CHARS + '-character storage limit');
        }
        return text;
    }

    // ------------------------------------------------------------------ //
    //  Endpoint authorisation                                             //
    // ------------------------------------------------------------------ //
    //
    // Node-RED does NOT apply `adminAuth` to routes that plugins/nodes add
    // to RED.httpAdmin — the core Admin API guards its own routes with
    // needsPermission individually, and anything registered afterwards is
    // wide open unless it does the same. Without this, enabling adminAuth
    // still left /llm-plugin/* reachable unauthenticated: chat history
    // readable, settings rewritable (which can redirect a stored API key to
    // an arbitrary endpoint), and generation billable by anyone who can
    // reach the port.
    //
    // needsPermission is a no-op when adminAuth is not configured, so
    // single-user installs are unaffected.
    //
    // `read`-scoped users get the read endpoints (Node-RED maps scope
    // "read" onto any "*.read" permission); everything that writes,
    // generates, or spends money requires full access.
    const PERM_READ = 'llm-plugin.read';
    const PERM_WRITE = 'llm-plugin.write';

    function guard(permission) {
        if (RED.auth && typeof RED.auth.needsPermission === 'function') {
            return RED.auth.needsPermission(permission);
        }
        // Embedded/older runtimes without RED.auth: fail closed only if the
        // host actually configured adminAuth, otherwise carry on.
        return function(req, res, next) {
            if (RED.settings && RED.settings.adminAuth) {
                return res.status(401).json({ error: 'Authentication required' });
            }
            next();
        };
    }

    // redactSecrets only ever substitutes quote-free placeholders, so a
    // redacted JSON string stays parseable - which keeps the log valid
    // JSON-lines while guaranteeing nothing unmasked reaches the file.
    function redactJson(value) {
        let text;
        try {
            text = JSON.stringify(value);
        } catch (e) {
            return '[unserialisable]';
        }
        if (!text) return {};
        text = redactSecrets(clip(text, MAX_EVENT_FIELD_CHARS));
        try { return JSON.parse(text); } catch (e) { return text; }
    }

    function rotateClientLogIfNeeded() {
        try {
            if (fs.statSync(clientEventsLog).size < MAX_CLIENT_LOG_BYTES) return;
            // Single generation; rename replaces any previous .1 on both
            // POSIX and Windows.
            fs.renameSync(clientEventsLog, clientEventsLog + '.1');
        } catch (e) { /* file absent on first write, or lost a rotate race */ }
    }

    function writeClientEvent(level, event, message, meta) {
        const lv = String(level || 'info').toLowerCase();
        const safeLevel = (lv === 'error' || lv === 'warn' || lv === 'warning') ? lv : 'info';
        // `meta` is redacted here, not only in the console preview: it used
        // to reach the log file verbatim, and importer diagnostics put node
        // contents in it.
        const payload = {
            ts: new Date().toISOString(),
            level: safeLevel,
            event: clip(event || 'client-event', 200),
            message: redactSecrets(clip(message, MAX_EVENT_FIELD_CHARS)),
            meta: redactJson(meta && typeof meta === 'object' ? meta : {})
        };

        if (persistenceEnabled && clientEventsLog) {
            try {
                rotateClientLogIfNeeded();
                fs.appendFile(clientEventsLog, JSON.stringify(payload) + '\n', 'utf8', () => {});
            } catch (e) { /* logs are best-effort */ }
        }

        const metaPreview = (() => {
            try {
                const text = JSON.stringify(payload.meta);
                return text && text.length > 0 ? ' meta=' + text : '';
            } catch (e) {
                return '';
            }
        })();

        const line = `[LLM Plugin][Client][${payload.event}] ${payload.message}${metaPreview}`;
        if (safeLevel === 'error') RED.log.error(line);
        else if (safeLevel === 'warn' || safeLevel === 'warning') RED.log.warn(line);
        // By default, info level debug output to terminal is suppressed.
        // else RED.log.info(line);
    }

    // ------------------------------------------------------------------ //
    //  Chat history persistence                                           //
    // ------------------------------------------------------------------ //

    function sanitizeChatId(id) {
        const s = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 64);
        return s || 'unknown';
    }

    function saveChatHistory(chatId, chatData) {
        const safeChatId = sanitizeChatId(chatId);
        if (!persistenceEnabled) {
            memChats[safeChatId] = chatData;
            return;
        }
        try {
            const date = new Date().toISOString().split('T')[0];
            const rawTitle = (chatData.title && typeof chatData.title === 'string') ? chatData.title : 'untitled';
            const sanitizedTitle = rawTitle.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 50);
            const filename = `${date}-${sanitizedTitle}-${safeChatId}.json`;
            const filepath = path.resolve(chatsDir, filename);
            if (!filepath.startsWith(path.resolve(chatsDir) + path.sep)) {
                throw new Error('Refused to write outside chats dir');
            }
            fs.ensureDirSync(chatsDir);

            // Clean up any older files for this chatId to prevent duplicates
            try {
                const existingFiles = fs.readdirSync(chatsDir).filter(file => file.endsWith(`-${safeChatId}.json`));
                existingFiles.forEach(file => {
                    if (file !== filename) fs.unlinkSync(path.join(chatsDir, file));
                });
            } catch (e) { /* ignore cleanup errors */ }

            writeFileAtomic(filepath, JSON.stringify(chatData, null, 2));
        } catch (error) {
            console.error("[LLM Plugin] Error saving chat history:", error);
        }
    }

    function loadAllChatHistories() {
        if (!persistenceEnabled) {
            // Return a shallow clone so callers can't mutate our memory store.
            let copy = {};
            Object.keys(memChats).forEach(function(k) { copy[k] = memChats[k]; });
            return copy;
        }
        try {
            if (!fs.existsSync(chatsDir)) {
                return {};
            }
            const chatFiles = fs.readdirSync(chatsDir).filter(file => file.endsWith('.json'));
            const chatHistories = {};
            chatFiles.forEach(file => {
                try {
                    const filepath = path.join(chatsDir, file);
                    const content = fs.readFileSync(filepath, 'utf8');
                    const chatData = JSON.parse(content);
                    // include the source filename so clients can request deletion by filename
                    if (chatData && typeof chatData === 'object') {
                        chatData.__file = file;
                    }
                    chatHistories[chatData.id] = chatData;
                } catch (error) {
                    console.error("[LLM Plugin] Error reading chat file:", file, error);
                }
            });
            return chatHistories;
        } catch (error) {
            console.error("[LLM Plugin] Error loading chat histories:", error);
            return {};
        }
    }

    // Prune oldest-first so an automated Agent loop cannot grow the
    // checkpoint directory without bound.
    function pruneCheckpoints() {
        try {
            const entries = fs.readdirSync(checkpointsDir)
                .map(f => /^cp_(\d+)_[a-z0-9]+\.json$/i.exec(f))
                .filter(Boolean)
                .map(m => ({ file: m[0], ts: parseInt(m[1], 10) }))
                .sort((a, b) => a.ts - b.ts);
            if (entries.length <= MAX_CHECKPOINT_FILES) return;
            entries.slice(0, entries.length - MAX_CHECKPOINT_FILES).forEach(e => {
                try { fs.unlinkSync(path.join(checkpointsDir, e.file)); } catch (err) { /* best effort */ }
            });
        } catch (e) { /* pruning must never block a save */ }
    }

    function saveCheckpoint(chatId, label, flow, meta) {
        // crypto RNG rather than Math.random: the id is the only handle on a
        // checkpoint, and a Math.random suffix next to a known epoch is
        // guessable.
        const checkpointId = 'cp_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
        const record = {
            id: checkpointId,
            chatId: chatId || null,
            label: label || 'checkpoint',
            created: new Date().toISOString(),
            meta: meta || {},
            flow: Array.isArray(flow) ? flow : []
        };
        if (!persistenceEnabled) {
            memCheckpoints[checkpointId] = record;
            // Same bound as the on-disk pruning, so the memory-only fallback
            // cannot grow without limit either.
            const ids = Object.keys(memCheckpoints);
            if (ids.length > MAX_CHECKPOINT_FILES) {
                ids.sort().slice(0, ids.length - MAX_CHECKPOINT_FILES)
                   .forEach(k => { delete memCheckpoints[k]; });
            }
            return record;
        }
        try {
            pruneCheckpoints();
            writeFileAtomic(path.join(checkpointsDir, checkpointId + '.json'), JSON.stringify(record, null, 2));
        } catch (e) {
            console.error('[LLM Plugin] Failed to save checkpoint:', e && e.message ? e.message : e);
            throw e;
        }
        return record;
    }

    // ------------------------------------------------------------------ //
    //  HTTP admin endpoints                                               //
    // ------------------------------------------------------------------ //

    // Single generation endpoint for BOTH sidebar modes: Ask and Agent send
    // the identical request; what differs is purely client-side (Agent
    // auto-clicks the Import button on the reply).
    RED.httpAdmin.post('/llm-plugin/generate', guard(PERM_WRITE), async function(req, res) {
        const { model, prompt, currentFlow, activeWorkspaceId } = req.body;
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }

        const settings = getPluginSettings();
        const maxLen = parseInt(settings.maxPromptLength, 10) || 10000;
        if (String(prompt).length > maxLen) {
            return res.status(400).json({ error: 'Prompt exceeds maximum length (' + maxLen + ' characters)' });
        }
        // maxPromptLength alone is not a limit: buildMessages concatenates the
        // flow context into the same system message, so an unbounded
        // currentFlow would carry any payload straight past the check above.
        if (currentFlow !== undefined && currentFlow !== null) {
            let flowChars;
            try {
                flowChars = JSON.stringify(currentFlow).length;
            } catch (e) {
                return res.status(400).json({ error: 'currentFlow is not serialisable' });
            }
            if (flowChars > MAX_FLOW_CONTEXT_CHARS) {
                return res.status(413).json({
                    error: 'Flow context is too large (' + flowChars + ' > ' +
                        MAX_FLOW_CONTEXT_CHARS + ' characters). Select fewer flows.'
                });
            }
        }
        const provider = settings.provider || 'ollama';

        const enhancedMessages = buildMessages(prompt, currentFlow, activeWorkspaceId, settings);
        const genStart = Date.now();

        try {
            const response = await generateWithProvider(provider, settings, model, enhancedMessages);
            res.json({ response: response, elapsed: Date.now() - genStart, model: model });
        } catch (error) {
            // Log only safe fields  -  never log the full error object which may contain sensitive headers
            const safeErrorText = redactSecrets(error && error.message ? error.message : error);
            console.error("[LLM Plugin] Generation error:", safeErrorText);
            let errorMessage = 'Generation failed';
            const providerLabel = provider === 'ollama'
                ? 'Ollama'
                : (provider === 'custom' ? 'the custom OpenAI-compatible endpoint' : 'the LLM provider');
            if (error.code === 'ECONNREFUSED') {
                errorMessage = 'Could not connect to ' + providerLabel + '. Please ensure it is running and accessible.';
            } else if (error.code === 'ECONNRESET') {
                errorMessage = 'The connection to ' + providerLabel + ' was unexpectedly closed. Please check that the server is running and stable.';
            } else if (error.message && error.message.includes('timeout')) {
                errorMessage = 'Request timed out. The model may be too slow or not responding.';
            } else {
                errorMessage = redactSecrets(error && error.message ? error.message : error);
            }
            res.status(500).json({ error: errorMessage });
        }
    });

    // --- Settings endpoints ---
    RED.httpAdmin.get('/llm-plugin/settings', guard(PERM_READ), function(req, res) {
        const settings = Object.assign({}, getPluginSettings());
        // Never expose the full API key to the client
        const hasKey = !!(settings.openaiApiKey && settings.openaiApiKey.length > 0);
        settings.openaiApiKeyMasked = hasKey ? maskApiKey(settings.openaiApiKey) : '';
        settings.ollamaUrlMasked = settings.ollamaUrl ? 'configured (hidden)' : '';
        const hasCustomKey = !!(settings.customApiKey && settings.customApiKey.length > 0);
        settings.customApiKeyMasked = hasCustomKey ? maskApiKey(settings.customApiKey) : '';
        settings.customBaseUrlMasked = settings.customBaseUrl ? 'configured (hidden)' : '';
        delete settings.openaiApiKey;
        delete settings.ollamaUrl;
        delete settings.customApiKey;
        delete settings.customBaseUrl;
        // systemPrompt is safe to send to client (user-authored content)
        res.json(settings);
    });

    // Blank URL fields preserve the existing value (the form shows URLs as
    // placeholders, not values). API keys use the '__EXISTING_KEY__'
    // placeholder to mean "keep"; anything else replaces, blank deletes
    // (a blank key is valid for auth-less custom endpoints).
    function urlOrExisting(value, existingValue) {
        return (value && typeof value === 'string' && value.trim() !== '') ? value.trim() : existingValue;
    }
    function keyOrExisting(value, existingValue) {
        if (value === '__EXISTING_KEY__') return existingValue || '';
        return (value && typeof value === 'string' && value.trim() !== '') ? value.trim() : '';
    }

    // Endpoint URLs must be http(s). Anything else (file:, gopher:, and the
    // like) is either useless to an OpenAI-compatible client or a way to
    // point the runtime at something it should not be opening.
    const ALLOWED_URL_SCHEMES = { 'http:': 1, 'https:': 1 };
    function badRequest(message) {
        const e = new Error(message);
        e.status = 400;
        return e;
    }
    function assertHttpUrl(value, label) {
        if (!value) return; // blank = unset / keep default
        let parsed;
        try {
            parsed = new URL(String(value));
        } catch (e) {
            throw badRequest(label + ' must be a valid URL');
        }
        if (!ALLOWED_URL_SCHEMES[parsed.protocol]) {
            throw badRequest(label + ' must use http:// or https://');
        }
    }

    // '__EXISTING_KEY__' means "keep the key you already have". Honouring it
    // while the endpoint URL is being changed in the SAME request turns the
    // settings form into a key-exfiltration primitive: point customBaseUrl at
    // an attacker host, keep the stored key, then hit /generate and the SDK
    // sends `Authorization: Bearer <stored key>` straight there — defeating
    // the masking that stops GET /settings from returning the key at all.
    // Changing the URL therefore requires re-entering the key.
    function rejectKeyReuseOnUrlChange(bodyKey, oldUrl, newUrl, label) {
        if (bodyKey !== '__EXISTING_KEY__') return;
        if ((oldUrl || '') === (newUrl || '')) return;
        throw badRequest('Re-enter the ' + label + ' API key when changing its Base URL ' +
            '(the stored key is never sent to a new endpoint without confirmation).');
    }

    RED.httpAdmin.post('/llm-plugin/settings', guard(PERM_WRITE), function(req, res) {
        try {
            const body = req.body || {};
            // Whitelist: only persist known settings fields
            const newSettings = {
                provider: body.provider || 'ollama'
            };
            const existing = getPluginSettings();
            newSettings.ollamaUrl = urlOrExisting(body.ollamaUrl, existing.ollamaUrl || 'http://localhost:11434');
            newSettings.customBaseUrl = urlOrExisting(body.customBaseUrl, existing.customBaseUrl || '');
            assertHttpUrl(newSettings.ollamaUrl, 'Ollama URL');
            assertHttpUrl(newSettings.customBaseUrl, 'Custom endpoint Base URL');
            rejectKeyReuseOnUrlChange(body.customApiKey, existing.customBaseUrl,
                newSettings.customBaseUrl, 'custom endpoint');
            newSettings.openaiApiKey = keyOrExisting(body.openaiApiKey, existing.openaiApiKey);
            newSettings.customApiKey = keyOrExisting(body.customApiKey, existing.customApiKey);
            // System prompt (user-authored, always save as-is)
            if (body.systemPrompt !== undefined && body.systemPrompt !== null) {
                newSettings.systemPrompt = String(body.systemPrompt);
            } else {
                newSettings.systemPrompt = existing.systemPrompt || '';
            }
            // Max prompt length (characters)
            if (body.maxPromptLength !== undefined && body.maxPromptLength !== null && body.maxPromptLength !== '') {
                const parsed = parseInt(body.maxPromptLength, 10);
                newSettings.maxPromptLength = (parsed >= 100 && parsed <= 100000) ? parsed : 10000;
            } else {
                newSettings.maxPromptLength = existing.maxPromptLength || 10000;
            }
            savePluginSettings(newSettings);
            res.status(200).send();
        } catch (error) {
            res.status(error && error.status === 400 ? 400 : 500)
               .json({ error: redactSecrets(error.message) });
        }
    });

    // --- Chat history endpoints ---
    RED.httpAdmin.get('/llm-plugin/chat-histories', guard(PERM_READ), function(req, res) {
        try {
            const chatHistories = loadAllChatHistories();
            res.json({ chatHistories: chatHistories });
        } catch (error) {
            res.status(500).json({ error: redactSecrets(error.message) });
        }
    });

    RED.httpAdmin.post('/llm-plugin/save-chat', guard(PERM_WRITE), function(req, res) {
        try {
            const { chatId, chatData } = req.body;
            if (!chatId || !chatData) {
                return res.status(400).json({ error: 'Chat ID and data required' });
            }
            assertStorableSize(chatData, 'Chat data');
            saveChatHistory(chatId, chatData);
            res.json({ success: true });
        } catch (error) {
            res.status(error && error.status === 400 ? 400 : 500)
               .json({ error: redactSecrets(error.message) });
        }
    });

    RED.httpAdmin.post('/llm-plugin/delete-chat', guard(PERM_WRITE), function(req, res) {
        try {
            const { chatId, filename } = req.body || {};

            if (!persistenceEnabled) {
                if (chatId) delete memChats[chatId];
                Object.keys(memCheckpoints).forEach(function(k) {
                    if (memCheckpoints[k] && memCheckpoints[k].chatId === chatId) delete memCheckpoints[k];
                });
                return res.json({ success: true });
            }

            if (!fs.existsSync(chatsDir)) return res.json({ success: true });

            function cleanupCheckpointsByChatId(targetChatId) {
                if (!targetChatId) return;
                try {
                    const cpFiles = fs.readdirSync(checkpointsDir).filter(file => file.endsWith('.json'));
                    cpFiles.forEach(file => {
                        const fp = path.join(checkpointsDir, file);
                        try {
                            const cp = JSON.parse(fs.readFileSync(fp, 'utf8'));
                            if (cp && cp.chatId === targetChatId) fs.unlinkSync(fp);
                        } catch (e) {
                            console.warn('[LLM Plugin] Failed to clean up checkpoint file:', file, e && e.message ? e.message : e);
                        }
                    });
                } catch (e) { /* ignore cleanup issues */ }
            }

            // If filename provided, only allow basename (no path traversal) and delete directly
            if (filename && typeof filename === 'string') {
                const safeName = path.basename(filename);
                const filepath = path.resolve(chatsDir, safeName);
                if (!filepath.startsWith(path.resolve(chatsDir) + path.sep)) {
                    return res.status(400).json({ error: 'Invalid filename' });
                }
                if (fs.existsSync(filepath)) {
                    let targetChatId = null;
                    try {
                        const content = fs.readFileSync(filepath, 'utf8');
                        const chatData = JSON.parse(content);
                        if (chatData && chatData.id) targetChatId = chatData.id;
                    } catch (e) { /* ignore parse issues */ }
                    fs.unlinkSync(filepath);
                    cleanupCheckpointsByChatId(targetChatId || chatId || null);
                    return res.json({ success: true });
                }
                // Already gone -> idempotent success
                cleanupCheckpointsByChatId(chatId || null);
                return res.json({ success: true });
            }

            // Fallback: match by chatId (legacy support)
            if (!chatId) return res.status(400).json({ error: 'Chat ID or filename required' });
            const chatFiles = fs.readdirSync(chatsDir).filter(file => file.endsWith('.json'));
            let deleted = false;
            chatFiles.forEach(file => {
                try {
                    const filepath = path.join(chatsDir, file);
                    const content = fs.readFileSync(filepath, 'utf8');
                    const chatData = JSON.parse(content);
                    if (chatData && chatData.id === chatId) {
                        fs.unlinkSync(filepath);
                        deleted = true;
                    }
                } catch (e) {
                    console.error('[LLM Plugin] Error checking/deleting chat file:', file, e);
                }
            });
            // Always respond success if nothing found to keep idempotency
            // Best-effort cleanup of checkpoints for this chat
            cleanupCheckpointsByChatId(chatId);
            return res.json({ success: deleted });
        } catch (error) {
            console.error('[LLM Plugin] Error deleting chat file:', error);
            return res.status(500).json({ error: redactSecrets(error.message) });
        }
    });

    // --- Checkpoint endpoints ---
    RED.httpAdmin.post('/llm-plugin/checkpoint/save', guard(PERM_WRITE), function(req, res) {
        try {
            const body = req.body || {};
            const chatId = body.chatId || null;
            const label = body.label || 'checkpoint';
            const flow = Array.isArray(body.flow) ? body.flow : [];
            const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

            if (flow.length === 0) {
                return res.status(400).json({ error: 'flow array is required' });
            }
            assertStorableSize(flow, 'Checkpoint flow');
            const cp = saveCheckpoint(chatId, clip(label, 200), flow, meta);
            return res.json({ checkpointId: cp.id, created: cp.created, label: cp.label });
        } catch (error) {
            return res.status(error && error.status === 400 ? 400 : 500)
                      .json({ error: redactSecrets(error.message || 'Failed to save checkpoint') });
        }
    });

    RED.httpAdmin.get('/llm-plugin/checkpoint/:id', guard(PERM_READ), function(req, res) {
        try {
            const id = path.basename(String(req.params.id || ''));
            if (!id || !/^cp_\d+_[a-z0-9]+$/.test(id)) {
                return res.status(400).json({ error: 'Invalid checkpoint id' });
            }
            if (!persistenceEnabled) {
                const cp = memCheckpoints[id];
                if (!cp) return res.status(404).json({ error: 'Checkpoint not found' });
                return res.json({ checkpoint: cp });
            }
            const fp = path.resolve(checkpointsDir, id + '.json');
            if (!fp.startsWith(path.resolve(checkpointsDir) + path.sep)) {
                return res.status(400).json({ error: 'Invalid checkpoint id' });
            }
            if (!fs.existsSync(fp)) {
                return res.status(404).json({ error: 'Checkpoint not found' });
            }
            const cp = JSON.parse(fs.readFileSync(fp, 'utf8'));
            return res.json({ checkpoint: cp });
        } catch (error) {
            return res.status(500).json({ error: redactSecrets(error.message || 'Failed to load checkpoint') });
        }
    });

    RED.httpAdmin.post('/llm-plugin/client-log', guard(PERM_WRITE), function(req, res) {
        try {
            const body = req.body || {};
            writeClientEvent(body.level, body.event, body.message, body.meta);
            return res.json({ ok: true });
        } catch (error) {
            return res.status(500).json({ ok: false, error: redactSecrets(error.message || 'Failed to write client log') });
        }
    });

    // Serve the bundled marked.js so Markdown rendering works offline (no
    // CDN). marked's exports map hides lib/, so resolve via package.json
    // and read the UMD build once (immutable per process). ui_core.js
    // falls back to escaped plain text if this 404s.
    let markedJsCache = null;
    RED.httpAdmin.get('/llm-plugin/vendor/marked.js', function(req, res) {
        try {
            if (markedJsCache === null) {
                const markedRoot = path.dirname(require.resolve('marked/package.json'));
                markedJsCache = fs.readFileSync(path.join(markedRoot, 'lib', 'marked.umd.js'), 'utf8');
            }
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.send(markedJsCache);
        } catch (error) {
            console.error('[LLM Plugin] Error serving marked.js:',
                error && error.message ? error.message : error);
            res.status(404).send('/* marked.js not available */');
        }
    });

    RED.httpAdmin.get('/llm-plugin_styles.css', function(req, res) {
        try {
            const cssPath = path.join(__dirname, '..', 'llm-plugin_styles.css');
            if (fs.existsSync(cssPath)) {
                res.setHeader('Content-Type', 'text/css; charset=utf-8');
                const cssContent = fs.readFileSync(cssPath, 'utf8');
                res.send(cssContent);
            } else {
                res.status(404).send('/* CSS file not found */');
            }
        } catch (error) {
            console.error('[LLM Plugin] Error serving CSS:', error);
            res.status(500).send('/* Error loading CSS */');
        }
    });

    RED.httpAdmin.get('/llm-plugin/src/*', function(req, res) {
        try {
            const relPathRaw = String((req.params && req.params[0]) || '');
            const normalized = path.normalize(relPathRaw).replace(/\\/g, '/');
            // Prevent path traversal / absolute paths
            if (!normalized || normalized.indexOf('..') !== -1 || normalized.startsWith('/')) {
                return res.status(400).send('Invalid file');
            }
            const filePath = path.join(__dirname, normalized);
            const srcRoot = path.join(__dirname);
            const relativePath = path.relative(srcRoot, filePath);
            if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                return res.status(400).send('Invalid file path');
            }
            // Allowlist the client asset types rather than serving whatever
            // happens to sit under src/. This route is deliberately
            // unauthenticated (script tags cannot send an auth header) and
            // only ever needs to hand out the browser modules.
            const CLIENT_ASSET_TYPES = {
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8'
            };
            const ext = path.extname(filePath).toLowerCase();
            if (!CLIENT_ASSET_TYPES[ext]) {
                return res.status(404).send('/* Not found */');
            }
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const contentType = CLIENT_ASSET_TYPES[ext];
                res.setHeader('Content-Type', contentType);
                const content = fs.readFileSync(filePath, 'utf8');
                res.send(content);
            } else {
                res.status(404).send('/* Not found */');
            }
        } catch (error) {
            console.error('[LLM Plugin] Error serving client file:', error);
            res.status(500).send('/* Error */');
        }
    });

    RED.log.info("[LLM Plugin] Server initialized successfully");
}
module.exports = { createLLMPluginServer };
