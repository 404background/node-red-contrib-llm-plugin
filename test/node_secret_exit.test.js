// The llm-request node's ERROR exit is a secret exit.
//
// `done(err)` is flow-visible: Node-RED logs the message AND hands it to a
// Catch node as `msg.error`, from where a debug or http response node can
// republish it. An OpenAI-compatible endpoint that echoes the Authorization
// header into its error body therefore puts the stored API key on that path.
// The sidebar's /generate handler redacts its equivalent; this covers the
// node, which is the other consumer of the same credential store.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ROOT, ok, summary } = require('./helpers.js');

const KEY = 'f3a91c4e-77bd-4a2e-9c10-8de55b0f1a22'; // not sk-shaped: only the
                                                    // literal-value redaction
                                                    // can catch this one.

// Answers every request 401 with the bearer token quoted back in the body —
// the real behaviour of proxies that log what they rejected.
function startEchoingEndpoint() {
    return new Promise(function(resolve) {
        const server = http.createServer(function(req, res) {
            const auth = req.headers['authorization'] || '(none)';
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'rejected credential ' + auth } }));
        });
        server.listen(0, '127.0.0.1', function() { resolve(server); });
    });
}

// One RED for the whole file: llm_core is a per-process singleton, so the
// node and the settings write have to share it (that sharing is the feature).
function buildRED(userDir) {
    const store = {};
    const warnings = [];
    return {
        warnings: warnings,
        RED: {
            settings: {
                userDir: userDir,
                get: (k) => store[k],
                set: (k, v) => { store[k] = v; return Promise.resolve(); }
            },
            log: { info() {}, warn(m) { warnings.push(m); }, error(m) { warnings.push(m); } },
            nodes: {
                createNode: function(node) {
                    node.handlers = {};
                    node.on = function(ev, fn) { node.handlers[ev] = fn; };
                    node.status = function() {};
                    node.warn = function(m) { warnings.push(m); };
                    node.error = function(m) { warnings.push(m); };
                    node.context = function() { return { flow: { get: () => undefined }, global: { get: () => undefined } }; };
                    node.id = 'test-node';
                },
                registerType: function(name, ctor) { this._ctor = ctor; }
            },
            comms: { publish: function() {} }
        }
    };
}

async function theErrorExitCarriesNoKey() {
    console.log('\nThe node\'s error exit carries no API key');

    const server = await startEchoingEndpoint();
    const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmp-nodeerr-'));

    const built = buildRED(userDir);
    const RED = built.RED;
    const core = require(path.join(ROOT, 'src', 'llm_core.js'))(RED);
    await core.savePluginSettings({
        provider: 'custom', customBaseUrl: baseUrl, customApiKey: KEY
    });

    const nodeModule = require(path.join(ROOT, 'node', 'llm-request', 'llm-request.js'));
    nodeModule(RED);

    const node = {};
    RED.nodes._ctor.call(node, { mode: 'ask', provider: 'custom', model: 'm', timeout: 30 });

    const err = await new Promise(function(resolve) {
        node.handlers.input.call(node, { payload: 'hi' }, function() {}, resolve);
    });
    server.close();

    ok(err instanceof Error, 'the failing request reports an error at all');
    const text = String(err && err.message);
    ok(text.includes('REDACTED'), 'the endpoint really did echo a credential back (' + text.slice(0, 90) + ')');
    ok(!text.includes(KEY), 'the stored API key is not in the error handed to the flow');
    ok(!JSON.stringify(built.warnings).includes(KEY),
        'and not in anything the node logged');
}

function urlUserinfoIsScrubbedFromLogs() {
    console.log('\nA log line never republishes a URL\'s userinfo');
    const nodeModule = require(path.join(ROOT, 'node', 'llm-request', 'llm-request.js'));
    const scrub = nodeModule._scrubUrlCredentials;

    const line = scrub('fetch failed for "http://admin:hunter2@10.0.0.4:1880/red" (ECONNREFUSED)');
    ok(!line.includes('hunter2') && !line.includes('admin:'),
        'the embedded credentials are gone');
    ok(line.includes('10.0.0.4:1880/red') && line.includes('ECONNREFUSED'),
        'the rest of the line still says what failed and where');
    ok(scrub('plain http://localhost:1880/ url') === 'plain http://localhost:1880/ url',
        'a URL without userinfo is left alone');
}

(async () => {
    await theErrorExitCarriesNoKey();
    urlUserinfoIsScrubbedFromLogs();
    summary();
})();
