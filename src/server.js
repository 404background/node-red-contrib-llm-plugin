
// VibeCoding Plugin - Server Side JavaScript
const fs = require('fs-extra');
const path = require('path');
const http = require('http');

function createVibeCodingServer(RED) {
    // Create logs directory in plugin folder
    const logsDir = path.join(__dirname, '..', '.logs', 'vibecoding');
    fs.ensureDirSync(logsDir);
    
    // Utility function to log to file
    function logToFile(filepath, data) {
        try {
            const logLine = JSON.stringify(data) + '\n';
            fs.appendFileSync(filepath, logLine);
        } catch (error) {
            console.error("[VibeCoding] Error writing to log:", error);
        }
    }
    
    // Utility function to save recent model
    function saveRecentModel(model) {
        try {
            const modelsFile = path.join(logsDir, 'recent-models.json');
            let recentModels = [];
            
            if (fs.existsSync(modelsFile)) {
                const content = fs.readFileSync(modelsFile, 'utf8');
                recentModels = JSON.parse(content);
            }
            
            // Remove if already exists and add to front
            recentModels = recentModels.filter(m => m !== model);
            recentModels.unshift(model);
            
            // Keep only last 10 models
            recentModels = recentModels.slice(0, 10);
            
            fs.writeFileSync(modelsFile, JSON.stringify(recentModels, null, 2));
        } catch (error) {
            console.error("[VibeCoding] Error saving recent model:", error);
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
            console.error("[VibeCoding] Error reading recent models:", error);
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
            console.error("[VibeCoding] Error saving chat history:", error);
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
                    chatHistories[chatData.id] = chatData;
                } catch (error) {
                    console.error("[VibeCoding] Error reading chat file:", file, error);
                }
            });
            
            return chatHistories;
        } catch (error) {
            console.error("[VibeCoding] Error loading chat histories:", error);
            return {};
        }
    }

    // Utility function to build flow context description
    function buildFlowContextDescription(flow) {
        if (!flow || (!flow.nodes || flow.nodes.length === 0)) {
            return "No current flow context available.";
        }
        
        let description = "Current Node-RED flow context:\n\n";
        
        // Describe nodes
        description += "NODES:\n";
        flow.nodes.forEach(node => {
            description += `- ${node.type} (ID: ${node.id})`;
            if (node.name) description += ` - Name: "${node.name}"`;
            
            // Add important properties based on node type
            if (node.properties) {
                const props = node.properties;
                if (props.topic) description += ` - Topic: "${props.topic}"`;
                if (props.payload) description += ` - Payload: "${props.payload}"`;
                if (props.url) description += ` - URL: "${props.url}"`;
                if (props.method) description += ` - Method: "${props.method}"`;
                if (props.func) description += ` - Function code length: ${props.func.length} chars`;
            }
            description += "\n";
        });
        
        // Describe connections
        if (flow.connections && flow.connections.length > 0) {
            description += "\nCONNECTIONS:\n";
            flow.connections.forEach(conn => {
                description += `- ${conn.from.type} (${conn.from.name || conn.from.id}) → ${conn.to.type} (${conn.to.name || conn.to.id})\n`;
            });
        }
        
        return description;
    }
    
    // Function to build enhanced prompt
    function buildPrompt(userPrompt, flowContext) {
        let prompt = `You are a helpful Node-RED flow assistant. You help users create, modify, and understand Node-RED flows.

FLOW JSON REQUIREMENTS:
- Always wrap flow JSON in \`\`\`json code blocks
- Use proper Node-RED node structure with id, type, name, x, y, z, wires properties
- Generate unique IDs for each node (use random strings like "abc123")
- Set appropriate x, y coordinates for visual layout (spread nodes out, typical spacing is 150-200 pixels)
- Include the 'z' property with the workspace ID (use "flow1" as default)
- Ensure wires array connects nodes properly (array of arrays, each sub-array represents output port connections)
- Include all necessary properties for each node type
- For inject nodes: set repeat to "" and crontab to ""
- For function nodes: include complete JavaScript code in 'func' property
- For debug nodes: set console to "false" and tostatus to false
- Make flows that actually work and are useful

`;
        
        if (flowContext) {
            prompt += buildFlowContextDescription(flowContext) + "\n\n";
        }
        
        prompt += `USER REQUEST: ${userPrompt}

Please provide a helpful response. If the user is asking for a flow, provide working Node-RED JSON that accomplishes their goal.`;
        
        return prompt;
    }
    
    // Function to make HTTP request to Ollama
    function generateWithOllama(model, prompt, timeout = 120000) {
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
                },
                timeout: timeout
            };
            
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
            
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out'));
            });
            
            req.write(data);
            req.end();
        });
    }
    
    // HTTP endpoint for generation
    RED.httpAdmin.post('/vibecoding/generate', function(req, res) {
    const { model, prompt, currentFlow } = req.body;
    // currentFlowが大きい場合はサマリのみ出力
    let logFlow = currentFlow;
    if (currentFlow && currentFlow.nodes) {
        logFlow = {
            nodes: currentFlow.nodes.map(n => ({id: n.id, type: n.type, name: n.name, x: n.x, y: n.y})),
            connections: currentFlow.connections
        };
    }
    console.log('[VibeCoding] LLM送信内容:', JSON.stringify({ model, prompt, currentFlow: logFlow }, null, 2));
        
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }
        
        const today = new Date().toISOString().split('T')[0];
        const logPath = path.join(logsDir, `chat-${today}.json`);
        
        // Log the request
        logToFile(logPath, {
            timestamp: new Date().toISOString(),
            type: 'request',
            model: model,
            prompt: prompt,
            hasFlow: !!currentFlow
        });
        
        // Build enhanced prompt
        const enhancedPrompt = buildPrompt(prompt, currentFlow);
        
        // Save recent model
        saveRecentModel(model);
        
        generateWithOllama(model, enhancedPrompt, 120000)
            .then(response => {
                // Log the response
                logToFile(logPath, {
                    timestamp: new Date().toISOString(),
                    type: 'response',
                    response: response
                });
                
                res.json({ response: response });
            })
            .catch(error => {
                console.error("[VibeCoding] Generation error:", error);
                
                // Log the error
                logToFile(logPath, {
                    timestamp: new Date().toISOString(),
                    type: 'error',
                    error: error.message
                });
                
                let errorMessage = 'Generation failed';
                if (error.code === 'ECONNREFUSED') {
                    errorMessage = 'Could not connect to Ollama. Please ensure Ollama is running on localhost:11434';
                } else if (error.message.includes('timeout')) {
                    errorMessage = 'Request timed out. The model may be too slow or not responding.';
                } else {
                    errorMessage = error.message;
                }
                
                res.status(500).json({ error: errorMessage });
            });
    });
    
    // HTTP endpoint for chat histories
    RED.httpAdmin.get('/vibecoding/chat-histories', function(req, res) {
        try {
            const chatHistories = loadAllChatHistories();
            res.json({ chatHistories: chatHistories });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // HTTP endpoint to save chat history
    RED.httpAdmin.post('/vibecoding/save-chat', function(req, res) {
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
    
    // HTTP endpoint for recent models
    RED.httpAdmin.get('/vibecoding/recent-models', function(req, res) {
        try {
            const models = getRecentModels();
            res.json({ models: models });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // HTTP endpoint for logs
    RED.httpAdmin.get('/vibecoding/logs', function(req, res) {
        try {
            const files = fs.readdirSync(logsDir);
            const logFiles = files.filter(f => f.startsWith('chat-') && f.endsWith('.json'));
            
            if (logFiles.length === 0) {
                return res.json({ logs: [] });
            }
            
            // Read the most recent chat log file
            const latestLogFile = logFiles.sort().reverse()[0];
            const logPath = path.join(logsDir, latestLogFile);
            const logContent = fs.readFileSync(logPath, 'utf8');
            
            const logs = logContent.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line);
                    } catch (e) {
                        return null;
                    }
                })
                .filter(log => log)
                .slice(-20); // Last 20 chat entries
            
            res.json({ logs: logs });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });
    
    // HTTP endpoint for CSS file
    RED.httpAdmin.get('/vibecoding_styles.css', function(req, res) {
        try {
            const cssPath = path.join(__dirname, '..', 'vibecoding_styles.css');
            if (fs.existsSync(cssPath)) {
                res.setHeader('Content-Type', 'text/css');
                const cssContent = fs.readFileSync(cssPath, 'utf8');
                res.send(cssContent);
            } else {
                res.status(404).send('/* CSS file not found */');
            }
        } catch (error) {
            console.error('[VibeCoding] Error serving CSS:', error);
            res.status(500).send('/* Error loading CSS */');
        }
    });

    console.log("[VibeCoding] Server initialized successfully");
}
module.exports = { createVibeCodingServer };