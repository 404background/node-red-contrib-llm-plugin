// Regression tests for flow_converter_core.js auto-stub creation.
// Run with `node test/flow_converter_core.test.js`.
//
// The historical bug: the auto-stub scan in toNodeRed treated a config
// node's OWN value props as dangling config references. An mqtt-broker's
// `broker: "localhost"` (its hostname) matched CONFIG_REF_KEYS.broker →
// mqtt-broker, so a spurious stub broker named "localhost" was created and
// the real broker's hostname was replaced by the stub's generated id.
// Fixed by skipping the stub when the mapped type equals the node's own
// type (cross-type refs like ui-group's `tab` → ui-tab still stub).

const Cfg = require('../src/core/flow_converter_core.js');
const assert = require('assert');
const { it, summary } = require('./helpers.js');

function byType(flow, type) {
    return flow.filter(function(n) { return n.type === type; });
}

// --- vibe-schema.md Example 1: broker hostname must survive intact ---
it('config node own props are not mistaken for config references', function() {
    const flow = Cfg.toNodeRed({
        nodes: {
            mqtt_out_publish: {
                type: 'mqtt out', name: 'Publish',
                props: { topic: 'sensors/ticks', broker: 'broker_cfg' }
            },
            broker_cfg: {
                type: 'mqtt-broker', name: 'Local broker', config: true,
                props: { broker: 'localhost', port: '1883' }
            }
        },
        connections: []
    }, { workspace: 'ws' });

    const brokers = byType(flow, 'mqtt-broker');
    assert.strictEqual(brokers.length, 1,
        'expected exactly 1 mqtt-broker, got ' + brokers.length + ' (spurious stub?)');
    assert.strictEqual(brokers[0].broker, 'localhost',
        'broker hostname was replaced: ' + brokers[0].broker);
    assert.strictEqual(brokers[0].port, '1883');

    const out = byType(flow, 'mqtt out')[0];
    assert.strictEqual(out.broker, brokers[0].id,
        'mqtt out should reference the defined broker by id');
});

it('self-type guard also covers the "…config"-key strategy', function() {
    const flow = Cfg.toNodeRed({
        nodes: {
            venv_cfg: {
                type: 'venv-config', name: 'py env', config: true,
                props: { venvconfig: 'primary' }
            }
        },
        connections: []
    }, { workspace: 'ws' });
    assert.strictEqual(byType(flow, 'venv-config').length, 1,
        'a venv-config prop key on a venv-config node must not stub another venv-config');
});

// --- The intended auto-stub feature must keep working ---
it('dangling broker ref on a CANVAS node still auto-stubs', function() {
    const flow = Cfg.toNodeRed({
        nodes: {
            mqtt_out_publish: {
                type: 'mqtt out', name: 'Publish',
                props: { topic: 't', broker: 'my_broker' }
            }
        },
        connections: []
    }, { workspace: 'ws' });
    const brokers = byType(flow, 'mqtt-broker');
    assert.strictEqual(brokers.length, 1, 'missing auto-stub for dangling broker ref');
    assert.strictEqual(byType(flow, 'mqtt out')[0].broker, brokers[0].id);
});

it('cross-type config→config ref (ui_group.tab → ui-tab) still auto-stubs', function() {
    const flow = Cfg.toNodeRed({
        nodes: {
            group_main: {
                type: 'ui_group', name: 'Main', config: true,
                props: { tab: 'dash_tab' }
            }
        },
        connections: []
    }, { workspace: 'ws' });
    const tabs = byType(flow, 'ui-tab');
    assert.strictEqual(tabs.length, 1, 'ui-tab stub should still be created for ui_group.tab');
    assert.strictEqual(byType(flow, 'ui_group')[0].tab, tabs[0].id);
});

it('non-alias-shaped values (URLs, paths, numbers) never stub', function() {
    const flow = Cfg.toNodeRed({
        nodes: {
            broker_cfg2: {
                type: 'mqtt-broker', name: 'B', config: true,
                props: { broker: '192.168.0.10', port: '1883' }
            }
        },
        connections: []
    }, { workspace: 'ws' });
    assert.strictEqual(byType(flow, 'mqtt-broker').length, 1);
    assert.strictEqual(byType(flow, 'mqtt-broker')[0].broker, '192.168.0.10');
});

// --- Full vibe-schema.md Example 1 sanity: node count + wiring ---
it('vibe-schema.md Example 1 produces exactly its 5 declared nodes', function() {
    const flow = Cfg.toNodeRed({
        description: 'Tick → format → publish',
        nodes: {
            comment_publish_pipeline: { type: 'comment', name: 'Publish pipeline', above: 'inject_tick' },
            inject_tick: { type: 'inject', name: 'Tick', props: { payload: '', payloadType: 'date' } },
            function_format: { type: 'function', name: 'Format', props: { func: 'msg.payload = { ts: msg.payload }; return msg;' } },
            mqtt_out_publish: { type: 'mqtt out', name: 'Publish', props: { topic: 'sensors/ticks', broker: 'broker_cfg' } },
            broker_cfg: { type: 'mqtt-broker', name: 'Local broker', config: true, props: { broker: 'localhost', port: '1883' } }
        },
        connections: [
            { from: 'inject_tick', to: 'function_format' },
            { from: 'function_format', to: 'mqtt_out_publish' }
        ]
    }, { workspace: 'ws' });

    assert.strictEqual(flow.length, 5, 'expected 5 nodes, got ' + flow.length);
    const inject = byType(flow, 'inject')[0];
    const fn = byType(flow, 'function')[0];
    const out = byType(flow, 'mqtt out')[0];
    assert.deepStrictEqual(inject.wires, [[fn.id]]);
    assert.deepStrictEqual(fn.wires, [[out.id]]);
    assert.deepStrictEqual(out.wires, []);
});

// --- A type written the way aliases spell it ---
it('http_in / http_response mean http in / http response; an unknown underscore type is kept', function() {
    const flow = Cfg.toNodeRed({
        nodes: { a: { type: 'http_in', props: { url: '/x' } }, b: { type: 'http_response' }, c: { type: 'my_custom_node' } },
        connections: [{ from: 'a', to: 'b' }]
    }, { workspace: 'ws' });
    assert.deepStrictEqual(flow.map((n) => n.type).sort(), ['http in', 'http response', 'my_custom_node']);
    const hin = byType(flow, 'http in')[0], hout = byType(flow, 'http response')[0];
    assert.deepStrictEqual(hin.wires, [[hout.id]]);
});

// --- Properties written under `config` ---
// `config` is the config-node flag; models also use it as `props`.
it('properties written under config reach the node, and props win a clash', function() {
    const flow = Cfg.toNodeRed({
        nodes: { http_in_hello: { type: 'http in', config: { url: '/hello', method: 'get' }, props: { method: 'post' } } },
        connections: []
    }, { workspace: 'ws' });
    const n = byType(flow, 'http in')[0];
    assert.strictEqual(n.url, '/hello');
    assert.strictEqual(n.method, 'post');
    assert.ok(n.z === 'ws' && typeof n.x === 'number', 'still a canvas node, not a config node');
});

// --- A debug asked for the whole message ---
// Models write `complete: "msg"` or `true`; the editor's value is `"true"`.
it('a debug told to show msg shows the whole message', function() {
    ['msg', true].forEach(function(complete) {
        const flow = Cfg.toNodeRed({
            nodes: { debug_x: { type: 'debug', props: { complete: complete } } }, connections: []
        }, { workspace: 'ws' });
        const d = byType(flow, 'debug')[0];
        assert.strictEqual(d.complete, 'true', JSON.stringify(complete) + ' -> ' + JSON.stringify(d.complete));
        assert.strictEqual(d.targetType, 'full');
    });
});

// --- The single-line `func` pretty-printer may only touch whitespace ---
// Its character walk models string literals but NOT regex literals or
// comments, so a `/"/` or a `// note {` can flip it into the wrong state.
// That must never cost the user a character of their function body.
it('reformatting a function body never changes anything but whitespace', function() {
    const bodies = [
        // A quote inside a regex literal: the walker reads it as a string open.
        'msg.payload = String(msg.payload).replace(/["{}]/g, ""); return msg;',
        // A line comment carrying braces and a quote.
        'let a = 1; // it\'s { fine } return msg;\nreturn msg;',
        // Plain single-line code — the case the formatter exists for.
        'let x = 1; if (x > 0) { x = x + 1; } return { payload: x };',
        // A template literal holding a brace pair.
        'msg.topic = `a${msg.payload}b`; return msg;',
    ];
    const strip = (s) => s.replace(/\s+/g, '');
    bodies.forEach(function(func) {
        const flow = Cfg.toNodeRed({
            nodes: { function_x: { type: 'function', name: 'X', props: { func: func } } },
            connections: []
        }, { workspace: 'ws' });
        const fn = byType(flow, 'function')[0];
        assert.strictEqual(strip(fn.func), strip(func),
            'function body changed beyond whitespace:\n  in:  ' + func + '\n  out: ' + fn.func);
    });
});

// What the small models wrote in the live scenarios (test/llm_scenarios.test.js).
it('an http in written `http-in`, with GET and a path, is a working http in', function() {
    const flow = Cfg.toNodeRed({
        nodes: { http_hello: { type: 'http-in', name: 'hello', props: { method: ['GET'], path: 'hello' } },
                 http_out: { type: 'http_response' } },
        connections: [{ from: 'http_hello', to: 'http_out' }]
    }, { workspace: 'ws' });
    const hin = byType(flow, 'http in')[0];
    assert(hin && hin.method === 'get' && hin.url === '/hello' && hin.path === undefined,
        JSON.stringify(hin));
    assert(byType(flow, 'http response').length === 1, 'the response is an http response');
    const full = Cfg.toNodeRed({ nodes: { http_a: { type: 'http in', props: { url: 'http://localhost:1880/a', method: 'POST' } } } }, { workspace: 'ws' });
    assert.strictEqual(byType(full, 'http in')[0].url, '/a');
});

it('an inject repeat written with a unit is seconds', function() {
    const every = (repeat) => byType(Cfg.toNodeRed({ nodes: { inject_t: { type: 'inject', props: { repeat: repeat } } } },
        { workspace: 'ws' }), 'inject')[0].repeat;
    assert.strictEqual(every('2 seconds'), '2');
    assert.strictEqual(every('5 min'), '300');
    assert.strictEqual(every(3), '3');
    assert.strictEqual(every('10'), '10');
});

it('a template body under a key of the model\'s choosing is the template', function() {
    const flow = Cfg.toNodeRed({ nodes: { template_f: { type: 'template', props: { expression: 'Time is {{payload}}' } } } },
        { workspace: 'ws' });
    const t = byType(flow, 'template')[0];
    assert(t.template === 'Time is {{payload}}' && t.expression === undefined, JSON.stringify(t));
});

it('`config: true` on a node drawn on the canvas does not make it a config node', function() {
    const flow = Cfg.toNodeRed({
        nodes: { function_f: { type: 'function', config: true, props: { func: 'return msg;', outputs: 1 } },
                 debug_d: { type: 'debug', config: true } },
        connections: [{ from: 'function_f', to: 'debug_d' }]
    }, { workspace: 'ws' });
    const fn = byType(flow, 'function')[0];
    assert(fn && typeof fn.x === 'number' && fn.z === 'ws' && fn.wires[0].length === 1, JSON.stringify(fn));
});

summary();
