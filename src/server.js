// LLM Plugin — Server Side
// Registers all HTTP admin endpoints used by the client sidebar.
const fs = require('fs-extra');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const { OpenAI } = require('openai');

function createLLMPluginServer(RED) {
    const logsDir = path.join(__dirname, '..', '.logs', 'llm-plugin');
    fs.ensureDirSync(logsDir);

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
                const url = new URL('/api/tags', baseUrl);
                const httpModule = url.protocol === 'https:' ? https : http;
                const req = httpModule.request(url.toString(), { method: 'GET', timeout: 5000 }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
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
    //  Recent-model tracking                                              //
    // ------------------------------------------------------------------ //

    function saveRecentModel(model) {
        try {
            const modelsFile = path.join(logsDir, 'recent-models.json');
            let recentModels = [];
            if (fs.existsSync(modelsFile)) {
                const content = fs.readFileSync(modelsFile, 'utf8');
                recentModels = JSON.parse(content);
            }
            recentModels = recentModels.filter(m => m !== model);
            recentModels.unshift(model);
            recentModels = recentModels.slice(0, 10);
            fs.writeFileSync(modelsFile, JSON.stringify(recentModels, null, 2));
        } catch (error) {
            console.error("[LLM Plugin] Error saving recent model:", error);
        }
    }

    // Utility function to get recent models
    function getRecentModels() {
        try {
            const modelsFile = path.join(logsDir, 'recent-models.json');
            if (fs.existsSync(modelsFile)) {
                const content = fs.readFileSync(modelsFile, 'utf8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error("[LLM Plugin] Error reading recent models:", error);
        }
        return [];
    }

    // ------------------------------------------------------------------ //
    //  Chat history persistence                                           //
    // ------------------------------------------------------------------ //

    function saveChatHistory(chatId, chatData) {
        try {
            const date = new Date().toISOString().split('T')[0];
            const rawTitle = (chatData.title && typeof chatData.title === 'string') ? chatData.title : 'untitled';
            const sanitizedTitle = rawTitle.replace(/[^a-zA-Z0-9_-]/g, '-').substring(0, 50);
            const filename = `${date}-${sanitizedTitle}-${chatId.substring(0, 8)}.json`;
            const filepath = path.join(logsDir, 'chats', filename);
            fs.ensureDirSync(path.dirname(filepath));
            fs.writeFileSync(filepath, JSON.stringify(chatData, null, 2));
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
    // Accepts either an object with {nodes, connections} or an array of nodes (export array).
    // All nodes are passed through without truncation so the LLM sees the complete flow.
    function buildFlowContextDescription(flow) {
        if (!flow) return "No current flow context available.";

        // normalize: if flow is an array, treat as nodes array
        let nodes = [];
        if (Array.isArray(flow)) {
            nodes = flow.filter(n => n && n.type);
        } else if (flow.nodes) {
            nodes = (flow.nodes || []);
        }

        if (!nodes || nodes.length === 0) return "No current flow context available.";

        // Defensive credential stripping — never pass secrets to the LLM
        nodes = nodes.map(n => {
            const out = Object.assign({}, n);
            delete out.credentials;
            return out;
        });

        // Human-readable summary
        let description = `Flow summary: ${nodes.length} node(s)`;
        description += `\nTypes present: ${[...new Set(nodes.map(n => n.type))].join(', ')}`;
        description += "\nNodes:\n";
        nodes.forEach(n => {
            const nm = n.name ? ` - ${String(n.name).slice(0,30)}` : '';
            description += `- ${n.type}${nm} (id:${String(n.id).slice(0,8)})\n`;
        });

        // Full JSON representation — no node or size limits
        description += `\nFlowJSON:\n` + JSON.stringify(nodes, null, 2) + '\n';
        return description;
    }

    // Function to build enhanced prompt
    function buildPrompt(userPrompt, flowContext) {
        let prompt = `You are a Node-RED expert.\n\n`;

        prompt += "RULES:\n";
        prompt += "- Detect language from user input.\n";
        prompt += "- When explaining flows, analyze logic and data flow. Do NOT mention IDs or coordinates.\n";
        prompt += "- To generate flows, output a single ```json``` array of node objects.\n";
        prompt += "- Nodes must have: id, type, z, x, y, wires.\n";
        prompt += "- Do NOT include `tab` nodes.\n";
        prompt += "- Be concise.\n\n";

        if (flowContext) {
            prompt += "FLOW CONTEXT SUMMARY:\n";
            prompt += buildFlowContextDescription(flowContext) + "\n";
        }

        // Pass the raw user input through and let the model handle language/details
        prompt += `USER REQUEST: ${userPrompt}\n\n`;
        return prompt;
    }

    // ------------------------------------------------------------------ //
    //  LLM provider adapters                                              //
    // ------------------------------------------------------------------ //

    // Ollama generation (timeout 0 = wait indefinitely)
    function generateWithOllama(model, prompt, timeout = 0) {
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
                prompt: prompt,
                stream: false
            });
            const isHttps = ollamaUrl.protocol === 'https:';
            const options = {
                hostname: ollamaUrl.hostname,
                port: ollamaUrl.port || (isHttps ? 443 : 80),
                path: '/api/generate',
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
                    try {
                        const response = JSON.parse(responseData);
                        if (response.response) {
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
    async function generateWithOpenAI(apiKey, model, prompt) {
        const openai = new OpenAI({ apiKey });
        const completion = await openai.chat.completions.create({
            messages: [{ role: 'system', content: prompt }],
            model: model,
        });
        return completion.choices[0].message.content;
    }


    // ------------------------------------------------------------------ //
    //  HTTP admin endpoints                                               //
    // ------------------------------------------------------------------ //

    RED.httpAdmin.post('/llm-plugin/generate', async function(req, res) {
        const { model, prompt, currentFlow } = req.body;
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }

        const settings = getPluginSettings();
        const provider = settings.provider || 'ollama';

        const enhancedPrompt = buildPrompt(prompt, currentFlow);
        saveRecentModel(model);

        try {
            let response;
            if (provider === 'openai') {
                if (!settings.openaiApiKey) {
                    throw new Error('OpenAI API key is not configured. Please set it in LLM Plugin settings.');
                }
                try {
                    response = await generateWithOpenAI(settings.openaiApiKey, model, enhancedPrompt);
                } catch (openaiError) {
                    // Provide detailed error messages based on OpenAI API error codes
                    if (openaiError.status === 401 || openaiError.code === 'invalid_api_key') {
                        throw new Error('Invalid OpenAI API key. Please check your API key in settings.');
                    } else if (openaiError.status === 429) {
                        throw new Error('OpenAI rate limit exceeded or quota exhausted. Please wait and try again, or check your billing.');
                    } else if (openaiError.status === 503) {
                        throw new Error('OpenAI service is temporarily unavailable. Please try again later.');
                    } else if (openaiError.status === 404) {
                        throw new Error('Model "' + model + '" not found on OpenAI. Please check the model name.');
                    } else if (openaiError.status === 400) {
                        throw new Error('Bad request to OpenAI: ' + (openaiError.message || 'Check your prompt and model settings.'));
                    }
                    // Re-throw with sanitized message (avoid leaking SDK internals)
                    throw new Error('OpenAI error: ' + (openaiError.message || 'Unknown error'));
                }
            } else {
                response = await generateWithOllama(model, enhancedPrompt);
            }
            res.json({ response: response });
        } catch (error) {
            // Log only safe fields — never log the full error object which may contain sensitive headers
            console.error("[LLM Plugin] Generation error:", error.message || error);
            let errorMessage = 'Generation failed';
            if (error.code === 'ECONNREFUSED') {
                const ollamaUrl = settings.ollamaUrl || 'http://localhost:11434';
                errorMessage = `Could not connect to Ollama at ${ollamaUrl}. Please ensure Ollama is running and accessible.`;
            } else if (error.code === 'ECONNRESET') {
                errorMessage = 'The connection to the LLM provider was unexpectedly closed. Please check if the Ollama server is running and stable.';
            } else if (error.message && error.message.includes('timeout')) {
                errorMessage = 'Request timed out. The model may be too slow or not responding.';
            } else {
                errorMessage = error.message;
            }
            res.status(500).json({ error: errorMessage });
        }
    });

    // --- Settings endpoints ---
    RED.httpAdmin.get('/llm-plugin/settings', function(req, res) {
        const settings = Object.assign({}, getPluginSettings());
        // Never expose the full API key to the client
        const hasKey = !!(settings.openaiApiKey && settings.openaiApiKey.length > 0);
        settings.openaiApiKeyMasked = hasKey ? maskApiKey(settings.openaiApiKey) : '';
        delete settings.openaiApiKey;
        res.json(settings);
    });

    RED.httpAdmin.post('/llm-plugin/settings', function(req, res) {
        try {
            const body = req.body || {};
            // Whitelist: only persist known settings fields
            const newSettings = {
                provider: body.provider || 'ollama',
                ollamaUrl: body.ollamaUrl || 'http://localhost:11434'
            };
            // If API key field is empty, preserve the existing key (user didn't change it)
            if (body.openaiApiKey && typeof body.openaiApiKey === 'string' && body.openaiApiKey.trim() !== '') {
                newSettings.openaiApiKey = body.openaiApiKey.trim();
            } else {
                const existing = getPluginSettings();
                newSettings.openaiApiKey = existing.openaiApiKey || '';
            }
            savePluginSettings(newSettings);
            res.status(200).send();
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // --- Model list ---
    RED.httpAdmin.get('/llm-plugin/ollama/models', async function(req, res) {
        try {
            const models = await listOllamaModels();
            res.json({ models });
        } catch (error) {
            console.error('[LLM Plugin] Error fetching Ollama models:', error);
            res.status(500).json({ error: 'Failed to list Ollama models' });
        }
    });


    // --- Chat history endpoints ---
    RED.httpAdmin.get('/llm-plugin/chat-histories', function(req, res) {
        try {
            const chatHistories = loadAllChatHistories();
            res.json({ chatHistories: chatHistories });
        } catch (error) {
            res.status(500).json({ error: error.message });
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
            res.status(500).json({ error: error.message });
        }
    });

    RED.httpAdmin.post('/llm-plugin/delete-chat', function(req, res) {
        try {
            const { chatId, filename } = req.body || {};
            const chatsDir = path.join(logsDir, 'chats');
            if (!fs.existsSync(chatsDir)) return res.json({ success: true });

            // If filename provided, only allow basename (no path traversal) and delete directly
            if (filename && typeof filename === 'string') {
                if (filename.indexOf('..') !== -1) return res.status(400).json({ error: 'Invalid filename' });
                const filepath = path.join(chatsDir, path.basename(filename));
                if (fs.existsSync(filepath)) {
                    fs.unlinkSync(filepath);
                    return res.json({ success: true });
                }
                // Already gone -> idempotent success
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
            return res.json({ success: deleted });
        } catch (error) {
            console.error('[LLM Plugin] Error deleting chat file:', error);
            return res.status(500).json({ error: error.message });
        }
    });

    // --- Static asset endpoints ---
    RED.httpAdmin.get('/llm-plugin/recent-models', function(req, res) {
        try {
            const models = getRecentModels();
            res.json({ models: models });
        } catch (error) {
            res.status(500).json({ error: error.message });
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

    RED.httpAdmin.get('/llm-plugin/src/:file', function(req, res) {
        try {
            const fileName = path.basename(req.params.file);
            // Prevent path traversal
            if (fileName.indexOf('..') !== -1 || fileName !== req.params.file) return res.status(400).send('Invalid file');
            const filePath = path.join(__dirname, fileName);
            if (fs.existsSync(filePath)) {
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

    console.log("[LLM Plugin] Server initialized successfully");
}
module.exports = { createLLMPluginServer };
