// Groups: the "flow" a user means when they say one connected sequence.
//
// Node-RED calls two different things a flow — a tab, and a chain of wired
// nodes — so "make me three flows" is ambiguous in the one place it matters.
// The schema settles it: a tab is `flow`, a sequence is a GROUP, and a group is
// a box drawn around members. See docs/{en,jp}/vibe-schema.md — Groups.
//
// What has to hold:
//  - membership is two-sided (`g` on the member, the id in the group's list),
//    because the editor draws from both and repairs neither for us;
//  - the BOX is ours to compute. Node-RED stores x/y/w/h on the group and only
//    recomputes them when a user drags a member, so a box we leave at 0×0 is a
//    box the user sees at 0×0;
//  - a group edit is a merge like everything else: re-declaring one does not
//    empty it, and deleting the box does not delete the nodes inside it.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

const TABS = [{ id: 'tab1', type: 'tab', label: 'Flow 1' }];

function loadSandbox(opts) {
  const mock = buildEditorMock(opts);
  return { LLMPlugin: loadPluginSandbox(mock.RED), snapshot: mock.snapshot, idsIn: mock.idsIn };
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

// The editor's own clearance between a group's box and the members inside it.
const PAD = 25;

function boxHolds(group, members) {
  return members.every((m) => {
    const w = (typeof m.w === 'number' && m.w > 0) ? m.w : 100;
    const h = (typeof m.h === 'number' && m.h > 0) ? m.h : 30;
    return group.x <= m.x - w / 2 && group.y <= m.y - h / 2 &&
      group.x + group.w >= m.x + w / 2 && group.y + group.h >= m.y + h / 2;
  });
}

async function scenarioGroupIsBuiltAroundItsMembers() {
  console.log('A declared group becomes a box around its members');
  const msg = 'Two sequences.\n' + fence({
    nodes: {
      inject_tick: { type: 'inject', name: 'tick' },
      debug_out: { type: 'debug', name: 'out' },
    },
    connections: [{ from: 'inject_tick', to: 'debug_out' }],
    groups: { group_collector: { name: 'Collector', nodes: ['inject_tick', 'debug_out'] } },
  });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const groups = groupsIn(flow);

  ok(res && res.ok, 'the import applied');
  ok(groups.length === 1, 'one group was created (' + groups.length + ')');
  const g = groups[0];
  ok(!!g && g.name === 'Collector', 'with the name the schema gave it (' + (g && g.name) + ')');

  const members = (g.nodes || []).map((id) => nodeById(flow, id)).filter(Boolean);
  ok(members.length === 2, 'both nodes are listed as members (' + (g.nodes || []).join(',') + ')');
  ok(members.every((m) => m.g === g.id),
    'and each member points back at the group, which is the half the editor draws from');

  ok(g.w > 0 && g.h > 0, 'the box has a size (' + g.w + 'x' + g.h + ')');
  ok(boxHolds(g, members),
    'and it contains every member — a box we leave empty is one the user sees empty');
  const tick = byName(flow, 'tick');
  ok(Math.abs((g.x + PAD) - (tick.x - 100 / 2)) < 1,
    "the padding is the editor's own 25px (left edge " + g.x + ' vs member ' + tick.x + ')');
}

async function scenarioGroupAroundExistingNodesOnly() {
  console.log('\nA group can be drawn around nodes that are already there');
  const nodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 300, y: 100, wires: [] },
  ];
  // No `nodes` key at all: the whole edit is the box.
  const msg = fence({ groups: { group_pair: { name: 'Pair', nodes: ['inject_tick', 'debug_out'] } } });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const groups = groupsIn(flow);

  ok(res && res.ok, 'the import applied (' + (res && res.error) + ')');
  ok(groups.length === 1, 'the box was created (' + groups.length + ')');
  const g = groups[0] || { nodes: [] };
  ok((g.nodes || []).indexOf('n1') !== -1 && (g.nodes || []).indexOf('n2') !== -1,
    'around the existing nodes, resolved by alias (' + (g.nodes || []).join(',') + ')');
  ok(nodeById(flow, 'n1').g === g.id && nodeById(flow, 'n2').g === g.id,
    'and both now say which group they are in');
  ok(nodeById(flow, 'n1').x === 100, 'the nodes themselves were not moved');
}

async function scenarioMembershipIsAdditive() {
  console.log('\nAdding a member does not empty the group');
  const nodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 300, y: 100, wires: [] },
  ];
  const groups = [{
    id: 'grp', type: 'group', z: 'tab1', name: 'Pair', style: { label: true },
    nodes: ['n1', 'n2'], x: 50, y: 50, w: 320, h: 100,
  }];
  // The existing group, re-declared with only the NEW node in its list.
  const msg = fence({
    nodes: { change_tag: { type: 'change', name: 'tag' } },
    connections: [{ from: 'debug_out', to: 'change_tag' }],
    groups: { group_pair: { nodes: ['change_tag'] } },
  });

  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(nodes), groups: clone(groups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const g = groupsIn(flow)[0];

  ok(res && res.ok, 'the import applied');
  ok(groupsIn(flow).length === 1, 'the existing group was edited, not duplicated');
  ok(!!g && (g.nodes || []).indexOf('n1') !== -1 && (g.nodes || []).indexOf('n2') !== -1,
    'the members it already had are still in it (' + (g && (g.nodes || []).join(',')) + ')');
  const added = byName(flow, 'tag');
  ok(!!added && (g.nodes || []).indexOf(added.id) !== -1, 'and the new node joined them');
  ok(!!added && added.g === g.id, 'with its own half of the membership set');
  ok(!!g && g.name === 'Pair', 'the name it had is kept when the schema omits it');
  ok(boxHolds(g, (g.nodes || []).map((id) => nodeById(flow, id)).filter(Boolean)),
    'and the box grew to hold the new member (' + [g.x, g.y, g.w, g.h].join(',') + ')');
}

async function scenarioDeletingTheBoxKeepsTheNodes() {
  console.log('\nDeleting a group deletes the box, not the nodes in it');
  const nodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']], g: 'grp' },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'out', x: 300, y: 100, wires: [], g: 'grp' },
  ];
  const groups = [{
    id: 'grp', type: 'group', z: 'tab1', name: 'Pair', style: { label: true },
    nodes: ['n1', 'n2'], x: 50, y: 50, w: 320, h: 100,
  }];
  const msg = fence({ groups: { group_pair: null } });

  const { LLMPlugin, snapshot } = loadSandbox({
    tabs: TABS, nodes: clone(nodes), groups: clone(groups), activeId: 'tab1',
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');

  ok(res && res.ok, 'the import applied (' + (res && res.error) + ')');
  ok(groupsIn(flow).length === 0, 'the box is gone');
  ok(!!nodeById(flow, 'n1') && !!nodeById(flow, 'n2'), 'both nodes are still on the canvas');
  ok(!nodeById(flow, 'n1').g && !nodeById(flow, 'n2').g,
    'and neither still points at a group that no longer exists');
}

async function scenarioTwoSequencesTwoBoxes() {
  console.log('\nTwo independent sequences get a box each, and the boxes do not overlap');
  const msg = 'Two independent sequences.\n' + fence({
    nodes: {
      inject_a: { type: 'inject', name: 'a in' },
      debug_a: { type: 'debug', name: 'a out' },
      inject_b: { type: 'inject', name: 'b in' },
      debug_b: { type: 'debug', name: 'b out' },
    },
    connections: [
      { from: 'inject_a', to: 'debug_a' },
      { from: 'inject_b', to: 'debug_b' },
    ],
    groups: {
      group_a: { name: 'Sequence A', nodes: ['inject_a', 'debug_a'] },
      group_b: { name: 'Sequence B', nodes: ['inject_b', 'debug_b'] },
    },
  });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const groups = groupsIn(flow);

  ok(res && res.ok, 'the import applied');
  ok(groups.length === 2, 'two boxes (' + groups.length + ')');
  const [g1, g2] = groups;
  const overlap = g1.x < g2.x + g2.w && g2.x < g1.x + g1.w &&
    g1.y < g2.y + g2.h && g2.y < g1.y + g1.h;
  ok(!overlap, 'they do not overlap (' + [g1.x, g1.y, g1.w, g1.h].join(',') + ' vs ' +
    [g2.x, g2.y, g2.w, g2.h].join(',') + ')');
  ok(groups.every((g) => (g.nodes || []).length === 2), 'each holds its own two nodes');
  ok(groups.every((g) => boxHolds(g, (g.nodes || []).map((id) => nodeById(flow, id)).filter(Boolean))),
    'and holds them inside its box');
}

// The clearance itself is canvas_layout's (`separateGroups`); what this pair
// asserts is that the shape an LLM actually proposes comes out of the
// importer with it — the node layout spaces MEMBERS, and a caption that
// joined a group used to grow its box 10px into the box above.
const GROUP_GAP = 40;

function boxGaps(groups) {
  const sorted = groups.slice().sort((a, b) => a.y - b.y);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].y - (sorted[i - 1].y + sorted[i - 1].h));
  }
  return gaps;
}

async function scenarioCaptionedBoxesStayApart() {
  console.log('\nThree captioned sequences: every box keeps two grid squares from the next');
  const nodes = {}, connections = [], groups = {};
  ['a', 'b', 'c'].forEach((l) => {
    nodes['inject_' + l] = { type: 'inject', name: l };
    nodes['debug_d' + l] = { type: 'debug', name: 'd' + l };
    nodes['comment_head_' + l] = {
      type: 'comment', name: 'Sequence ' + l.toUpperCase(), above: 'inject_' + l,
    };
    connections.push({ from: 'inject_' + l, to: 'debug_d' + l });
    groups['group_' + l] = {
      name: 'Seq' + l.toUpperCase(),
      nodes: ['inject_' + l, 'debug_d' + l, 'comment_head_' + l],
    };
  });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(fence({ nodes, connections, groups }), {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const boxes = groupsIn(snapshot('tab1'));
  const gaps = boxGaps(boxes);

  ok(res && res.ok, 'the import applied');
  ok(boxes.length === 3, 'three boxes (' + boxes.length + ')');
  ok(gaps.every((g) => g >= GROUP_GAP),
    'each box clears the one above it by at least two grid squares (' + gaps.join(', ') + ')');
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
    groups: { group_seqa: { name: 'SeqA', nodes: ['function_fa'] } },
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

// A box has no position of its own — it is fitted around wherever its members
// end up — so naming one in `reposition` can only mean the sequence inside it.
// Silently ignoring the alias left the user's "tidy this group up" doing
// nothing at all.
async function scenarioRepositioningABoxMovesItsMembers() {
  console.log('\nNaming a box in a reposition rearranges the sequence inside it');
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
    fence({ reposition: ['group_pair'] }),
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

async function scenarioCaptionJoinsTheBoxItHeads() {
  console.log('\nA new comment heading a member is drawn inside the box');
  const msg = fence({
    nodes: {
      inject_tick: { type: 'inject', name: 'tick' },
      debug_out: { type: 'debug', name: 'out' },
      comment_overview: {
        type: 'comment', name: 'Overview', above: 'inject_tick',
        props: { info: 'What this sequence does.' },
      },
    },
    connections: [{ from: 'inject_tick', to: 'debug_out' }],
    groups: { group_seq: { name: 'Sequence', nodes: ['inject_tick', 'debug_out'] } },
  });

  const { LLMPlugin, snapshot } = loadSandbox({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const flow = snapshot('tab1');
  const g = groupsIn(flow)[0];
  const comment = flow.find((n) => n && n.type === 'comment');

  ok(res && res.ok, 'the import applied');
  // The padding is one row, so a caption left out of the box lands exactly on
  // its top edge and reads as a stray label rather than a heading.
  ok(!!g && !!comment && (g.nodes || []).indexOf(comment.id) !== -1,
    'the caption is a member of the group it heads');
  ok(!!comment && comment.g === g.id, 'and says so itself');
  ok(!!g && g.y < comment.y - 15,
    'so the box starts above it (' + (g && g.y) + ' vs ' + (comment && comment.y) + ')');
}

// The context the model reads back has to name groups the same way it names
// nodes, or the next turn cannot edit the box it was just shown.
function scenarioContextRoundTrip() {
  console.log('\nThe context presents a group as a group, and leaves node aliases alone');
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

  ok(!withG.nodes.group_pair, 'the group is NOT one of the nodes');
  ok(!!withG.groups && !!withG.groups.group_pair,
    'it is in the groups map, under a {type}_{name} alias (' +
      Object.keys(withG.groups || {}).join(',') + ')');
  ok(!!withG.groups && withG.groups.group_pair.nodes.join(',') === 'inject_tick,debug_out',
    'with its members named by THEIR aliases (' +
      (withG.groups && withG.groups.group_pair.nodes.join(',')) + ')');
  ok(Object.keys(plain.nodes).join(',') === Object.keys(withG.nodes).join(','),
    'and every node alias is what it was without the group — the numbering the ' +
      'importer reproduces cannot move because a box exists');
  ok(Converter.isVibeSchema({ groups: { group_pair: { nodes: ['inject_tick'] } } }),
    'a groups-only reply is a schema in its own right');
}

async function run() {
  await scenarioGroupIsBuiltAroundItsMembers();
  await scenarioGroupAroundExistingNodesOnly();
  await scenarioMembershipIsAdditive();
  await scenarioDeletingTheBoxKeepsTheNodes();
  await scenarioTwoSequencesTwoBoxes();
  await scenarioCaptionedBoxesStayApart();
  await scenarioBoxGrowsWithoutCrowdingTheNext();
  await scenarioRepositioningABoxMovesItsMembers();
  await scenarioCaptionJoinsTheBoxItHeads();
  scenarioContextRoundTrip();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
