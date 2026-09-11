// The two canvas entities an apply loses first: junctions and groups.
//
//   (A) a junction survives an edit WITH ITS WIRES — it sits in the middle of
//       a chain, so losing it silently breaks the path rather than leaving a
//       visible gap.
//   (B) group membership survives an edit, and a deleted member does not
//       linger in the group's `nodes` list.
//
// Loads the real client modules in a mocked RED/browser sandbox and drives
// Importer.importFlowFromMessage end to end.
//
// Deliberately NOT here: "a property edit keeps the wires nobody mentioned"
// and "an explicit `remove` does sever one". Both are assertions about the
// work an apply does, which is incremental_apply.test.js's subject, and both
// are already made there (`propertyEditTouchesNothingElse` pins every wire,
// `rewiringOnlyMovesLinks` drives a `remove` directive). Asserting them twice
// meant two suites to update for one behaviour change.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

// `byId` / `imported` read the flow AS IT NOW STANDS, not import()'s payload:
// the apply is a diff, so an untouched junction or an unmentioned wire is
// never handed to import() at all — which is exactly the guarantee here.
async function runImport(nodesArr, junctionsArr, groupsArr, message, extraOpts) {
  const mock = buildEditorMock(Object.assign({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: nodesArr,
    junctions: junctionsArr || [],
    groups: groupsArr || [],
    activeId: 'tab1',
  }, extraOpts || {}));
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

// ------------------------------------------------------------------ //
//  Group membership survives an edit, and does not outlive a delete   //
// ------------------------------------------------------------------ //
//
// `g` on a node and `nodes` on the group are two halves of one
// relationship, and nothing in Node-RED keeps them in step for us:
// RED.nodes.remove has no group bookkeeping at all. So the importer owns
// both directions — carrying `g` through a merge, and pruning a deleted
// member out of the group.
//
// This is also what decides whether the incremental apply runs: a node that
// comes back from the merge without its `g` reads as "group membership
// changed", and the diff hands the whole edit to the destructive rebuild.

async function scenarioEditKeepsGroupMembership() {
  console.log('\nScenario 2: editing a node inside a group keeps it in the group');
  const A = { id: 'a', type: 'inject', z: 'tab1', g: 'grp', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', g: 'grp', name: 'B', x: 300, y: 100,
              func: 'return msg;', wires: [[]] };
  const G = { id: 'grp', type: 'group', z: 'tab1', name: 'Box', style: {}, nodes: ['a', 'b'] };
  const msg = 'Tweak the function.\n' + fence({
    nodes: { function_b: { props: { func: 'msg.payload = 1; return msg;' } } },
  });
  const { res, byId, captured } = await runImport([A, B], [], [G], msg);

  ok(res && res.ok, 'import returned ok');
  ok(byId['b'] && /payload = 1/.test(byId['b'].func || ''), 'the edit landed');
  ok(byId['b'] && byId['b'].g === 'grp',
    'the edited node is still in the group (g=' + JSON.stringify(byId['b'] && byId['b'].g) + ')');
  ok(byId['a'] && byId['a'].g === 'grp', 'the untouched member is still in the group');
  ok(byId['grp'] && byId['grp'].nodes.length === 2, 'the group still lists both members');
  // The payoff: with `g` preserved there is no phantom membership change, so
  // the edit no longer forces the destructive rebuild.
  ok(captured.removed.length === 0,
    'no node was destroyed to make the edit (' + (captured.removed.join(',') || 'none') + ')');
}

async function scenarioDeleteLeavesNoDanglingMember() {
  console.log('\nScenario 3: deleting a grouped node removes it from the group too');
  const A = { id: 'a', type: 'inject', z: 'tab1', g: 'grp', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', g: 'grp', name: 'B', x: 300, y: 100,
              func: 'return msg;', wires: [[]] };
  const G = { id: 'grp', type: 'group', z: 'tab1', name: 'Box', style: {}, nodes: ['a', 'b'] };
  const msg = 'Drop the function.\n' + fence({ nodes: { function_b: null } });
  const { res, byId, captured } = await runImport([A, B], [], [G], msg);

  ok(res && res.ok, 'import returned ok');
  ok(!byId['b'], 'the node is gone');
  ok(!!byId['grp'], 'the group itself survives');
  ok(byId['grp'] && byId['grp'].nodes.indexOf('b') === -1,
    'the group no longer names the deleted node (' +
      JSON.stringify(byId['grp'] && byId['grp'].nodes) + ')');
  ok(byId['grp'] && byId['grp'].nodes.indexOf('a') !== -1,
    'the surviving member is still a member');
  // It gets there through RED.group.removeFromGroup rather than by rebuilding
  // the tab, so nothing but the deleted node is touched.
  ok(captured.removed.length === 1 && captured.removed[0] === 'b',
    'only the deleted node was removed (' + captured.removed.join(',') + ')');
  ok([].concat.apply([], captured.imports).length === 0,
    'and no survivor was destroyed and re-imported');
}

// The group API is a no-op on a locked workspace, and a no-op here is the
// worst outcome available: the node would go while the group went on naming
// it. So the diff checks first and declines, and the destructive rebuild —
// which does not need the API, because it re-imports the group wholesale —
// produces the same consistent end state.
async function scenarioLockedWorkspaceFallsBackSafely() {
  console.log('\nScenario 4: a locked workspace falls back rather than half-detaching');
  const A = { id: 'a', type: 'inject', z: 'tab1', g: 'grp', name: 'A', x: 100, y: 100, wires: [['b']] };
  const B = { id: 'b', type: 'function', z: 'tab1', g: 'grp', name: 'B', x: 300, y: 100,
              func: 'return msg;', wires: [[]] };
  const G = { id: 'grp', type: 'group', z: 'tab1', name: 'Box', style: {}, nodes: ['a', 'b'] };
  const msg = 'Drop the function.\n' + fence({ nodes: { function_b: null } });
  const { res, byId } = await runImport([A, B], [], [G], msg, { workspaceLocked: true });

  ok(res && res.ok, 'the edit still applies');
  ok(!byId['b'], 'the node is gone');
  ok(byId['grp'] && byId['grp'].nodes.indexOf('b') === -1,
    'and the group does not name it either (' +
      JSON.stringify(byId['grp'] && byId['grp'].nodes) + ')');
  ok(byId['a'] && byId['a'].g === 'grp', 'the surviving member kept its membership');
}

async function run() {
  await scenarioJunctionSurvivesAddNode();
  await scenarioEditKeepsGroupMembership();
  await scenarioDeleteLeavesNoDanglingMember();
  await scenarioLockedWorkspaceFallsBackSafely();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
