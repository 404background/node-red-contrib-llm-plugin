// LLM Plugin - sidebar entry point. Registers the admin routes; the client
// code under src/ is fetched by the browser (see llm_plugin.html).
const path = require('path');
const { createLLMPluginServer } = require(path.join(__dirname, 'src', 'server.js'));

module.exports = function(RED) {
    try {
        createLLMPluginServer(RED);
        RED.log.info('[LLM Plugin] Server routes registered');
    } catch (err) {
        // Logged AND rethrown, so Node-RED marks the plugin as failed rather than
        // leaving a sidebar whose endpoints all 404.
        RED.log.error('[LLM Plugin] Failed to initialise: ' +
            ((err && err.message) ? err.message : err));
        throw err;
    }
};
