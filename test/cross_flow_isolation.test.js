// The flow-isolation guarantee: the user's flow selection is the boundary,
// in both directions.
//
// INBOUND (1-7): an edit may only modify the flows sent to the model.
// Aliases are unique only WITHIN a flow and the rebuild clears its target's
// canvas first, so a misrouted edit is destructive, not additive.
//
// OUTBOUND (8): the same selection bounds what LEAVES the machine. Attaching
// every config node in the instance meant picking one small flow still
// shipped every broker and endpoint definition to the provider.
const path = require('path');

const { ROOT, ok, summary, clone, fence, loadPluginSandbox } = require('./helpers.js');

// Two-tab editor. `filterNodes` mirrors the real registry (regular nodes
// only, filtered by z); every workspace is visible to eachWorkspace, which
// is exactly what makes an unscoped scan dangerous.
function buildRED(tabs, nodesArr, activeId) {
  const regularById = {};
  nodesArr.forEach((n) => { regularById[n.id] = n; });
  const captured = { imports: [], removedFrom: [] };

  const RED = {
    notify: function () {},
    nodes: {
      filterNodes: (f) => Object.values(regularById).filter((n) => n.z === f.z),
      junctions: () => [],
      groups: () => [],
      workspace: (id) => tabs.find((t) => t.id === id) || null,
      eachWorkspace: (cb) => tabs.forEach(cb),
      eachNode: (cb) => Object.values(regularById).forEach(cb),
      eachConfig: () => {},
      node: (id) => regularById[id] || null,
      getType: () => undefined,
      createExportableNodeSet: (set) => set.filter(Boolean).map(clone),
      import: function (nodes) {
        captured.imports.push(clone(nodes));
        clone(nodes).forEach((n) => { if (n && n.id) regularById[n.id] = n; });
        return { nodes: nodes };
      },
      remove: function (id) {
        if (regularById[id]) captured.removedFrom.push(regularById[id].z);
        delete regularById[id];
      },
      removeJunction: () => {},
      removeGroup: () => {},
      dirty: () => {},
    },
    view: { redraw: () => {} },
    actions: { invoke: () => {} },
    workspaces: { active: () => activeId, refresh: () => {}, show: () => {} },
  };
  return { RED, captured };
}

// Fresh sandbox + module load per scenario (modules hold singletons).
async function runImport(tabs, nodesArr, activeId, message, importOpts) {
  const { RED, captured } = buildRED(tabs, nodesArr, activeId);
  const LLMPlugin = loadPluginSandbox(RED);
  const Importer = LLMPlugin.Importer;
  const res = await Importer.importFlowFromMessage(message, Object.assign({ mode: 'agent' }, importOpts));
  const imported = [].concat(...captured.imports);
  // Post-run editor state, so a scenario can assert what a specific node
  // looks like after the import rather than inferring it from the payload.
  const after = {};
  ['tabA', 'tabB'].forEach((z) => {
    RED.nodes.filterNodes({ z: z }).forEach((n) => { after[n.id] = n; });
  });
  return { res, imported, captured, after };
}


// Which workspaces did the import actually write to / clear?
function writtenWorkspaces(imported, captured) {
  const zs = {};
  imported.forEach((n) => { if (n && n.z) zs[n.z] = true; });
  (captured.removedFrom || []).forEach((z) => { if (z) zs[z] = true; });
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
  const { res, imported, captured } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(res && res.ok, 'import returned ok');
  ok(written.indexOf('tabA') === -1, 'unrelated flow Alpha was never written to or cleared');
  ok(written.indexOf('tabB') !== -1, 'context flow Beta was the one rebuilt');
  const debug = imported.find((n) => n.type === 'debug');
  ok(!!debug && debug.z === 'tabB', 'new debug node landed on Beta');
  const injB = imported.find((n) => n.id === 'b1');
  ok(!!injB && !!debug && injB.wires[0].indexOf(debug.id) !== -1, "Beta's inject is the node that got wired");
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
  const { res, imported, captured } = await runImport(TABS, nodes, 'tabB', msg, {
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const written = writtenWorkspaces(imported, captured);
  ok(res && res.ok, 'import returned ok');
  ok(written.indexOf('tabA') !== -1 && written.indexOf('tabB') !== -1,
     'both in-scope flows were updated');
  const mqtt = imported.find((n) => n.type === 'mqtt in');
  ok(!!mqtt && mqtt.topic === 'changed/by/llm', 'the in-scope Alpha edit was applied');
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
//  Outbound: what the runtime node sends to the provider              //
// ------------------------------------------------------------------ //

function scenarioProviderContextIsScoped() {
  console.log('\nScenario 8: the flow context sent to the provider is scoped too');

  // Load the node module and let it register, so the helper is attached.
  const nodeModule = require(path.join(ROOT, 'node', 'llm-request', 'llm-request.js'));
  nodeModule({
    nodes: { createNode() {}, registerType() {} },
    settings: { userDir: require('os').tmpdir(), get: () => undefined, set: () => {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const flowContextFor = nodeModule._flowContextFor;

  // Alpha's mqtt node points at one broker, Beta's at another. `tls-shared`
  // is referenced by Alpha's broker (a config node referencing another),
  // `broker-orphan` by nobody.
  const FLOWS = [
    { id: 'alpha', type: 'tab', label: 'Alpha' },
    { id: 'beta', type: 'tab', label: 'Beta' },
    { id: 'a1', type: 'mqtt in', z: 'alpha', broker: 'broker-a', topic: 'a/#' },
    { id: 'a2', type: 'debug', z: 'alpha' },
    { id: 'b1', type: 'mqtt in', z: 'beta', broker: 'broker-b', topic: 'b/#' },
    { id: 'broker-a', type: 'mqtt-broker', name: 'Alpha broker', host: 'alpha.local', tls: 'tls-shared' },
    { id: 'broker-b', type: 'mqtt-broker', name: 'Beta broker', host: 'beta.local' },
    { id: 'tls-shared', type: 'tls-config', name: 'shared TLS' },
    { id: 'broker-orphan', type: 'mqtt-broker', name: 'Unused broker', host: 'orphan.local' },
  ];
  const idsOf = (ctx) => (ctx || []).map((n) => n.id);

  const alpha = idsOf(flowContextFor(FLOWS, ['alpha']));
  ok(alpha.includes('a1') && alpha.includes('a2') && alpha.includes('alpha'),
    "Alpha's own nodes and tab are present");
  ok(alpha.includes('broker-a'), 'a referenced config node is pulled in');
  ok(alpha.includes('tls-shared'), 'a config referenced BY that config is pulled in (transitive)');
  ok(!alpha.includes('broker-b'), "Beta's broker does not leak into Alpha's context");
  ok(!alpha.includes('broker-orphan'), 'an unreferenced config node does not leak');
  ok(!alpha.includes('b1') && !alpha.includes('beta'), 'Beta canvas nodes and tab do not leak');

  const beta = idsOf(flowContextFor(FLOWS, ['beta']));
  ok(beta.includes('broker-b') && !beta.includes('broker-a'),
    'selecting Beta pulls in only Beta\'s broker');
  ok(!beta.includes('tls-shared'), 'a config reachable only through Alpha does not leak');

  const both = idsOf(flowContextFor(FLOWS, ['alpha', 'beta']));
  ok(both.includes('broker-a') && both.includes('broker-b'),
    'selecting both flows pulls in both referenced brokers');
  ok(!both.includes('broker-orphan'), 'the unreferenced config still does not leak');

  const withArray = idsOf(flowContextFor(
    FLOWS.concat([{ id: 'g1', type: 'some-node', z: 'alpha', servers: ['broker-orphan'] }]),
    ['alpha']));
  ok(withArray.includes('broker-orphan'), 'a config named inside an array property is pulled in');

  ok(flowContextFor(FLOWS, []) === null, 'no selection -> no flow context at all');
  ok(flowContextFor(FLOWS, null) === null, 'null selection -> no flow context');
  ok(flowContextFor(null, ['alpha']) === null, 'no flows -> no flow context');
  ok(flowContextFor(FLOWS, ['nope']) === null, 'an unknown tab yields nothing, not a full dump');
}

async function run() {
  await scenarioAliasCollision();
  await scenarioTabSwitchedBeforeImport();
  await scenarioMultiFlowFanOut();
  await scenarioExplicitOutOfScopeFlowTag();
  await scenarioUnscopedStillUsesActiveTab();
  await scenarioMultiFlowContextStillFansOut();
  await scenarioUntaggedNodesFollowTheContextFlow();
  scenarioProviderContextIsScoped();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
