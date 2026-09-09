// Integration test for two guarantees the importer must uphold:
//   (A) an LLM edit must NOT delete junctions (or groups), and
//   (B) existing wires are never severed unless the schema explicitly
//       asks (a `remove` directive) — omitting wires means "keep them".
// Loads the real client modules in a mocked RED/browser sandbox and drives
// Importer.importFlowFromMessage end to end.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

// `byId` / `imported` read the flow AS IT NOW STANDS, not import()'s payload:
// the apply is a diff, so an untouched junction or an unmentioned wire is
// never handed to import() at all — which is exactly the guarantee here.
async function runImport(nodesArr, junctionsArr, groupsArr, message) {
  const mock = buildEditorMock({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: nodesArr,
    junctions: junctionsArr || [],
    groups: groupsArr || [],
    activeId: 'tab1',
  });
  const Importer = loadPluginSandbox(mock.RED).Importer;
  const res = await Importer.importFlowFromMessage(message, { mode: 'agent' });
  const flow = mock.snapshot('tab1');
  const byId = {};
  flow.forEach((n) => { byId[n.id] = n; });
  return { res, imported: flow, byId, captured: mock.captured };
}


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
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
