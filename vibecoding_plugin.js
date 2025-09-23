// VibeCoding Plugin for Node-RED
const { createVibeCodingServer } = require('./src/server');

module.exports = function(RED) {
    // Initialize server-side functionality
    createVibeCodingServer(RED);
};