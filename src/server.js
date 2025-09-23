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
            console.error("[VibeCoding] Error loading recent models:", error);
        }
        return [];
    }
    
    // Build enhanced prompt for Ollama
    function buildPrompt(userPrompt, flowContext, isFlowRequest) {
        let systemPrompt = '';
        
        if (isFlowRequest) {
            systemPrompt = `You are a Node-RED flow generator assistant. Your task is to create Node-RED flows based on user requests.

IMPORTANT RESPONSE FORMAT RULES:
1. When generating a flow, ALWAYS format your response as follows:
   - First: Brief explanation of what the flow does
   - Then: Flow JSON wrapped in \`\`\`json and \`\`\` markers
   - Finally: Usage instructions or additional notes

2. The JSON must be valid Node-RED flow format with:
   - "nodes" array containing node objects
   - Each node must have: "id", "type", "x", "y", "z" properties
   - Valid node types: "inject", "debug", "function", "http request", "mqtt in", "mqtt out", etc.
   - Proper "wires" arrays for connections between nodes

3. NEVER include JSON in non-flow responses (general questions, explanations, etc.)

${flowContext ? buildFlowContextDescription(flowContext) : 'No current flow is open.'}

User request: ${userPrompt}`;
        } else {
            systemPrompt = `You are a helpful Node-RED assistant. Answer questions about Node-RED, flows, and automation.

IMPORTANT: Do NOT include any JSON code blocks in your response unless the user specifically asks to generate or modify a flow.

${flowContext ? buildFlowContextDescription(flowContext) : 'No current flow context available.'}

User question: ${userPrompt}`;
        }
        
        return systemPrompt;
    }
    
    // Build detailed flow context description
    function buildFlowContextDescription(flowContext) {
        if (!flowContext || !flowContext.nodes) {
            return 'Current flow: Empty or no flow selected.';
        }
        
        let description = `Current flow context: "${flowContext.label || 'Untitled Flow'}" (${flowContext.nodes.length} nodes)

NODES IN CURRENT FLOW:`;
        
        flowContext.nodes.forEach((node, index) => {
            description += `\n${index + 1}. ${node.type}`;
            if (node.name) description += ` (${node.name})`;
            
            // Add type-specific details
            if (node.type === 'function' && node.func) {
                description += `\n   Function code: ${node.func.substring(0, 100)}${node.func.length > 100 ? '...' : ''}`;
            } else if (node.type === 'inject' && node.payload) {
                description += `\n   Payload: ${node.payload} (${node.payloadType})`;
            } else if (node.type === 'debug' && node.property) {
                description += `\n   Debug property: ${node.property}`;
            } else if (node.type === 'change' && node.rules && node.rules.length > 0) {
                description += `\n   Rules: ${node.rules.length} change rule(s)`;
            } else if (node.type === 'http request' && node.url) {
                description += `\n   Method: ${node.method || 'GET'}, URL: ${node.url}`;
            }
        });
        
        if (flowContext.connections && flowContext.connections.length > 0) {
            description += `\n\nCONNECTIONS:`;
            flowContext.connections.forEach((conn, index) => {
                const fromNode = flowContext.nodes.find(n => n.id === conn.from.id);
                const toNode = flowContext.nodes.find(n => n.id === conn.to.id);
                description += `\n${index + 1}. ${fromNode?.type || 'unknown'} → ${toNode?.type || 'unknown'}`;
            });
        }
        
        return description;
    }
    
    // Detect if user wants a flow generated
    function isFlowGenerationRequest(prompt) {
        const flowKeywords = [
            'create flow', 'generate flow', 'make flow', 'build flow',
            'add node', 'create node', 'inject node', 'debug node',
            'http request', 'mqtt', 'function node', 'switch node',
            'flow that', 'flow to', 'nodes that', 'connect'
        ];
        
        const lowercasePrompt = prompt.toLowerCase();
        return flowKeywords.some(keyword => lowercasePrompt.includes(keyword));
    }

    // Generate with Ollama
    function generateWithOllama(model, prompt, flowContext, callback) {
        const isFlowRequest = isFlowGenerationRequest(prompt);
        const enhancedPrompt = buildPrompt(prompt, flowContext, isFlowRequest);
        
        // Simple chat log entry
        const chatEntry = {
            timestamp: new Date().toISOString(),
            user: prompt,
            model: model,
            hasFlowContext: !!flowContext
        };
        
        const logFile = path.join(logsDir, `chat-${new Date().toISOString().split('T')[0]}.json`);
        logToFile(logFile, chatEntry);
        
        // Prepare Ollama request
        const requestData = JSON.stringify({
            model: model,
            prompt: enhancedPrompt,
            stream: false,
            options: {
                temperature: 0.1,
                top_p: 0.9
            }
        });
        
        const options = {
            hostname: 'localhost',
            port: 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestData)
            },
            timeout: 120000 // 2 minutes timeout for generation
        };
        
        const request = http.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    
                    if (result.response) {
                        // Log chat response only
                        const responseEntry = {
                            timestamp: new Date().toISOString(),
                            assistant: result.response.substring(0, 500) + (result.response.length > 500 ? '...' : ''),
                            model: model
                        };
                        logToFile(logFile, responseEntry);
                        
                        callback(null, result.response);
                    } else {
                        const error = result.error || 'Unknown error from Ollama';
                        callback(error, null);
                    }
                } catch (e) {
                    callback(`Failed to parse Ollama response: ${e.message}`, null);
                }
            });
        });
        
        request.on('error', (error) => {
            callback(`Ollama request failed: ${error.message}`, null);
        });
        
        request.on('timeout', () => {
            request.destroy();
            callback('Ollama request timed out', null);
        });
        
        request.write(requestData);
        request.end();
    }
    
    // HTTP endpoint for generation
    RED.httpAdmin.post('/vibecoding/generate', function(req, res) {
        console.log('[VibeCoding] Generate endpoint called');
        const { model, prompt, currentFlow } = req.body;
        
        if (!model || !prompt) {
            return res.status(400).json({ error: 'Model and prompt are required' });
        }
        
        // Save model to recent models
        saveRecentModel(model);
        
        generateWithOllama(model, prompt, currentFlow, (error, response) => {
            if (error) {
                res.status(500).json({ error: error });
            } else {
                res.json({ response: response });
            }
        });
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
}

module.exports = createVibeCodingServer;