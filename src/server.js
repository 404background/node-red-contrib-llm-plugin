// LLM Plugin - Server Side JavaScript
const fs = require('fs-extra');
const path = require('path');
const http = require('http');

function createLLMPluginServer(RED) {
    // Create logs directory in plugin folder
    const logsDir = path.join(__dirname, '..', '.logs', 'llm-plugin');
    fs.ensureDirSync(logsDir);

    // Utility function to save recent model
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

    // Utility function to save chat history
    function saveChatHistory(chatId, chatData) {
        try {
            const date = new Date().toISOString().split('T')[0];
            const sanitizedTitle = chatData.title.replace(/[<>:"/\\|?*]/g, '-').substring(0, 50);
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

    // Utility: build a compact summary of the flow context for the prompt.
    // Accepts either an object with {nodes, connections} or an array of nodes (export array).
    function buildFlowContextDescription(flow) {
        if (!flow) return "No current flow context available.";

        // normalize: if flow is an array, treat as nodes array
        let nodes = [];
        let connections = [];
        if (Array.isArray(flow)) {
            nodes = flow.filter(n => n && n.type).slice(0, 50);
        } else if (flow.nodes) {
            nodes = (flow.nodes || []).slice(0, 50);
            connections = flow.connections || [];
        }

        if (!nodes || nodes.length === 0) return "No current flow context available.";

        // Build a short human-readable summary (max 12 nodes listed)
        const maxList = 12;
        let description = `Flow summary: ${nodes.length} node(s)`;
        description += `\nTypes present: ${[...new Set(nodes.map(n => n.type))].slice(0,20).join(', ')}`;
        description += "\nTop nodes:\n";
        nodes.slice(0, maxList).forEach(n => {
            const nm = n.name ? ` - ${String(n.name).slice(0,30)}` : '';
            description += `- ${n.type}${nm} (id:${String(n.id).slice(0,8)})\n`;
        });
        if (nodes.length > maxList) description += `- ... and ${nodes.length - maxList} more nodes\n`;

        if (connections && connections.length > 0) {
            description += `Connections: ${connections.length}\n`;
            // show up to 6 connections
            connections.slice(0,6).forEach(c => {
                try {
                    const from = c.from || {};
                    const to = c.to || {};
                    description += `- ${from.type || from.id} -> ${to.type || to.id}\n`;
                } catch (e) {}
            });
            if (connections.length > 6) description += `- ... and ${connections.length - 6} more connections\n`;
        }

        // Also include a compact JSON snippet containing only essential fields (limited size)
        const compact = nodes.map(n => {
            const out = { id: n.id, type: n.type };
            if (n.name) out.name = n.name;
            if (typeof n.x !== 'undefined') out.x = n.x;
            if (typeof n.y !== 'undefined') out.y = n.y;
            if (n.z) out.z = n.z;
            if (n.wires) out.wires = n.wires;
            if (n.func) out.func = (typeof n.func === 'string') ? n.func.slice(0,500) : undefined;
            return out;
        }).slice(0, 50);

        description += `\nCompactFlowJSON: \n` + JSON.stringify(compact, null, 2).slice(0, 5000) + '\n';
        return description;
    }

    // Function to build enhanced prompt
    function buildPrompt(userPrompt, flowContext) {
        // Build a concise prompt that hands the user's request to the LLM.
        let prompt = `You are a helpful Node-RED flow assistant. You help users create, modify, and understand Node-RED flows.\n`;

        prompt += "IMPORTANT RESPONSE RULES:\n";
        prompt += "1) Respond naturally; detect language from the user's message.\n";
        prompt += "2) If the user requests a Node-RED flow, return ONLY a single JSON code block (```json ... ```).\n";
        prompt += "3) Ensure the flow is importable into Node-RED.\n";
        prompt += "4) Keep responses concise.\n\n";

        if (flowContext) {
            prompt += "FLOW CONTEXT SUMMARY:\n";
            prompt += buildFlowContextDescription(flowContext) + "\n";
        }

        // Pass the raw user input through and let the model handle language/details
        prompt += `USER REQUEST: ${userPrompt}\n\n`;
        return prompt;
    }

    // Function to make HTTP request to Ollama
    // timeout: 0 (default) means wait indefinitely
    function generateWithOllama(model, prompt, timeout = 0) {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                model: model,
                prompt: prompt,
                stream: false
            });
            const options = {
                hostname: 'localhost',
                port: 11434,
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
            const req = http.request(options, (res) => {
                let responseData = '';
                res.on('data', (chunk) => {
                    responseData += chunk;
                });
                res.on('end', () => {
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

    // HTTP endpoint for generation
    RED.httpAdmin.post('/llm-plugin/generate', function(req, res) {
        const { model, prompt, currentFlow } = req.body;
        let logFlow = currentFlow;
        if (currentFlow && currentFlow.nodes) {
            logFlow = {
                nodes: currentFlow.nodes.map(n => ({id: n.id, type: n.type, name: n.name, x: n.x, y: n.y})),
                connections: currentFlow.connections
            };
        }
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }
        const enhancedPrompt = buildPrompt(prompt, currentFlow);
        saveRecentModel(model);
        // Do not pass a timeout so the request can run as long as needed
        generateWithOllama(model, enhancedPrompt)
            .then(response => {
                res.json({ response: response });
            })
            .catch(error => {
                console.error("[LLM Plugin] Generation error:", error);
                let errorMessage = 'Generation failed';
                if (error.code === 'ECONNREFUSED') {
                    errorMessage = 'Could not connect to Ollama. Please ensure Ollama is running on localhost:11434';
                } else if (error.message && error.message.includes('timeout')) {
                    errorMessage = 'Request timed out. The model may be too slow or not responding.';
                } else {
                    errorMessage = error.message;
                }
                res.status(500).json({ error: errorMessage });
            });
    });

    // HTTP endpoint for chat histories
    RED.httpAdmin.get('/llm-plugin/chat-histories', function(req, res) {
        try {
            const chatHistories = loadAllChatHistories();
            res.json({ chatHistories: chatHistories });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // HTTP endpoint to save chat history
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

    // HTTP endpoint to delete a chat file
    // Prefer accepting a filename (from server-provided metadata). Fallback to chatId if needed.
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

    // HTTP endpoint for recent models
    RED.httpAdmin.get('/llm-plugin/recent-models', function(req, res) {
        try {
            const models = getRecentModels();
            res.json({ models: models });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    // HTTP endpoint for CSS file
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

    // Serve client module files under /llm-plugin/src/* (e.g. /red/llm-plugin/src/client.js)
    RED.httpAdmin.get('/llm-plugin/src/:file', function(req, res) {
        try {
            const fileName = req.params.file;
            // Prevent path traversal
            if (fileName.indexOf('..') !== -1) return res.status(400).send('Invalid file');
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
