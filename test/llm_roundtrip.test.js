// Live round-trip test against a real LLM endpoint.
//
// Unlike the rest of test/, this one talks to an actual model, so it is NOT
// part of `npm test`. Run it with:
//
//     npm run test:llm
//
// Settings come from `llm-test-config.json` in the repo root (git-ignored;
// copy `llm-test-config.example.json` to create it). Environment variables
// LLM_TEST_URL / LLM_TEST_MODEL override individual fields.
//
// What it covers is the path a user actually drives, using the same engine
// the sidebar and the llm-request node use:
//
//     user prompt
//       -> llm_core.buildMessages / buildChatMessages   (system prompt +
//                                                        Vibe Schema flow ctx)
//       -> llm_core.generateWithProvider                (real HTTP to Ollama)
//       -> LLMJsonParser.extractVibeSchema              (parse a model reply)
//       -> FlowConverterCore.toNodeRed                  (importable flow)
//
// Model output is not deterministic, so the assertions are structural: a
// schema must be extractable and the flow it produces must be something
// RED.nodes.import would accept (real ids, resolvable wires, no leaked
// metadata). Scenarios that do not depend on the model's wording (prompt
// construction, credential stripping) are asserted exactly.
//
// Exit codes: 0 = passed, 1 = failed, 2 = skipped (endpoint or model absent).

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const Cfg = require(path.join(ROOT, 'src', 'core', 'flow_converter_core.js'));
const Parser = require(path.join(ROOT, 'src', 'core', 'llm_json_parser.js'));

// ------------------------------------------------------------------ //
//  Configuration                                                      //
// ------------------------------------------------------------------ //

const DEFAULTS = {
    provider: 'ollama',
    ollamaUrl: 'http://localhost:11434',
    model: 'gemma3:4b',
    timeoutMs: 180000,
    attempts: 2,
    showReplies: true
};

function loadConfig() {
    const file = path.join(ROOT, 'llm-test-config.json');
    let fromFile = {};
    if (fs.existsSync(file)) {
        try {
            fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error('Could not parse llm-test-config.json: ' + e.message);
            process.exit(1);
        }
    } else {
        console.log('(no llm-test-config.json - using built-in defaults; ' +
            'copy llm-test-config.example.json to customise)');
    }
    const cfg = Object.assign({}, DEFAULTS, fromFile);
    if (process.env.LLM_TEST_URL) cfg.ollamaUrl = process.env.LLM_TEST_URL;
    if (process.env.LLM_TEST_MODEL) cfg.model = process.env.LLM_TEST_MODEL;
    return cfg;
}

const CONFIG = loadConfig();

// ------------------------------------------------------------------ //
//  Harness                                                            //
// ------------------------------------------------------------------ //

let assertions = 0, failures = 0;
function ok(cond, msg, detail) {
    assertions++;
    if (cond) {
        console.log('  ok  ' + msg);
    } else {
        failures++;
        console.log('  FAIL ' + msg + (detail ? '\n       -> ' + detail : ''));
    }
}

function preview(text, max) {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max) + '...' : one;
}

function showReply(label, text) {
    if (!CONFIG.showReplies) return;
    const body = String(text || '').split('\n').map(l => '       | ' + l).join('\n');
    console.log('       --- ' + label + ' ---\n' + body.slice(0, 4000) +
        (body.length > 4000 ? '\n       | ...' : ''));
}

// Reachability + model presence, so an absent endpoint reads as "skipped"
// rather than a wall of failed assertions.
function preflight() {
    return new Promise(function (resolve) {
        let url;
        try { url = new URL(CONFIG.ollamaUrl); } catch (e) { return resolve({ ok: false, why: 'ollamaUrl is not a valid URL' }); }
        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: '/api/tags',
            method: 'GET',
            timeout: 5000
        }, function (res) {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', function () {
                try {
                    const names = (JSON.parse(Buffer.concat(chunks).toString('utf8')).models || [])
                        .map(m => m.name);
                    if (names.indexOf(CONFIG.model) === -1) {
                        return resolve({
                            ok: false,
                            why: 'model "' + CONFIG.model + '" is not installed (have: ' +
                                (names.join(', ') || 'none') + ')\n       pull it with:  ollama pull ' + CONFIG.model
                        });
                    }
                    resolve({ ok: true, models: names });
                } catch (e) {
                    resolve({ ok: false, why: 'unexpected /api/tags response: ' + e.message });
                }
            });
        });
        req.on('error', e => resolve({ ok: false, why: 'cannot reach ' + CONFIG.ollamaUrl + ' (' + e.message + ')' }));
        req.on('timeout', function () { req.destroy(); resolve({ ok: false, why: 'timed out contacting ' + CONFIG.ollamaUrl }); });
        req.end();
    });
}

// A stub runtime so the engine uses OUR endpoint and a throwaway userDir,
// never the developer's real settings or credentials file.
function makeCore() {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-roundtrip-'));
    const store = {
        credentialSecret: 'llm-roundtrip-test',
        llmPluginSettings: { provider: CONFIG.provider, ollamaUrl: CONFIG.ollamaUrl }
    };
    const RED = {
        settings: { userDir, get: k => store[k], set: (k, v) => { store[k] = v; } },
        log: { info() {}, warn() {}, error() {} },
        nodes: {}
    };
    return { core: require(path.join(ROOT, 'src', 'llm_core.js'))(RED), userDir };
}

// toNodeRed deliberately hands the importer some `_`-prefixed bookkeeping
// (see docs/{en,jp}/design.md 0 and test/metadata_props.test.js); the
// importer sweeps every `_` key before RED.nodes.import. This mirrors that
// sweep so the round-trip is validated at the same point the canvas sees it.
const CONVERTER_META_KEYS = { _llmOrder: 1, _llmSpecKeys: 1, _llmAlias: 1, _llmAboveId: 1 };

function stripMetadataLikeImporter(flow) {
    return flow.map(function (n) {
        const out = {};
        Object.keys(n).forEach(function (k) {
            if (k.charAt(0) !== '_') out[k] = n[k];
        });
        return out;
    });
}

// Everything RED.nodes.import needs to be true of a generated flow.
function validateFlow(flow, workspace) {
    const problems = [];
    if (!Array.isArray(flow)) return ['toNodeRed did not return an array'];
    const ids = new Set(flow.map(n => n && n.id));
    flow.forEach(function (n, i) {
        const at = 'node[' + i + ']' + (n && n.type ? ' (' + n.type + ')' : '');
        if (!n || typeof n !== 'object') { problems.push(at + ' is not an object'); return; }
        if (typeof n.id !== 'string' || !n.id) problems.push(at + ' has no id');
        if (typeof n.type !== 'string' || !n.type) problems.push(at + ' has no type');
        Object.keys(n).forEach(function (k) {
            if (k.charAt(0) === '_') problems.push(at + ' leaked internal metadata "' + k + '"');
        });
        if (Cfg.isConfigNode(n)) return; // config nodes have no canvas position
        if (n.z !== workspace) problems.push(at + ' has z="' + n.z + '", expected "' + workspace + '"');
        if (typeof n.x !== 'number' || typeof n.y !== 'number') problems.push(at + ' has no numeric x/y');
        if (n.wires !== undefined) {
            if (!Array.isArray(n.wires)) { problems.push(at + ' has non-array wires'); return; }
            n.wires.forEach(function (port, pi) {
                if (!Array.isArray(port)) { problems.push(at + ' wires[' + pi + '] is not an array'); return; }
                port.forEach(function (target) {
                    if (!ids.has(target)) problems.push(at + ' wires to unknown id "' + target + '"');
                });
            });
        }
    });
    return problems;
}

// Wrap a generation so a provider-side failure (the endpoint dying, or the
// model crashing its runner) is reported as an environment problem rather
// than surfacing as a plugin stack trace.
async function callModel(core, settings, messages) {
    try {
        return await core.generateWithProvider(
            CONFIG.provider, settings, CONFIG.model, messages, { timeoutMs: CONFIG.timeoutMs });
    } catch (e) {
        const err = new Error('the endpoint failed to generate: ' + (e && e.message ? e.message : e));
        err.environment = true;
        throw err;
    }
}

// Ask the model, then pull a Vibe Schema out of the reply. Small models
// sometimes answer in prose on the first go, so allow a second attempt -
// the same thing a user does when they press Send again.
async function generateSchema(core, settings, messages, label) {
    let lastReply = null;
    for (let attempt = 1; attempt <= Math.max(1, CONFIG.attempts); attempt++) {
        const started = Date.now();
        const reply = await callModel(core, settings, messages);
        lastReply = reply;
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        const schema = Parser.extractVibeSchema(reply, Cfg);
        console.log('       attempt ' + attempt + ': ' + elapsed + 's, ' +
            reply.length + ' chars, schema=' + (schema ? 'yes' : 'no'));
        if (schema) {
            showReply(label + ' (attempt ' + attempt + ')', reply);
            return { schema, reply, attempt };
        }
    }
    showReply(label + ' (no schema found)', lastReply);
    return { schema: null, reply: lastReply, attempt: CONFIG.attempts };
}

// ------------------------------------------------------------------ //
//  Scenarios                                                          //
// ------------------------------------------------------------------ //

async function main() {
    console.log('LLM round-trip test');
    console.log('  endpoint : ' + CONFIG.ollamaUrl);
    console.log('  model    : ' + CONFIG.model);
    console.log('  timeout  : ' + CONFIG.timeoutMs + 'ms, attempts: ' + CONFIG.attempts);

    const pre = await preflight();
    if (!pre.ok) {
        console.log('\nSKIPPED: ' + pre.why);
        process.exit(2);
    }
    console.log('  installed: ' + pre.models.join(', ') + '\n');

    const { core, userDir } = makeCore();
    const settings = core.getPluginSettings();

    // -------------------------------------------------------------- //
    console.log('Scenario 1: Ask mode - a plain question, a plain answer');
    // The sidebar with no flow selected, and the llm-request node's Ask mode.
    {
        const prompt = 'Node-RED の inject ノードは何をするノードですか。1〜2文で簡潔に答えてください。';
        const messages = core.buildChatMessages(prompt, settings);
        ok(messages[messages.length - 1].content === prompt, 'the user prompt is passed through verbatim');
        ok(!messages.some(m => /Vibe Schema/i.test(m.content)),
            'Ask mode carries no flow-building instructions');

        const started = Date.now();
        const reply = await callModel(core, settings, messages);
        console.log('       ' + ((Date.now() - started) / 1000).toFixed(1) + 's, ' + reply.length + ' chars');
        showReply('reply', reply);

        ok(typeof reply === 'string' && reply.trim().length > 0, 'the model returned non-empty text');
        ok(reply.trim().length > 10, 'the answer is more than a stray token', preview(reply, 120));
    }

    // -------------------------------------------------------------- //
    console.log('\nScenario 2: Agent mode - build a flow from nothing');
    {
        const prompt = '1秒ごとにタイムスタンプを送る inject ノードと、' +
            'それを受け取る debug ノードだけの、ごく単純なフローを作ってください。';
        const messages = core.buildMessages(prompt, null, null, settings);
        ok(/Vibe Schema/i.test(messages[0].content), 'the system prompt asks for Vibe Schema');

        const { schema } = await generateSchema(core, settings, messages, 'model reply');
        ok(!!schema, 'a Vibe Schema was extracted from the reply');

        if (schema) {
            ok(Cfg.isVibeSchema(schema), 'the extracted object is a well-formed Vibe Schema');
            const flow = Cfg.toNodeRed(schema, { workspace: 'tab-test' });
            console.log('       produced ' + flow.length + ' node(s): ' +
                flow.map(n => n.type).join(', '));
            ok(flow.length > 0, 'toNodeRed produced at least one node');

            // Converter output may carry bookkeeping for the importer, but
            // only keys the importer knows about.
            const unknownMeta = [];
            flow.forEach(n => Object.keys(n).forEach(function (k) {
                if (k.charAt(0) === '_' && !CONVERTER_META_KEYS[k]) unknownMeta.push(n.type + '.' + k);
            }));
            ok(unknownMeta.length === 0, 'converter metadata is limited to keys the importer sweeps',
                unknownMeta.join(', '));

            const canvasFlow = stripMetadataLikeImporter(flow);
            const problems = validateFlow(canvasFlow, 'tab-test');
            ok(problems.length === 0, 'the flow is importable by Node-RED', problems.join('\n       -> '));

            const aliases = Object.keys(schema.nodes || {});
            ok(!canvasFlow.some(n => aliases.indexOf(n.id) !== -1),
                'schema aliases were replaced with generated ids');
        }
    }

    // -------------------------------------------------------------- //
    console.log('\nScenario 3: Agent mode - edit an existing flow');
    {
        // What the sidebar sends when the user has a flow open and selected.
        const currentFlow = [
            { id: 'tab-test', type: 'tab', label: 'Test Flow' },
            { id: 'n-inject', type: 'inject', z: 'tab-test', name: 'every second', x: 100, y: 100, wires: [['n-debug']] },
            { id: 'n-debug', type: 'debug', z: 'tab-test', name: 'output', x: 300, y: 100, wires: [] }
        ];
        const prompt = 'この2つのノードの間に、payload を大文字に変換する function ノードを1つ挟んでください。';
        const messages = core.buildMessages(prompt, currentFlow, 'tab-test', settings);

        const system = messages[0].content;
        ok(/CURRENT FLOW/.test(system), 'the flow context is attached to the system prompt');
        ok(/inject/.test(system) && /debug/.test(system), 'the existing nodes appear in the context');
        ok(!/n-inject|n-debug/.test(system), 'raw Node-RED ids are not exposed to the model');
        ok(!/"x"\s*:\s*100/.test(system), 'canvas coordinates are not exposed to the model');

        const { schema } = await generateSchema(core, settings, messages, 'model reply');
        ok(!!schema, 'a Vibe Schema was extracted from the reply');

        if (schema) {
            const flow = Cfg.toNodeRed(schema, { workspace: 'tab-test' });
            console.log('       produced ' + flow.length + ' node(s): ' +
                flow.map(n => n.type).join(', '));
            const canvasFlow = stripMetadataLikeImporter(flow);
            const problems = validateFlow(canvasFlow, 'tab-test');
            ok(problems.length === 0, 'the edited flow is importable by Node-RED', problems.join('\n       -> '));
            ok(canvasFlow.some(n => n.type === 'function'),
                'the requested function node is present in the result',
                'types: ' + canvasFlow.map(n => n.type).join(', '));
        }
    }

    // -------------------------------------------------------------- //
    console.log('\nScenario 4: nothing secret rides along in the prompt');
    // Deterministic: this is about what we send, not what the model says.
    {
        const flowWithSecrets = [
            { id: 'tab-test', type: 'tab', label: 'Test Flow' },
            {
                id: 'n-mqtt', type: 'mqtt in', z: 'tab-test', topic: 'sensors/#',
                broker: 'b1', x: 100, y: 100, wires: [[]]
            },
            {
                id: 'b1', type: 'mqtt-broker', name: 'broker', broker: 'mqtt.local',
                credentials: { user: 'admin', password: 'SUPER-SECRET-PASSWORD' }
            }
        ];
        const system = core.buildMessages('このフローを説明してください。', flowWithSecrets, 'tab-test', settings)[0].content;

        ok(!/SUPER-SECRET-PASSWORD/.test(system), 'the credential value is stripped from the prompt');
        ok(!/"credentials"/.test(system), 'the credentials object itself is stripped');
        ok(/mqtt/.test(system), 'the rest of the flow still reaches the model');
    }

    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }

    console.log('\n' + (failures === 0
        ? assertions + ' passed, 0 failed'
        : (assertions - failures) + ' passed, ' + failures + ' failed'));
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(function (err) {
    if (err && err.environment) {
        console.log('\nSKIPPED: ' + err.message);
        console.log('         The plugin reported the failure correctly; the endpoint or model\n' +
            '         is what could not serve the request. Try another model with:\n' +
            '           LLM_TEST_MODEL=<name> npm run test:llm');
        process.exit(2);
    }
    console.error('\nUnexpected error: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
});
