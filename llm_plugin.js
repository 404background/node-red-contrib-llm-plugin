// LLM Plugin - sidebar entry point
// ...this file is a thin wrapper that loads the actual client code from src when Node-RED loads the plugin
module.exports = function(RED) {
    // Initialize server-side admin routes and utilities
    try {
        const path = require('path');
        const server = require(path.join(__dirname, 'src', 'server.js'));
        if (server && typeof server.createLLMPluginServer === 'function') {
            server.createLLMPluginServer(RED);
            RED.log && RED.log.info && RED.log.info('[LLM Plugin] Server routes registered');
        } else if (typeof server === 'function') {
            // support older export style
            server(RED);
            RED.log && RED.log.info && RED.log.info('[LLM Plugin] Server initialized (function export)');
        } else {
            RED.log && RED.log.warn && RED.log.warn('[LLM Plugin] No server initializer found in src/server.js');
        }
    } catch (err) {
        console.error('[LLM Plugin] Error initializing server:', err);
    }
};
