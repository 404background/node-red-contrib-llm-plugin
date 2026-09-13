// LLM Plugin nodes  -  Node-RED Admin API helper (read-only).
// The node-facing `RED.nodes` cannot read flows, so flow context comes from
// GET <adminRoot>/flows. Assumes adminAuth is off.
// See docs/{en,jp}/llm-request.md — Files.

function createAdminApi(RED) {

    // Normalise a path so it has a single leading and trailing slash.
    function normaliseRoot(root) {
        if (typeof root !== 'string' || root.length === 0) return '/';
        if (root.charAt(0) !== '/') root = '/' + root;
        if (root.charAt(root.length - 1) !== '/') root += '/';
        return root;
    }

    function isHttpsServer(server) {
        // https.Server exposes setSecureContext(); http.Server does not.
        return !!server && typeof server.setSecureContext === 'function';
    }

    // RED.server is whatever was handed to RED.init(), so its bound port is
    // authoritative — uiPort is unset when Node-RED is embedded.
    function detectPort() {
        try {
            const addr = RED.server && typeof RED.server.address === 'function' ? RED.server.address() : null;
            if (addr && typeof addr === 'object' && addr.port) return addr.port;
        } catch (e) { /* fall through */ }
        return RED.settings.uiPort || 1880;
    }

    // The override can arrive as flow data (`msg.editorUrl`), so the scheme
    // is an allowlist rather than a branch.
    const ALLOWED_PROTOCOLS = { 'http:': 1, 'https:': 1 };

    function resolveBase(overrideUrl) {
        if (overrideUrl && String(overrideUrl).trim()) {
            let u;
            try {
                u = new URL(String(overrideUrl).trim());
            } catch (e) {
                throw new Error('API URL is not a valid URL: ' + String(overrideUrl).trim());
            }
            if (!ALLOWED_PROTOCOLS[u.protocol]) {
                throw new Error('API URL must use http:// or https:// (got ' + u.protocol + ')');
            }
            let p = u.pathname || '/';
            // Forgiving: a pasted endpoint URL is cut back to the admin root.
            const idx = p.indexOf('/llm-plugin');
            if (idx !== -1) p = p.slice(0, idx + 1);
            const flowsIdx = p.indexOf('/flows');
            if (flowsIdx !== -1) p = p.slice(0, flowsIdx + 1);
            return u.origin + normaliseRoot(p);
        }

        const root = RED.settings.httpAdminRoot;
        if (root === false) {
            throw new Error('Node-RED admin API is disabled (httpAdminRoot=false); set an API URL on the node.');
        }
        const scheme = (isHttpsServer(RED.server) || !!RED.settings.https) ? 'https' : 'http';
        return scheme + '://127.0.0.1:' + detectPort() + normaliseRoot(root);
    }

    const REQUEST_TIMEOUT_MS = 30000;

    // Promise-based JSON GET against the resolved admin API.
    async function request(pathSuffix, extraHeaders, opts) {
        opts = opts || {};
        const base = resolveBase(opts.url);   // throws → rejects, as before

        let res;
        try {
            res = await fetch(base + pathSuffix, {
                method: 'GET',
                headers: Object.assign({ 'Accept': 'application/json' }, extraHeaders || {}),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (e) {
            // Callers match on this message, so keep saying the same thing.
            if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
                throw new Error('Admin API request timed out');
            }
            throw e;
        }

        const text = await res.text();
        const status = res.status || 0;
        if (status === 401) {
            throw new Error('Admin API returned 401 Unauthorized (adminAuth is enabled). ' +
                'Flow context needs an unauthenticated admin API; clear the node\'s Flows selection or disable adminAuth.');
        }
        if (status >= 400) {
            // The path only: the base can carry `user:pass@`, and this
            // message travels out through done(err).
            let where = base + pathSuffix;
            try { where = new URL(where).pathname; } catch (e) { /* keep as-is */ }
            throw new Error('Admin API GET ' + where +
                ' failed (' + status + '): ' + text.substring(0, 200));
        }
        if (!text) return {};
        try { return JSON.parse(text); }
        catch (e) { return { raw: text }; }
    }

    // The full flow configuration (all tabs + config nodes) plus its rev.
    function getFlows(opts) {
        return request('flows', { 'Node-RED-API-Version': 'v2' }, opts);
    }

    return {
        getFlows: getFlows
    };
}

module.exports = createAdminApi;
