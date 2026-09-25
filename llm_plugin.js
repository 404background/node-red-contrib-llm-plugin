// LLM Plugin - sidebar entry point. Registers the admin routes; the client
// code under src/ is fetched by the browser (see llm_plugin.html).
const path = require('path');
const { createLLMPluginServer } = require(path.join(__dirname, 'src', 'server.js'));

module.exports = function(RED) {
    try {
        createLLMPluginServer(RED);
        RED.log.info('[LLM Plugin] Server routes registered');
    } catch (err) {
        // Logged AND rethrown. Swallowing it left the sidebar loading against
        // endpoints that all 404, with nothing in the log to say why; letting
        // it through makes Node-RED mark the plugin as failed, which is the
        // signal a broken install should give.
        RED.log.error('[LLM Plugin] Failed to initialise: ' +
            ((err && err.message) ? err.message : err));
        throw err;
    }
};
