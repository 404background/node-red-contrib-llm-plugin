// Regression tests for the editor-level node flags (`disabled`, `showLabel`).
//
// Node-RED stores them under single-letter keys — `d` (Enable/Disable, what
// users call "commenting out" a node) and `l` (label visibility) — which say
// nothing to a reader. The schema renames them to the editor's own UI words
// and keeps them at the entry root, present only when set, so:
//   (A) a model reads a disabled node the way a user sees it on the canvas —
//       flagged, and otherwise listed in full with all its properties;
//   (B) `disabled: false` re-enables by REMOVING `d`, and the importer's
//       merge must not restore the node's previous `d: true`.
// See docs/{en,jp}/vibe-schema.md "Editor flags".

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const Cfg = require('../src/core/flow_converter_core.js');

const files = [
  'src/common.js',
  'src/core/canvas_layout.js',
  'src/core/flow_converter_core.js',
  'src/core/llm_json_parser.js',
  'src/chat_manager.js',
  'src/importer.js',
  'src/ui_core.js',
];

let assertions = 0, failures = 0;
function ok(cond, msg) {
  assertions++;
  if (cond) { console.log('  ok  ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

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

function buildRED(nodesArr) {
  const regularById = {};
  nodesArr.forEach((n) => { regularById[n.id] = n; });
  const TAB = { id: 'tab1', type: 'tab', label: 'Flow 1' };
  const captured = { import: null };
  const RED = {
    notify: function () {},
    nodes: {
      filterNodes: function (filter) {
        return Object.values(regularById).filter((n) => n.z === filter.z);
      },
      junctions: function () { return []; },
      groups: function () { return []; },
      workspace: function (id) { return id === 'tab1' ? TAB : null; },
      eachWorkspace: function (cb) { cb(TAB); },
      eachNode: function (cb) { Object.values(regularById).forEach(cb); },
      eachConfig: function () {},
      node: function (id) { return regularById[id] || null; },
      getType: function () { return undefined; },
      createExportableNodeSet: function (set) { return set.filter(Boolean).map(clone); },
      import: function (nodes) { captured.import = clone(nodes); return { nodes: nodes }; },
      remove: function (id) { delete regularById[id]; },
      removeJunction: function () {},
      removeGroup: function () {},
      dirty: function () {},
    },
    view: { redraw: function () {} },
    actions: { invoke: function () {} },
    workspaces: { active: function () { return 'tab1'; }, refresh: function () {}, show: function () {} },
  };
  return { RED, captured };
}

async function runImport(nodesArr, message) {
  const { RED, captured } = buildRED(nodesArr);
  const sandbox = {
    console, setTimeout,
    requestAnimationFrame: (cb) => cb(),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }) },
    RED,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  const Importer = sandbox.window.LLMPlugin.Importer;
  const res = await Importer.importFlowFromMessage(message, { mode: 'agent' });
  return { res, imported: captured.import || [] };
}

function fence(obj) { return '```json\n' + JSON.stringify(obj) + '\n```'; }

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
  outboundRenamesFlags();
  outboundLeavesRealPropertiesAlone();
  inboundMapsFlagsBack();
  await endToEndFlags();
  console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
