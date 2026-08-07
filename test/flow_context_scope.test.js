// Regression test for the flow context the LLM node sends to the provider.
//
// The selection of flows is the user's statement of what may leave the
// machine. Canvas nodes were always scoped to it, but config nodes were
// included wholesale (`if (!n.z) return true`), so picking one small flow
// still shipped every broker, server and endpoint definition in the whole
// instance to the LLM provider. Config nodes must now come in by reference
// only, transitively, and nothing outside the selection may appear.

const path = require('path');

let assertions = 0, failures = 0;
function ok(cond, msg) {
  assertions++;
  if (cond) { console.log('  ok  ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}

// Load the node module and let it register, so the helper is attached.
const nodeModule = require(path.resolve(__dirname, '..', 'node', 'llm-request', 'llm-request.js'));
nodeModule({
  nodes: { createNode() {}, registerType() {} },
  settings: { userDir: require('os').tmpdir(), get: () => undefined, set: () => {} },
  log: { info() {}, warn() {}, error() {} }
});
const flowContextFor = nodeModule._flowContextFor;

// Two tabs. Alpha's mqtt node points at a broker config; Beta's points at a
// different one. `broker-shared` is referenced by Alpha's broker (a config
// node referencing another config node), `broker-orphan` by nobody.
const FLOWS = [
  { id: 'alpha', type: 'tab', label: 'Alpha' },
  { id: 'beta', type: 'tab', label: 'Beta' },
  { id: 'a1', type: 'mqtt in', z: 'alpha', broker: 'broker-a', topic: 'a/#' },
  { id: 'a2', type: 'debug', z: 'alpha' },
  { id: 'b1', type: 'mqtt in', z: 'beta', broker: 'broker-b', topic: 'b/#' },
  { id: 'broker-a', type: 'mqtt-broker', name: 'Alpha broker', host: 'alpha.local', tls: 'tls-shared' },
  { id: 'broker-b', type: 'mqtt-broker', name: 'Beta broker', host: 'beta.local' },
  { id: 'tls-shared', type: 'tls-config', name: 'shared TLS' },
  { id: 'broker-orphan', type: 'mqtt-broker', name: 'Unused broker', host: 'orphan.local' }
];

const idsOf = (ctx) => (ctx || []).map(n => n.id).sort();

console.log('\nScenario 1: selecting Alpha pulls in only what Alpha references');
{
  const ctx = flowContextFor(FLOWS, ['alpha']);
  const ids = idsOf(ctx);
  ok(ids.indexOf('a1') !== -1 && ids.indexOf('a2') !== -1, 'Alpha canvas nodes are present');
  ok(ids.indexOf('alpha') !== -1, 'the Alpha tab definition is present');
  ok(ids.indexOf('broker-a') !== -1, 'the referenced broker config is pulled in');
  ok(ids.indexOf('tls-shared') !== -1, 'a config referenced BY that config is pulled in (transitive)');
  ok(ids.indexOf('broker-b') === -1, "Beta's broker does not leak into Alpha's context");
  ok(ids.indexOf('broker-orphan') === -1, 'an unreferenced config node does not leak');
  ok(ids.indexOf('b1') === -1, 'Beta canvas nodes do not leak');
  ok(ids.indexOf('beta') === -1, 'the Beta tab definition does not leak');
}

console.log('\nScenario 2: selecting Beta pulls in only Beta\'s broker');
{
  const ids = idsOf(flowContextFor(FLOWS, ['beta']));
  ok(ids.indexOf('broker-b') !== -1, 'the referenced broker config is pulled in');
  ok(ids.indexOf('broker-a') === -1, "Alpha's broker does not leak");
  ok(ids.indexOf('tls-shared') === -1, 'a config reachable only through Alpha does not leak');
}

console.log('\nScenario 3: both flows selected -> both brokers, still no orphan');
{
  const ids = idsOf(flowContextFor(FLOWS, ['alpha', 'beta']));
  ok(ids.indexOf('broker-a') !== -1 && ids.indexOf('broker-b') !== -1, 'both referenced brokers are present');
  ok(ids.indexOf('broker-orphan') === -1, 'the unreferenced config still does not leak');
}

console.log('\nScenario 4: array-valued references are followed');
{
  const flows = FLOWS.concat([
    { id: 'g1', type: 'some-node', z: 'alpha', servers: ['broker-orphan'] }
  ]);
  const ids = idsOf(flowContextFor(flows, ['alpha']));
  ok(ids.indexOf('broker-orphan') !== -1, 'a config named inside an array property is pulled in');
}

console.log('\nScenario 5: degenerate inputs');
{
  ok(flowContextFor(FLOWS, []) === null, 'no selection -> null (no flow context in the prompt)');
  ok(flowContextFor(FLOWS, null) === null, 'null selection -> null');
  ok(flowContextFor(null, ['alpha']) === null, 'no flows -> null');
  ok(flowContextFor(FLOWS, ['does-not-exist']) === null, 'unknown tab -> null, not a full dump');
}

console.log('\n' + (failures === 0
  ? assertions + ' passed, 0 failed'
  : (assertions - failures) + ' passed, ' + failures + ' failed'));
process.exit(failures === 0 ? 0 : 1);
