// An edit must touch only what it edits.
//
// The apply used to clear the target workspace and re-import the whole merged
// flow. That produced the right end state, but every node in the tab was
// destroyed and recreated on the way there — taking the canvas selection, the
// editor's own undo history, and anything the snapshot happened to miss with
// it. `applyWorkspaceDiff` applies the same end state as a diff instead.
//
// So these scenarios assert the WORK DONE, not the result: which entities were
// removed, which were handed to import(), which links were cut and made. The
// resulting flow is checked too, because "touch nothing" is only a virtue if
// the edit still lands.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('../helpers.js');

const TABS = [{ id: 't1', type: 'tab', label: 'Main' }];

// inject -> function -> debug, plus a junction and a group that no edit below
// ever mentions. Junctions and groups are the entities a rebuild loses first,
// so they are in every scenario as tripwires.
function flow() {
  return {
    nodes: [
      { id: 'inj', type: 'inject', z: 't1', name: 'tick', repeat: '5', payloadType: 'date',
        x: 100, y: 100, wires: [['fn']] },
      { id: 'fn', type: 'function', z: 't1', name: 'shape', func: 'return msg;', outputs: 1,
        x: 300, y: 100, wires: [['dbg']] },
      { id: 'dbg', type: 'debug', z: 't1', name: 'out', active: true,
        x: 500, y: 100, wires: [] },
    ],
    junctions: [{ id: 'jn', type: 'junction', z: 't1', x: 300, y: 300, wires: [[]] }],
    groups: [{ id: 'grp', type: 'group', z: 't1', name: 'Box', style: {}, nodes: ['inj'] }],
  };
}

async function apply(message, mockOpts) {
  const f = flow();
  const mock = buildEditorMock(Object.assign({
    tabs: TABS, nodes: f.nodes, junctions: f.junctions, groups: f.groups, activeId: 't1',
  }, mockOpts || {}));
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(message, {
    mode: 'agent', allowedWorkspaceIds: ['t1'],
  });
  const byId = {};
  mock.snapshot('t1').forEach((n) => { byId[n.id] = n; });
  const c = mock.captured;
  return {
    res, byId, captured: c,
    importedIds: [].concat(...c.imports).map((n) => n.id),
  };
}

function extrasSurvived(c, label) {
  ok(c.removedJunctions.length === 0,
    label + ': the unrelated junction was never removed');
  ok(c.removedGroups.length === 0,
    label + ': the unrelated group was never removed');
}

async function propertyEditTouchesNothingElse() {
  console.log('A property edit is written in place - nothing is removed or re-imported');
  const { res, byId, captured, importedIds } = await apply(
    'Tweaking the function.\n' + fence({
      nodes: { function_shape: { props: { func: 'msg.payload = 1; return msg;' } } },
    })
  );

  ok(res && res.ok, 'the edit applied');
  // The importer reformats a function body onto separate statements, so this
  // asks whether the new code is there, not how it was laid out.
  ok(!!byId.fn && byId.fn.func.indexOf('msg.payload = 1;') !== -1 &&
     byId.fn.func.indexOf('return msg;') !== -1, 'the function body changed');
  ok(captured.removed.length === 0,
    'no node was removed (' + (captured.removed.join(',') || 'none') + ')');
  ok(importedIds.length === 0,
    'import() was never called (' + (importedIds.join(',') || 'nothing') + ')');
  ok(captured.linksAdded.length === 0 && captured.linksRemoved.length === 0,
    'and no wire was disturbed');
  // Validated as the edit dialog would, or a warning mark set before the
  // edit stays until the user opens the node.
  ok(captured.validated.indexOf('fn') !== -1, 'the edited node was re-validated');
  extrasSurvived(captured, 'property edit');
}

async function addingANodeImportsOnlyThatNode() {
  console.log('\nAdding a node imports that node and rewires only its neighbour');
  const { res, byId, captured, importedIds } = await apply(
    'Adding a second logger.\n' + fence({
      nodes: { debug_audit: { type: 'debug', props: { name: 'audit' } } },
      connections: [{ from: 'function_shape', to: 'debug_audit' }],
    })
  );

  ok(res && res.ok, 'the edit applied');
  const audit = Object.values(byId).find((n) => n.name === 'audit');
  ok(!!audit, 'the new debug node is on the canvas');
  ok(importedIds.length === 1 && importedIds[0] === (audit && audit.id),
    'exactly one node went through import() (' + importedIds.join(',') + ')');
  ok(captured.removed.length === 0,
    'nothing was removed to make room (' + (captured.removed.join(',') || 'none') + ')');
  // fn already reached dbg; the new edge is the only link created, and the
  // existing one must survive untouched rather than being cut and remade.
  ok(captured.linksRemoved.length === 0,
    'no existing wire was cut (' + (captured.linksRemoved.join(',') || 'none') + ')');
  ok(byId.fn.wires[0].indexOf('dbg') !== -1 && byId.fn.wires[0].indexOf(audit.id) !== -1,
    'the function now feeds both loggers');
  extrasSurvived(captured, 'add');
}

// A property the reply leaves out takes its type's default, as a node dropped
// from the palette does. A split with no `property` fails validation and
// shows the warning mark on the canvas.
async function aNewNodeTakesItsTypeDefaults() {
  console.log('\nA new node takes the defaults of its type for what the reply left out');
  const types = { split: { category: 'sequence', defaults: {
    name: { value: '' }, splt: { value: '\\n' }, spltType: { value: 'str' },
    property: { value: 'payload', required: true },
  } } };
  const { res, byId } = await apply(fence({
    nodes: { split_items: { type: 'split', name: 'Split Items', props: { spltType: 'len' } } },
    connections: [{ from: 'function_shape', to: 'split_items' }],
  }), { types });
  const split = Object.values(byId).find((n) => n.type === 'split');
  ok(res && res.ok && split && split.property === 'payload' && split.splt === '\\n',
    'the missing properties came from the type (' + JSON.stringify(split && { property: split.property, splt: split.splt }) + ')');
  ok(split && split.spltType === 'len', 'and what the reply set is kept');

  // The edit dialog writes "" for a config reference left at "none"; left
  // undefined, opening the node and closing it marks the flow changed.
  const httpTypes = { 'http in': { category: 'network', defaults: {
    name: { value: '' }, url: { value: '', required: true }, method: { value: 'get', required: true },
    upload: { value: false }, skipBodyParsing: { value: false }, swaggerDoc: { type: 'swagger-doc', required: false },
  } } };
  const r2 = await apply(fence({
    nodes: { http_in_hello: { type: 'http in', name: 'GET /hello', props: { url: '/hello' } } },
  }), { types: httpTypes });
  const httpIn = Object.values(r2.byId).find((n) => n.type === 'http in');
  ok(r2.res && r2.res.ok && httpIn && httpIn.swaggerDoc === '' && httpIn.method === 'get',
    'a config reference with no default is "", as the dialog writes it (' +
      JSON.stringify(httpIn && { swaggerDoc: httpIn.swaggerDoc, method: httpIn.method }) + ')');
}

async function deletingANodeRemovesOnlyThatNode() {
  console.log('\nDeleting a node removes that node and nothing else');
  const { res, byId, captured, importedIds } = await apply(
    'Dropping the logger.\n' + fence({ delete: ['debug_out'] })
  );

  ok(res && res.ok, 'the edit applied');
  ok(!byId.dbg, 'the debug node is gone');
  ok(captured.removed.length === 1 && captured.removed[0] === 'dbg',
    'it is the ONLY node removed (' + captured.removed.join(',') + ')');
  ok(importedIds.length === 0,
    'the survivors were not re-imported (' + (importedIds.join(',') || 'nothing') + ')');
  ok(!!byId.inj && !!byId.fn, 'the rest of the chain is still there');
  ok(byId.inj.wires[0].indexOf('fn') !== -1, 'and still wired to each other');
  extrasSurvived(captured, 'delete');
}

async function rewiringOnlyMovesLinks() {
  console.log('\nRewiring cuts and makes links - it does not rebuild the nodes');
  // Bypass the function: wire the inject straight to the debug and drop the
  // inject -> function edge.
  const { res, byId, captured, importedIds } = await apply(
    'Bypassing the function.\n' + fence({
      connections: [
        { from: 'inject_tick', to: 'debug_out' },
        { delete: { from: 'inject_tick', to: 'function_shape' } },
      ],
    })
  );

  ok(res && res.ok, 'the edit applied');
  ok(byId.inj && byId.inj.wires[0].indexOf('dbg') !== -1, 'the inject now feeds the debug');
  ok(byId.inj && byId.inj.wires[0].indexOf('fn') === -1, 'the old edge to the function is gone');
  ok(captured.removed.length === 0,
    'no node was removed to change a wire (' + (captured.removed.join(',') || 'none') + ')');
  ok(importedIds.length === 0,
    'and none was re-imported (' + (importedIds.join(',') || 'nothing') + ')');
  ok(captured.linksAdded.length === 1 && captured.linksAdded[0] === 'inj:0->dbg',
    'exactly one link was made (' + captured.linksAdded.join(',') + ')');
  ok(captured.linksRemoved.length === 1 && captured.linksRemoved[0] === 'inj:0->fn',
    'exactly one link was cut (' + captured.linksRemoved.join(',') + ')');
  ok(byId.fn && byId.fn.wires[0].indexOf('dbg') !== -1,
    'the function -> debug wire nobody mentioned is untouched');
  extrasSurvived(captured, 'rewire');
}

// Groups used to be the one thing the diff refused outright, so every edit
// that put a node in a box rebuilt the whole tab. A new node wired into a
// boxed sequence joins that box, so extending one is the common case. The
// diff expresses it; the fallback's fingerprint is that it removes the group,
// so that is what this asserts it does not do.
async function joiningAGroupIsStillADiff() {
  console.log('\nA node joining an existing group does not rebuild the tab');
  const { res, byId, captured, importedIds } = await apply(
    'Tag it.\n' + fence({
      nodes: { change_tag: { type: 'change', name: 'tag' } },
      connections: [{ from: 'inject_tick', to: 'change_tag' }],
    })
  );

  const added = importedIds.filter((id) => !['inj', 'fn', 'dbg', 'jn', 'grp'].includes(id));
  ok(res && res.ok, 'the edit applied');
  ok(added.length === 1, 'one node was imported (' + (importedIds.join(',') || 'nothing') + ')');
  ok(captured.removed.length === 0,
    'nothing was removed to make room for it (' + (captured.removed.join(',') || 'none') + ')');
  extrasSurvived(captured, 'group join');

  const box = byId.grp;
  ok(!!box && (box.nodes || []).indexOf(added[0]) !== -1,
    'the box lists its new member (' + ((box && box.nodes) || []).join(',') + ')');
  ok(!!box && (box.nodes || []).indexOf('inj') !== -1,
    'and still lists the member it had');
  ok(byId[added[0]] && byId[added[0]].g === 'grp',
    'the member points back at the box, which is the half the editor draws from');
  ok(!!box && box.w > 0 && box.h > 0,
    'and the box has bounds the layout fitted (' + (box && box.w) + 'x' + (box && box.h) + ')');
}

// A rename is a width change, and `x` is a centre: the node used to slide out
// of its column, leaving the caption above it stranded and pushing the left
// edge (and any box around it) towards negative x.
async function renamingKeepsTheColumn() {
  console.log('\nRenaming a node keeps its left edge, and its caption with it');
  const f = flow();
  f.nodes.unshift({ id: 'cap', type: 'comment', z: 't1', name: 'What this does',
    x: 130, y: 60, wires: [] });
  const mock = buildEditorMock({
    tabs: TABS, nodes: f.nodes, junctions: f.junctions, groups: f.groups, activeId: 't1',
  });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(
    'Name it properly.\n' + fence({
      nodes: { inject_tick: { type: 'inject', name: 'a considerably longer trigger name' } },
    }),
    { mode: 'agent', allowedWorkspaceIds: ['t1'] }
  );

  const byId = {};
  mock.snapshot('t1').forEach((n) => { byId[n.id] = n; });
  const Layout = require('../../src/core/canvas_layout.js');
  const leftOf = (n) => n.x - Layout.estimateNodeWidth(n, {}) / 2;

  // The fixture's inject sits at x=100 and is 100 wide, so its column is 50.
  const column = 100 - Layout.estimateNodeWidth({ type: 'inject', name: 'tick' }, {}) / 2;

  ok(res && res.ok, 'the edit applied');
  // The fixture's column is off the grid: the node keeps it, or the nearest square.
  ok(Math.abs(leftOf(byId.inj) - column) <= 10,
    'the renamed node kept its left edge (' + leftOf(byId.inj) + ', was ' + column + ')');
  ok(leftOf(byId.cap) === leftOf(byId.inj),
    'the caption still shares that edge (' + leftOf(byId.cap) + ')');
  ok(leftOf(byId.fn) >= leftOf(byId.inj) + Layout.estimateNodeWidth(byId.inj, {}),
    'and the node after it moved over rather than being overlapped (' +
      leftOf(byId.fn) + ')');
  ok(byId.grp.x === leftOf(byId.inj) - 25,
    'the box around it sits one padding left of that column, not off the canvas (' +
      byId.grp.x + ')');
}

// The fixture sits off the grid (left edges at 50, 250, 450). A reposition
// is kept at the sequence's old top-left, but only to the nearest square:
// the node already at that corner used to stay off the grid.
// RED.nodes.import links a wire only to a node in the same import, so a wire
// from the new node to one already on the canvas has to be made after it:
// an edit inserting a change between a ui-form and a ui-text lost the second
// wire in the editor while the old mock kept it.
async function aNewNodeWiresToAnExistingOne() {
  console.log('\nA new node is wired to the existing node it feeds');
  const { res, byId } = await apply(fence({
    nodes: { change_mid: { type: 'change', name: 'mid', props: { rules: [{ t: 'set', p: 'payload', pt: 'msg', to: 'x', tot: 'str' }] } } },
    connections: [{ from: 'function_shape', to: 'change_mid' }, { from: 'change_mid', to: 'debug_out' }],
  }));
  const mid = Object.values(byId).find((n) => n.type === 'change');
  ok(res && res.ok && mid && byId.fn.wires[0].indexOf(mid.id) !== -1, 'the existing node feeds the new one');
  ok(mid && mid.wires[0] && mid.wires[0].indexOf('dbg') !== -1,
    'and the new one feeds the existing debug (' + JSON.stringify(mid && mid.wires) + ')');
  // The chain is reflowed around the insertion but stays on its row: pinning
  // its centre as a top edge put it a square lower every time.
  ok([byId.inj, byId.fn, byId.dbg].every((n) => n && n.y === 100),
    'and the chain keeps its row (' + [byId.inj, byId.fn, byId.dbg].map((n) => n && n.y).join(',') + ')');
}

// An import marks nothing unless asked: a new node came in looking deployed
// while the edited one next to it was marked, so a Deploy looked complete.
async function aNewNodeIsUndeployed() {
  console.log('\nA new node is marked undeployed, like an edited one');
  const f = flow();
  const mock = buildEditorMock({ tabs: TABS, nodes: f.nodes, junctions: f.junctions, groups: f.groups, activeId: 't1' });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(fence({
    nodes: { debug_extra: { type: 'debug', name: 'extra' }, function_shape: { type: 'function', name: 'shape', props: { func: 'return null;' } } },
    connections: [{ from: 'function_shape', to: 'debug_extra' }],
  }), { mode: 'agent', allowedWorkspaceIds: ['t1'] });
  const added = mock.snapshot('t1').find((n) => n.name === 'extra');
  ok(res && res.ok && added && mock.RED.nodes.node(added.id).changed === true, 'the new node is changed');
  ok(mock.RED.nodes.node('fn').changed === true, 'and so is the edited one');
  ok(!mock.RED.nodes.node('inj').changed, 'while the untouched inject is not');
}

// A reply's new nodes go to the tab it was asked from, even when another tab
// in scope is open by the time it is applied (an Apply Again later on).
async function newNodesGoHome() {
  console.log('\nNew nodes go to the tab the reply was asked from');
  const tabs = [{ id: 't1', type: 'tab', label: 'Flow 1' }, { id: 't2', type: 'tab', label: 'Flow 2' }];
  const mock = buildEditorMock({ tabs, activeId: 't2', nodes: [
    { id: 'a', type: 'inject', z: 't1', name: 'a', x: 150, y: 100, wires: [[]] },
    { id: 'b', type: 'inject', z: 't2', name: 'b', x: 150, y: 100, wires: [[]] }] });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(fence({ nodes: { debug_new: { type: 'debug', name: 'new' } } }),
    { mode: 'agent', allowedWorkspaceIds: ['t1', 't2'], homeWorkspaceId: 't1' });
  const onT1 = mock.snapshot('t1').some((n) => n.name === 'new'), onT2 = mock.snapshot('t2').some((n) => n.name === 'new');
  ok(res && res.ok && onT1 && !onT2, 'it lands on Flow 1, not the open Flow 2 (' + onT1 + '/' + onT2 + ')');
}

async function repositionLandsOnTheGrid() {
  console.log('\nA reposition puts the whole sequence on the grid');
  const { res, byId } = await apply(fence({ reposition: ['inject_tick', 'function_shape', 'debug_out'] }));
  const Layout = require('../../src/core/canvas_layout.js');
  const off = ['inj', 'fn', 'dbg'].filter((id) => {
    const n = byId[id];
    return (n.x - Layout.estimateNodeWidth(n, {}) / 2) % 20 !== 0 || n.y % 20 !== 0;
  });
  ok(res && res.ok && off.length === 0, 'every node of it is on the grid (' +
    ['inj', 'fn', 'dbg'].map((id) => byId[id].x + ',' + byId[id].y).join(' ') + ')');
  // The box holds only the inject, listed on the group but with no `g` on the
  // node: read as outside its own box, it was pushed down by 40 000 px.
  ok(['inj', 'fn', 'dbg'].every((id) => Math.abs(byId[id].y - 100) <= 20),
    'and it stays where it was, to the nearest square');
}

(async () => {
  await propertyEditTouchesNothingElse();
  await addingANodeImportsOnlyThatNode();
  await aNewNodeTakesItsTypeDefaults();
  await deletingANodeRemovesOnlyThatNode();
  await rewiringOnlyMovesLinks();
  await joiningAGroupIsStillADiff();
  await renamingKeepsTheColumn();
  await repositionLandsOnTheGrid();
  await aNewNodeWiresToAnExistingOne();
  await aNewNodeIsUndeployed();
  await newNodesGoHome();
  summary();
})();
