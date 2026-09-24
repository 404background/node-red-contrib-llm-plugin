// LLM Plugin  -  Server side: the HTTP admin endpoints, plus chat-history and
// checkpoint persistence. The LLM engine itself lives in ./llm_core.js, shared
// with the llm-request node. See docs/{en,jp}/architecture.md — `server.js`.
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const createLLMCore = require('./llm_core');
const createApplyQueue = require('./apply_queue_server');
const agentDispatch = require('./agent_dispatch');

function createLLMPluginServer(RED) {
    const core = createLLMCore(RED);

    // One queue for every editor, and the deploy that releases a hold is
    // observed here. See docs/{en,jp}/design.md §13.
    const applyQueue = createApplyQueue(RED);
    applyQueue.bindDeployListener();

    // Storage locations resolved once by the shared core.
    const chatsDir = core.chatsDir;
    const checkpointsDir = core.checkpointsDir;
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
    // `apiMaxLength` bounds one request body; the flow context lands in the
    // same system message as the prompt and needs its own bound.
    // See docs/{en,jp}/architecture.md — Security measures.
    const MAX_FLOW_CONTEXT_CHARS = 1024 * 1024;
    // Ceiling for anything persisted as a JSON file (chat, checkpoint).
    const MAX_STORED_JSON_CHARS = 5 * 1024 * 1024;
    // Per-field clip for a reported client event.
    const MAX_EVENT_FIELD_CHARS = 4096;
    // Checkpoints are pruned oldest-first past this count.
    const MAX_CHECKPOINT_FILES = 200;
    // Node-driven checkpoints get their own, smaller budget. They
    // accumulate unattended (a timer-driven Agent node), so they are the
    // ones that must not grow into the chat checkpoints' space.
    const MAX_NODE_CHECKPOINT_FILES = 50;
    // One definition of what a checkpoint file is named, shared by the
    // pruner and the listing so they can never disagree about it.
    const CHECKPOINT_FILE_RE = /^cp_(\d+)_[a-z0-9]+\.json$/i;
    // The id alone, as a route receives it. Nothing else can reach a path.
    const CHECKPOINT_ID_RE = /^cp_\d+_[a-z0-9]+$/;

    // RED.log takes ONE message, unlike console.error(a, b, c).
    function errText(e) {
        return String((e && e.message) ? e.message : e);
    }

    function clip(text, max) {
        const s = String(text === undefined || text === null ? '' : text);
        return s.length > max ? s.substring(0, max) + '[truncated]' : s;
    }

    // A deliberate refusal (`status` set where it was raised) keeps its code;
    // anything else is a 500. The message is redacted either way.
    function fail(res, error, fallback) {
        const status = (error && error.status >= 400 && error.status < 500) ? error.status : 500;
        return res.status(status).json({
            error: redactSecrets((error && error.message) || fallback || 'Request failed')
        });
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
    // `adminAuth` does not reach routes a plugin adds to RED.httpAdmin, so
    // every endpoint guards itself. See docs/{en,jp}/architecture.md.
    const PERM_READ = 'llm-plugin.read';
    const PERM_WRITE = 'llm-plugin.write';

    // No "runtime without RED.auth" branch: were it ever missing, this throws
    // while registering routes instead of leaving them reachable.
    function guard(permission) {
        return RED.auth.needsPermission(permission);
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

    // An import failure happens in the browser, where the operator cannot see
    // it; the Node-RED log is the record a user can attach to a bug report.
    // `meta` is redacted — importer diagnostics put node contents in it.
    function writeClientEvent(level, event, message, meta) {
        const lv = String(level || 'info').toLowerCase();
        if (lv !== 'error' && lv !== 'warn' && lv !== 'warning') return;

        // Newlines collapsed: this text is caller-supplied and goes into a
        // line-oriented log, where an embedded newline forges a log entry.
        const oneLine = (t) => String(t).replace(/[\r\n]+/g, ' ');
        const safeEvent = oneLine(clip(event || 'client-event', 200));
        const safeMessage = oneLine(redactSecrets(clip(message, MAX_EVENT_FIELD_CHARS)));
        const safeMeta = redactJson(meta && typeof meta === 'object' ? meta : {});

        let metaPreview = '';
        try {
            const text = JSON.stringify(safeMeta);
            if (text && text.length > 0) metaPreview = ' meta=' + text;
        } catch (e) { /* preview is optional */ }

        const line = `[LLM Plugin][Client][${safeEvent}] ${safeMessage}${metaPreview}`;
        if (lv === 'error') RED.log.error(line);
        else RED.log.warn(line);
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
            RED.log.error('[LLM Plugin] Error saving chat history: ' + errText(error));
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
                    // Written into older files; the id is the handle now.
                    if (chatData && typeof chatData === 'object') delete chatData.__file;
                    chatHistories[chatData.id] = chatData;
                } catch (error) {
                    RED.log.error('[LLM Plugin] Error reading chat file ' + file + ': ' + errText(error));
                }
            });
            return chatHistories;
        } catch (error) {
            RED.log.error('[LLM Plugin] Error loading chat histories: ' + errText(error));
            return {};
        }
    }

    // Every file holding this chat: saveChatHistory names them by the
    // sanitised id, but the id inside is what identifies a file an older
    // build named differently.
    function deleteChatHistory(chatId) {
        const safeChatId = sanitizeChatId(chatId);
        if (!persistenceEnabled) {
            delete memChats[safeChatId];
            return;
        }
        if (!fs.existsSync(chatsDir)) return;
        fs.readdirSync(chatsDir).filter(file => file.endsWith('.json')).forEach(file => {
            const filepath = path.join(chatsDir, file);
            try {
                let match = file.endsWith(`-${safeChatId}.json`);
                if (!match) {
                    const chatData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
                    match = !!chatData && chatData.id === chatId;
                }
                if (match) fs.unlinkSync(filepath);
            } catch (e) {
                RED.log.warn('[LLM Plugin] Could not check chat file ' + file + ': ' + errText(e));
            }
        });
    }

    function deleteCheckpointsOfChat(chatId) {
        if (!persistenceEnabled) {
            Object.keys(memCheckpoints).forEach(function(k) {
                if (memCheckpoints[k].chatId === chatId) delete memCheckpoints[k];
            });
            return;
        }
        if (!fs.existsSync(checkpointsDir)) return;
        fs.readdirSync(checkpointsDir).filter(file => CHECKPOINT_FILE_RE.test(file)).forEach(file => {
            const head = readCheckpointHeader(file);
            if (!head || head.chatId !== chatId) return;
            try { fs.unlinkSync(path.join(checkpointsDir, file)); }
            catch (e) { RED.log.warn('[LLM Plugin] Failed to remove checkpoint ' + file + ': ' + errText(e)); }
        });
    }

    // Prune oldest-first: an automated Agent loop must not grow the
    // directory without bound. The `flow` is the bulk of a file, so the
    // listing reads only enough to classify it.
    function checkpointHeader(cp) {
        return {
            id: cp.id, chatId: cp.chatId || null, label: cp.label,
            created: cp.created, meta: cp.meta || {},
            nodes: Array.isArray(cp.flow) ? cp.flow.length : 0
        };
    }

    function readCheckpointHeader(file) {
        try {
            return checkpointHeader(JSON.parse(fs.readFileSync(path.join(checkpointsDir, file), 'utf8')));
        } catch (e) { return null; }
    }

    // Oldest-first, but per SOURCE rather than across the whole directory, so
    // a busy node can only crowd out itself. See docs/{en,jp}/design.md §9.
    function pruneCheckpoints() {
        try {
            const buckets = {};
            fs.readdirSync(checkpointsDir)
                .map((name) => CHECKPOINT_FILE_RE.exec(name))
                .filter(Boolean)
                .map((m) => ({ file: m[0], ts: parseInt(m[1], 10) }))
                .sort((a, b) => a.ts - b.ts)
                .forEach((e) => {
                    // Classified by source, falling back to "chat": an
                    // unreadable or older checkpoint gets the protected
                    // budget rather than the disposable one.
                    const head = readCheckpointHeader(e.file);
                    const src = (head && head.meta && head.meta.source === 'node-apply')
                        ? 'node' : 'chat';
                    (buckets[src] = buckets[src] || []).push(e);
                });
            Object.keys(buckets).forEach((src) => {
                const list = buckets[src];
                const cap = (src === 'node') ? MAX_NODE_CHECKPOINT_FILES : MAX_CHECKPOINT_FILES;
                if (list.length <= cap) return;
                list.slice(0, list.length - cap).forEach((e) => {
                    try { fs.unlinkSync(path.join(checkpointsDir, e.file)); } catch (err) { /* best effort */ }
                });
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
            // Prune AFTER the write, so the cap means what it says.
            // See docs/{en,jp}/design.md §9.
            writeFileAtomic(path.join(checkpointsDir, checkpointId + '.json'), JSON.stringify(record, null, 2));
            pruneCheckpoints();
        } catch (e) {
            RED.log.error('[LLM Plugin] Failed to save checkpoint: ' + errText(e));
            throw e;
        }
        return record;
    }

    // ------------------------------------------------------------------ //
    //  HTTP admin endpoints                                               //
    // ------------------------------------------------------------------ //

    // One generation endpoint for both sidebar modes, but not one prompt:
    // `mode: 'ask'` reads the flow and explains it, anything else builds one.
    // The mode has to be decided HERE because it chooses the instructions the
    // model is given; what stays client-side is only what happens to a reply
    // once it arrives.
    //
    // Bounded like the node (core.DEFAULT_TIMEOUT_MS), and abandoned when the
    // sidebar goes away: its Stop button only closes the connection.
    RED.httpAdmin.post('/llm-plugin/generate', guard(PERM_WRITE), async function(req, res) {
        const { model, prompt, currentFlow, activeWorkspaceId, mode } = req.body;
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

        const enhancedMessages = buildMessages(prompt, currentFlow, activeWorkspaceId, settings,
            { mode: (mode === 'ask') ? 'ask' : 'agent' });
        const genStart = Date.now();
        const abort = new AbortController();
        res.on('close', function() { if (!res.writableFinished) abort.abort(); });

        try {
            const response = await generateWithProvider(provider, settings, model, enhancedMessages,
                { timeoutMs: core.DEFAULT_TIMEOUT_MS, signal: abort.signal });
            res.json({ response: response, elapsed: Date.now() - genStart, model: model });
        } catch (error) {
            if (abort.signal.aborted) return;      // nobody is left to answer
            // Log only safe fields  -  never log the full error object which may contain sensitive headers
            const safeErrorText = redactSecrets(error && error.message ? error.message : error);
            RED.log.error('[LLM Plugin] Generation error: ' + safeErrorText);
            let errorMessage = 'Generation failed';
            const providerLabel = provider === 'ollama'
                ? 'Ollama'
                : (provider === 'custom' ? 'the custom OpenAI-compatible endpoint' : 'the LLM provider');
            const code = error && error.code;
            if (code === 'ECONNREFUSED') {
                errorMessage = 'Could not connect to ' + providerLabel + '. Please ensure it is running and accessible.';
            } else if (code === 'ECONNRESET') {
                errorMessage = 'The connection to ' + providerLabel + ' was unexpectedly closed. Please check that the server is running and stable.';
            } else if (code === 'ETIMEDOUT' || (error && error.message && error.message.includes('timeout'))) {
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

    // The form shows URLs and keys as placeholders, so blank means "keep"
    // for a URL, and '__EXISTING_KEY__' means "keep" for a key.
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

    // Keeping a stored key while the URL changes in the same request would
    // send that key to a new endpoint the user never typed it for.
    // See docs/{en,jp}/architecture.md — Security measures.
    function rejectKeyReuseOnUrlChange(bodyKey, oldUrl, newUrl, label) {
        if (bodyKey !== '__EXISTING_KEY__') return;
        if ((oldUrl || '') === (newUrl || '')) return;
        throw badRequest('Re-enter the ' + label + ' API key when changing its Base URL ' +
            '(the stored key is never sent to a new endpoint without confirmation).');
    }

    const PROVIDERS = { ollama: 1, openai: 1, custom: 1 };

    RED.httpAdmin.post('/llm-plugin/settings', guard(PERM_WRITE), async function(req, res) {
        try {
            const body = req.body || {};
            const provider = body.provider || 'ollama';
            if (!PROVIDERS[provider]) throw badRequest('Unknown provider: ' + clip(provider, 40));
            // Whitelist: only persist known settings fields
            const newSettings = { provider: provider };
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
            // Awaited: RED.settings.set is asynchronous, so answering 200
            // before it resolves reports a save the user may not actually have.
            await savePluginSettings(newSettings);
            res.status(200).send();
        } catch (error) {
            fail(res, error);
        }
    });

    // --- Chat history endpoints ---
    RED.httpAdmin.get('/llm-plugin/chats', guard(PERM_READ), function(req, res) {
        try {
            res.json({ chatHistories: loadAllChatHistories() });
        } catch (error) {
            fail(res, error);
        }
    });

    RED.httpAdmin.post('/llm-plugin/chats/save', guard(PERM_WRITE), function(req, res) {
        try {
            const { chatId, chatData } = req.body || {};
            if (!chatId || !chatData) {
                return res.status(400).json({ error: 'Chat ID and data required' });
            }
            assertStorableSize(chatData, 'Chat data');
            saveChatHistory(chatId, chatData);
            res.json({ success: true });
        } catch (error) {
            fail(res, error);
        }
    });

    // Idempotent: a chat that is already gone is a success. Its checkpoints
    // go with it.
    RED.httpAdmin.post('/llm-plugin/chats/delete', guard(PERM_WRITE), function(req, res) {
        try {
            const chatId = (req.body || {}).chatId;
            if (!chatId || typeof chatId !== 'string') {
                return res.status(400).json({ error: 'Chat ID required' });
            }
            deleteChatHistory(chatId);
            deleteCheckpointsOfChat(chatId);
            return res.json({ success: true });
        } catch (error) {
            RED.log.error('[LLM Plugin] Error deleting chat: ' + errText(error));
            return fail(res, error);
        }
    });

    // --- Checkpoint endpoints ---
    RED.httpAdmin.post('/llm-plugin/checkpoints/save', guard(PERM_WRITE), function(req, res) {
        try {
            const body = req.body || {};
            const flow = Array.isArray(body.flow) ? body.flow : [];
            const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};
            if (flow.length === 0) {
                return res.status(400).json({ error: 'flow array is required' });
            }
            // The whole record, not just the flow: `meta` is caller-supplied too.
            assertStorableSize({ flow: flow, meta: meta }, 'Checkpoint');
            const chatId = body.chatId ? clip(body.chatId, 200) : null;
            const cp = saveCheckpoint(chatId, clip(body.label || 'checkpoint', 200), flow, meta);
            return res.json({ checkpointId: cp.id, created: cp.created, label: cp.label });
        } catch (error) {
            return fail(res, error, 'Failed to save checkpoint');
        }
    });

    // Checkpoint headers (no flow bodies), newest first; `?source=node-apply`
    // narrows to node checkpoints. See docs/{en,jp}/design.md §9.
    RED.httpAdmin.get('/llm-plugin/checkpoints', guard(PERM_READ), function(req, res) {
        try {
            const wanted = req.query && req.query.source ? String(req.query.source) : null;
            let heads;
            if (!persistenceEnabled) {
                heads = Object.keys(memCheckpoints).map(function(k) {
                    return checkpointHeader(memCheckpoints[k]);
                });
            } else {
                heads = fs.readdirSync(checkpointsDir)
                    .filter(function(name) { return CHECKPOINT_FILE_RE.test(name); })
                    .map(readCheckpointHeader)
                    .filter(Boolean);
            }
            if (wanted) {
                heads = heads.filter(function(h) { return h.meta && h.meta.source === wanted; });
            }
            heads.sort(function(a, b) {
                return String(b.created || "").localeCompare(String(a.created || ""));
            });
            return res.json({ checkpoints: heads });
        } catch (error) {
            return fail(res, error, 'Failed to list checkpoints');
        }
    });

    RED.httpAdmin.get('/llm-plugin/checkpoints/:id', guard(PERM_READ), function(req, res) {
        try {
            const id = String(req.params.id || '');
            if (!CHECKPOINT_ID_RE.test(id)) {
                return res.status(400).json({ error: 'Invalid checkpoint id' });
            }
            if (!persistenceEnabled) {
                const cp = memCheckpoints[id];
                if (!cp) return res.status(404).json({ error: 'Checkpoint not found' });
                return res.json({ checkpoint: cp });
            }
            const fp = path.join(checkpointsDir, id + '.json');
            if (!fs.existsSync(fp)) {
                return res.status(404).json({ error: 'Checkpoint not found' });
            }
            return res.json({ checkpoint: JSON.parse(fs.readFileSync(fp, 'utf8')) });
        } catch (error) {
            return fail(res, error, 'Failed to load checkpoint');
        }
    });

    // ------------------------------------------------------------------ //
    //  Apply queue                                                        //
    // ------------------------------------------------------------------ //
    // Ordering only; the apply itself runs in the browser.
    // See docs/{en,jp}/design.md §13.

    RED.httpAdmin.get('/llm-plugin/apply-queue', guard(PERM_READ), function(req, res) {
        try {
            return res.json(applyQueue.state());
        } catch (error) {
            return fail(res, error, 'Failed to read the apply queue');
        }
    });

    // PERM_WRITE throughout: taking a turn is a claim on the flows, even
    // though the write itself happens in the browser.
    const queueActions = {
        request: function(body) {
            return applyQueue.request({
                clientId: body.clientId,
                source: body.source,
                label: body.label,
                targetFlowIds: body.targetFlowIds,
                undo: body.undo
            });
        },
        complete: function(body) { return applyQueue.complete(String(body.entryId || ''), !!body.ok); },
        cancel: function(body) { return applyQueue.cancel(String(body.entryId || '')); },
        release: function() { return applyQueue.releaseHold(); }
    };
    Object.keys(queueActions).forEach(function(action) {
        RED.httpAdmin.post('/llm-plugin/apply-queue/' + action, guard(PERM_WRITE), function(req, res) {
            try {
                const out = queueActions[action](req.body || {});
                return res.status(out.ok === false ? 404 : 200).json(out);
            } catch (error) {
                return fail(res, error, 'Apply queue ' + action + ' failed');
            }
        });
    });

    // An Agent-node reply is published to every editor; the first one to
    // claim it applies it, the rest drop it. PERM_WRITE, so an editor that
    // could not deploy the edit never makes it. See docs/{en,jp}/llm-request.md.
    RED.httpAdmin.post('/llm-plugin/agent-apply/claim', guard(PERM_WRITE), function(req, res) {
        try {
            return res.json({ granted: agentDispatch.claim(String((req.body || {}).dispatchId || '')) });
        } catch (error) {
            return fail(res, error);
        }
    });

    RED.httpAdmin.post('/llm-plugin/client-log', guard(PERM_WRITE), function(req, res) {
        try {
            const body = req.body || {};
            writeClientEvent(body.level, body.event, body.message, body.meta);
            return res.json({ ok: true });
        } catch (error) {
            return fail(res, error, 'Failed to write client log');
        }
    });

    // ------------------------------------------------------------------ //
    //  Static client files                                                //
    // ------------------------------------------------------------------ //
    // Unauthenticated by necessity (script and link tags send no auth
    // header), so each route serves a fixed list and nothing else.

    function serveFile(res, filePath, contentType) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            res.setHeader('Content-Type', contentType);
            res.send(content);
        } catch (error) {
            RED.log.error('[LLM Plugin] Error serving ' + path.basename(filePath) + ': ' + errText(error));
            res.status(404).send('/* Not found */');
        }
    }

    // The bundled marked.js, so Markdown rendering works offline. Its
    // exports map hides lib/, hence resolving through package.json.
    RED.httpAdmin.get('/llm-plugin/vendor/marked.js', function(req, res) {
        let markedPath;
        try {
            markedPath = path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js');
        } catch (error) {
            return res.status(404).send('/* marked.js not available */');
        }
        serveFile(res, markedPath, 'application/javascript; charset=utf-8');
    });

    RED.httpAdmin.get('/llm-plugin/styles.css', function(req, res) {
        serveFile(res, path.join(__dirname, '..', 'llm-plugin_styles.css'), 'text/css; charset=utf-8');
    });

    // Exactly what client.js loads — never the server-side modules beside
    // them. test/http_transport.test.js keeps the two lists equal.
    const CLIENT_FILES = [
        'client.js',
        'common.js',
        'core/canvas_layout.js',
        'core/flow_converter_core.js',
        'core/llm_json_parser.js',
        'apply_queue.js',
        'chat_manager.js',
        'importer.js',
        'ui_core.js',
        'vibe_ui.js',
        'agent_apply.js'
    ];
    CLIENT_FILES.forEach(function(file) {
        RED.httpAdmin.get('/llm-plugin/src/' + file, function(req, res) {
            serveFile(res, path.join(__dirname, file), 'application/javascript; charset=utf-8');
        });
    });

    RED.log.info("[LLM Plugin] Server initialized successfully");
}
module.exports = { createLLMPluginServer };
