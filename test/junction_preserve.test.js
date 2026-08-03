// Integration test for two guarantees the importer must uphold:
//   (A) an LLM edit must NOT delete junctions (or groups), and
//   (B) existing wires are never severed unless the schema explicitly
//       asks (a `remove` directive) — omitting wires means "keep them".
// Loads the real client modules in a mocked RED/browser sandbox and drives
// Importer.importFlowFromMessage end to end.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
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

// Build a mocked RED whose registries mirror the real editor: filterNodes
// returns ONLY regular nodes; junctions/groups live in separate lookups.
function buildRED(nodesArr, junctionsArr, groupsArr) {
  const regularById = {};
  nodesArr.forEach((n) => { regularById[n.id] = n; });
  const juncById = {};
  (junctionsArr || []).forEach((j) => { juncById[j.id] = j; });
  const TAB = { id: 'tab1', type: 'tab', label: 'Flow 1' };
  const captured = { import: null, removed: [], removedJunctions: [], removedGroups: [] };

  const RED = {
    notify: function () {},
    nodes: {
      filterNodes: function (filter) {
        return Object.values(regularById).filter((n) => n.z === filter.z);
      },
      junctions: function (z) { return (junctionsArr || []).filter((j) => j.z === z); },
      groups: function (z) { return (groupsArr || []).filter((g) => g.z === z); },
      workspace: function (id) { return id === 'tab1' ? TAB : null; },
      eachWorkspace: function (cb) { cb(TAB); },
      eachNode: function (cb) { Object.values(regularById).forEach(cb); },
      eachConfig: function (cb) {},
      node: function (id) { return regularById[id] || juncById[id] || null; },
      getType: function () { return undefined; },
      createExportableNodeSet: function (set) { return set.filter(Boolean).map(clone); },
      import: function (nodes) { captured.import = clone(nodes); return { nodes: nodes }; },
      remove: function (id) { captured.removed.push(id); delete regularById[id]; },
      removeJunction: function (j) { captured.removedJunctions.push(j.id); },
      removeGroup: function (g) { captured.removedGroups.push(g.id); },
      dirty: function () {},
    },
    view: { redraw: function () {} },
    actions: { invoke: function () {} },
    workspaces: { active: function () { return 'tab1'; }, refresh: function () {}, show: function () {} },
  };
  return { RED, captured };
}

// Fresh sandbox + module load per scenario (modules hold singletons).
async function runImport(nodesArr, junctionsArr, groupsArr, message) {
  const { RED, captured } = buildRED(nodesArr, junctionsArr, groupsArr);
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
  const byId = {};
  (captured.import || []).forEach((n) => { byId[n.id] = n; });
  return { res, imported: captured.import || [], byId, captured };
}

function fence(obj) { return '```json\n' + JSON.stringify(obj) + '\n```'; }

async function scenarioJunctionSurvivesAddNode() {
  console.log('Scenario 1: adding a node must not delete a junction or sever its wires');
  // inject A ->[j] junction J ->[b] function B ; add debug fed from B.
  const A = { id: 'a', type: 'inject', z: 'tab1', name: 'A', x: 100, y: 100, wires: [['j']] };
  const J = { id: 'j', type: 'junction', z: 'tab1', x: 200, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', name: 'B', x: 300, y: 100, func: 'return msg;', wires: [[]] };
  const msg = 'Adding a debug node.\n' + fence({
    nodes: { debug_out: { type: 'debug' } },
    connections: [{ from: 'function_b', to: 'debug_out' }],
  });
  const { res, byId, imported } = await runImport([A, B], [J], [], msg);
  ok(res && res.ok, 'import returned ok');
  ok(!!byId['j'] && byId['j'].type === 'junction', 'junction J is present after import');
  ok(byId['a'] && byId['a'].wires[0].indexOf('j') !== -1, 'inject A still wired to junction J (node->junction kept)');
  ok(byId['j'] && byId['j'].wires[0].indexOf('b') !== -1, 'junction J still wired to function B (junction->node kept)');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!!debug, 'new debug node added');
  ok(byId['b'] && byId['b'].wires[0].indexOf(debug.id) !== -1, 'function B wired to the new debug node');
}

async function scenarioWiresKeptOnPropertyEdit() {
  console.log('\nScenario 2: editing a node property (no wires mentioned) keeps existing wires');
  // inject A ->[b] function B ->[c] debug C ; plus an untouched junction J.
  const A = { id: 'a', type: 'inject', z: 'tab1', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', name: 'B', x: 300, y: 100, func: 'return msg;', wires: [['c']] };
  const C = { id: 'c', type: 'debug', z: 'tab1', name: 'C', x: 500, y: 100, wires: [[]] };
  const J = { id: 'j', type: 'junction', z: 'tab1', x: 700, y: 300, wires: [[]] };
  // Edit only B's function body — no `connections`, no `wires`.
  const msg = 'Tweaking the function.\n' + fence({
    nodes: { function_b: { type: 'function', name: 'B', props: { func: 'msg.payload = 1; return msg;' } } },
  });
  const { res, byId } = await runImport([A, B, C], [J], [], msg);
  ok(res && res.ok, 'import returned ok');
  ok(byId['a'] && byId['a'].wires[0].indexOf('b') !== -1, 'A->B wire preserved (upstream untouched)');
  ok(byId['b'] && byId['b'].wires[0].indexOf('c') !== -1, 'B->C wire preserved though wires were not mentioned');
  ok(byId['b'] && /payload = 1/.test(byId['b'].func || ''), 'B function body was updated');
  ok(!!byId['j'] && byId['j'].type === 'junction', 'untouched junction J still present');
}

async function scenarioExplicitRemoveDoesCut() {
  console.log('\nScenario 3: an explicit remove directive DOES sever the wire');
  const A = { id: 'a', type: 'inject', z: 'tab1', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', name: 'B', x: 300, y: 100, func: 'return msg;', wires: [[]] };
  const msg = 'Disconnect them.\n' + fence({
    connections: [{ remove: { from: 'inject_a', to: 'function_b' } }],
  });
  const { res, byId } = await runImport([A, B], [], [], msg);
  ok(res && res.ok, 'import returned ok');
  ok(byId['a'] && byId['a'].wires[0].indexOf('b') === -1, 'A->B wire severed by explicit remove');
  ok(!!byId['b'], 'function B itself still present (only the wire was removed)');
}

async function run() {
  await scenarioJunctionSurvivesAddNode();
  await scenarioWiresKeptOnPropertyEdit();
  await scenarioExplicitRemoveDoesCut();
  console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
