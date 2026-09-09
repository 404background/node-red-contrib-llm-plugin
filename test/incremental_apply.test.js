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
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

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

async function apply(message) {
  const f = flow();
  const mock = buildEditorMock({
    tabs: TABS, nodes: f.nodes, junctions: f.junctions, groups: f.groups, activeId: 't1',
  });
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

async function deletingANodeRemovesOnlyThatNode() {
  console.log('\nDeleting a node removes that node and nothing else');
  const { res, byId, captured, importedIds } = await apply(
    'Dropping the logger.\n' + fence({ remove: ['debug_out'] })
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
        { remove: { from: 'inject_tick', to: 'function_shape' } },
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

(async () => {
  await propertyEditTouchesNothingElse();
  await addingANodeImportsOnlyThatNode();
  await deletingANodeRemovesOnlyThatNode();
  await rewiringOnlyMovesLinks();
  summary();
})();
