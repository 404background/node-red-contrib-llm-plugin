// What happens to a reply whose JSON is not quite JSON.
//
// A model that drops one quote in a 40-node schema costs the whole reply: the
// parse fails, nothing is applied, and the only way forward is to ask again.
// So the parser reads a malformed block the way a person would — but only when
// the repair is unambiguous, and never at the cost of a block that was already
// valid. This suite pins both halves: what is recovered, and what is left to
// fail loudly rather than be guessed at.
//
// The schema-level behaviour of the recovered nodes belongs to
// flow_converter_core / import_safety; here the question is only whether the
// text parses at all, and into what.
const { ok, summary, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

const mock = buildEditorMock({ tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }], activeId: 'tab1' });
const sandbox = loadPluginSandbox(mock.RED);
const P = sandbox.LLMJsonParser;
const CFG = sandbox.FlowConverterCore;
const fence = (body) => 'Here you go.\n\n```json\n' + body + '\n```\n';

function schema(body) {
  return P.extractVibeSchema(fence(body), CFG);
}

// ------------------------------------------------------------------ //
//  Recovered                                                          //
// ------------------------------------------------------------------ //

function scenarioUnterminatedStringBeforeComma() {
  console.log('An unterminated string closes at the end of its line');
  // The real report: one missing quote, 40 nodes lost. The trailing comma is
  // a separator, not the last character of the flow name.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "inject_tick": { "type": "inject", "name": "tick", "flow": "Flow 1" },',
    '    "switch_band": {',
    '      "type": "switch",',
    '      "name": "band",',
    '      "flow": "Flow 1,',
    '      "props": { "property": "payload.t", "outputs": 3 }',
    '    },',
    '    "debug_out": { "type": "debug", "name": "out", "flow": "Flow 1" }',
    '  },',
    '  "connections": [{ "from": "switch_band", "to": "debug_out", "fromPort": 2 }]',
    '}',
  ].join('\n'));

  ok(!!s, 'the schema is recovered rather than discarded');
  ok(!!s && Object.keys(s.nodes).length === 3, 'with every node, not just the ones before the break');
  ok(!!s && s.nodes.switch_band.flow === 'Flow 1', 'the broken value is closed at the line end (' +
    (s && JSON.stringify(s.nodes.switch_band.flow)) + ')');
  ok(!!s && s.nodes.switch_band.props.outputs === 3, 'and the properties after it survive');
  ok(!!s && s.connections.length === 1 && s.connections[0].fromPort === 2,
    'as do the connections');
}

function scenarioMultiLineStringIsEscaped() {
  console.log('\nA value that really is multi-line is escaped instead');
  // No closing quote at the end of EITHER line, so "close at the line end"
  // cannot parse it and the other reading is the one that fits.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "function_calc": {',
    '      "type": "function",',
    '      "props": { "func": "let a = 1',
    'return msg;" }',
    '    }',
    '  }',
    '}',
  ].join('\n'));

  ok(!!s, 'the schema is recovered');
  const func = s && s.nodes.function_calc.props.func;
  ok(typeof func === 'string' && /let a = 1/.test(func) && /return msg;/.test(func),
    'both lines of the function body are kept (' + JSON.stringify(func) + ')');
}

function scenarioUnescapedQuotesStillRepaired() {
  console.log('\nUnescaped quotes inside a value are still repaired');
  const s = schema([
    '{',
    '  "nodes": {',
    '    "function_greet": {',
    '      "type": "function",',
    '      "props": { "func": "msg.payload = f\\"hello {name}\\"; return msg;" }',
    '    }',
    '  }',
    '}',
  ].join('\n').replace(/\\\\"/g, '"'));   // the model wrote them unescaped

  ok(!!s, 'the schema is recovered');
  ok(!!s && /hello \{name\}/.test(s.nodes.function_greet.props.func),
    'with the quoted text intact');
}

function scenarioJsonataKeepsItsOwnQuotes() {
  console.log('\nA JSONata expression keeps the quotes of its own literals');
  // The repair reads a value as "everything between the first quote and the
  // last one", which for an expression eats the delimiters of its first and
  // last string literal — and Node-RED then rejects the expression. Both
  // readings parse as JSON; only one of them is JSONata.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "change_warn": {',
    '      "type": "change",',
    '      "name": "format warning",',
    '      "props": { "rules": [{',
    '        "t": "set", "p": "payload.summary", "pt": "msg",',
    '        "to": "WARN " & payload.line & " over " & $string(payload.temp) & "C",',
    '        "tot": "jsonata"',
    '      }] }',
    '    }',
    '  }',
    '}',
  ].join('\n'));

  const to = s && s.nodes.change_warn.props.rules[0].to;
  ok(!!s, 'the schema is recovered');
  ok(to === '"WARN " & payload.line & " over " & $string(payload.temp) & "C"',
    'and the expression is whole, outer quotes included (' + JSON.stringify(to) + ')');

  // The other half of the same mistake: here it is only the LAST literal's
  // closing quote that the repair read as the end of the value.
  const t = schema([
    '{',
    '  "nodes": {',
    '    "change_suffix": {',
    '      "type": "change",',
    '      "props": { "rules": [{ "t": "set", "p": "payload.x", "pt": "msg",',
    '        "to": "payload.a & "-suffix", "tot": "jsonata" }] }',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  const suffix = t && t.nodes.change_suffix.props.rules[0].to;
  ok(suffix === 'payload.a & "-suffix"',
    'the trailing literal is closed again (' + JSON.stringify(suffix) + ')');
}

// ------------------------------------------------------------------ //
//  Not guessed at                                                     //
// ------------------------------------------------------------------ //

function scenarioUnambiguousExpressionsAreLeftAlone() {
  console.log('\nAn expression that already reads correctly is not re-quoted');
  // Each of these is the OTHER reading: the value starts outside a literal,
  // so what the repair produced is already the expression the model meant.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "change_concat": {',
    '      "type": "change",',
    '      "props": { "rules": [{ "t": "set", "p": "payload.x", "pt": "msg",',
    '        "to": "payload.a & "-" & payload.b", "tot": "jsonata" }] }',
    '    },',
    '    "change_ternary": {',
    '      "type": "change",',
    '      "props": { "rules": [{ "t": "set", "p": "payload.s", "pt": "msg",',
    '        "to": "payload.t >= 85 ? "alert" : "ok"", "tot": "jsonata" }] }',
    '    }',
    '  }',
    '}',
  ].join('\n'));

  ok(!!s, 'the schema is recovered');
  ok(!!s && s.nodes.change_concat.props.rules[0].to === 'payload.a & "-" & payload.b',
    'a concatenation keeps its shape (' +
    (s && JSON.stringify(s.nodes.change_concat.props.rules[0].to)) + ')');
  ok(!!s && s.nodes.change_ternary.props.rules[0].to === 'payload.t >= 85 ? "alert" : "ok"',
    'and so does a ternary (' +
    (s && JSON.stringify(s.nodes.change_ternary.props.rules[0].to)) + ')');
}

function scenarioArrayOfStringsSurvivesTheRepair() {
  console.log('\nAn array of strings is not read as a row of keys');
  // One broken value sends the WHOLE block through the quote repair, and the
  // repair used to decide "key or value" by looking back for a `:`. Inside an
  // array there is none, so every element was read as a key — whose end is a
  // `:`, not a `,` — and the commas were swallowed into the string.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "change_warn": { "type": "change", "props": { "rules": [{ "t": "set",',
    '      "p": "payload.s", "pt": "msg", "to": "WARN " & payload.line, "tot": "jsonata" }] } }',
    '  },',
    '  "reposition": ["change_warn", "debug_out"]',
    '}',
  ].join('\n'));

  ok(!!s, 'the schema is recovered');
  ok(Array.isArray(s && s.reposition) && s.reposition.length === 2 &&
     s.reposition[0] === 'change_warn' && s.reposition[1] === 'debug_out',
    'and reposition still lists two aliases (' + JSON.stringify(s && s.reposition) + ')');
}

function scenarioValidJsonIsUntouched() {
  console.log('\nValid JSON is never "repaired"');
  // A value that legitimately ends in a comma is exactly what the
  // close-at-line-end repair would damage — so it must never run here.
  const s = schema([
    '{',
    '  "nodes": {',
    '    "change_join": {',
    '      "type": "change",',
    '      "props": { "rules": [{ "t": "set", "p": "payload", "to": "a,", "tot": "str" }] }',
    '    }',
    '  }',
    '}',
  ].join('\n'));

  ok(!!s, 'the schema parses');
  ok(!!s && s.nodes.change_join.props.rules[0].to === 'a,',
    'and the trailing comma inside the value is left alone (' +
    (s && JSON.stringify(s.nodes.change_join.props.rules[0].to)) + ')');
}

function scenarioBeyondRepairIsReported() {
  console.log('\nA block beyond repair is reported, not silently dropped');
  const broken = fence('{ "nodes": { "inject_a": { "type": ');
  ok(P.extractFlowNodes(broken, {}, CFG) === null, 'nothing is extracted');

  const diag = P.diagnoseJsonExtractionFailure(broken);
  ok(!!diag && !!diag.error, 'the failure is described');
  ok(!!diag && typeof diag.line === 'number', 'with the line it failed on (line ' +
    (diag && diag.line) + ')');
}

function scenarioRepairedBlockIsNotReportedAsFailed() {
  console.log('\nA block the parser recovered is not reported as a failure');
  const recovered = fence([
    '{',
    '  "nodes": {',
    '    "debug_out": {',
    '      "type": "debug",',
    '      "name": "out,',
    '      "flow": "Flow 1"',
    '    }',
    '  }',
    '}',
  ].join('\n'));
  ok(P.diagnoseJsonExtractionFailure(recovered) === null,
    'diagnose agrees with the parser, so no warning contradicts a successful import');
}

// ------------------------------------------------------------------ //
//  The sidebar's own reading of a block                               //
// ------------------------------------------------------------------ //

function scenarioParseJsonBlockReportsTheRepair() {
  console.log('\nparseJsonBlock reads a block the way the import will');
  // The sidebar folds a JSON block into <details> on this. Reading it any
  // more strictly than the importer does is how a reply the plugin went on
  // to import correctly was left unfoldable, filling the panel.
  const clean = P.parseJsonBlock('{ "nodes": { "debug_out": { "type": "debug" } } }');
  ok(!!clean && clean.repaired === false, 'valid JSON is read as written');
  ok(!!clean && clean.value.nodes.debug_out.type === 'debug', 'and parsed');

  const broken = P.parseJsonBlock([
    '{ "nodes": { "change_warn": { "type": "change", "props": { "rules": [',
    '  { "t": "set", "p": "payload.s", "pt": "msg",',
    '    "to": "WARN " & payload.line & "!", "tot": "jsonata" }',
    '] } } } }',
  ].join('\n'));
  ok(!!broken && broken.repaired === true, 'a block that needed repair says so');
  ok(!!broken && broken.value.nodes.change_warn.props.rules[0].to ===
    '"WARN " & payload.line & "!"', 'and carries the repaired value (' +
    (broken && JSON.stringify(broken.value.nodes.change_warn.props.rules[0].to)) + ')');

  ok(P.parseJsonBlock('{ "nodes": { "inject_a": { "type": ') === null,
    'a block beyond repair reads as nothing');
  ok(P.parseJsonBlock('not json at all') === null, 'and so does prose');
}

// Small models (gemma3:4b, gemma4:e2b in the live round-trip) write the nodes
// as a list with the alias inside. The meaning is plain, so it is read as the
// map form — and a raw Node-RED array, which has no alias, is not.
function scenarioAnAliasListReadsAsTheMap() {
  console.log('\nNodes written as a list with their aliases inside');
  const listed = schema(JSON.stringify({
    nodes: [{ alias: 'inject_tick', type: 'inject', name: 'tick' }, { alias: 'debug_out', type: 'debug' }],
    connections: [{ from: 'inject_tick', to: 'debug_out' }],
  }));
  ok(listed && listed.nodes && listed.nodes.inject_tick && listed.nodes.inject_tick.type === 'inject' &&
     !('alias' in listed.nodes.inject_tick) && listed.nodes.debug_out,
    '`nodes: [{ alias, ... }]` reads as the alias map');

  const flat = schema(JSON.stringify([
    { alias: 'inject_tick', type: 'inject' }, { alias: 'debug_out', type: 'debug' },
    { from: 'inject_tick', to: 'debug_out' },
  ]));
  ok(flat && flat.nodes && flat.nodes.debug_out && flat.connections.length === 1 &&
     flat.connections[0].to === 'debug_out',
    'and so does one list of aliased nodes and connections');

  const nodes = P.extractFlowNodes(fence(JSON.stringify({
    nodes: [{ alias: 'inject_tick', type: 'inject' }, { alias: 'debug_out', type: 'debug' }],
    connections: [{ from: 'inject_tick', to: 'debug_out' }],
  })), {}, CFG);
  ok(Array.isArray(nodes) && nodes.length === 2, 'which converts to nodes (' + (nodes && nodes.length) + ')');

  const perSequence = schema(JSON.stringify([
    { nodes: [{ alias: 'inject_temp', type: 'inject' }, { alias: 'debug_temp', type: 'debug' }],
      connections: [{ from: 'inject_temp', to: 'debug_temp' }] },
    { nodes: { inject_hum: { type: 'inject' }, debug_hum: { type: 'debug' } },
      connections: [{ from: 'inject_hum', to: 'debug_hum' }] },
  ]));
  ok(perSequence && Object.keys(perSequence.nodes).length === 4 && perSequence.connections.length === 2,
    'and one schema per sequence, listed, reads as one schema');

  const byName = schema(JSON.stringify({
    nodes: { switch_check: { type: 'switch', name: 'payload_check' }, debug_high: { type: 'debug', name: 'high' } },
    connections: [{ from: 'payload_check', to: 'high' }, { from: 'inject_tick', to: 'switch_check' }],
  }));
  ok(byName && byName.connections[0].from === 'switch_check' && byName.connections[0].to === 'debug_high' &&
     byName.connections[1].from === 'inject_tick',
    'a connection naming a declared node by its name means that node; an alias it does not declare is kept');

  const topRemove = schema(JSON.stringify({ remove: { from: 'inject_tick', to: 'debug_a' } }));
  ok(topRemove && topRemove.connections && topRemove.connections[0].remove &&
     topRemove.connections[0].remove.to === 'debug_a' && !('remove' in topRemove),
    'a connection delete written at the top level reads as one in connections');
  const nodeRemove = schema(JSON.stringify({ nodes: { debug_a: null }, remove: ['debug_b'] }));
  ok(nodeRemove && JSON.stringify(nodeRemove.remove) === '["debug_b"]',
    'while a remove of aliases stays a node delete');

  // The prompt teaches `delete`; `null` and `remove` are still read.
  const taught = schema(JSON.stringify({ delete: ['debug_a'], connections: [{ delete: { from: 'inject_tick', to: 'debug_b' } }] }));
  ok(taught && JSON.stringify(taught.delete) === '["debug_a"]' && taught.connections[0].remove &&
     taught.connections[0].remove.to === 'debug_b' && !('delete' in taught.connections[0]),
    '`delete` lists node deletes, and `{ delete: { from, to } }` in connections is a connection delete');
  const mixed = schema(JSON.stringify({ delete: ['debug_a', { from: 'inject_tick', to: 'debug_b' }] }));
  ok(mixed && JSON.stringify(mixed.delete) === '["debug_a"]' && mixed.connections[0].remove.to === 'debug_b',
    'a connection among the aliases in a top-level `delete` reads as a connection delete');
  const word = schema(JSON.stringify({ nodes: { debug_a: 'delete', debug_log: { type: 'debug' } } }));
  ok(word && word.nodes.debug_a === null, '`"debug_a": "delete"` reads as a delete of debug_a');

  const aliasNull = schema(JSON.stringify({ nodes: { debug_extra: { alias: null }, debug_log: { type: 'debug' } } }));
  ok(aliasNull && aliasNull.nodes.debug_extra === null && aliasNull.nodes.debug_log.type === 'debug',
    '`"debug_extra": { "alias": null }` reads as a delete of debug_extra');

  // gemma4:e4b lists nodes the way an export does, keyed by `id`.
  const byIds = schema(JSON.stringify({
    nodes: [{ id: 'inject_temp', type: 'inject', name: 'T', repeat: '2', x: 100, y: 100, wires: [['debug_temp']] },
            { id: 'debug_temp', type: 'debug', name: 'D', x: 300, y: 100 },
            { id: 'inject_hum', type: 'inject', name: 'H' }, { id: 'debug_hum', type: 'debug', name: 'HD' }],
    connections: [{ from: 'inject_hum', to: 'debug_hum' }],
  }));
  ok(byIds && byIds.nodes.inject_temp && byIds.nodes.inject_temp.repeat === '2' && !('x' in byIds.nodes.inject_temp) &&
     !('id' in byIds.nodes.inject_temp) && byIds.connections.length === 2 &&
     byIds.connections.some((c) => c.from === 'inject_temp' && c.to === 'debug_temp'),
    'nodes listed by `id` read with the id as alias, their wires as connections (' + JSON.stringify(byIds && byIds.connections) + ')');

  const bare = schema('"nodes": { "debug_a": { "type": "debug" } }');
  ok(bare && bare.nodes.debug_a && bare.nodes.debug_a.type === 'debug', 'a reply with the outer braces left off still reads');

  const objDelete = schema(JSON.stringify({ connections: { remove: { from: 'inject_tick', to: 'debug_extra' } } }));
  ok(objDelete && Array.isArray(objDelete.connections) && objDelete.connections[0].remove &&
     objDelete.connections[0].remove.to === 'debug_extra',
    '`connections: { remove: { from, to } }` is a connection delete, not wires from a node called remove');

  // qwen3.5:9b / gemma4:e4b wire both routes of a switch with no port.
  const spread = schema(JSON.stringify({
    nodes: { switch_level: { type: 'switch', props: { rules: [{ t: 'gte', v: '10', vt: 'num' }, { t: 'else' }] } },
             debug_high: { type: 'debug' }, debug_low: { type: 'debug' } },
    connections: [{ from: 'switch_level', to: 'debug_high' }, { from: 'switch_level', to: 'debug_low' }],
  }));
  ok(spread && spread.connections[0].fromPort === 0 && spread.connections[1].fromPort === 1,
    'N unported wires from a declared N-output node take one port each, in order');
  const fanOut = schema(JSON.stringify({
    nodes: { function_f: { type: 'function', props: { func: 'return msg;', outputs: 1 } }, debug_a: { type: 'debug' }, debug_b: { type: 'debug' } },
    connections: [{ from: 'function_f', to: 'debug_a' }, { from: 'function_f', to: 'debug_b' }],
  }));
  ok(fanOut && fanOut.connections.every((c) => c.fromPort === undefined), 'while a one-output node fanning out is left alone');
  const notACount = schema(JSON.stringify({
    nodes: { function_f: { type: 'function', props: { func: 'return [msg, null];', outputs: true } }, debug_a: { type: 'debug' }, debug_b: { type: 'debug' } },
    connections: [{ from: 'function_f', to: 'debug_a', fromPort: 0 }, { from: 'function_f', to: 'debug_b', fromPort: '1' }],
  }));
  ok(notACount && notACount.nodes.function_f.props.outputs === 2 && notACount.connections[1].fromPort === 1,
    'a function whose outputs is not a count has as many as its wires name (' + JSON.stringify(notACount && notACount.nodes.function_f.props) + ')');

  // gemma3:4b lists `delete` beside nodes it restates, and deletes a
  // connection from a node to itself when asked to disable it.
  const contradictory = schema(JSON.stringify({
    delete: ['debug_log', 'debug_old'],
    nodes: { debug_log: { type: 'debug', name: 'log' } },
    connections: [{ delete: { from: 'debug_log', to: 'debug_log' } }, { delete: { from: 'inject_tick', to: 'debug_old' } }],
  }));
  ok(contradictory && JSON.stringify(contradictory.delete) === '["debug_old"]',
    'a node the reply both deletes and declares is kept (' + JSON.stringify(contradictory && contradictory.delete) + ')');
  ok(contradictory && contradictory.connections.length === 1 && contradictory.connections[0].remove.to === 'debug_old',
    'and a connection deleted from a node to itself is dropped');

  // gemma4:12b keys the connections by their source.
  const keyed = schema(JSON.stringify({
    nodes: { inject_t: { type: 'inject' }, debug_t: { type: 'debug' }, debug_u: { type: 'debug' } },
    connections: { inject_t: { to: ['debug_t', 'debug_u'] }, debug_x: 'debug_t' },
  }));
  ok(keyed && Array.isArray(keyed.connections) && keyed.connections.length === 3 &&
     keyed.connections[0].from === 'inject_t' && keyed.connections[1].to === 'debug_u' && keyed.connections[2].from === 'debug_x',
    'connections keyed by their source read as the list (' + JSON.stringify(keyed && keyed.connections) + ')');

  const oneBased = schema(JSON.stringify({
    nodes: { switch_v: { type: 'switch', props: { rules: [{ t: 'gte', v: '10', vt: 'num' }, { t: 'else' }] } },
             function_f: { type: 'function', props: { outputs: 2 } } },
    connections: [{ from: 'switch_v', to: 'debug_h', fromPort: 1 }, { from: 'switch_v', to: 'debug_l', fromPort: 2 },
                  { from: 'function_f', to: 'debug_a', fromPort: 0 }, { from: 'function_f', to: 'debug_b', fromPort: 1 }],
  }));
  ok(oneBased && oneBased.connections[0].fromPort === 0 && oneBased.connections[1].fromPort === 1,
    'ports counted from 1 (the last one out of range) are shifted to count from 0');
  ok(oneBased && oneBased.connections[2].fromPort === 0 && oneBased.connections[3].fromPort === 1,
    'while ports already counted from 0 are left alone');

  const raw = [{ id: 'a', type: 'inject', z: 't', wires: [['b']] }, { id: 'b', type: 'debug', z: 't', wires: [] }];
  ok(schema(JSON.stringify(raw)) === null, 'a raw Node-RED array is not mistaken for one');
}

scenarioParseJsonBlockReportsTheRepair();
scenarioAnAliasListReadsAsTheMap();
scenarioUnterminatedStringBeforeComma();
scenarioMultiLineStringIsEscaped();
scenarioUnescapedQuotesStillRepaired();
scenarioJsonataKeepsItsOwnQuotes();
scenarioUnambiguousExpressionsAreLeftAlone();
scenarioArrayOfStringsSurvivesTheRepair();
scenarioValidJsonIsUntouched();
scenarioBeyondRepairIsReported();
scenarioRepairedBlockIsNotReportedAsFailed();
summary();
