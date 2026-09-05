// Three guarantees around applying an LLM edit.
//
// (A) A deletion reaches the flow that owns it, and only that flow. The old
//     slice kept only aliases the same sub-schema also DECLARED — never true
//     of a node being deleted — so a fan-out dropped every deletion.
// (B) A failed import leaves the canvas as it was, junctions and groups
//     included. The rollback snapshot held regular nodes only, so the error
//     path deleted exactly what the import was not allowed to touch.
// (C) Config nodes reach the flow context by reference, followed transitively
//     and through array properties.
const { ok, summary, clone, fence, loadPluginSandbox } = require('./helpers.js');

// Mocked editor registries: filterNodes returns ONLY regular canvas nodes;
// junctions, groups and config nodes each live in their own lookup, exactly
// as in the real editor.
function buildRED(opts) {
  const tabs = opts.tabs || [];
  const regularById = {};
  (opts.nodes || []).forEach((n) => { regularById[n.id] = n; });
  const configById = {};
  (opts.configs || []).forEach((c) => { configById[c.id] = c; });
  const junctions = opts.junctions || [];
  const groups = opts.groups || [];
  const captured = { imports: [], removed: [], removedJunctions: [], removedGroups: [] };
  let importCalls = 0;

  const RED = {
    notify: function () {},
    nodes: {
      filterNodes: (f) => Object.values(regularById).filter((n) => n.z === f.z),
      junctions: (z) => junctions.filter((j) => j.z === z),
      groups: (z) => groups.filter((g) => g.z === z),
      workspace: (id) => tabs.find((t) => t.id === id) || null,
      eachWorkspace: (cb) => tabs.forEach(cb),
      eachNode: (cb) => Object.values(regularById).forEach(cb),
      eachConfig: (cb) => Object.values(configById).forEach(cb),
      node: (id) => regularById[id] || configById[id] || null,
      getType: () => undefined,
      createExportableNodeSet: (set) => set.filter(Boolean).map(clone),
      import: function (nodes) {
        importCalls++;
        // `failFirstImport` reproduces a mid-import failure (a malformed
        // node, a registry that rejects the set) so the rollback runs.
        if (opts.failFirstImport && importCalls === 1) {
          throw new Error('simulated import failure');
        }
        captured.imports.push(clone(nodes));
        clone(nodes).forEach((n) => { if (n && n.id) regularById[n.id] = n; });
        return { nodes: nodes };
      },
      remove: function (id) { captured.removed.push(id); delete regularById[id]; },
      removeJunction: function (j) { captured.removedJunctions.push(j.id); },
      removeGroup: function (g) { captured.removedGroups.push(g.id); },
      dirty: () => {},
    },
    view: { redraw: () => {} },
    actions: { invoke: () => {} },
    workspaces: { active: () => opts.activeId, refresh: () => {}, show: () => {} },
  };
  return { RED, captured };
}

// Fresh sandbox + module load per scenario (modules hold singletons).
function loadSandbox(opts) {
  const { RED, captured } = buildRED(opts);
  const LLMPlugin = loadPluginSandbox(RED);
  return { RED, captured, LLMPlugin };
}


// ------------------------------------------------------------------ //
//  (A) Deletions are routed to the flow that owns them                //
// ------------------------------------------------------------------ //

const TABS = [
  { id: 'tabA', type: 'tab', label: 'Alpha' },
  { id: 'tabB', type: 'tab', label: 'Beta' },
];

// Both flows are in scope, so the fan-out itself is allowed; the question is
// only where the delete lands.
async function scenarioDeleteReachesItsOwnFlow() {
  console.log('Scenario A1: a `remove` in a multi-flow edit deletes from the right flow');
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tabA', name: 'alpha tick', x: 100, y: 100, wires: [[]] },
    { id: 'a2', type: 'debug', z: 'tabA', name: 'alpha log', x: 300, y: 100, wires: [] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'beta tick', x: 100, y: 100, wires: [[]] },
    { id: 'b2', type: 'debug', z: 'tabB', name: 'beta log', x: 300, y: 100, wires: [] },
  ];
  // One new node per flow makes the dispatch fan out; the deletion names a
  // node that exists only on Beta.
  const msg = 'Cleaning up.\n' + fence({
    nodes: {
      function_a: { type: 'function', flow: 'Alpha', props: { func: 'return msg;' } },
      function_b: { type: 'function', flow: 'Beta', props: { func: 'return msg;' } },
    },
    remove: ['debug_beta_log'],
  });

  const { LLMPlugin, captured } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabA' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const imported = [].concat(...captured.imports);
  const survivingIds = imported.map((n) => n.id);

  ok(res && res.ok, 'import returned ok');
  ok(res && res.multiFlow, 'the edit fanned out across both flows');
  ok(survivingIds.indexOf('b2') === -1, "Beta's debug node was deleted as asked");
  ok(survivingIds.indexOf('a2') !== -1, "Alpha's debug node was left alone");
  ok(survivingIds.indexOf('a1') !== -1 && survivingIds.indexOf('b1') !== -1,
    'both injects survived');
}

async function scenarioNullAliasDeleteIsRoutedToo() {
  console.log('\nScenario A2: the `nodes: {alias: null}` delete form is routed the same way');
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tabA', name: 'alpha tick', x: 100, y: 100, wires: [[]] },
    { id: 'a2', type: 'debug', z: 'tabA', name: 'alpha log', x: 300, y: 100, wires: [] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'beta tick', x: 100, y: 100, wires: [[]] },
    { id: 'b2', type: 'debug', z: 'tabB', name: 'beta log', x: 300, y: 100, wires: [] },
  ];
  const msg = 'Dropping the Alpha logger.\n' + fence({
    nodes: {
      function_a: { type: 'function', flow: 'Alpha', props: { func: 'return msg;' } },
      function_b: { type: 'function', flow: 'Beta', props: { func: 'return msg;' } },
      debug_alpha_log: null,
    },
  });

  const { LLMPlugin, captured } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabB' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const survivingIds = [].concat(...captured.imports).map((n) => n.id);

  ok(res && res.ok, 'import returned ok');
  ok(survivingIds.indexOf('a2') === -1, "Alpha's debug node was deleted as asked");
  ok(survivingIds.indexOf('b2') !== -1, "Beta's debug node was NOT deleted by the same directive");
}

async function scenarioAmbiguousDeleteIsRefused() {
  console.log('\nScenario A3: a deletion no single flow owns is refused, not broadcast');
  // Both flows hold an unnamed debug node, so both resolve the alias `debug`.
  // There is no evidence of which one the model meant — and a deletion is not
  // recoverable from the import — so neither may be removed.
  const nodes = [
    { id: 'a1', type: 'inject', z: 'tabA', name: 'alpha tick', x: 100, y: 100, wires: [[]] },
    { id: 'a2', type: 'debug', z: 'tabA', name: '', x: 300, y: 100, wires: [] },
    { id: 'b1', type: 'inject', z: 'tabB', name: 'beta tick', x: 100, y: 100, wires: [[]] },
    { id: 'b2', type: 'debug', z: 'tabB', name: '', x: 300, y: 100, wires: [] },
  ];
  const msg = 'Removing the logger.\n' + fence({
    nodes: {
      function_a: { type: 'function', flow: 'Alpha', props: { func: 'return msg;' } },
      function_b: { type: 'function', flow: 'Beta', props: { func: 'return msg;' } },
    },
    remove: ['debug'],
  });

  const { LLMPlugin, captured } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabA' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const survivingIds = [].concat(...captured.imports).map((n) => n.id);

  ok(res && res.ok, 'import returned ok');
  ok(survivingIds.indexOf('a2') !== -1 && survivingIds.indexOf('b2') !== -1,
    'the ambiguous deletion removed nothing from either flow');
}

// ------------------------------------------------------------------ //
//  (B) A failed import restores the canvas it cleared                 //
// ------------------------------------------------------------------ //

async function scenarioRollbackRestoresCanvasExtras() {
  console.log('\nScenario B: a failed import rolls back junctions and groups too');
  const nodes = [
    { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']] },
    { id: 'n2', type: 'debug', z: 'tab1', name: 'log', x: 400, y: 100, wires: [] },
  ];
  const junctions = [{ id: 'j1', type: 'junction', z: 'tab1', x: 250, y: 100, wires: [[]] }];
  const groups = [{ id: 'g1', type: 'group', z: 'tab1', name: 'Box', style: {}, nodes: ['n1', 'n2'] }];

  const { LLMPlugin, captured } = loadSandbox({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: clone(nodes),
    junctions: clone(junctions),
    groups: clone(groups),
    activeId: 'tab1',
    failFirstImport: true,
  });
  const msg = 'Adding a function.\n' + fence({
    nodes: { function_x: { type: 'function', props: { func: 'return msg;' } } },
    connections: [{ from: 'inject_tick', to: 'function_x' }],
  });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tab1'],
  });

  ok(res && res.ok === false, 'the import reports failure rather than partial success');
  ok(captured.removedJunctions.indexOf('j1') !== -1 && captured.removedGroups.indexOf('g1') !== -1,
    'the junction and group really were cleared (so the rollback has work to do)');
  const rollback = captured.imports[0] || [];
  const rolledBackIds = rollback.map((n) => n.id);
  ok(rolledBackIds.indexOf('j1') !== -1, 'the junction is restored by the rollback');
  ok(rolledBackIds.indexOf('g1') !== -1, 'the group is restored by the rollback');
  ok(rolledBackIds.indexOf('n1') !== -1 && rolledBackIds.indexOf('n2') !== -1,
    'the regular nodes are restored too');
  const restoredGroup = rollback.find((n) => n.id === 'g1');
  ok(!!restoredGroup && Array.isArray(restoredGroup.nodes) &&
     restoredGroup.nodes.every((m) => typeof m === 'string'),
    'the restored group keeps its export shape (member ids, not node objects)');
}

// ------------------------------------------------------------------ //
//  (C) Flow context pulls config nodes in by reference, completely    //
// ------------------------------------------------------------------ //

function scenarioSidebarConfigContextIsComplete() {
  console.log('\nScenario C: the sidebar\'s flow export follows config references fully');
  const nodes = [
    { id: 'n1', type: 'mqtt in', z: 'tab1', name: 'sensor', broker: 'broker-a', x: 100, y: 100, wires: [[]] },
    { id: 'n2', type: 'some-node', z: 'tab1', name: 'fan', servers: ['pool-a'], x: 300, y: 100, wires: [[]] },
  ];
  const configs = [
    // broker-a → tls-shared → ca-shared: two hops, so a one-level scan
    // stops after the first.
    { id: 'broker-a', type: 'mqtt-broker', name: 'Broker A', tls: 'tls-shared' },
    { id: 'tls-shared', type: 'tls-config', name: 'TLS', ca: 'ca-shared' },
    { id: 'ca-shared', type: 'ca-config', name: 'CA' },
    // Reachable only through an ARRAY property.
    { id: 'pool-a', type: 'server-config', name: 'Pool A' },
    { id: 'orphan', type: 'mqtt-broker', name: 'Unused' },
  ];

  const { LLMPlugin } = loadSandbox({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: nodes,
    configs: configs,
    activeId: 'tab1',
  });
  const ids = (LLMPlugin.UI.getFlowsByIds(['tab1']) || []).map((n) => n.id);

  ok(ids.indexOf('broker-a') !== -1, 'a directly referenced config node is included');
  ok(ids.indexOf('tls-shared') !== -1, 'a config referenced BY that config is included (transitive)');
  ok(ids.indexOf('ca-shared') !== -1, 'the second transitive hop is included too');
  ok(ids.indexOf('pool-a') !== -1, 'a config named inside an array property is included');
  ok(ids.indexOf('orphan') === -1, 'an unreferenced config node still does not leak');
}

async function run() {
  await scenarioDeleteReachesItsOwnFlow();
  await scenarioNullAliasDeleteIsRoutedToo();
  await scenarioAmbiguousDeleteIsRefused();
  await scenarioRollbackRestoresCanvasExtras();
  scenarioSidebarConfigContextIsComplete();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
