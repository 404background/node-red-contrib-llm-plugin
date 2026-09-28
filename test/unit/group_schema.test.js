// Group boxes are the user's: the model neither sees nor declares one, and a
// box holds one wired sequence. See docs/{en,jp}/design.md §15.
//
// What has to hold:
//  - a reply cannot create, edit or delete a box, and the context shows none;
//  - an edit keeps a box around its sequence: a new node wired into it, and a
//    comment placed over one of its nodes, join it;
//  - membership is two-sided (`g` on the member, the id in the group's list),
//    because the editor draws from both and repairs neither for us;
//  - the BOX is ours to fit. Node-RED stores x/y/w/h on the group and only
//    recomputes them when a user drags a member.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('../helpers.js');

const TABS = [{ id: 'tab1', type: 'tab', label: 'Flow 1' }];

function loadSandbox(opts) {
  const mock = buildEditorMock(opts);
  return { LLMPlugin: loadPluginSandbox(mock.RED), snapshot: mock.snapshot, idsIn: mock.idsIn, RED: mock.RED };
}

function groupsIn(snapshot) {
  return snapshot.filter((n) => n && n.type === 'group');
}
function nodeById(snapshot, id) {
  return snapshot.find((n) => n && n.id === id) || null;
}
function byName(snapshot, name) {
  return snapshot.find((n) => n && n.name === name) || null;
}

function boxHolds(group, members) {
  return members.every((m) => {
    const w = (typeof m.w === 'number' && m.w > 0) ? m.w : 100;
    const h = (typeof m.h === 'number' && m.h > 0) ? m.h : 30;
    return group.x <= m.x - w / 2 && group.y <= m.y - h / 2 &&
      group.x + group.w >= m.x + w / 2 && group.y + group.h >= m.y + h / 2;
  });
}






// The clearance itself is canvas_layout's (`separateGroups`); what this pair
// asserts is that the shape an LLM actually proposes comes out of the
// importer with it — the node layout spaces MEMBERS, and a caption that
// joined a group used to grow its box 10px into the box above.
const GROUP_GAP = require('../../src/core/canvas_layout.js').LAYOUT_DEFAULTS.groupGap;

function boxGaps(groups) {
  const sorted = groups.slice().sort((a, b) => a.y - b.y);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].y - (sorted[i - 1].y + sorted[i - 1].h));
  }
  return gaps;
}


async function scenarioBoxGrowsWithoutCrowdingTheNext() {
  console.log('\nA node added to a group later pushes the next sequence down, whole');
  const liveNodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'a', x: 110, y: 160, g: 'gA', wires: [['a2']] },
    { id: 'a2', type: 'debug', z: 'tab1', name: 'da', x: 310, y: 160, g: 'gA', wires: [] },
    { id: 'b1', type: 'inject', z: 'tab1', name: 'b', x: 110, y: 280, g: 'gB', wires: [['b2']] },
    { id: 'b2', type: 'debug', z: 'tab1', name: 'db', x: 310, y: 280, g: 'gB', wires: [] },
  ];
  const liveGroups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'SeqA', nodes: ['a1', 'a2'],
      x: 35, y: 130, w: 340, h: 80 },
    { id: 'gB', type: 'group', z: 'tab1', name: 'SeqB', nodes: ['b1', 'b2'],
      x: 35, y: 250, w: 340, h: 80 },
  ];
  const msg = fence({
    nodes: { function_fa: { type: 'function', name: 'fa', props: { func: 'return msg;' } } },
    connections: [{ from: 'inject_a', to: 'function_fa' }],
  });

  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const boxes = groupsIn(flow);
  const seqA = boxes.find((g) => g.name === 'SeqA');
  const gaps = boxGaps(boxes);
  const b1 = nodeById(flow, 'b1'), b2 = nodeById(flow, 'b2');

  ok(res && res.ok, 'the import applied');
  ok(seqA && seqA.h > 80, 'the box it joined grew (' + (seqA && seqA.h) + ')');
  ok(gaps.every((g) => g >= GROUP_GAP),
    'and the sequence below still clears it (' + gaps.join(', ') + ')');
  ok(b1.y > 280 && (b2.y - b1.y) === 0,
    'which moved down as a whole, not reflowed (b1 ' + b1.y + ', b2 ' + b2.y + ')');
}

// A box has no position of its own: it is fitted around wherever its members
// end up, so rearranging the sequence inside it refits it.
async function scenarioRepositioningABoxMovesItsMembers() {
  console.log('\nRearranging a boxed sequence refits the box around it');
  const liveNodes = [
    // Deliberately strewn about: same chain, wrong cadence.
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 110, y: 100, g: 'grp', wires: [['n2']] },
    { id: 'n2', type: 'function', z: 'tab1', name: 'shape', func: 'return msg;',
      x: 520, y: 260, g: 'grp', wires: [['n3']] },
    { id: 'n3', type: 'debug', z: 'tab1', name: 'out', x: 900, y: 100, g: 'grp', wires: [] },
  ];
  const liveGroups = [{
    id: 'grp', type: 'group', z: 'tab1', name: 'Pair', nodes: ['n1', 'n2', 'n3'],
    x: 35, y: 60, w: 1000, h: 260,
  }];

  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    fence({ reposition: ['inject_tick', 'function_shape', 'debug_out'] }),
    { mode: 'agent', allowedWorkspaceIds: ['tab1'] }
  );
  const flow = snapshot('tab1');
  const at = (id) => flow.find((n) => n.id === id);

  ok(res && res.ok, 'the import applied');
  ok(at('n1').y === at('n2').y && at('n2').y === at('n3').y,
    'the chain is back on one row (' + [at('n1').y, at('n2').y, at('n3').y].join(',') + ')');
  ok(at('n1').x < at('n2').x && at('n2').x < at('n3').x, 'in wiring order');
  const box = groupsIn(flow)[0];
  ok(box.w < 1000, 'and the box was refitted around them (' + box.w + ')');
  ok(box.x <= at('n1').x - 50 && box.x + box.w >= at('n3').x,
    'still holding every member (' + [box.x, box.w].join(',') + ')');
}

// The caption complaint end to end: it sat above its node, a reposition moved
// the node, and the caption stayed behind — orphaned because its column had
// drifted further than the anchor tolerance allowed. Membership is what says
// they belong together.
async function scenarioRepositionTakesTheCaptionAlong() {
  console.log('\nA caption in the box follows the node it heads through a reposition');
  const liveNodes = [
    // The caption is a member, but its left edge is nowhere near its node's.
    { id: 'c1', type: 'comment', z: 'tab1', name: 'What this does',
      x: 260, y: 160, g: 'grp', wires: [] },
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 150, y: 200, g: 'grp', wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 600, y: 320, g: 'grp', wires: [] },
  ];
  const liveGroups = [{
    id: 'grp', type: 'group', z: 'tab1', name: 'Pair', nodes: ['c1', 'n1', 'n2'],
    x: 75, y: 120, w: 640, h: 240,
  }];

  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    fence({ reposition: ['inject_tick', 'debug_out'] }),
    { mode: 'agent', allowedWorkspaceIds: ['tab1'] }
  );
  const flow = snapshot('tab1');
  const at = (id) => flow.find((n) => n.id === id);
  // Widths from the engine's own estimator, so this measures the same edges
  // the layout was reasoning about.
  const Layout = require('../../src/core/canvas_layout.js');
  const leftOf = (n) => n.x - Layout.estimateNodeWidth(n, {}) / 2;

  ok(res && res.ok, 'the import applied');
  ok(at('c1').y < at('n1').y, 'the caption is still above its node');
  ok(Math.abs(leftOf(at('c1')) - leftOf(at('n1'))) < 1,
    'and back in its column (' + leftOf(at('c1')) + ' vs ' + leftOf(at('n1')) + ')');
  const box = groupsIn(flow)[0];
  ok(box.y <= at('c1').y - 15 - 25 + 0.01 && box.x <= leftOf(at('c1')),
    'and the box was fitted around it, not just around the nodes (' +
      [box.x, box.y, box.w, box.h].join(',') + ')');
}



function nodes2d(flow) { return flow.filter((n) => n && n.type !== 'group' && n.type !== 'tab'); }

// A box is the user's. Emptied by deleting its members, or drawn empty, it
// stays — the same as the editor, which keeps a group whose members were
// deleted.
async function scenarioAnExistingBoxIsNeverRemovedImplicitly() {
  console.log('\nA box stays when its members are deleted, and so does an empty one');
  const liveNodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'a', x: 250, y: 215, g: 'gA', wires: [['a2']] },
    { id: 'a2', type: 'debug', z: 'tab1', name: 'da', x: 450, y: 215, g: 'gA', wires: [] },
    { id: 'c1', type: 'inject', z: 'tab1', name: 'c', x: 250, y: 400, wires: [] },
  ];
  const liveGroups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'A', nodes: ['a1', 'a2'], x: 175, y: 175, w: 360, h: 80 },
    { id: 'gE', type: 'group', z: 'tab1', name: 'Empty', nodes: [], x: 600, y: 500, w: 200, h: 80 },
  ];
  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    fence({ nodes: { inject_a: null, debug_da: null, inject_c: { type: 'inject', name: 'c', props: { topic: 't' } } } }),
    { mode: 'agent', allowedWorkspaceIds: ['tab1'] }
  );
  const flow = snapshot('tab1');
  ok(res && res.ok, 'the import applied');
  ok(!nodeById(flow, 'a1') && !nodeById(flow, 'a2'), 'the members were deleted as asked');
  ok(!!nodeById(flow, 'gA'), 'the box they were in is still there');
  ok(!!nodeById(flow, 'gE'), 'and so is the one the user drew empty');
}

// Wiring two boxed sequences together is an edit to the wires, not to the
// boxes: both stay, with their members, where they were.
async function scenarioWiringAcrossBoxesMovesNothing() {
  console.log('\nA wire between two boxes keeps both boxes where they are');
  const liveNodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'a', x: 120, y: 100, g: 'gA', wires: [['a2']] },
    { id: 'a2', type: 'function', z: 'tab1', name: 'fa', x: 280, y: 100, g: 'gA', wires: [] },
    { id: 'b1', type: 'function', z: 'tab1', name: 'fb', x: 120, y: 260, g: 'gB', wires: [['b2']] },
    { id: 'b2', type: 'debug', z: 'tab1', name: 'db', x: 280, y: 260, g: 'gB', wires: [] },
  ];
  // Left of the layout's own origin, where a user's flow often sits.
  const liveGroups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'A', nodes: ['a1', 'a2'], x: 45, y: 55, w: 310, h: 90 },
    { id: 'gB', type: 'group', z: 'tab1', name: 'B', nodes: ['b1', 'b2'], x: 45, y: 215, w: 310, h: 90 },
  ];
  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    fence({ connections: [{ from: 'function_fa', to: 'function_fb' }] }),
    { mode: 'agent', allowedWorkspaceIds: ['tab1'] }
  );
  const flow = snapshot('tab1');
  ok(res && res.ok, 'the import applied');
  ok(JSON.stringify(nodeById(flow, 'a2').wires) === JSON.stringify([['b1']]), 'the wire was added');
  ok(nodeById(flow, 'gA').nodes.join(',') === 'a1,a2' && nodeById(flow, 'gB').nodes.join(',') === 'b1,b2',
    'each box keeps its members');
  ok(liveNodes.every((l) => nodeById(flow, l.id).x === l.x && nodeById(flow, l.id).y === l.y),
    'and no node moved (' + nodes2d(flow).map((n) => n.id + '@' + n.x + ',' + n.y).join(' ') + ')');
  ok(nodeById(flow, 'gA').x === 45 && nodeById(flow, 'gB').x === 45, 'nor did either box');
}

// The model often leaves the box out when it extends a boxed sequence. The
// new node is part of that sequence, so it belongs in the box; left outside,
// the box and the node it no longer covers were aligned apart.
async function scenarioANewNodeJoinsTheBoxItIsWiredInto() {
  console.log('\nA new node wired into a boxed sequence joins that box');
  const liveNodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'a', x: 120, y: 100, g: 'gA', wires: [['a2']] },
    { id: 'a2', type: 'function', z: 'tab1', name: 'fa', x: 280, y: 100, g: 'gA', wires: [] },
    { id: 'b1', type: 'inject', z: 'tab1', name: 'b', x: 120, y: 260, g: 'gB', wires: [] },
  ];
  const liveGroups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'A', nodes: ['a1', 'a2'], x: 45, y: 55, w: 310, h: 90 },
    { id: 'gB', type: 'group', z: 'tab1', name: 'B', nodes: ['b1'], x: 45, y: 215, w: 150, h: 90 },
  ];
  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    fence({
      nodes: { change_x: { type: 'change', name: 'x' }, debug_y: { type: 'debug', name: 'y' } },
      connections: [{ from: 'function_fa', to: 'change_x' }, { from: 'change_x', to: 'debug_y' }],
    }),
    { mode: 'agent', allowedWorkspaceIds: ['tab1'] }
  );
  const flow = snapshot('tab1');
  const boxA = nodeById(flow, 'gA');
  const x = byName(flow, 'x'), y = byName(flow, 'y');
  ok(res && res.ok, 'the import applied');
  ok(!!x && x.g === 'gA' && !!y && y.g === 'gA', 'both new nodes joined the box, the far one too');
  ok(boxHolds(boxA, nodes2d(flow).filter((n) => n.g === 'gA')), 'and the box was fitted around them');
  const members = nodes2d(flow);
  const clash = members.some((m, i) => members.some((o, j) => j > i &&
    Math.abs(m.x - o.x) < 100 && Math.abs(m.y - o.y) < 30));
  ok(!clash, 'no two nodes overlap (' + members.map((n) => n.id.slice(0, 4) + '@' + n.x + ',' + n.y).join(' ') + ')');
}




// A branch added in the middle of a switch's fan-out, inside a box, with a
// reposition that names the new branch but not every old one. The unnamed
// branch used to keep its row while the named ones were laid over it, and a
// wire removal without a port only looked at port 0, so the moved branches
// stayed wired to two ports. See docs/{en,jp}/vibe-schema.md — Layout fix.
async function scenarioABranchAddedInsideABoxLandsClear() {
  console.log('\nA branch added inside a box lands clear of the others, in port order');
  const nodes = [
    { id: 'u1', type: 'inject', z: 'tab1', name: 'Users Trigger', x: 160, y: 120, wires: [['u2']], g: 'gu' },
    { id: 'u2', type: 'switch', z: 'tab1', name: 'Check Role', x: 380, y: 120, outputs: 3, wires: [['u3'], ['u4'], ['u5']], g: 'gu' },
    { id: 'u3', type: 'change', z: 'tab1', name: 'Set Admin Route', x: 600, y: 80, wires: [['u6']], g: 'gu' },
    { id: 'u4', type: 'change', z: 'tab1', name: 'Set User Route', x: 600, y: 120, wires: [['u7']], g: 'gu' },
    { id: 'u5', type: 'change', z: 'tab1', name: 'Set Guest Route', x: 600, y: 160, wires: [['u8']], g: 'gu' },
    { id: 'u6', type: 'debug', z: 'tab1', name: 'Admin Route', x: 820, y: 80, wires: [], g: 'gu' },
    { id: 'u7', type: 'debug', z: 'tab1', name: 'User Route', x: 820, y: 120, wires: [], g: 'gu' },
    { id: 'u8', type: 'debug', z: 'tab1', name: 'Guest Route', x: 820, y: 160, wires: [], g: 'gu' },
    { id: 'l1', type: 'inject', z: 'tab1', name: 'Log Trigger', x: 160, y: 280, wires: [['l2']], g: 'gl' },
    { id: 'l2', type: 'debug', z: 'tab1', name: 'Log Out', x: 380, y: 280, wires: [], g: 'gl' },
  ];
  const groups = [
    { id: 'gu', type: 'group', z: 'tab1', name: 'Users', style: { label: true },
      nodes: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'], x: 85, y: 45, w: 820, h: 150 },
    { id: 'gl', type: 'group', z: 'tab1', name: 'Log', style: { label: true },
      nodes: ['l1', 'l2'], x: 85, y: 245, w: 380, h: 70 },
  ];
  const msg = fence({
    nodes: {
      switch_check_role: { type: 'switch', name: 'Check Role', props: { outputs: 4 } },
      change_set_manager_route: { type: 'change', name: 'Set Manager Route' },
      debug_manager_route: { type: 'debug', name: 'Manager Route' },
    },
    connections: [
      { remove: { from: 'switch_check_role', to: 'change_set_user_route' } },
      { remove: { from: 'switch_check_role', to: 'change_set_guest_route' } },
      { from: 'switch_check_role', to: 'change_set_manager_route', fromPort: 1 },
      { from: 'switch_check_role', to: 'change_set_user_route', fromPort: 2 },
      { from: 'switch_check_role', to: 'change_set_guest_route', fromPort: 3 },
      { from: 'change_set_manager_route', to: 'debug_manager_route' },
    ],
    reposition: ['switch_check_role', 'change_set_manager_route', 'debug_manager_route',
      'change_set_user_route', 'debug_user_route', 'change_set_guest_route', 'debug_guest_route'],
  });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: clone(nodes), groups: clone(groups), activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, { mode: 'agent', allowedWorkspaceIds: ['tab1'] });
  const flow = snapshot('tab1');
  ok(res && res.ok, 'the import applied (' + (res && res.error) + ')');

  const sw = byName(flow, 'Check Role');
  const manager = byName(flow, 'Set Manager Route');
  ok(JSON.stringify(sw.wires) === JSON.stringify([['u3'], [manager.id], ['u4'], ['u5']]),
    'a removal without a port takes the wire off whichever port it was on (' + JSON.stringify(sw.wires) + ')');

  const rows = ['Set Admin Route', 'Set Manager Route', 'Set User Route', 'Set Guest Route'].map((n) => byName(flow, n).y);
  ok(rows.every((y, i) => i === 0 || y > rows[i - 1]), 'the branches run in port order (' + rows.join(',') + ')');

  const solid = flow.filter((n) => n.type !== 'tab' && n.type !== 'group' && n.type !== 'comment');
  const clash = [];
  solid.forEach((a, i) => solid.slice(i + 1).forEach((b) => {
    if (Math.abs(a.x - b.x) < 100 && Math.abs(a.y - b.y) < 30) clash.push(a.name + '/' + b.name);
  }));
  ok(clash.length === 0, 'no node sits on another (' + clash.join(', ') + ')');

  const users = nodeById(flow, 'gu');
  const log = nodeById(flow, 'gl');
  ok(boxHolds(users, users.nodes.map((id) => nodeById(flow, id)).filter(Boolean)), 'the box grew around the new branch');
  ok(log.y >= users.y + users.h, 'and the box below was pushed clear of it (' + (users.y + users.h) + ' / ' + log.y + ')');
}

// Where a comment sits is the model's decision: the context says which node
// each comment heads, and naming another one moves it there — into that
// node's box, out of the one it was in.
async function scenarioTheModelMovesACommentByNamingItsNode() {
  console.log('\nA comment moves to the node the reply names, and into its box');
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tab1', name: 'A in', x: 160, y: 120, wires: [['a2']], g: 'gA' },
    { id: 'a2', type: 'debug', z: 'tab1', name: 'A out', x: 380, y: 120, wires: [], g: 'gA' },
    { id: 'cm', type: 'comment', z: 'tab1', name: 'Heading', x: 160, y: 80, wires: [], g: 'gA' },
    { id: 'b1', type: 'inject', z: 'tab1', name: 'B in', x: 160, y: 300, wires: [['b2']], g: 'gB' },
    { id: 'b2', type: 'debug', z: 'tab1', name: 'B out', x: 380, y: 300, wires: [], g: 'gB' },
  ];
  const groups = [
    { id: 'gA', type: 'group', z: 'tab1', name: 'A', style: { label: true }, nodes: ['a1', 'a2', 'cm'], x: 85, y: 45, w: 400, h: 100 },
    { id: 'gB', type: 'group', z: 'tab1', name: 'B', style: { label: true }, nodes: ['b1', 'b2'], x: 85, y: 265, w: 400, h: 60 },
  ];

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: clone(nodes), groups: clone(groups), activeId: 'tab1' });
  const Converter = LLMPlugin.FlowConverterCore;
  const ctx = Converter.toIntermediate(clone(nodes.concat(groups)));
  ok(ctx.nodes.comment_heading && ctx.nodes.comment_heading.above === 'inject_a_in',
    'the context says which node the comment heads (' + JSON.stringify(ctx.nodes.comment_heading) + ')');

  const msg = fence({ nodes: { comment_heading: { type: 'comment', name: 'Heading', above: 'inject_b_in' } } });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, { mode: 'agent', allowedWorkspaceIds: ['tab1'] });
  const flow = snapshot('tab1');
  ok(res && res.ok, 'the import applied (' + (res && res.error) + ')');

  const cm = nodeById(flow, 'cm'), b1 = nodeById(flow, 'b1');
  ok(cm.y < b1.y && b1.y - cm.y <= 60, 'the comment now sits directly above B in (' + cm.y + ' / ' + b1.y + ')');
  const W = (n) => LLMPlugin.CanvasLayout.getNodeWidth(n, {});
  ok(Math.abs((cm.x - W(cm) / 2) - (b1.x - W(b1) / 2)) < 1, 'sharing its left edge (' + cm.x + ' / ' + b1.x + ')');
  ok(cm.g === 'gB', 'it moved into B\'s box (' + cm.g + ')');
  ok(nodeById(flow, 'gA').nodes.indexOf('cm') === -1 && nodeById(flow, 'gB').nodes.indexOf('cm') !== -1,
    'and left A\'s list for B\'s');
}

// A reply that mentions groups anyway changes no box: none is created,
// none is edited, none is deleted.
async function scenarioAReplyCannotTouchABox() {
  console.log('\nA reply cannot create, edit or delete a box');
  const liveNodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 150, y: 100, g: 'grp', wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 350, y: 100, g: 'grp', wires: [] },
    { id: 'n3', type: 'inject', z: 'tab1', name: 'other', x: 150, y: 300, wires: [] },
  ];
  const liveGroups = [{ id: 'grp', type: 'group', z: 'tab1', name: 'Pair', nodes: ['n1', 'n2'],
    x: 75, y: 75, w: 350, h: 50 }];
  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const Converter = LLMPlugin.FlowConverterCore;
  ok(!Converter.isVibeSchema({ groups: { group_new: { nodes: ['inject_other'] } } }),
    'a groups-only reply is not a schema');
  const res = await LLMPlugin.Importer.importFlowFromMessage(fence({
    nodes: { inject_other: { type: 'inject', name: 'other', props: { topic: 't' } } },
    groups: { group_pair: null, group_new: { name: 'New', nodes: ['inject_other'] } },
  }), { mode: 'agent', allowedWorkspaceIds: ['tab1'] });
  const flow = snapshot('tab1');
  const boxes = groupsIn(flow);
  ok(res && res.ok, 'the node edit still applied');
  ok(boxes.length === 1 && boxes[0].id === 'grp', 'no box was created, and none deleted (' +
    boxes.map((g) => g.name).join(',') + ')');
  ok(boxes[0].nodes.join(',') === 'n1,n2' && !nodeById(flow, 'n3').g, 'and none edited');
}

// The context shows no box, and the node aliases are what they would be
// without one: a box is the user's, and the numbering the importer reproduces
// must not move because one exists.
function scenarioTheContextShowsNoBox() {
  console.log('\nThe context shows no box, and leaves node aliases alone');
  const { LLMPlugin } = loadSandbox({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const Converter = LLMPlugin.FlowConverterCore;
  const exported = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 300, y: 100, wires: [] },
  ];
  const withGroup = exported.concat([{
    id: 'grp', type: 'group', z: 'tab1', name: 'Pair', style: { label: true },
    nodes: ['n1', 'n2'], x: 50, y: 50, w: 320, h: 100,
  }]);
  const plain = Converter.toIntermediate(clone(exported));
  const withG = Converter.toIntermediate(clone(withGroup));
  ok(!withG.groups && !Object.keys(withG.nodes).some((k) => /group/.test(k)),
    'no group appears (' + Object.keys(withG.nodes).join(',') + ')');
  ok(Object.keys(plain.nodes).join(',') === Object.keys(withG.nodes).join(','),
    'and every node alias is what it was without the box');
}

// A comment placed over a node in a box is that sequence's heading, so it goes
// in the box: left out, it would sit exactly on the top edge.
async function scenarioACaptionJoinsTheBoxOfTheNodeItHeads() {
  console.log('\nA new comment over a boxed node is drawn inside the box');
  const liveNodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 150, y: 100, g: 'grp', wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 350, y: 100, g: 'grp', wires: [] },
  ];
  const liveGroups = [{ id: 'grp', type: 'group', z: 'tab1', name: 'Pair', nodes: ['n1', 'n2'],
    x: 75, y: 75, w: 350, h: 50 }];
  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(liveNodes), groups: clone(liveGroups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(fence({
    nodes: { comment_overview: { type: 'comment', name: 'Overview', above: 'inject_tick' } },
  }), { mode: 'agent', allowedWorkspaceIds: ['tab1'] });
  const flow = snapshot('tab1');
  const g = nodeById(flow, 'grp');
  const comment = flow.find((n) => n && n.type === 'comment');
  ok(res && res.ok, 'the import applied');
  ok(!!comment && comment.g === 'grp' && g.nodes.indexOf(comment.id) !== -1,
    'the caption is a member of the box it heads');
  ok(g.y < comment.y - 15, 'so the box starts above it (' + g.y + ' vs ' + comment.y + ')');
}

async function run() {
  await scenarioAReplyCannotTouchABox();
  scenarioTheContextShowsNoBox();
  await scenarioBoxGrowsWithoutCrowdingTheNext();
  await scenarioRepositioningABoxMovesItsMembers();
  await scenarioRepositionTakesTheCaptionAlong();
  await scenarioAnExistingBoxIsNeverRemovedImplicitly();
  await scenarioWiringAcrossBoxesMovesNothing();
  await scenarioANewNodeJoinsTheBoxItIsWiredInto();
  await scenarioACaptionJoinsTheBoxOfTheNodeItHeads();
  await scenarioABranchAddedInsideABoxLandsClear();
  await scenarioTheModelMovesACommentByNamingItsNode();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
