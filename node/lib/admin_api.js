// LLM Plugin nodes  -  Node-RED Admin API helper (read-only)
//
// The node-facing `RED.nodes` cannot read flows, so flow context comes from
// GET <adminRoot>/flows (v2). Changes are NOT applied here — Agent hands the
// reply to the open editor over comms.
//
// Base URL: opts.url if set (manual fallback); otherwise auto-detected from
// the live runtime — port from RED.server.address() (correct even when
// embedded in Express) → uiPort → 1880, root from settings.httpAdminRoot,
// https if RED.server is an https.Server. Auth: none by default (plugin
// assumes adminAuth off); opts.token adds a Bearer token.
// Docs: https://nodered.org/docs/api/admin/methods/get/flows/
const http = require('http');
const https = require('https');

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

    // Resolve { host, port, root, useHttps } from an optional explicit editor
    // URL, falling back to live auto-detection.
    function resolveBase(overrideUrl) {
        if (overrideUrl && String(overrideUrl).trim()) {
            const u = new URL(String(overrideUrl).trim());
            let p = u.pathname || '/';
            // Be forgiving if the user pasted a full endpoint URL (e.g.
            // ".../red/llm-plugin/generate") instead of just the editor root:
            // keep everything up to the admin root.
            const idx = p.indexOf('/llm-plugin');
            if (idx !== -1) p = p.slice(0, idx + 1);
            const flowsIdx = p.indexOf('/flows');
            if (flowsIdx !== -1) p = p.slice(0, flowsIdx + 1);
            return {
                host: u.hostname,
                port: u.port || (u.protocol === 'https:' ? 443 : 80),
                root: normaliseRoot(p),
                useHttps: u.protocol === 'https:'
            };
        }

        const root = RED.settings.httpAdminRoot;
        if (root === false) {
            throw new Error('Node-RED admin API is disabled (httpAdminRoot=false); set an Editor URL on the node.');
        }
        return {
            host: '127.0.0.1',
            port: detectPort(),
            root: normaliseRoot(root),
            useHttps: isHttpsServer(RED.server) || !!RED.settings.https
        };
    }

    // Promise-based JSON request against the resolved admin API.
    function request(method, pathSuffix, extraHeaders, bodyObj, opts) {
        opts = opts || {};
        return new Promise(function(resolve, reject) {
            let base;
            try { base = resolveBase(opts.url); } catch (e) { return reject(e); }

            const body = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8');
            const headers = Object.assign({
                'Accept': 'application/json',
                'Content-Type': 'application/json; charset=utf-8'
            }, extraHeaders || {});
            if (body) headers['Content-Length'] = body.length;
            if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;

            const options = {
                host: base.host,
                port: base.port,
                method: method,
                path: base.root + pathSuffix,
                headers: headers,
                timeout: 30000
            };
            const mod = base.useHttps ? https : http;
            const req = mod.request(options, function(res) {
                const chunks = [];
                res.on('data', function(c) { chunks.push(c); });
                res.on('end', function() {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const status = res.statusCode || 0;
                    if (status === 401) {
                        return reject(new Error('Admin API returned 401 Unauthorized. Disable adminAuth or set a token.'));
                    }
                    if (status >= 400) {
                        return reject(new Error('Admin API ' + method + ' ' + base.root + pathSuffix +
                            ' failed (' + status + '): ' + text.substring(0, 200)));
                    }
                    if (!text) return resolve({});
                    try { resolve(JSON.parse(text)); }
                    catch (e) { resolve({ raw: text }); }
                });
            });
            req.on('error', reject);
            req.on('timeout', function() { req.destroy(); reject(new Error('Admin API request timed out')); });
            if (body) req.write(body);
            req.end();
        });
    }

    // GET the full flow configuration (all tabs + config nodes) plus its rev.
    // Used by the LLM node's Agent mode to give the model prompt context.
    function getFlows(opts) {
        return request('GET', 'flows', { 'Node-RED-API-Version': 'v2' }, undefined, opts);
    }

    return {
        resolveBase: resolveBase,
        getFlows: getFlows
    };
}

module.exports = createAdminApi;
