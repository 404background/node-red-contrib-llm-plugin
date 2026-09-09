// The restore-point endpoints, driven through the real route handlers.
//
// A chat checkpoint is reachable without a listing: the sidebar keeps its id
// on the message. The Agent node's checkpoints have no message, so the
// listing IS how they are found — and a restore point nobody can find is not
// a restore point. That makes this endpoint load-bearing rather than
// convenience, so it is worth exercising rather than eyeballing.
//
// Storage is pointed at a temp dir under the repo (test/ is gitignored apart
// from the suites themselves) so nothing touches a real Node-RED userDir.
const fs = require('fs');
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

const { createLLMPluginServer } = require(path.join(ROOT, 'src', 'server.js'));

const WORK = path.join(ROOT, 'test', '.tmp-checkpoints');
// Where llm_core lays out its storage under a userDir.
const CHECKPOINTS = path.join(WORK, 'llm-plugin', 'checkpoints');

// A RED stand-in that records the routes instead of serving them, so a
// handler can be called directly with a fake req/res.
function fakeRED(userDir) {
  const routes = { get: {}, post: {}, delete: {} };
  const settingsStore = {};
  return {
    routes,
    settings: {
      userDir: userDir,
      uiPort: 1880,
      httpAdminRoot: '/',
      get: (k) => settingsStore[k],
      set: (k, v) => { settingsStore[k] = v; return Promise.resolve(); },
    },
    server: null,
    log: { info() {}, warn() {}, error() {} },
    // Every route is registered as `guard(PERM)` middleware plus a handler,
    // and guard() goes straight to RED.auth.needsPermission — deliberately
    // with no "runtime without RED.auth" branch. A pass-through stands in for
    // it here; the permissions themselves are not what this suite is about.
    auth: { needsPermission: () => (req, res, next) => next && next() },
    httpAdmin: {
      get: (p, ...rest) => { routes.get[p] = rest[rest.length - 1]; },
      post: (p, ...rest) => { routes.post[p] = rest[rest.length - 1]; },
      delete: (p, ...rest) => { routes.delete[p] = rest[rest.length - 1]; },
    },
    nodes: { registerType() {} },
  };
}

// Minimal Express res: capture status + JSON body.
function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body: body }); return this; },
    };
    try { handler(req || { query: {}, params: {}, body: {} }, res); }
    catch (e) { resolve({ status: 500, body: { error: String(e && e.message) } }); }
  });
}

// Booted ONCE. createLLMCore is a per-process singleton by design — two
// instances would cache credentials separately and could encrypt with
// different in-memory secrets — so a second boot in the same process keeps
// the first storage paths whatever userDir the new fake RED claims. A
// per-scenario boot silently pointed every later scenario at a directory
// the previous one had deleted.
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RED = fakeRED(WORK);
createLLMPluginServer(RED);

// Scenarios get a clean slate by emptying the directory instead.
function clearCheckpoints() {
  if (!fs.existsSync(CHECKPOINTS)) return;
  fs.readdirSync(CHECKPOINTS).forEach(function(name) {
    fs.rmSync(path.join(CHECKPOINTS, name), { force: true });
  });
}

const saveHandler = RED.routes.post['/llm-plugin/checkpoint/save'];
const listHandler = RED.routes.get['/llm-plugin/checkpoints'];

function flow(n) {
  const out = [{ id: 'tab1', type: 'tab', label: 'Flow 1' }];
  for (let i = 0; i < n; i++) {
    out.push({ id: 'n' + i, type: 'inject', z: 'tab1', x: 0, y: 0, wires: [[]] });
  }
  return out;
}

async function save(chatId, label, meta, nodeCount) {
  return call(saveHandler, {
    query: {}, params: {},
    body: { chatId: chatId, label: label, meta: meta, flow: flow(nodeCount || 2) },
  });
}

async function scenarioListsBothSources() {
  console.log('The listing returns both kinds of restore point');
  clearCheckpoints();
  ok(!!listHandler, 'the /llm-plugin/checkpoints route is registered');

  await save('chat_1', 'pre-import-a', { source: 'pre-import' }, 2);
  await save(null, 'pre-node-apply-b', {
    source: 'node-apply',
    node: { id: 'llm1', name: 'nightly' },
    targetFlowIds: ['tab1'],
  }, 3);

  const out = await call(listHandler, { query: {} });
  ok(out.status === 200, 'it answers 200');
  const items = (out.body && out.body.checkpoints) || [];
  ok(items.length === 2, 'both checkpoints are listed (' + items.length + ')');

  const node = items.find((c) => c.meta && c.meta.source === 'node-apply');
  ok(!!node, 'the node-driven one is there');
  ok(node && node.chatId === null, 'filed under no chat');
  ok(node && node.meta.node && node.meta.node.name === 'nightly',
    'carrying which node made it');
  ok(node && node.nodes === 4, 'and how big the snapshot is (' + (node && node.nodes) + ')');
  // The bodies are the bulk of the files; a listing that carried them would
  // grow with the flow rather than the number of restore points.
  ok(node && node.flow === undefined, 'without dragging the flow body along');
}

async function scenarioFiltersBySource() {
  console.log('\n?source= narrows to one producer');
  clearCheckpoints();
  await save('chat_1', 'a', { source: 'pre-import' }, 1);
  await save(null, 'b', { source: 'node-apply' }, 1);
  await save(null, 'c', { source: 'node-apply' }, 1);

  const nodeOnly = await call(listHandler, { query: { source: 'node-apply' } });
  const items = (nodeOnly.body && nodeOnly.body.checkpoints) || [];
  ok(items.length === 2, 'only the node-driven ones come back (' + items.length + ')');
  ok(items.every((c) => c.meta.source === 'node-apply'), 'and nothing else slipped in');

  const chatOnly = await call(listHandler, { query: { source: 'pre-import' } });
  ok(((chatOnly.body && chatOnly.body.checkpoints) || []).length === 1,
    'the other filter works too');
}

async function scenarioNewestFirst() {
  console.log('\nThe listing is newest-first');
  clearCheckpoints();
  // `created` is an ISO timestamp; saves inside the same millisecond would
  // tie, so space them enough to order deterministically.
  await save(null, 'oldest', { source: 'node-apply' }, 1);
  await new Promise((r) => setTimeout(r, 5));
  await save(null, 'middle', { source: 'node-apply' }, 1);
  await new Promise((r) => setTimeout(r, 5));
  await save(null, 'newest', { source: 'node-apply' }, 1);

  const out = await call(listHandler, { query: {} });
  const labels = ((out.body && out.body.checkpoints) || []).map((c) => c.label);
  ok(labels[0] === 'newest',
    'the most recent edit is first (' + labels.join(' , ') + ')');
  ok(labels[labels.length - 1] === 'oldest', 'and the oldest is last');
}

// The reason pruning is per-source. A node on a timer produces checkpoints
// forever; a single oldest-first pass over the directory would let that
// stream evict the chat checkpoints the sidebar's Restore buttons point at,
// leaving those buttons pointing at nothing.
async function scenarioNodeCheckpointsCannotEvictChatOnes() {
  console.log('\nA flood of node checkpoints does not evict the chat ones');
  clearCheckpoints();
  await save('chat_1', 'the-one-that-matters', { source: 'pre-import' }, 1);

  // Comfortably past the node budget (50).
  for (let i = 0; i < 60; i++) {
    await save(null, 'node-' + i, { source: 'node-apply' }, 1);
  }

  const out = await call(listHandler, { query: {} });
  const items = (out.body && out.body.checkpoints) || [];
  const chat = items.filter((c) => c.meta.source === 'pre-import');
  const node = items.filter((c) => c.meta.source === 'node-apply');

  ok(chat.length === 1, 'the chat checkpoint survived (' + chat.length + ')');
  ok(chat[0] && chat[0].label === 'the-one-that-matters',
    'and it is the same one, not a replacement');
  ok(node.length <= 50,
    'the node stream was capped at its own budget (' + node.length + ')');
  ok(node.length >= 40,
    'but was not over-pruned either (' + node.length + ')');
}

async function run() {
  try {
    await scenarioListsBothSources();
    await scenarioFiltersBySource();
    await scenarioNewestFirst();
    await scenarioNodeCheckpointsCannotEvictChatOnes();
  } finally {
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
