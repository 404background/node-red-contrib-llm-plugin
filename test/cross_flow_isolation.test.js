// The flow-isolation guarantee: the user's flow selection is the boundary.
// An edit may only modify the flows sent to the model. Aliases are unique
// only WITHIN a flow and the rebuild clears its target's canvas first, so a
// misrouted edit is destructive, not additive.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

// `imported` is still the raw import() payload, because scenario 1-7 ask
// "which workspaces did this edit WRITE to" — and under an incremental apply
// that payload is now only the genuinely new nodes, which makes the isolation
// question sharper, not weaker. `after` is the resulting flow, for assertions
// about nodes the edit left in place.
async function runImport(tabs, nodesArr, activeId, message, importOpts) {
  const mock = buildEditorMock({ tabs: tabs, nodes: nodesArr, activeId: activeId });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const Importer = LLMPlugin.Importer;
  const res = await Importer.importFlowFromMessage(message, Object.assign({ mode: 'agent' }, importOpts));
  const imported = [].concat(...mock.captured.imports);
  const after = {};
  tabs.forEach((t) => { mock.snapshot(t.id).forEach((n) => { after[n.id] = n; }); });
  return { res, imported, captured: mock.captured, after, snapshot: mock.snapshot };
}


// Which workspaces did the import actually write to / clear?
function writtenWorkspaces(imported, captured, before) {
  const zs = {};
  imported.forEach((n) => { if (n && n.z) zs[n.z] = true; });
  // A removal counts as writing to the flow that owned the node.
  (captured.removed || []).forEach((id) => {
    const owner = before && before[id] && before[id].z;
    if (owner) zs[owner] = true;
  });
  return Object.keys(zs);
}

const TABS = [
  { id: 'tabA', type: 'tab', label: 'Alpha' },   // NOT in the conversation
  { id: 'tabB', type: 'tab', label: 'Beta' },    // the context flow
];

async function scenarioAliasCollision() {
  console.log('Scenario 1: a colliding alias must not divert the edit to an unrelated flow');
  // Both flows own a node whose auto-alias is `inject`. Alpha sits first in
  // the tab bar, so a first-wins global alias map would pick it.
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tabA', name: '', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: '', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Adding a debug.\n' + fence({
    nodes: { debug_1: { type: 'debug' } },
    connections: [{ from: 'inject', to: 'debug_1' }],
  });
  const before = {}; nodes.forEach((n) => { before[n.id] = n; });
  const { res, imported, captured, after } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured, before);
  ok(res && res.ok, 'import returned ok');
  ok(written.indexOf('tabA') === -1, 'unrelated flow Alpha was never written to or cleared');
  ok(written.indexOf('tabB') !== -1, 'context flow Beta was the one rebuilt');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!!debug && debug.z === 'tabB', 'new debug node landed on Beta');
  // Read from the resulting flow: b1 itself was never re-imported, only rewired.
  ok(!!after.b1 && !!debug && after.b1.wires[0].indexOf(debug.id) !== -1,
    "Beta's inject is the node that got wired");
  ok(!!after.a1 && after.a1.wires[0].length === 0, "Alpha's inject was left unwired");
}

async function scenarioTabSwitchedBeforeImport() {
  console.log('\nScenario 2: switching the canvas tab before Import must not move the target');
  // Context was Beta; the user is looking at Alpha when pressing Import. The
  // schema is all-new nodes, so nothing resolves against any canvas and the
  // old code fell straight through to the active tab.
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'tick', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Here is a new pipeline.\n' + fence({
    nodes: { http_in_1: { type: 'http in' }, func_1: { type: 'function' } },
    connections: [{ from: 'http_in_1', to: 'func_1' }],
  });
  const { res, imported, captured } = await runImport(TABS, nodes, 'tabA', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(res && res.ok, 'import returned ok');
  ok(written.indexOf('tabA') === -1, 'the active-but-unrelated flow Alpha was left alone');
  ok(written.indexOf('tabB') !== -1, 'the edit went to the context flow Beta');
  const fn = imported.find((n) => n.type === 'function');
  ok(!!fn && fn.z === 'tabB', 'new nodes carry the context flow as their z');
}

async function scenarioMultiFlowFanOut() {
  console.log('\nScenario 3: a fan-out must not reach a flow outside the context');
  // The schema names a node that only exists on Alpha. Beta alone is in
  // scope, so Alpha's half must be skipped, not applied.
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', topic: 'original', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'tick', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Tidying up.\n' + fence({
    nodes: {
      debug_1: { type: 'debug' },
      mqtt_in_sensor: { type: 'mqtt in', name: 'sensor', props: { topic: 'changed/by/llm' } },
    },
    connections: [{ from: 'inject_tick', to: 'debug_1' }],
  });
  const { res, imported, captured, after } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(written.indexOf('tabA') === -1, 'Alpha was not rebuilt by the fan-out');
  ok(after['a1'] && after['a1'].topic === 'original', "Alpha's mqtt node kept its original topic");
  ok(after['a1'] && after['a1'].z === 'tabA', "Alpha's mqtt node stayed on Alpha");
  // The out-of-scope alias no longer resolves, so it degrades to "add as a
  // new node" on the flow in scope — visible and undoable via the
  // checkpoint, unlike a silent overwrite on another tab.
  ok(imported.every((n) => n.z !== 'tabA'), 'nothing was written with Alpha as its workspace');
  ok(written.indexOf('tabB') !== -1, 'Beta still received its part of the edit');
  ok(res && res.ok, 'import returned ok');
}

async function scenarioExplicitOutOfScopeFlowTag() {
  console.log('\nScenario 4: an explicit `flow` tag naming an out-of-scope tab is refused');
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'tick', x: 100, y: 100, wires: [[]] },
  ];
  // The model insists the node belongs on Alpha, which this chat never saw.
  const msg = 'Putting it on Alpha.\n' + fence({
    nodes: { debug_1: { type: 'debug', flow: 'Alpha' } },
  });
  const { imported, captured } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(written.indexOf('tabA') === -1, 'Alpha was not touched despite the explicit flow tag');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!debug || debug.z === 'tabB', 'the node fell back to the context flow instead');
}

async function scenarioUnscopedStillUsesActiveTab() {
  console.log('\nScenario 5: with no flow context selected, the active tab still works');
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Adding a debug.\n' + fence({ nodes: { debug_1: { type: 'debug' } } });
  // allowedWorkspaceIds omitted entirely — legacy/unrestricted behaviour.
  const { res, imported } = await runImport(TABS, nodes, 'tabA', msg, {});
  ok(res && res.ok, 'import returned ok');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!!debug && debug.z === 'tabA', 'unrestricted import still targets the active workspace');
}

async function scenarioMultiFlowContextStillFansOut() {
  console.log('\nScenario 6: both flows in scope -> the fan-out is still allowed');
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', topic: 'original', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'tick', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Updating both flows.\n' + fence({
    nodes: {
      debug_1: { type: 'debug', flow: 'Beta' },
      mqtt_in_sensor: { type: 'mqtt in', name: 'sensor', flow: 'Alpha', props: { topic: 'changed/by/llm' } },
    },
    connections: [{ from: 'inject_tick', to: 'debug_1' }],
  });
  const { res, after } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  ok(res && res.ok, 'import returned ok');
  // Alpha's half of this edit is a property change, which an incremental
  // apply makes in place — it never reaches import(). The question is what
  // the flows now HOLD, so both halves are read from the resulting state.
  const alphaChanged = !!after.a1 && after.a1.topic === 'changed/by/llm';
  const betaGrew = Object.values(after).some((n) => n.z === 'tabB' && n.type === 'debug');
  ok(alphaChanged && betaGrew, 'both in-scope flows were updated');
  ok(alphaChanged, 'the in-scope Alpha edit was applied');
}

async function scenarioUntaggedNodesFollowTheContextFlow() {
  console.log('\nScenario 7: untagged nodes follow the context flow, not the active tab');
  // Mixed schema: one node tagged `Beta`, one untagged. The active tab is
  // the out-of-scope Alpha, so grouping untagged nodes under the ACTIVE
  // label would put them in a group the dispatch may not write to — and
  // they would vanish as "unknown flow" instead of being applied.
  const nodes = [
    { id: 'a1', type: 'mqtt in', z: 'tabA', name: 'sensor', x: 100, y: 100, wires: [[]] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'tick', x: 100, y: 100, wires: [[]] },
  ];
  const msg = 'Extending the pipeline.\n' + fence({
    nodes: {
      debug_1: { type: 'debug', flow: 'Beta' },
      func_1: { type: 'function' },
    },
    connections: [{ from: 'inject_tick', to: 'func_1' }, { from: 'func_1', to: 'debug_1' }],
  });
  const { res, imported, captured } = await runImport(TABS, nodes, 'tabA', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(res && res.ok, 'import returned ok');
  ok(written.indexOf('tabA') === -1, 'the out-of-scope active tab was not written to');
  const fn = imported.find((n) => n.type === 'function');
  const dbg = imported.find((n) => n.type === 'debug');
  ok(!!fn && fn.z === 'tabB', 'the untagged node was applied to the context flow');
  ok(!!dbg && dbg.z === 'tabB', 'the explicitly tagged node landed on the context flow too');
}

// ------------------------------------------------------------------ //
//  An alias names one node across every context flow                 //
// ------------------------------------------------------------------ //
//
// The model is shown one numbering over all the context flows, so each alias
// names exactly one node. Each tab on its own numbers differently (Beta's
// debug is `debug_2` in the context but `debug` on Beta alone), and a reply
// is read against the numbering the model saw.

function twoDebugs() {
  return [
    { id: 'a1', type: 'inject', z: 'tabA', name: 'alpha tick', x: 100, y: 100, wires: [['a2']] },
    { id: 'a2', type: 'debug', z: 'tabA', name: '', x: 300, y: 100, wires: [] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'beta tick', x: 100, y: 100, wires: [['b2']] },
    { id: 'b2', type: 'debug', z: 'tabB', name: '', x: 300, y: 100, wires: [] },
  ];
}

async function scenarioAnAliasNamesOneNodeAcrossTheContext() {
  console.log('\nScenario 9: an alias is read the way the model was shown it, across the context');
  const both = { allowedWorkspaceIds: ['tabA', 'tabB'] };

  let r = await runImport(TABS, twoDebugs(), 'tabA', fence({
    nodes: { debug_2: { type: 'debug', props: { complete: 'true' } } },
  }), both);
  ok(r.res && r.res.ok && r.after.b2.complete === 'true' && r.after.a2.complete === undefined,
    'an untagged edit to `debug_2` changes Beta\'s debug, not Alpha\'s');

  r = await runImport(TABS, twoDebugs(), 'tabA', fence({
    nodes: { debug_2: { type: 'debug', flow: 'Alpha', props: { complete: 'true' } } },
  }), both);
  ok(r.res && r.res.ok && r.after.b2.complete === 'true' && r.after.b2.z === 'tabB' && r.after.a2.complete === undefined,
    'a `flow` naming another tab does not move the edit: the node is edited where it is');

  r = await runImport(TABS, twoDebugs(), 'tabA', fence({
    nodes: { function_new: { type: 'function', props: { func: 'return msg;' } } },
    connections: [{ from: 'inject_beta_tick', to: 'function_new' }],
  }), both);
  const fn = r.imported.find((n) => n.type === 'function');
  ok(r.res && r.res.ok && fn && fn.z === 'tabB' && r.after.b1.wires[0].indexOf(fn.id) !== -1,
    'a new node wired to Beta\'s inject goes to Beta, although Alpha is the active tab');
}

async function scenarioNodeReferencesInPropertiesRoundTrip() {
  console.log('\nScenario 10: node ids inside properties are aliases to the model, and ids again after');
  const nodes = twoDebugs().concat([
    { id: 'c1', type: 'catch', z: 'tabB', name: 'errors', scope: ['b1', 'b2'], uncaught: false, x: 100, y: 200, wires: [[]] },
    { id: 'lc', type: 'link call', z: 'tabB', name: 'call', links: ['li'], linkType: 'static', x: 100, y: 300, wires: [[]] },
    { id: 'li', type: 'link in', z: 'tabB', name: 'target', links: [], x: 300, y: 300, wires: [[]] },
  ]);
  const mock = buildEditorMock({ tabs: TABS, nodes: clone(nodes), activeId: 'tabB' });
  const P = loadPluginSandbox(mock.RED);
  const ctx = P.FlowConverterCore.toIntermediate(P.UI.getFlowsByIds(['tabA', 'tabB'], { includeCanvasExtras: true }));
  const catchNode = Object.values(ctx.nodes).find((n) => n.type === 'catch');
  const callNode = Object.values(ctx.nodes).find((n) => n.type === 'link call');
  ok(catchNode && JSON.stringify(catchNode.props.scope) === JSON.stringify(['inject_beta_tick', 'debug_2']),
    'a catch node\'s scope reads as aliases (' + JSON.stringify(catchNode && catchNode.props.scope) + ')');
  ok(callNode && !('links' in (callNode.props || {})),
    'a property naming routing, which has no alias, is left out rather than shown as an id');

  const r = await runImport(TABS, clone(nodes), 'tabB', fence({
    nodes: {
      catch_errors: { type: 'catch', name: 'errors', props: { scope: ['inject_beta_tick', 'debug_2', 'function_guard'] } },
      function_guard: { type: 'function', name: 'guard', props: { func: 'return msg;' } },
    },
    connections: [{ from: 'inject_beta_tick', to: 'function_guard' }],
  }), { allowedWorkspaceIds: ['tabA', 'tabB'] });
  const guard = Object.values(r.after).find((n) => n.name === 'guard');
  ok(r.res && r.res.ok && guard && JSON.stringify(r.after.c1.scope) === JSON.stringify(['b1', 'b2', guard.id]),
    'the scope comes back as ids, a node this reply adds included (' + JSON.stringify(r.after.c1.scope) + ')');
  ok(JSON.stringify(r.after.lc.links) === JSON.stringify(['li']), 'and the link call kept its target');
}

async function run() {
  await scenarioAliasCollision();
  await scenarioTabSwitchedBeforeImport();
  await scenarioMultiFlowFanOut();
  await scenarioExplicitOutOfScopeFlowTag();
  await scenarioUnscopedStillUsesActiveTab();
  await scenarioMultiFlowContextStillFansOut();
  await scenarioUntaggedNodesFollowTheContextFlow();
  await scenarioAnAliasNamesOneNodeAcrossTheContext();
  await scenarioNodeReferencesInPropertiesRoundTrip();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
