// LLM Plugin — Server Side
// Registers all HTTP admin endpoints used by the client sidebar.
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { OpenAI } = require('openai');
const Configurator = require('./core/flow_converter_core');
const LLMJsonParser = require('./core/llm_json_parser');

// Load system prompt template once at startup
const SYSTEM_PROMPT_TEMPLATE = fs.readFileSync(
    path.join(__dirname, 'prompt_system.txt'), 'utf8'
);

function createLLMPluginServer(RED) {
    const logsDir = path.join(__dirname, '..', '.logs', 'llm-plugin');
    const checkpointsDir = path.join(logsDir, 'checkpoints');
    const clientEventsLog = path.join(logsDir, 'client-events.log');
    fs.ensureDirSync(logsDir);
    fs.ensureDirSync(checkpointsDir);

    function writeClientEvent(level, event, message, meta) {
        const lv = String(level || 'info').toLowerCase();
        const safeLevel = (lv === 'error' || lv === 'warn' || lv === 'warning') ? lv : 'info';
        const payload = {
            ts: new Date().toISOString(),
            level: safeLevel,
            event: String(event || 'client-event'),
            message: redactSecrets(message || ''),
            meta: meta && typeof meta === 'object' ? meta : {}
        };

        try {
            fs.appendFile(clientEventsLog, JSON.stringify(payload) + '\n', 'utf8', (err) => {
                if (err) {
                    // silently ignore log write errors
                }
            });
        } catch (e) {
            // ignore log file errors to avoid breaking user flow
        }

        const metaPreview = (() => {
            try {
                const text = JSON.stringify(payload.meta);
                return text && text.length > 0 ? ' meta=' + redactSecrets(text) : '';
            } catch (e) {
                return '';
            }
        })();

        const line = `[LLM Plugin][Client][${payload.event}] ${payload.message}${metaPreview}`;
        if (safeLevel === 'error') RED.log.error(line);
        else if (safeLevel === 'warn' || safeLevel === 'warning') RED.log.warn(line);
        else RED.log.info(line);
    }

    // ------------------------------------------------------------------ //
    //  Settings persistence                                               //
    // ------------------------------------------------------------------ //

    function getPluginSettings() {
        return RED.settings.get('llmPluginSettings') || {};
    }

    // Save settings to RED.settings
    function savePluginSettings(settings) {
        RED.settings.set('llmPluginSettings', settings);
    }

    // Mask API key for safe client-side display (never expose full key)
    function maskApiKey(key) {
        if (!key || key.length < 8) return '';
        return key.substring(0, 5) + '...' + key.substring(key.length - 4);
    }

    function redactSecrets(input) {
        let text = String(input || '');
        text = text.replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***REDACTED***');
        text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***REDACTED***');
        text = text.replace(/("openaiApiKey"\s*:\s*")([^"]+)(")/gi, '$1***REDACTED***$3');
        text = text.replace(/https?:\/\/[^\s'"`]+/gi, '***URL_REDACTED***');
        text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '***IP_REDACTED***');
        return text;
    }

    // ------------------------------------------------------------------ //
    //  Ollama model discovery                                             //
    // ------------------------------------------------------------------ //

    function listOllamaModels() {
        const settings = getPluginSettings();
        const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
        
        // If localhost, try CLI first as it's more reliable for local installs
        if (ollamaUrl.includes('localhost') || ollamaUrl.includes('127.0.0.1')) {
            return new Promise((resolve) => {
                exec('ollama list --format json', { timeout: 5000 }, (error, stdout) => {
                    if (!error && stdout) {
                        const models = [];
                        stdout.split(/\r?\n/).forEach(line => {
                            const trimmed = line.trim();
                            if (!trimmed) return;
                            try {
                                const parsed = JSON.parse(trimmed);
                                const name = parsed.name || parsed.model || '';
                                if (name) models.push(name);
                            } catch (e) {}
                        });
                        return resolve(Array.from(new Set(models)));
                    }
                    // Fallback to API if CLI fails
                    listOllamaModelsFromApi(ollamaUrl).then(resolve);
                });
            });
        } else {
            return listOllamaModelsFromApi(ollamaUrl);
        }
    }

    function listOllamaModelsFromApi(baseUrl) {
        return new Promise((resolve) => {
            try {
                let base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
                const url = new URL(base + '/api/tags');
                const httpModule = url.protocol === 'https:' ? https : http;
                const req = httpModule.request(url.toString(), { method: 'GET', timeout: 5000 }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode && res.statusCode >= 400) {
                            return resolve([]);
                        }
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed && parsed.models) {
                                resolve(parsed.models.map(m => m.name));
                            } else {
                                resolve([]);
                            }
                        } catch (e) { resolve([]); }
                    });
                });
                req.on('error', () => resolve([]));
                req.on('timeout', () => { req.destroy(); resolve([]); });
                req.end();
            } catch (e) { resolve([]); }
        });
    }

    // ------------------------------------------------------------------ //
    //  Chat history persistence                                           //
    // ------------------------------------------------------------------ //

    function saveChatHistory(chatId, chatData) {
        try {
            const date = new Date().toISOString().split('T')[0];
            const rawTitle = (chatData.title && typeof chatData.title === 'string') ? chatData.title : 'untitled';
            const sanitizedTitle = rawTitle.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 50);
            const filename = `${date}-${sanitizedTitle}-${chatId}.json`;
            const filepath = path.join(logsDir, 'chats', filename);
            fs.ensureDirSync(path.dirname(filepath));
            writeFileAtomic(filepath, JSON.stringify(chatData, null, 2));
        } catch (error) {
            console.error("[LLM Plugin] Error saving chat history:", error);
        }
    }

    // Utility function to load all chat histories
    function loadAllChatHistories() {
        try {
            const chatsDir = path.join(logsDir, 'chats');
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
        const tabIds = Object.keys(byTab);

        // Single-flow case: keep the original single-schema output for prompt
        // continuity (existing prompt template references "CURRENT FLOW").
        if (tabIds.length <= 1) {
            return {
                header: 'CURRENT FLOW (Vibe Schema):',
                body: JSON.stringify(Configurator.toIntermediate(nodes), null, 2)
            };
        }

        // Multi-flow case: emit ONE flat Vibe Schema where every canvas node
        // carries a `flow` field naming its home flow (tab label). Aliases
        // come from a single toIntermediate pass so they are globally unique
        // across all flows, preventing cross-flow alias collisions that
        // caused the importer to overwrite nodes in the wrong tab.
        // Config nodes are collected once (referenced by any flow) and
        // emitted without a `flow` field since they live outside canvases.
        const allCanvas = [];
        const neededConfigs = {};
        for (const z of tabIds) {
            for (const n of byTab[z]) allCanvas.push(n);
            const refs = collectReferencedConfigsServer(byTab[z], configById);
            for (const cn of refs) if (cn && cn.id) neededConfigs[cn.id] = cn;
        }
        const allNodes = allCanvas.concat(Object.values(neededConfigs));
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

        let header = 'CURRENT FLOWS (Vibe Schema — each canvas node has a "flow" field naming its home flow tab). Aliases are globally unique across all flows; do not rename existing aliases.';
        header += '\nFLOWS: ' + flowNames.map(n => JSON.stringify(n)).join(', ');
        if (activeLabel) header += '\nACTIVE FLOW: ' + JSON.stringify(activeLabel);
        header += '\nAll listed flows are editable. When adding a new node, set its "flow" field to one of the FLOWS names to choose its target flow.';

        return {
            header: header,
            body: JSON.stringify(inter, null, 2)
        };
    }

    function collectReferencedConfigsServer(flowNodes, configById) {
        if (!configById || Object.keys(configById).length === 0) return [];
        const collected = {};
        const queue = flowNodes.slice();
        while (queue.length > 0) {
            const cur = queue.shift();
            if (!cur) continue;
            for (const key of Object.keys(cur)) {
                const v = cur[key];
                if (typeof v !== 'string') continue;
                const cn = configById[v];
                if (cn && !collected[cn.id]) {
                    collected[cn.id] = cn;
                    queue.push(cn);
                }
            }
        }
        return Object.values(collected);
    }

    // Build the system prompt.
    // Instructs the LLM to output Vibe Schema (intermediate JSON) instead of
    // raw Node-RED JSON, which avoids the need for random IDs and coordinates.
    function normalizeApplyMode(v) {
        const m = String(v || '').trim().toLowerCase();
        if (m === 'edit-only' || m === 'merge' || m === 'overwrite' || m === 'delete-only' || m === 'auto') return m;
        return null;
    }

    function detectApplyModeFromResponse(text) {
        const payload = parseFlowPayloadFromText(text);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const fromPayload = normalizeApplyMode(payload.applyMode || payload.mode || payload.strategy);
            if (fromPayload) return fromPayload;
        }
        const marker = String(text || '').match(/APPLY[_\s-]*MODE\s*[:=]\s*(edit-only|merge|overwrite|delete-only|auto)/i);
        return marker && marker[1] ? (normalizeApplyMode(marker[1]) || 'auto') : 'auto';
    }

    function buildMessages(userPrompt, flowContext, activeWorkspaceId) {
        const settings = getPluginSettings();
        const userSystemPrompt = (settings.systemPrompt !== undefined && settings.systemPrompt !== null)
            ? String(settings.systemPrompt).trim()
            : '';

        let system = '';
        if (userSystemPrompt) {
            system += userSystemPrompt + '\n\n';
        }
        system += SYSTEM_PROMPT_TEMPLATE + "\n";

        system += 'APPLY MODE: auto\n';
        system += '- Strategy: choose one of edit-only / merge / overwrite / delete-only yourself based on user intent.\n';
        system += '- Include your choice as top-level JSON field: "applyMode".\n\n';

        if (flowContext) {
            const ctx = buildFlowContextDescription(flowContext, activeWorkspaceId);
            system += ctx.header + "\n";
            system += ctx.body + "\n\n";
        }

        return [
            { role: 'system', content: system },
            { role: 'user', content: String(userPrompt || '') }
        ];
    }

    function generateWithProvider(provider, settings, model, messages) {
        if (provider === 'openai') {
            if (!settings.openaiApiKey) {
                return Promise.reject(new Error('OpenAI API key is not configured. Please set it in LLM Plugin settings.'));
            }
            return generateWithOpenAI(settings.openaiApiKey, model, messages);
        }
        return generateWithOllamaChat(model, messages);
    }

    // ------------------------------------------------------------------ //
    //  Agent-mode validation helpers                                      //
    // ------------------------------------------------------------------ //

    function parseFlowPayloadFromText(text) {
        const candidates = [];
        const codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        let m;
        while ((m = codeBlockRegex.exec(String(text || ''))) !== null) {
            candidates.push(m[1].trim());
        }
        if (candidates.length === 0) {
            candidates.push(String(text || '').trim());
        }

        for (let i = candidates.length - 1; i >= 0; i--) {
            const cleaned = LLMJsonParser.stripJsonComments(candidates[i]).trim();
            try {
                return JSON.parse(cleaned);
            } catch (e1) {
                try {
                    return JSON.parse(LLMJsonParser.repairJsonQuotes(cleaned));
                } catch (e2) { /* keep trying */ }
            }
        }
        return null;
    }

    function isExplanationOnlyRequest(userPrompt) {
        const text = String(userPrompt || '').trim();
        if (!text) return false;

        const explainRe = /(explain|explanation|describe|summary|review|analy[sz]e|walk\s*through)/i;
        const changeRe = /(create|generate|build|add|modify|update|edit|fix|implement|convert|refactor)/i;

        return explainRe.test(text) && !changeRe.test(text);
    }

    function writeFileAtomic(filepath, content) {
        const tmpPath = filepath + '.tmp';
        fs.writeFileSync(tmpPath, content);
        fs.renameSync(tmpPath, filepath);
    }

    function saveCheckpoint(chatId, label, flow, meta) {
        const checkpointId = 'cp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
        const record = {
            id: checkpointId,
            chatId: chatId || null,
            label: label || 'checkpoint',
            created: new Date().toISOString(),
            meta: meta || {},
            flow: Array.isArray(flow) ? flow : []
        };
        try {
            writeFileAtomic(path.join(checkpointsDir, checkpointId + '.json'), JSON.stringify(record, null, 2));
        } catch (e) {
            console.error('[LLM Plugin] Failed to save checkpoint:', e && e.message ? e.message : e);
            throw e;
        }
        return record;
    }

    // ------------------------------------------------------------------ //
    //  LLM provider adapters                                              //
    // ------------------------------------------------------------------ //

    // Ollama chat generation (timeout 0 = wait indefinitely)
    function generateWithOllamaChat(model, messages, timeout = 0) {
        const settings = getPluginSettings();
        const ollamaUrlStr = settings.ollamaUrl || 'http://localhost:11434';
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
                    'Content-Type': 'application/json',
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
                    const responseData = Buffer.concat(chunks).toString();
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
                        } else if (response && typeof response.response === 'string') {
                            // Compatibility fallback for mixed server versions.
                            resolve(response.response);
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
                    reject(new Error('Request timed out'));
                });
            }
            req.write(data);
            req.end();
        });
    }

    // OpenAI generation
    async function generateWithOpenAI(apiKey, model, messages) {
        const openai = new OpenAI({ apiKey });
        const completion = await openai.chat.completions.create({
            messages: Array.isArray(messages) ? messages : [],
            model: model,
        });
        return completion.choices[0].message.content;
    }


    // ------------------------------------------------------------------ //
    //  HTTP admin endpoints                                               //
    // ------------------------------------------------------------------ //

    RED.httpAdmin.post('/llm-plugin/generate', async function(req, res) {
        const { model, prompt, currentFlow, activeWorkspaceId } = req.body;
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }

        const settings = getPluginSettings();
        const maxLen = parseInt(settings.maxPromptLength, 10) || 10000;
        if (String(prompt).length > maxLen) {
            return res.status(400).json({ error: 'Prompt exceeds maximum length (' + maxLen + ' characters)' });
        }
        const provider = settings.provider || 'ollama';

        const enhancedMessages = buildMessages(prompt, currentFlow, activeWorkspaceId);
        const genStart = Date.now();

        try {
            const response = await generateWithProvider(provider, settings, model, enhancedMessages);
            res.json({ response: response, elapsed: Date.now() - genStart, model: model, applyMode: detectApplyModeFromResponse(response) });
        } catch (error) {
            // Log only safe fields — never log the full error object which may contain sensitive headers
            const safeErrorText = redactSecrets(error && error.message ? error.message : error);
            console.error("[LLM Plugin] Generation error:", safeErrorText);
            let errorMessage = 'Generation failed';
            if (error.code === 'ECONNREFUSED') {
                errorMessage = 'Could not connect to Ollama. Please ensure Ollama is running and accessible.';
            } else if (error.code === 'ECONNRESET') {
                errorMessage = 'The connection to the LLM provider was unexpectedly closed. Please check if the Ollama server is running and stable.';
            } else if (error.message && error.message.includes('timeout')) {
                errorMessage = 'Request timed out. The model may be too slow or not responding.';
            } else {
                errorMessage = redactSecrets(error && error.message ? error.message : error);
            }
            res.status(500).json({ error: errorMessage });
        }
    });

    RED.httpAdmin.post('/llm-plugin/agent-generate', async function(req, res) {
        const { model, prompt, currentFlow, activeWorkspaceId } = req.body || {};

        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }

        const settings = getPluginSettings();
        const maxLen = parseInt(settings.maxPromptLength, 10) || 10000;
        if (String(prompt).length > maxLen) {
            return res.status(400).json({ error: 'Prompt exceeds maximum length (' + maxLen + ' characters)' });
        }
        const provider = settings.provider || 'ollama';

        try {
            const enhancedMessages = buildMessages(prompt, currentFlow, activeWorkspaceId);
            const totalStart = Date.now();

            if (isExplanationOnlyRequest(prompt)) {
                const response = await generateWithProvider(provider, settings, model, enhancedMessages);
                return res.json({
                    response,
                    elapsed: Date.now() - totalStart,
                    model: model,
                    applyMode: detectApplyModeFromResponse(response),
                    agent: {
                        mode: 'agent',
                        performed: 1,
                        singlePass: true,
                        reason: 'explanation-only'
                    }
                });
            }

            const response = await generateWithProvider(provider, settings, model, enhancedMessages);

            return res.json({
                response,
                elapsed: Date.now() - totalStart,
                model: model,
                applyMode: detectApplyModeFromResponse(response),
                agent: {
                    mode: 'agent',
                    performed: 1,
                    singlePass: true
                }
            });
        } catch (error) {
            const safeErrorText = redactSecrets(error && error.message ? error.message : error);
            console.error('[LLM Plugin] Agent generation error:', safeErrorText);
            return res.status(500).json({ error: redactSecrets(error && error.message ? error.message : 'Agent generation failed') });
        }
    });

    // --- Settings endpoints ---
    RED.httpAdmin.get('/llm-plugin/settings', function(req, res) {
        const settings = Object.assign({}, getPluginSettings());
        // Never expose the full API key to the client
        const hasKey = !!(settings.openaiApiKey && settings.openaiApiKey.length > 0);
        settings.openaiApiKeyMasked = hasKey ? maskApiKey(settings.openaiApiKey) : '';
        settings.ollamaUrlMasked = settings.ollamaUrl ? 'configured (hidden)' : '';
        delete settings.openaiApiKey;
        delete settings.ollamaUrl;
        // systemPrompt is safe to send to client (user-authored content)
        res.json(settings);
    });

    RED.httpAdmin.post('/llm-plugin/settings', function(req, res) {
        try {
            const body = req.body || {};
            // Whitelist: only persist known settings fields
            const newSettings = {
                provider: body.provider || 'ollama'
            };
            const existing = getPluginSettings();
            // If URL field is empty, preserve existing URL.
            if (body.ollamaUrl && typeof body.ollamaUrl === 'string' && body.ollamaUrl.trim() !== '') {
                newSettings.ollamaUrl = body.ollamaUrl.trim();
            } else {
                newSettings.ollamaUrl = existing.ollamaUrl || 'http://localhost:11434';
            }
            // If API key field is empty, preserve the existing key (user didn't change it)
            if (body.openaiApiKey && typeof body.openaiApiKey === 'string' && body.openaiApiKey.trim() !== '') {
                newSettings.openaiApiKey = body.openaiApiKey.trim();
            } else {
                newSettings.openaiApiKey = existing.openaiApiKey || '';
            }
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
            res.status(500).json({ error: redactSecrets(error.message) });
        }
    });

    // --- Model list ---
    RED.httpAdmin.get('/llm-plugin/ollama/models', async function(req, res) {
        try {
            const models = await listOllamaModels();
            res.json({ models });
        } catch (error) {
            console.error('[LLM Plugin] Error fetching Ollama models:', redactSecrets(error && error.message ? error.message : error));
            res.status(500).json({ error: 'Failed to list Ollama models' });
        }
    });


    // --- Chat history endpoints ---
    RED.httpAdmin.get('/llm-plugin/chat-histories', function(req, res) {
        try {
            const chatHistories = loadAllChatHistories();
            res.json({ chatHistories: chatHistories });
        } catch (error) {
            res.status(500).json({ error: redactSecrets(error.message) });
        }
    });

    RED.httpAdmin.post('/llm-plugin/save-chat', function(req, res) {
        try {
            const { chatId, chatData } = req.body;
            if (!chatId || !chatData) {
                return res.status(400).json({ error: 'Chat ID and data required' });
            }
            saveChatHistory(chatId, chatData);
            res.json({ success: true });
        } catch (error) {
            res.status(500).json({ error: redactSecrets(error.message) });
        }
    });

    RED.httpAdmin.post('/llm-plugin/delete-chat', function(req, res) {
        try {
            const { chatId, filename } = req.body || {};
            const chatsDir = path.join(logsDir, 'chats');
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
    RED.httpAdmin.post('/llm-plugin/checkpoint/save', function(req, res) {
        try {
            const body = req.body || {};
            const chatId = body.chatId || null;
            const label = body.label || 'checkpoint';
            const flow = Array.isArray(body.flow) ? body.flow : [];
            const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

            if (flow.length === 0) {
                return res.status(400).json({ error: 'flow array is required' });
            }
            const cp = saveCheckpoint(chatId, label, flow, meta);
            return res.json({ checkpointId: cp.id, created: cp.created, label: cp.label });
        } catch (error) {
            return res.status(500).json({ error: redactSecrets(error.message || 'Failed to save checkpoint') });
        }
    });

    RED.httpAdmin.get('/llm-plugin/checkpoint/:id', function(req, res) {
        try {
            const id = path.basename(String(req.params.id || ''));
            if (!id || !/^cp_\d+_[a-z0-9]+$/.test(id)) {
                return res.status(400).json({ error: 'Invalid checkpoint id' });
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

    RED.httpAdmin.post('/llm-plugin/client-log', function(req, res) {
        try {
            const body = req.body || {};
            writeClientEvent(body.level, body.event, body.message, body.meta);
            return res.json({ ok: true });
        } catch (error) {
            return res.status(500).json({ ok: false, error: redactSecrets(error.message || 'Failed to write client log') });
        }
    });

    RED.httpAdmin.get('/llm-plugin_styles.css', function(req, res) {
        try {
            const cssPath = path.join(__dirname, '..', 'llm-plugin_styles.css');
            if (fs.existsSync(cssPath)) {
                res.setHeader('Content-Type', 'text/css');
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
            if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                const ext = path.extname(filePath).toLowerCase();
                let contentType = 'application/octet-stream';
                if (ext === '.js') contentType = 'application/javascript';
                else if (ext === '.css') contentType = 'text/css';
                else if (ext === '.json') contentType = 'application/json';
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
