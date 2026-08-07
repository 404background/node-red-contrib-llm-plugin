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

    // Unique id: <prefix><epoch>_<random>. Used for chat / message ids.
    // Uses the WebCrypto RNG so ids aren't predictable from a known epoch;
    // Math.random is only a fallback for exotic/non-secure-context editors.
    Common.randomId = function(prefix) {
        let rand;
        try {
            let buf = new Uint8Array(6);
            window.crypto.getRandomValues(buf);
            rand = Array.prototype.map.call(buf, function(b) {
                return b.toString(16).padStart(2, '0');
            }).join('');
        } catch (e) {
            rand = Math.random().toString(36).substring(2, 11);
        }
        return (prefix || '') + Date.now() + '_' + rand;
    };

    // fetch() against the plugin's admin endpoints, carrying the editor's
    // bearer token. Node-RED only auto-injects the Authorization header into
    // jQuery ajax calls, so plain fetch() would 401 the moment `adminAuth`
    // is enabled — every plugin endpoint that touches data or settings is
    // behind RED.auth.needsPermission (see src/server.js).
    // Static assets (marked.js, the stylesheet, src/*.js) stay unauthenticated
    // because <script>/<link> tags cannot send headers.
    Common.apiFetch = function(url, options) {
        let opts = Object.assign({}, options || {});
        let headers = Object.assign({}, opts.headers || {});
        try {
            let tokens = window.RED && RED.settings && typeof RED.settings.get === 'function'
                ? RED.settings.get('auth-tokens')
                : null;
            if (tokens && tokens.access_token) {
                headers['Authorization'] = 'Bearer ' + tokens.access_token;
            }
        } catch (e) { /* no adminAuth configured — no header needed */ }
        opts.headers = headers;
        return fetch(url, opts);
    };

    // Workspace ids → comma-joined tab labels (id kept when the tab is
    // gone / unnamed). Null when nothing usable so callers can fall back.
    Common.flowLabels = function(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return null;
        if (!window.RED || !RED.nodes || typeof RED.nodes.workspace !== 'function') return ids.join(', ');
        try {
            return ids.map(function(id) {
                let ws = RED.nodes.workspace(id);
                return (ws && ws.label) ? ws.label : id;
            }).join(', ');
        } catch (e) {
            return null;
        }
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.Common = Common;
})();
