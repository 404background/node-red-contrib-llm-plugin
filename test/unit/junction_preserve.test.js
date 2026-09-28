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
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('../helpers.js');

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

// ------------------------------------------------------------------ //
//  Junctions are the user's: never moved, never rewired by a reply    //
// ------------------------------------------------------------------ //
//
// Start -> J -> {Left, Right}, and a link out -> link in pair whose virtual
// link is drawn only on hover. The model is not offered junctions: a wire
// through one reads as a connection to where it leads.
function junctionCanvas() {
  return {
    nodes: [
      { id: 'a', type: 'inject', z: 'tab1', name: 'Start', x: 150, y: 100, wires: [['j1']] },
      { id: 'b', type: 'change', z: 'tab1', name: 'Left', x: 450, y: 80, wires: [['lo']] },
      { id: 'c', type: 'debug', z: 'tab1', name: 'Right', x: 450, y: 160, wires: [] },
      { id: 'lo', type: 'link out', z: 'tab1', name: 'send', x: 650, y: 80, links: ['li'], wires: [] },
      { id: 'li', type: 'link in', z: 'tab1', name: 'recv', x: 150, y: 300, links: ['lo'], wires: [['d']] },
      { id: 'd', type: 'debug', z: 'tab1', name: 'Far', x: 350, y: 300, wires: [] },
    ],
    junctions: [{ id: 'j1', type: 'junction', z: 'tab1', x: 300, y: 100, wires: [['b', 'c']] }],
  };
}

async function scenarioEditsNeverMoveOrRewireAJunction() {
  console.log('\nScenario 5: no edit moves a junction or touches its wires');
  const edits = {
    'a rename': { nodes: { inject_start: { type: 'inject', name: 'Start!' } } },
    'a node added after Left': { nodes: { debug_new: { type: 'debug', name: 'New' } },
      connections: [{ from: 'change_left', to: 'debug_new' }] },
    'a node added from Start': { nodes: { debug_tap: { type: 'debug', name: 'Tap' } },
      connections: [{ from: 'inject_start', to: 'debug_tap' }] },
    'a reposition of the sequence': { reposition: ['inject_start', 'change_left', 'debug_right'] },
  };
  for (const label of Object.keys(edits)) {
    const canvas = junctionCanvas();
    const { res, byId, imported } = await runImport(canvas.nodes, canvas.junctions, [], fence(edits[label]));
    const j = byId['j1'];
    ok(res && res.ok && j && j.x === 300 && j.y === 100 &&
       JSON.stringify(j.wires) === JSON.stringify([['b', 'c']]) &&
       byId['a'].wires[0].indexOf('j1') !== -1,
      label + ': the junction is where it was, wired as it was' +
        (j ? ' (' + j.x + ',' + j.y + ' ' + JSON.stringify(j.wires) + ')' : ' (gone)'));
    const onIt = imported.filter((n) => n.type !== 'junction' && n.type !== 'group' && n.type !== 'tab' &&
      Math.abs(n.x - 300) < 55 && Math.abs(n.y - 100) < 20);
    ok(onIt.length === 0, label + ': and nothing sits on it (' + onIt.map((n) => n.name).join(',') + ')');
  }
}

async function scenarioTheContextReadsThroughJunctions() {
  console.log('\nScenario 6: the model sees where a junction leads, and restating it adds no wire');
  const canvas = junctionCanvas();
  const mock = buildEditorMock({ tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: canvas.nodes, junctions: canvas.junctions, activeId: 'tab1' });
  const P = loadPluginSandbox(mock.RED);
  const ctx = P.FlowConverterCore.toIntermediate(canvas.nodes.concat(canvas.junctions));
  ok(!Object.keys(ctx.nodes).some((k) => /junction|link_/.test(k)),
    'no junction or link node is offered to the model (' + Object.keys(ctx.nodes).join(',') + ')');
  const conns = ctx.connections.map((c) => c.from + '>' + c.to);
  ok(conns.indexOf('inject_start>change_left') !== -1 && conns.indexOf('inject_start>debug_right') !== -1,
    'Start reads as connected to Left and Right (' + conns.join(' ') + ')');
  ok(conns.indexOf('change_left>debug_far') !== -1, 'and Left, through link out -> link in, to Far');

  const restated = fence({ nodes: { inject_start: { type: 'inject', name: 'Start' } },
    connections: [{ from: 'inject_start', to: 'change_left' }, { from: 'inject_start', to: 'debug_right' }] });
  const { res, byId } = await runImport(canvas.nodes, canvas.junctions, [], restated);
  ok(res && res.ok && JSON.stringify(byId['a'].wires) === JSON.stringify([['j1']]),
    'restating the connections adds no direct wire beside the junction (' + JSON.stringify(byId['a'].wires) + ')');

  const throughLink = fence({ connections: [{ from: 'change_left', to: 'debug_far' }] });
  const second = await runImport(canvas.nodes, canvas.junctions, [], throughLink);
  ok(second.res && second.res.ok && JSON.stringify(second.byId['b'].wires) === JSON.stringify([['lo']]),
    'nor beside a link out -> link in (' + JSON.stringify(second.byId['b'].wires) + ')');
}

// ------------------------------------------------------------------ //
//  A removed connection is cut through its routing                     //
// ------------------------------------------------------------------ //
//
// The model sees `A -> B` wherever A reaches B through junctions and link
// nodes, so removing it has to cut there — and nothing else may change: every
// other connection reads the same afterwards. Routing the cut leaves idle
// goes with it.

// The connections the model would read off a flow, as `from>to` strings.
function connectionsOf(P, flow) {
  return P.FlowConverterCore.toIntermediate(flow.filter((n) => n.type !== 'tab'))
    .connections.map((c) => c.from + (c.fromPort ? ':' + c.fromPort : '') + '>' + c.to).sort();
}

async function cutCase(label, canvas, reply, expectGone, check) {
  const mock = buildEditorMock({ tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: canvas.nodes, junctions: canvas.junctions || [], activeId: 'tab1' });
  const P = loadPluginSandbox(mock.RED);
  const before = connectionsOf(P, canvas.nodes.concat(canvas.junctions || []));
  const removed = (reply.connections || []).map((c) => c.remove.from + '>' + c.remove.to);
  const res = await P.Importer.importFlowFromMessage(fence(reply), { mode: 'agent' });
  const flow = mock.snapshot('tab1');
  const byId = {};
  flow.forEach((n) => { byId[n.id] = n; });
  const after = connectionsOf(P, flow);
  const expected = before.filter((c) => removed.indexOf(c) === -1 &&
    !(reply.nodes && Object.keys(reply.nodes).some((a) => c.split('>').indexOf(a) !== -1)));
  ok(res && res.ok && JSON.stringify(after) === JSON.stringify(expected),
    label + ': the model reads exactly the connections that stay (' + after.join(' ') + ')');
  const left = expectGone.filter((id) => byId[id]);
  ok(left.length === 0, label + ': the routing left idle is gone (' + left.join(',') + ')');
  if (check) check(byId);
}

async function scenarioARemovedConnectionIsCutThroughRouting() {
  console.log('\nScenario 9: removing a connection cuts it through junctions and link nodes');
  const node = (id, type, name, wires, extra) =>
    Object.assign({ id, type, z: 'tab1', name, x: 100, y: 100, wires }, extra || {});
  const junction = (id, wires) => ({ id, type: 'junction', z: 'tab1', x: 200, y: 100, wires });

  await cutCase('fan-out, one branch', junctionCanvas(),
    { connections: [{ remove: { from: 'inject_start', to: 'change_left' } }] }, [],
    (byId) => ok(JSON.stringify(byId['j1'].wires) === JSON.stringify([['c']]) &&
      JSON.stringify(byId['a'].wires) === JSON.stringify([['j1']]),
      'fan-out: only the junction\'s wire to Left went (' + JSON.stringify(byId['j1'].wires) + ')'));

  await cutCase('fan-out, every branch', junctionCanvas(),
    { connections: [{ remove: { from: 'inject_start', to: 'change_left' } },
                    { remove: { from: 'inject_start', to: 'debug_right' } }] }, ['j1']);

  await cutCase('through a link', junctionCanvas(),
    { connections: [{ remove: { from: 'change_left', to: 'debug_far' } }] }, ['lo', 'li']);

  await cutCase('fan-in', {
    nodes: [node('a', 'inject', 'A', [['j']]), node('c', 'inject', 'C', [['j']]), node('b', 'debug', 'B', [])],
    junctions: [junction('j', [['b']])],
  }, { connections: [{ remove: { from: 'inject_a', to: 'debug_b' } }] }, [],
  (byId) => ok(JSON.stringify(byId['a'].wires) === JSON.stringify([[]]) &&
    JSON.stringify(byId['j'].wires) === JSON.stringify([['b']]),
    'fan-in: A left the junction, which still serves C'));

  // A and C share J to B and D: no wire serves A -> B alone, so A leaves J
  // and is wired back to D.
  await cutCase('a shared crossing', {
    nodes: [node('a', 'inject', 'A', [['j']]), node('c', 'inject', 'C', [['j']]),
            node('b', 'debug', 'B', []), node('d', 'debug', 'D', [])],
    junctions: [junction('j', [['b', 'd']])],
  }, { connections: [{ remove: { from: 'inject_a', to: 'debug_b' } }] }, [],
  (byId) => ok(JSON.stringify(byId['a'].wires) === JSON.stringify([['d']]),
    'a shared crossing: A is wired straight to D (' + JSON.stringify(byId['a'].wires) + ')'));

  // ... unless routing that leads only to D is already there.
  await cutCase('a shared crossing beside other routing', {
    nodes: [node('a', 'inject', 'A', [['j']]), node('c', 'inject', 'C', [['j']]), node('e', 'inject', 'E', [['k']]),
            node('b', 'debug', 'B', []), node('d', 'debug', 'D', [])],
    junctions: [junction('j', [['b', 'd']]), junction('k', [['d']])],
  }, { connections: [{ remove: { from: 'inject_a', to: 'debug_b' } }] }, [],
  (byId) => ok(JSON.stringify(byId['a'].wires) === JSON.stringify([['k']]),
    'beside other routing: A is wired into the junction that reaches D alone (' + JSON.stringify(byId['a'].wires) + ')'));

  // A link in a link call uses stays, and so does its wire on.
  await cutCase('a link in a link call uses', {
    nodes: [node('a', 'inject', 'A', [['lo']]), node('lc', 'link call', 'call', [[]], { links: ['li'] }),
            node('lo', 'link out', 'out', [], { mode: 'link', links: ['li'] }),
            node('li', 'link in', 'in', [['d']], { links: ['lo'] }), node('d', 'debug', 'D', [])],
  }, { connections: [{ remove: { from: 'inject_a', to: 'debug_d' } }] }, ['lo'],
  (byId) => ok(byId['li'] && JSON.stringify(byId['li'].wires) === JSON.stringify([['d']]) &&
    JSON.stringify(byId['li'].links) === JSON.stringify([]),
    'the called link in keeps its wire and forgets the link out'));

  await cutCase('a deleted target', junctionCanvas(), { nodes: { debug_far: null } }, ['lo', 'li'],
    (byId) => ok(JSON.stringify(byId['j1'].wires) === JSON.stringify([['b', 'c']]),
      'a deleted target: the junction serving others is untouched'));

  await cutCase('a deleted source', junctionCanvas(), { nodes: { inject_start: null } }, ['j1']);

  // Routing idle before the edit is the user's work in progress.
  await cutCase('routing idle before the edit', {
    nodes: [node('a', 'inject', 'A', [['b']]), node('b', 'debug', 'B', [])],
    junctions: [junction('j', [[]])],
  }, { connections: [{ remove: { from: 'inject_a', to: 'debug_b' } }] }, [],
  (byId) => ok(!!byId['j'], 'an idle junction nobody touched stays'));
}

async function scenarioAHoverOnlyLinkDoesNotJoinASequence() {
  console.log('\nScenario 7: a link node virtual link does not carry a box across it');
  // The user boxed Start, the junction, Left and Right. Far is reached from
  // Left only through link out -> link in.
  const canvas = junctionCanvas();
  const nodes = canvas.nodes.map((n) => (['a', 'b', 'c'].includes(n.id) ? Object.assign({}, n, { g: 'grp' }) : n));
  const junctions = canvas.junctions.map((j) => Object.assign({}, j, { g: 'grp' }));
  const groups = [{ id: 'grp', type: 'group', z: 'tab1', name: 'Main', nodes: ['a', 'j1', 'b', 'c'],
    x: 75, y: 45, w: 460, h: 150 }];
  const msg = fence({
    nodes: { debug_after_left: { type: 'debug', name: 'After Left' }, debug_after_far: { type: 'debug', name: 'After Far' } },
    connections: [{ from: 'change_left', to: 'debug_after_left' }, { from: 'debug_far', to: 'debug_after_far' }],
  });
  const { res, byId, imported } = await runImport(nodes, junctions, groups, msg);
  const afterLeft = imported.find((n) => n.name === 'After Left');
  const afterFar = imported.find((n) => n.name === 'After Far');
  ok(res && res.ok && afterLeft && afterLeft.g === 'grp',
    'a node wired to Left joins the box Left is in (' + (afterLeft && afterLeft.g) + ')');
  ok(afterFar && !afterFar.g && byId['grp'].nodes.indexOf(afterFar.id) === -1,
    'one wired to Far, which the box reaches only through a link, does not');
}

async function scenarioRoutingFollowsTheBoxItServes() {
  console.log('\nScenario 8: nodes added to one box push the next, and its routing goes along');
  // Box A feeds box B through a junction in the gap between them, and a link
  // in beside B feeds it too. A link out hangs off A.
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'a', x: 250, y: 160, g: 'gA', wires: [['a2', 'j1']] },
    { id: 'a2', type: 'debug', z: 'tab1', name: 'da', x: 450, y: 160, g: 'gA', wires: [] },
    { id: 'b1', type: 'function', z: 'tab1', name: 'fb', func: 'return msg;', outputs: 1, x: 250, y: 320, g: 'gB', wires: [['b2', 'lo']] },
    { id: 'b2', type: 'debug', z: 'tab1', name: 'db', x: 450, y: 320, g: 'gB', wires: [] },
    { id: 'li', type: 'link in', z: 'tab1', name: '', x: 90, y: 320, links: [], wires: [['b1']] },
    { id: 'lo', type: 'link out', z: 'tab1', name: '', x: 250, y: 420, mode: 'link', links: [], wires: [] },
  ];
  const junctions = [{ id: 'j1', type: 'junction', z: 'tab1', x: 330, y: 240, wires: [['b1']] }];
  const groups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'SeqA', nodes: ['a1', 'a2'], x: 175, y: 130, w: 340, h: 60 },
    { id: 'gB', type: 'group', z: 'tab1', name: 'SeqB', nodes: ['b1', 'b2'], x: 175, y: 290, w: 340, h: 60 },
  ];
  const msg = fence({
    nodes: { function_fa: { type: 'function', name: 'fa', props: { func: 'return msg;' } },
             function_fa2: { type: 'function', name: 'fa2', props: { func: 'return msg;' } } },
    connections: [{ from: 'inject_a', to: 'function_fa' }, { from: 'inject_a', to: 'function_fa2' }],
  });
  const { res, byId } = await runImport(nodes, junctions, groups, msg);
  const b1 = byId['b1'], j1 = byId['j1'], li = byId['li'], lo = byId['lo'], gA = byId['gA'];
  ok(res && res.ok && b1.y > 320, 'the box below was pushed down (' + (b1 && b1.y) + ')');
  ok(Math.abs(j1.x - b1.x - 80) <= 10 && j1.y - b1.y === -80,
    'the junction feeding it kept its place beside it (' + (j1.x - b1.x) + ',' + (j1.y - b1.y) + ')');
  ok(!(j1.x > gA.x && j1.x < gA.x + gA.w && j1.y > gA.y && j1.y < gA.y + gA.h),
    'so it is not left inside the box that grew');
  // Within the half square the snap onto the grid may take.
  ok(Math.abs(li.x - b1.x + 160) <= 10 && li.y === b1.y, 'the link in kept its place too (' + (li.x - b1.x) + ',' + (li.y - b1.y) + ')');
  ok(Math.abs(lo.x - b1.x) <= 10 && lo.y - b1.y === 100, 'and so did the link out it feeds (' + (lo.x - b1.x) + ',' + (lo.y - b1.y) + ')');
}

// A on Flow 1 reaches B on Flow 2 through a link out / link in pair. The same
// link out also feeds a link in on Flow 3, which is not in the context.
async function scenarioACrossTabConnectionIsCutWhenBothTabsAreInContext() {
  console.log('\nScenario 10: a connection across tabs is cut when both tabs are in the context');
  const tabs = [{ id: 't1', type: 'tab', label: 'Flow 1' }, { id: 't2', type: 'tab', label: 'Flow 2' },
    { id: 't3', type: 'tab', label: 'Flow 3' }];
  function canvas(withFlow3) {
    return [
      { id: 'a', type: 'inject', z: 't1', name: 'A', x: 100, y: 100, wires: [['lo']] },
      { id: 'lo', type: 'link out', z: 't1', name: '', x: 250, y: 100, mode: 'link',
        links: withFlow3 ? ['li', 'li3'] : ['li'], wires: [] },
      { id: 'li', type: 'link in', z: 't2', name: '', x: 100, y: 100, links: ['lo'], wires: [['b']] },
      { id: 'b', type: 'debug', z: 't2', name: 'B', x: 250, y: 100, wires: [] },
    ].concat(withFlow3 ? [
      { id: 'li3', type: 'link in', z: 't3', name: '', x: 100, y: 100, links: ['lo'], wires: [['c']] },
      { id: 'c', type: 'debug', z: 't3', name: 'C', x: 250, y: 100, wires: [] },
    ] : []);
  }
  async function run(withFlow3, allowed) {
    const mock = buildEditorMock({ tabs, nodes: canvas(withFlow3), activeId: 't1' });
    const P = loadPluginSandbox(mock.RED);
    const ctx = P.FlowConverterCore.toIntermediate(P.UI.getFlowsByIds(allowed, { includeCanvasExtras: true }));
    const shown = ctx.connections.map((c) => c.from + '>' + c.to);
    const res = await P.Importer.importFlowFromMessage(
      fence({ connections: [{ remove: { from: 'inject_a', to: 'debug_b' } }] }),
      { mode: 'agent', allowedWorkspaceIds: allowed });
    const byId = {};
    tabs.forEach((t) => mock.snapshot(t.id).forEach((n) => { byId[n.id] = n; }));
    return { res, byId, shown };
  }

  const only = await run(false, ['t1', 't2']);
  ok(only.shown.indexOf('inject_a>debug_b') !== -1, 'the model is shown A -> B across the tabs');
  ok(only.res && only.res.ok && !only.byId['lo'] && !only.byId['li'] &&
     JSON.stringify(only.byId['a'].wires) === JSON.stringify([[]]),
    'removing it cuts the link, and both link nodes, left idle, go');

  const shared = await run(true, ['t1', 't2']);
  ok(shared.res && shared.res.ok && shared.byId['lo'] &&
     JSON.stringify(shared.byId['lo'].links) === JSON.stringify(['li3']) && !shared.byId['li'],
    'a link out that also feeds a tab outside the context keeps that link (' +
      JSON.stringify(shared.byId['lo'] && shared.byId['lo'].links) + ')');
  ok(JSON.stringify(shared.byId['li3'].links) === JSON.stringify(['lo']) &&
     JSON.stringify(shared.byId['a'].wires) === JSON.stringify([['lo']]),
    'and the tab outside the context is untouched');

  const oneTab = await run(false, ['t1']);
  ok(oneTab.shown.indexOf('inject_a>debug_b') === -1 && oneTab.byId['lo'] && oneTab.byId['li'],
    'with one of the tabs out of the context, nothing is shown and nothing is cut');
}

async function run() {
  await scenarioJunctionSurvivesAddNode();
  await scenarioEditKeepsGroupMembership();
  await scenarioDeleteLeavesNoDanglingMember();
  await scenarioLockedWorkspaceFallsBackSafely();
  await scenarioEditsNeverMoveOrRewireAJunction();
  await scenarioTheContextReadsThroughJunctions();
  await scenarioAHoverOnlyLinkDoesNotJoinASequence();
  await scenarioRoutingFollowsTheBoxItServes();
  await scenarioARemovedConnectionIsCutThroughRouting();
  await scenarioACrossTabConnectionIsCutWhenBothTabsAreInContext();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
