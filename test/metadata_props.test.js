// Regression tests for the metadata naming convention:
// a property whose name starts with `_` is plugin-internal bookkeeping.
// Two boundaries must hold (see docs/{en,jp}/design.md §0):
//   (A) outbound — toIntermediate never emits a `_` key, so the LLM never
//       receives metadata (it also never receives node IDs or coordinates);
//   (B) inbound  — toNodeRed ignores `_` keys coming from the schema, and
//       the importer strips every `_` key the converter/layout added, so no
//       metadata ever lands on the canvas.
// The historical leak: `_llmAboveId` (set when resolving a comment's
// `above:` target) was consumed by the layout pass but never deleted, so it
// rode along into RED.nodes.import.

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
  'src/ui_core.js',
  'src/importer.js',
];

let assertions = 0, failures = 0;
function ok(cond, msg) {
  assertions++;
  if (cond) { console.log('  ok  ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}

const clone = (x) => JSON.parse(JSON.stringify(x));

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

async function run() {
  outboundKeepsMetadataOut();
  inboundIgnoresForgedMetadata();
  await canvasReceivesNoMetadata();
  console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
