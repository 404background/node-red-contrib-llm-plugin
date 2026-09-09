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
// (D) A failed import restores the config nodes it had already rewritten.
//     They have no `z`, so the workspace rollback cannot reach them.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

// The shared editor mock models links as their own registry, which is what
// lets these scenarios read the flow as it NOW STANDS (`idsIn` / `snapshot`)
// rather than the payload handed to import(). Under an incremental apply most
// of an edit never goes through import() at all.
function loadSandbox(opts) {
  const mock = buildEditorMock(opts);
  const LLMPlugin = loadPluginSandbox(mock.RED);
  return { RED: mock.RED, captured: mock.captured, snapshot: mock.snapshot, idsIn: mock.idsIn, LLMPlugin };
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

  const { LLMPlugin, idsIn } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabA' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const survivingIds = idsIn('tabA').concat(idsIn('tabB'));

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

  const { LLMPlugin, idsIn } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabB' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const survivingIds = idsIn('tabA').concat(idsIn('tabB'));

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

  const { LLMPlugin, idsIn } = loadSandbox({ tabs: TABS, nodes: clone(nodes), activeId: 'tabA' });
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tabA', 'tabB'],
  });
  const survivingIds = idsIn('tabA').concat(idsIn('tabB'));

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

  const { LLMPlugin, snapshot } = loadSandbox({
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

  // Compared as the FLOW, before and after — not as the payload of whichever
  // call happened to run. The guarantee is "a failed import leaves the canvas
  // as it was", and that has to hold whether the apply was incremental or a
  // wholesale rebuild.
  const before = snapshot('tab1');
  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent',
    allowedWorkspaceIds: ['tab1'],
  });
  const after = snapshot('tab1');
  const byId = (list) => { const m = {}; list.forEach((n) => { m[n.id] = n; }); return m; };
  const b = byId(before), a = byId(after);

  ok(res && res.ok === false, 'the import reports failure rather than partial success');
  ok(!!a.j1, 'the junction is still there');
  ok(!!a.g1, 'the group is still there');
  ok(!!a.n1 && !!a.n2, 'the regular nodes are still there');
  ok(Object.keys(a).length === Object.keys(b).length,
    'nothing was added either (' + Object.keys(a).sort().join(',') + ')');
  ok(JSON.stringify(a.n1) === JSON.stringify(b.n1) && JSON.stringify(a.n2) === JSON.stringify(b.n2),
    'the surviving nodes are byte-identical, wires included');
  ok(!!a.g1 && Array.isArray(a.g1.nodes) && a.g1.nodes.every((m) => typeof m === 'string'),
    'the group keeps its export shape (member ids, not node objects)');
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

// ------------------------------------------------------------------ //
//  (D) A failed import restores the CONFIG nodes it rewrote           //
// ------------------------------------------------------------------ //
//
// Config nodes have no `z`, so they are not in the workspace export the
// rollback re-imports — restoring the canvas leaves them exactly as the
// half-finished apply wrote them. That is the worst kind of residue: the
// flow looks untouched while the broker it talks to has been repointed.
//
// Harness note: the type is `-config`-suffixed on purpose. Without the
// editor's registry the converter falls back to that naming rule to decide
// what is a config node, so a realistically named type (`mqtt-broker`)
// would be classified as a canvas node here and miss this path entirely.
async function scenarioRollbackRestoresConfigNodes() {
  console.log('\nScenario D: a failed import rolls back config node edits too');
  const nodes = [
    { id: 'm1', type: 'sender', z: 'tab1', name: 'feed', broker: 'brk',
      x: 100, y: 100, wires: [['d1']] },
    { id: 'd1', type: 'debug', z: 'tab1', name: 'log', x: 400, y: 100, wires: [] },
  ];
  const configs = [{ id: 'brk', type: 'creds-config', name: 'prod broker',
                     broker: 'prod.example.com', port: '1883' }];

  // Repoints the config node AND adds a node, so the apply reaches the
  // import — which is the step made to fail.
  const msg = 'Point the broker at staging and add a logger.\n' + fence({
    nodes: {
      creds_config_prod_broker: { type: 'creds-config', props: { broker: 'staging.example.com' } },
      debug_extra: { type: 'debug', name: 'extra' },
    },
    connections: [{ from: 'sender_feed', to: 'debug_extra' }],
  });

  const { LLMPlugin, RED } = loadSandbox({
    tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }],
    nodes: clone(nodes), configs: clone(configs), activeId: 'tab1',
    failFirstImport: true,
  });

  const res = await LLMPlugin.Importer.importFlowFromMessage(msg, {
    mode: 'agent', allowedWorkspaceIds: ['tab1'],
  });
  const brk = RED.nodes.node('brk');

  ok(res && res.ok === false, 'the import reports failure');
  ok(!!brk, 'the config node still exists');
  ok(brk.broker === 'prod.example.com',
    'the repointed property is back to its original value (' + brk.broker + ')');
  ok(brk.port === '1883' && brk.name === 'prod broker',
    'the properties the edit never mentioned are untouched');
  // `changed` is what a deploy reads. Leaving it set on a node whose values
  // were restored would restart the config node for an edit that never landed.
  ok(!brk.changed, 'the config node is not left marked as changed');
}

async function run() {
  await scenarioDeleteReachesItsOwnFlow();
  await scenarioNullAliasDeleteIsRoutedToo();
  await scenarioAmbiguousDeleteIsRefused();
  await scenarioRollbackRestoresCanvasExtras();
  await scenarioRollbackRestoresConfigNodes();
  scenarioSidebarConfigContextIsComplete();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
