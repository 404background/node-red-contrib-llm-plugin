// The two conventions governing how a node crosses the Vibe Schema boundary.
// Both are enforced in the same three places (toIntermediate, toNodeRed, the
// importer), so they share one harness.
//
// (1) METADATA — `_`-prefixed keys never reach the LLM and never reach the
//     canvas. The historical leak: `_llmAboveId` was consumed by the layout
//     pass but never deleted, so it rode into RED.nodes.import.
//     docs/{en,jp}/design.md §0.
//
// (2) EDITOR FLAGS — Node-RED's `d` / `l` are surfaced under the editor's own
//     words, present only when set. `disabled: false` re-enables by REMOVING
//     `d`, and the merge must not restore the node's previous `d: true`.
//     docs/{en,jp}/vibe-schema.md "Editor flags".

const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');
const Cfg = require('../src/core/flow_converter_core.js');

function metaKeysOf(obj) {
  return Object.keys(obj || {}).filter((k) => k.charAt(0) === '_');
}

// ------------------------------------------------------------------ //
//  (A) Outbound: nothing metadata-shaped reaches the LLM              //
// ------------------------------------------------------------------ //

function outboundKeepsMetadataOut() {
  console.log('Outbound (toIntermediate): the LLM sees no metadata');
  // A flow whose nodes carry every metadata key the plugin can attach.
  const flow = [
    { id: 'a', type: 'inject', z: 'tab1', name: 'A', x: 100, y: 100, wires: [['b']],
      _llmOrder: 0, _llmAlias: 'inject_a', _llmSpecKeys: ['name'] },
    { id: 'b', type: 'function', z: 'tab1', name: 'B', x: 300, y: 100, func: 'return msg;', wires: [[]],
      _llmAboveId: 'a', _autoStub: true },
    { id: 'c', type: 'comment', z: 'tab1', name: 'Note', x: 300, y: 40, info: 'hi', wires: [],
      _llmAbove: 'function_b', _llmAboveId: 'b' },
  ];
  const inter = Cfg.toIntermediate(flow);
  const leaked = [];
  Object.keys(inter.nodes).forEach((alias) => {
    const entry = inter.nodes[alias];
    metaKeysOf(entry).forEach((k) => leaked.push(alias + '.' + k));
    metaKeysOf(entry.props).forEach((k) => leaked.push(alias + '.props.' + k));
  });
  ok(leaked.length === 0, 'no `_` key in the emitted schema (' + (leaked.join(', ') || 'none') + ')');

  // The same guarantee for the deterministic fields the code owns.
  const serialized = JSON.stringify(inter);
  ok(serialized.indexOf('"id"') === -1, 'no node IDs in the emitted schema');
  ok(!/"[xy]":/.test(serialized), 'no coordinates in the emitted schema');
  ok(inter.nodes.function_b && inter.nodes.function_b.props.func === 'return msg;',
    'real properties still pass through');

  // includeIdMap is an internal caller aid; llm_core deletes it before the
  // prompt. It must stay `_`-prefixed so the convention flags it as such.
  const withMap = Cfg.toIntermediate(flow, { includeIdMap: true });
  ok(metaKeysOf(withMap).indexOf('_meta') !== -1, 'the id map is exposed as `_meta` (metadata-named)');
}

// ------------------------------------------------------------------ //
//  (B1) Inbound: a schema cannot forge metadata                       //
// ------------------------------------------------------------------ //

function inboundIgnoresForgedMetadata() {
  console.log('\nInbound (toNodeRed): a schema cannot forge metadata');
  const schema = {
    nodes: {
      function_x: {
        type: 'function',
        name: 'X',
        _autoStub: true,           // would have skipped Config Node Protection
        _llmSpecKeys: ['func'],    // would have faked "the LLM set this"
        props: { func: 'return msg;', _llmAboveId: 'nope' },
      },
    },
    connections: [],
  };
  const flow = Cfg.toNodeRed(schema, { workspace: 'tab1', preserveAlias: true });
  const fn = flow.find((n) => n.type === 'function');
  ok(!!fn, 'function node produced');
  ok(fn._autoStub === undefined, 'schema-supplied `_autoStub` ignored');
  ok(fn._llmAboveId === undefined, 'schema-supplied `_llmAboveId` in props ignored');
  ok(fn._llmSpecKeys.indexOf('_llmSpecKeys') === -1 && fn._llmSpecKeys.indexOf('_autoStub') === -1,
    '_llmSpecKeys lists only real properties');
  ok(fn.func === 'return msg;', 'real property still applied');
  ok(fn._llmAlias === 'function_x', 'converter-owned metadata is still attached for the importer');
}

// ------------------------------------------------------------------ //
//  (B2) Inbound end-to-end: nothing `_`-prefixed reaches the canvas   //
// ------------------------------------------------------------------ //

// ------------------------------------------------------------------ //
//  (A) Outbound: the model reads the flags under their editor names   //
// ------------------------------------------------------------------ //

function outboundRenamesFlags() {
  console.log('Outbound (toIntermediate): single-letter flags become editor names');
  const flow = [
    { id: 't1', type: 'tab', label: 'Flow 1' },
    { id: 'a', type: 'inject', z: 't1', name: 'Tick', x: 100, y: 100, d: true,
      repeat: '5', payloadType: 'date', wires: [['b']] },
    { id: 'b', type: 'debug', z: 't1', name: 'Out', x: 300, y: 100, l: false, wires: [] },
    { id: 'c', type: 'function', z: 't1', name: 'Plain', x: 500, y: 100, func: 'return msg;', wires: [] },
  ];
  const nodes = Cfg.toIntermediate(flow).nodes;

  ok(nodes.inject_tick.disabled === true, 'a disabled node is flagged `disabled: true`');
  ok(!('d' in nodes.inject_tick) && !('d' in (nodes.inject_tick.props || {})),
    'the raw `d` key is gone from the schema');
  ok(nodes.inject_tick.props && nodes.inject_tick.props.repeat === '5' &&
     nodes.inject_tick.props.payloadType === 'date',
    'a disabled node still carries every property, as in the editor');

  ok(nodes.debug_out.showLabel === false, '`l` becomes `showLabel`');
  ok(!('l' in nodes.debug_out), 'the raw `l` key is gone from the schema');

  ok(!('disabled' in nodes.function_plain) && !('showLabel' in nodes.function_plain),
    'a normal node carries neither flag');
}

function outboundLeavesRealPropertiesAlone() {
  console.log('\nOutbound: a type owning a real `disabled` property keeps it');
  // The node is disabled AND has its own property called `disabled`.
  const flow = [
    { id: 'a', type: 'my-thing', z: 't1', name: 'X', x: 1, y: 1, d: true, disabled: 'never', wires: [] },
  ];
  const entry = Cfg.toIntermediate(flow).nodes.my_thing_x;
  ok(entry.props.disabled === 'never', "the type's own `disabled` property survives");
  ok(entry.props.d === true, 'the flag falls back to the raw `d` key when the name is taken');
  ok(!('disabled' in entry), 'no ambiguous root-level flag is emitted');

  const back = Cfg.toNodeRed({ nodes: { my_thing_x: entry }, connections: [] }, { workspace: 't1' })[0];
  ok(back.d === true && back.disabled === 'never', 'and the pair round-trips unchanged');
}

// ------------------------------------------------------------------ //
//  (B) Inbound: the schema name maps back to Node-RED's key           //
// ------------------------------------------------------------------ //

function first(schema) {
  return Cfg.toNodeRed(schema, { workspace: 't1' })[0];
}

function inboundMapsFlagsBack() {
  console.log('\nInbound (toNodeRed): editor names map back to `d` / `l`');

  let n = first({ nodes: { inject_a: { type: 'inject', name: 'A', disabled: true } }, connections: [] });
  ok(n.d === true, 'root-level `disabled: true` → `d: true`');
  ok(!('disabled' in n), 'the schema name does not leak onto the node');

  n = first({ nodes: { inject_a: { type: 'inject', props: { disabled: true, showLabel: false } } }, connections: [] });
  ok(n.d === true && n.l === false, 'the flags are accepted inside `props` too');

  n = first({ nodes: { inject_a: { type: 'inject', disabled: 'true' } }, connections: [] });
  ok(n.d === true, 'the string "true" is coerced to a boolean');

  n = first({ nodes: { inject_a: { type: 'inject', name: 'A', disabled: false } }, connections: [] });
  ok(!('d' in n), '`disabled: false` removes the key instead of writing `d: false`');
  ok(n._llmSpecKeys.indexOf('d') !== -1,
    're-enabling still counts as an explicitly proposed key (merge must not undo it)');

  n = first({ nodes: { thing_a: { type: 'my-thing', props: { disabled: 'never' } } }, connections: [] });
  ok(!('d' in n) && n.disabled === 'never',
    'a non-boolean value is left as an ordinary property, never read as the flag');

  n = first({ nodes: { thing_a: { type: 'my-thing', props: { d: true, disabled: false } } }, connections: [] });
  ok(n.d === true && n.disabled === false, 'an explicit raw `d` wins over the alias');
}

// ------------------------------------------------------------------ //
//  (C) End-to-end: disable / re-enable / edit through the importer    //
// ------------------------------------------------------------------ //

// `imported` is the flow as it now stands. Under an incremental apply a
// property edit is written straight onto the live node and never reaches
// import(), so reading that payload would see nothing at all.
async function runImport(nodesArr, message) {
  const mock = buildEditorMock({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: nodesArr,
    activeId: 'tab1',
  });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(message, { mode: 'agent' });
  return { res, imported: mock.snapshot('tab1'), captured: mock.captured };
}


async function canvasReceivesNoMetadata() {
  console.log('\nInbound end-to-end: the canvas receives no metadata');
  const A = { id: 'a', type: 'inject', z: 'tab1', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', name: 'B', x: 300, y: 100, func: 'return msg;', wires: [[]] };
  // A comment with `above` is the case that used to leak `_llmAboveId`.
  const msg = 'Adding a debug node and a caption.\n' + fence({
    nodes: {
      debug_out: { type: 'debug' },
      comment_note: { type: 'comment', name: 'Output', above: 'debug_out', props: { info: 'shows the result' } },
    },
    connections: [{ from: 'function_b', to: 'debug_out' }],
  });
  const { res, imported } = await runImport([A, B], msg);
  ok(res && res.ok, 'import returned ok');

  const leaked = [];
  imported.forEach((n) => {
    metaKeysOf(n).forEach((k) => leaked.push((n.type || '?') + '.' + k));
  });
  ok(leaked.length === 0, 'no `_` key on any imported node (' + (leaked.join(', ') || 'none') + ')');

  // The metadata was still doing its job before being stripped.
  const comment = imported.find((n) => n.type === 'comment');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!!comment && !!debug, 'comment and debug nodes were both imported');
  ok(comment && debug && comment.y < debug.y,
    'the comment was placed above its `above:` target (metadata was consumed)');
}

const injectA = () => ({ id: 'a', type: 'inject', z: 'tab1', name: 'Tick', x: 100, y: 100,
  repeat: '5', payloadType: 'date', wires: [['b']] });
const funcB = () => ({ id: 'b', type: 'function', z: 'tab1', name: 'Fmt', x: 300, y: 100,
  func: 'return msg;', wires: [[]] });

async function endToEndFlags() {
  console.log('\nEnd-to-end: disable, re-enable and edit through the importer');

  // Disable an existing node.
  let msg = 'Disabling `inject_tick`.\n' + fence({
    nodes: { inject_tick: { type: 'inject', disabled: true } }, connections: [],
  });
  let { res, imported } = await runImport([injectA(), funcB()], msg);
  let inject = imported.find((n) => n.id === 'a');
  ok(res && res.ok, 'import returned ok');
  ok(inject && inject.d === true, 'the existing node is now disabled on the canvas');
  ok(inject && inject.repeat === '5' && inject.payloadType === 'date',
    'disabling changed nothing else about the node');

  // Re-enable a disabled node: `d` must not come back through the merge.
  const disabledA = Object.assign(injectA(), { d: true });
  msg = 'Re-enabling `inject_tick`.\n' + fence({
    nodes: { inject_tick: { type: 'inject', disabled: false } }, connections: [],
  });
  ({ imported } = await runImport([disabledA, funcB()], msg));
  inject = imported.find((n) => n.id === 'a');
  ok(inject && inject.d === undefined, 're-enabling clears `d` (merge does not restore it)');
  ok(inject && inject.repeat === '5', 're-enabling changed nothing else about the node');

  // Edit a disabled node without mentioning the flag: it stays disabled.
  msg = 'Slowing `inject_tick` down.\n' + fence({
    nodes: { inject_tick: { type: 'inject', props: { repeat: '30' } } }, connections: [],
  });
  ({ imported } = await runImport([Object.assign(injectA(), { d: true }), funcB()], msg));
  inject = imported.find((n) => n.id === 'a');
  ok(inject && inject.d === true, 'an unmentioned `disabled` flag is preserved');
  ok(inject && inject.repeat === '30', 'the edit itself was applied');
}

async function run() {
  outboundKeepsMetadataOut();
  inboundIgnoresForgedMetadata();
  outboundRenamesFlags();
  outboundLeavesRealPropertiesAlone();
  inboundMapsFlagsBack();
  await canvasReceivesNoMetadata();
  await endToEndFlags();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
