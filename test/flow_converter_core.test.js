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

let passed = 0, failed = 0;
function it(label, fn) {
    try {
        fn();
        console.log('  ok  ' + label);
        passed++;
    } catch (e) {
        console.log('  FAIL ' + label);
        console.log('       ' + (e && e.message ? e.message : e));
        failed++;
    }
}

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

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
