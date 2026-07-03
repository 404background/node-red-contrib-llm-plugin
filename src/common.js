// Shared client-side helpers (loaded before every other module).
// Exposed as window.LLMPlugin.Common.
(function() {
    let Common = {};

    // Escape HTML special characters (XSS-safe text interpolation).
    Common.escapeHtml = function(str) {
        return String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    // Escape a string for literal use inside a RegExp.
    Common.escapeRegExp = function(str) {
        return String(str).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    };

    // RED.notify with the availability guard every caller was repeating.
    // `type` may be a string ('success' | 'warning' | 'error' | 'info')
    // or a Node-RED options object ({ type, timeout, ... }).
    Common.notify = function(text, type) {
        if (window.RED && RED.notify) RED.notify(text, type || 'info');
    };

    // createElement with optional className / textContent.
    Common.el = function(tag, className, text) {
        let node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };

    // Unique-enough id: <prefix><epoch>_<random>. Used for chat / message ids.
    Common.randomId = function(prefix) {
        return (prefix || '') + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.Common = Common;
})();
