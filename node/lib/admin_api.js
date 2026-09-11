// LLM Plugin nodes  -  Node-RED Admin API helper (read-only)
//
// The node-facing `RED.nodes` cannot read flows, so flow context comes from
// GET <adminRoot>/flows (v2). Changes are NOT applied here — Agent hands the
// reply to the open editor over comms.
//
// Base URL: `opts.url`, else auto-detected — port from RED.server.address()
// (correct even when embedded in Express) → uiPort → 1880, root from
// settings.httpAdminRoot. No auth: this local read assumes adminAuth is off.
// Built on global `fetch` (the package requires Node >= 18): one code path
// for both schemes. Docs: https://nodered.org/docs/api/admin/methods/get/flows/
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

    // The actual port the runtime is listening on. RED.server is whatever was
    // handed to RED.init() — Node-RED's own server when standalone, or the
    // host app's server when embedded — so its bound port is authoritative.
    function detectPort() {
        try {
            const addr = RED.server && typeof RED.server.address === 'function' ? RED.server.address() : null;
            if (addr && typeof addr === 'object' && addr.port) return addr.port;
        } catch (e) { /* fall through */ }
        return RED.settings.uiPort || 1880;
    }

    // Resolve the admin API base as a URL string ending in `/`, from an
    // optional explicit editor URL or by auto-detection.
    //
    // The override can come from `msg.editorUrl`, i.e. from flow data rather
    // than an operator, so the scheme is an allowlist — not a protocol branch.
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
            // Be forgiving if the user pasted a full endpoint URL (e.g.
            // ".../red/llm-plugin/generate") instead of just the editor root:
            // keep everything up to the admin root.
            const idx = p.indexOf('/llm-plugin');
            if (idx !== -1) p = p.slice(0, idx + 1);
            const flowsIdx = p.indexOf('/flows');
            if (flowsIdx !== -1) p = p.slice(0, flowsIdx + 1);
            // `u.origin` already carries the default port for the scheme, so
            // there is nothing to fill in by hand.
            return u.origin + normaliseRoot(p);
        }

        const root = RED.settings.httpAdminRoot;
        if (root === false) {
            throw new Error('Node-RED admin API is disabled (httpAdminRoot=false); set an API URL on the node.');
        }
        // The scheme is still decided here, but only to build a URL: the
        // runtime we are calling is our own, and it may be serving TLS.
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
            // An aborted fetch throws a TimeoutError, not the ETIMEDOUT-ish
            // shape the http module produced. Callers only ever matched on
            // this message, so keep saying the same thing.
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
            // The PATH, not the full URL. The base can carry `user:pass@`
            // (it may come from msg.editorUrl), and this message travels out
            // through done(err) to the Node-RED log and msg.error.
            let where = base + pathSuffix;
            try { where = new URL(where).pathname; } catch (e) { /* keep as-is */ }
            throw new Error('Admin API GET ' + where +
                ' failed (' + status + '): ' + text.substring(0, 200));
        }
        if (!text) return {};
        try { return JSON.parse(text); }
        catch (e) { return { raw: text }; }
    }

    // GET the full flow configuration (all tabs + config nodes) plus its rev.
    // Used by the llm-request node's Agent mode to give the model prompt context.
    function getFlows(opts) {
        return request('flows', { 'Node-RED-API-Version': 'v2' }, opts);
    }

    return {
        getFlows: getFlows
    };
}

module.exports = createAdminApi;
