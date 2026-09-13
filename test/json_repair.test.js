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

// ------------------------------------------------------------------ //
//  Not guessed at                                                     //
// ------------------------------------------------------------------ //

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

scenarioUnterminatedStringBeforeComma();
scenarioMultiLineStringIsEscaped();
scenarioUnescapedQuotesStillRepaired();
scenarioValidJsonIsUntouched();
scenarioBeyondRepairIsReported();
scenarioRepairedBlockIsNotReportedAsFailed();
summary();
