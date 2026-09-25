// The admin routes' own guarantees, driven through the real handlers: what the
// unauthenticated routes hand out, what a write is refused for, and that an
// Agent-node reply is claimed by exactly one editor.
const fs = require('fs');
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

const { createLLMPluginServer } = require(path.join(ROOT, 'src', 'server.js'));
const agentDispatch = require(path.join(ROOT, 'src', 'agent_dispatch.js'));

const WORK = path.join(ROOT, 'test', '.tmp-server-api');
const CHATS = path.join(WORK, 'llm-plugin', 'chats');

function fakeRED(userDir) {
  const routes = { get: {}, post: {} };
  const settingsStore = {};
  return {
    routes,
    settings: {
      userDir: userDir,
      get: (k) => settingsStore[k],
      set: (k, v) => { settingsStore[k] = v; return Promise.resolve(); },
    },
    log: { info() {}, warn() {}, error() {} },
    auth: { needsPermission: () => (req, res, next) => next && next() },
    httpAdmin: {
      get: (p, ...rest) => { routes.get[p] = rest[rest.length - 1]; },
      post: (p, ...rest) => { routes.post[p] = rest[rest.length - 1]; },
    },
  };
}

// Minimal Express res: status + json/send, resolved on the first answer.
function call(handler, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headers: {},
      on() {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body: body }); return this; },
      send(body) { resolve({ status: this.statusCode, body: body }); return this; },
    };
    Promise.resolve(handler(Object.assign({ query: {}, params: {}, body: {} }, req || {}), res))
      .catch((e) => resolve({ status: 500, body: { error: String(e && e.message) } }));
  });
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RED = fakeRED(WORK);
createLLMPluginServer(RED);

function scenarioServesOnlyClientFiles() {
  console.log('The unauthenticated src route serves what client.js loads, and nothing else');
  const clientJs = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8');
  const loaded = (clientJs.match(/'llm-plugin\/src\/[^']+'/g) || [])
    .map((s) => s.slice(1, -1)).concat(['llm-plugin/src/client.js']).sort();
  const served = Object.keys(RED.routes.get)
    .filter((p) => p.indexOf('/llm-plugin/src/') === 0)
    .map((p) => p.slice(1)).sort();
  ok(JSON.stringify(served) === JSON.stringify(loaded),
    'the served list matches client.js (' + served.length + ' files)');
  ok(!RED.routes.get['/llm-plugin/src/server.js'] && !RED.routes.get['/llm-plugin/src/llm_core.js'],
    'server-side modules are not served');
  ok(!RED.routes.get['/llm-plugin/src/*'], 'no wildcard route reaches src/');
}

async function scenarioAgentReplyClaimedOnce() {
  console.log('An Agent-node reply is applied by the first editor that claims it');
  const claim = RED.routes.post['/llm-plugin/agent-apply/claim'];
  const id = agentDispatch.issue();
  const first = await call(claim, { body: { dispatchId: id } });
  const second = await call(claim, { body: { dispatchId: id } });
  ok(first.body.granted === true, 'the first claim is granted');
  ok(second.body.granted === false, 'a second editor is refused');
  const forged = await call(claim, { body: { dispatchId: 'not-issued' } });
  ok(forged.body.granted === false, 'an id the node never issued is refused');
}

async function scenarioSettingsRejectUnknownProvider() {
  console.log('Settings refuse a provider that does not exist');
  const r = await call(RED.routes.post['/llm-plugin/settings'], { body: { provider: 'evil' } });
  ok(r.status === 400, 'an unknown provider is a 400 (' + r.status + ')');
}

async function scenarioCheckpointMetaCounts() {
  console.log('A checkpoint\'s meta counts towards the storage limit');
  const r = await call(RED.routes.post['/llm-plugin/checkpoints/save'], {
    body: { flow: [{ id: 't', type: 'tab' }], meta: { pad: 'x'.repeat(6 * 1024 * 1024) } },
  });
  ok(r.status === 400, 'an oversized meta is refused (' + r.status + ')');
}

async function scenarioChatDeletedById() {
  console.log('A chat is deleted by its id');
  const save = RED.routes.post['/llm-plugin/chats/save'];
  await call(save, { body: { chatId: 'chat_1', chatData: { id: 'chat_1', title: 'hello', messages: [] } } });
  await call(save, { body: { chatId: 'chat_2', chatData: { id: 'chat_2', title: 'other', messages: [] } } });
  // A file an older build named differently, found by the id inside it.
  fs.writeFileSync(path.join(CHATS, 'legacy.json'), JSON.stringify({ id: 'chat_1', __file: 'legacy.json' }));

  const list = (await call(RED.routes.get['/llm-plugin/chats'])).body.chatHistories;
  ok(list.chat_1 && list.chat_1.__file === undefined, 'the listing carries no file names');

  const del = await call(RED.routes.post['/llm-plugin/chats/delete'], { body: { chatId: 'chat_1' } });
  ok(del.status === 200, 'the delete succeeds');
  const left = fs.readdirSync(CHATS);
  ok(left.length === 1 && /chat_2\.json$/.test(left[0]), 'every file of that chat is gone, the other stays (' + left + ')');
  const missing = await call(RED.routes.post['/llm-plugin/chats/delete'], { body: {} });
  ok(missing.status === 400, 'a delete without an id is refused');
}

(async function run() {
  scenarioServesOnlyClientFiles();
  await scenarioAgentReplyClaimedOnce();
  await scenarioSettingsRejectUnknownProvider();
  await scenarioCheckpointMetaCounts();
  await scenarioChatDeletedById();
  fs.rmSync(WORK, { recursive: true, force: true });
  summary();
})();
