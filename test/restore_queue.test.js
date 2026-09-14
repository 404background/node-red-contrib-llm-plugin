// A restore is an apply too.
//
// Restore — the button under a message, the restore-point list, and the Retry
// button, which rewinds before re-asking — writes to the canvas exactly like an
// import does. It went straight to the editor, around the queue, and that broke
// the two things the queue is for:
//
//  (A) it could rewind the canvas while another turn's apply was mid-flight;
//  (B) it left the hold in place. The flow was back to what the runtime has,
//      but the queue still believed a deploy was owed — so the retried turn's
//      own edit waited for a deploy nobody was going to make, and from the
//      user's side the canvas simply stopped changing.
//
// So a restore goes through the queue as an `undo`: it waits its turn, but a
// hold cannot block it, and finishing it releases the flows it rewound. The
// server rules for that are in apply_queue.test.js; what this suite pins is
// that the importer actually asks for the turn, and applies nothing until it
// has one. See docs/{en,jp}/design.md §13.
const { ok, summary, clone, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

const TABS = [{ id: 'tab1', type: 'tab', label: 'Flow 1' }];
// What the canvas holds now: the edit that was applied and not deployed.
const NODES = [
  { id: 'n_new', type: 'debug', z: 'tab1', name: 'added by the edit', x: 300, y: 100, wires: [] },
];
// What the checkpoint holds: the flow as it was before that edit.
const SNAPSHOT = [
  { id: 'tab1', type: 'tab', label: 'Flow 1' },
  { id: 'n_old', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [[]] },
];

function jsonOf(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
}

function setup(opts) {
  opts = opts || {};
  const mock = buildEditorMock({ tabs: TABS, nodes: clone(NODES), activeId: 'tab1' });
  let commsHandler = null;
  mock.RED.comms = { subscribe: function (topic, fn) { commsHandler = fn; } };

  const P = loadPluginSandbox(mock.RED);
  const posts = [];
  // The state the fake server answers a request with. A scenario decides
  // whether the turn is granted at once or has to be pushed later.
  let requestReply = opts.requestReply || null;

  P.Common.apiFetch = function (url, options) {
    const u = String(url);
    if (!options || options.method !== 'POST') {
      if (/checkpoint\//.test(u)) return jsonOf({ checkpoint: { flow: clone(SNAPSHOT) } });
      return jsonOf({ entries: [] });
    }
    const body = options.body ? JSON.parse(options.body) : {};
    posts.push({ url: u, body: body });
    if (/apply-queue\/request$/.test(u)) return jsonOf(requestReply);
    return jsonOf({ ok: true, queue: { entries: [] } });
  };

  if (opts.connect !== false) P.ApplyQueue.connect();

  return {
    P: P,
    posts: posts,
    idsIn: mock.idsIn,
    setRequestReply: function (r) { requestReply = r; },
    push: function (state) {
      if (!commsHandler) throw new Error('push before connect()');
      commsHandler('llm-plugin/apply-queue', state);
    },
    clientId: P.ApplyQueue._clientId(),
  };
}

function grantedEntry(clientId, undo) {
  return {
    entries: [{
      id: 'e1', clientId: clientId, source: 'sidebar', label: 'Restore flow',
      targets: ['tab1'], state: 'granted', undo: !!undo, blockedBy: null,
    }],
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function scenarioRestoreAsksForItsTurn() {
  console.log('A restore asks the queue for a turn, as an undo');
  const c = setup();
  // The entry is this editor's own, so it is filled in once the sandbox has
  // told us the client id it generated.
  c.setRequestReply({ entryId: 'e1', state: 'waiting', queue: { entries: [
    { id: 'e1', clientId: c.clientId, source: 'sidebar', label: 'Restore flow',
      targets: ['tab1'], state: 'waiting', undo: true, blockedBy: 'queue' },
  ] } });

  const p = c.P.Importer.restoreCheckpoint('cp_1');
  await tick();

  const req = c.posts.find((x) => /apply-queue\/request$/.test(x.url));
  ok(!!req, 'a turn was requested');
  ok(!!req && req.body.undo === true, 'declared as an undo, so a hold cannot block it');
  ok(!!req && req.body.targetFlowIds.join(',') === 'tab1',
    'scoped to the flows the snapshot writes to (' +
      (req && req.body.targetFlowIds.join(',')) + ')');
  ok(!!req && req.body.label === 'Restore flow', 'and named for the queue panel');

  const ids = c.idsIn('tab1');
  ok(ids.indexOf('n_old') === -1 && ids.indexOf('n_new') !== -1,
    'and NOTHING was restored while the turn was still waiting (' + ids.join(',') + ')');

  // The server grants it, the way a comms push does.
  c.push(grantedEntry(c.clientId, true));
  const result = await p;

  const after = c.idsIn('tab1');
  ok(result && result.ok === true, 'the restore reports success once granted');
  ok(after.indexOf('n_old') !== -1, 'the snapshot is back (' + after.join(',') + ')');
  ok(after.indexOf('n_new') === -1, 'and the undeployed edit is gone');

  const done = c.posts.find((x) => /apply-queue\/complete$/.test(x.url));
  ok(!!done && done.body.ok === true,
    'the queue is told it succeeded, which is what releases the flow');
}

async function scenarioGrantedAtOnceRestoresAtOnce() {
  console.log('\nA turn granted immediately restores immediately');
  const c = setup();
  c.setRequestReply({ entryId: 'e1', state: 'granted', queue: grantedEntry(c.clientId, true) });

  const result = await c.P.Importer.restoreCheckpoint('cp_1');
  ok(result && result.ok === true, 'it restored (' + JSON.stringify(result) + ')');
  ok(c.idsIn('tab1').indexOf('n_old') !== -1, 'and the canvas holds the snapshot');
}

async function scenarioQueueRefusalIsReported() {
  console.log('\nA turn that could not be had is reported, not applied anyway');
  const c = setup({ requestReply: { error: 'queue unavailable' } });

  const result = await c.P.Importer.restoreCheckpoint('cp_1');
  ok(result && result.ok === false, 'the caller is told it did not happen');
  ok(c.idsIn('tab1').indexOf('n_new') !== -1,
    'and the canvas is untouched (' + c.idsIn('tab1').join(',') + ')');
}

async function run() {
  await scenarioRestoreAsksForItsTurn();
  await scenarioGrantedAtOnceRestoresAtOnce();
  await scenarioQueueRefusalIsReported();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
