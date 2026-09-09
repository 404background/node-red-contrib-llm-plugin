// The browser half of the apply queue: ask for a turn, wait to be granted it,
// apply, report back.
//
// The rules are not here — they are on the server, and apply_queue.test.js
// covers them. What this pins is the protocol, because the failure modes are
// quiet ones: an apply that runs before its turn defeats the whole mechanism,
// an apply that runs twice on a re-pushed grant applies the edit twice, and a
// completion that is never reported holds up every other editor until the
// grant expires.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, summary, ROOT } = require('./helpers.js');

// A stand-in for the server, driven by hand. Requests are answered from
// `nextResponse`, and `push` delivers a state the way comms would.
function loadClient() {
  const posts = [];
  const gets = [];
  let commsHandler = null;
  let nextResponse = null;

  let serverState = emptyState();

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    RED: {
      comms: { subscribe: (topic, fn) => { commsHandler = fn; } },
      settings: { get: () => null },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'common.js'), 'utf8'),
    sandbox, { filename: 'src/common.js' });

  // Common.apiFetch is the one thing the queue client talks through.
  sandbox.window.LLMPlugin.Common.apiFetch = function (url, opts) {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    if (!opts || opts.method !== 'POST') {
      gets.push(url);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(serverState) });
    }
    posts.push({ url: url, body: body });
    const reply = typeof nextResponse === 'function' ? nextResponse(url, body) : (nextResponse || {});
    return Promise.resolve({ ok: true, json: () => Promise.resolve(reply) });
  };

  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'apply_queue.js'), 'utf8'),
    sandbox, { filename: 'src/apply_queue.js' });

  const Q = sandbox.window.LLMPlugin.ApplyQueue;
  // connect() is what subscribes, and the sidebar panel calls it on load — so
  // a scenario that pushes has to have connected, exactly as the real one does.
  Q.connect();
  return {
    Q,
    posts,
    gets,
    setResponse: (r) => { nextResponse = r; },
    push: (state) => {
      serverState = state;
      if (!commsHandler) throw new Error('push before connect(): nothing is subscribed');
      commsHandler('llm-plugin/apply-queue', state);
    },
    commsBound: () => commsHandler !== null,
  };
}

function emptyState() {
  return { entries: [], heldFlows: [], heldEverything: false, holding: false };
}

function stateWith(entries) {
  return { entries: entries, heldFlows: [], heldEverything: false, holding: false };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function scenarioWaitsForTheGrant() {
  console.log('The apply does not run until the server grants the turn');
  const c = loadClient();
  const ran = [];

  // The server says: queued, not yet your turn.
  c.setResponse({ entryId: 'e1', state: 'waiting', queue: stateWith([
    { id: 'e1', clientId: c.Q._clientId(), source: 'sidebar', label: 'Import Flow',
      targets: ['tabA'], state: 'waiting', blockedBy: 'deploy' },
  ]) });

  const p = c.Q.enqueue({ source: 'sidebar', targetFlowIds: ['tabA'],
    apply: function () { ran.push('applied'); return { ok: true }; } });
  await tick();

  ok(c.posts.length === 1 && /request$/.test(c.posts[0].url),
    'it asked the server for a turn');
  ok(c.posts[0].body.targetFlowIds.join(',') === 'tabA',
    'declaring the flows it wants to write');
  ok(c.posts[0].body.clientId === c.Q._clientId(),
    'and identifying this editor session');
  ok(ran.length === 0, 'and did NOT apply while waiting');

  // Now the server grants it, the way a comms push would.
  c.setResponse({ ok: true, queue: emptyState() });
  c.push(stateWith([
    { id: 'e1', clientId: c.Q._clientId(), source: 'sidebar', label: 'Import Flow',
      targets: ['tabA'], state: 'granted', blockedBy: null },
  ]));
  await tick();

  ok(ran.length === 1, 'the grant ran the apply');
  const complete = c.posts.find((x) => /complete$/.test(x.url));
  ok(!!complete, 'and the outcome was reported back');
  ok(complete.body.entryId === 'e1' && complete.body.ok === true,
    'with the entry id and a successful result');
  await p;
}

// A grant stays in every pushed state until the client reports completion, so
// a naive reading of each push would apply the same edit again and again.
async function scenarioGrantIsNotAppliedTwice() {
  console.log('\nA re-pushed grant does not apply the edit twice');
  const c = loadClient();
  let runs = 0;
  let settle;
  c.setResponse({ entryId: 'e1', state: 'waiting', queue: emptyState() });
  const p = c.Q.enqueue({ targetFlowIds: ['tabA'],
    apply: function () { runs++; return new Promise((r) => { settle = r; }); } });
  await tick();

  const granted = stateWith([
    { id: 'e1', clientId: c.Q._clientId(), source: 'sidebar', label: 'x',
      targets: ['tabA'], state: 'granted', blockedBy: null },
  ]);
  c.push(granted);
  await tick();
  ok(runs === 1, 'the first push ran it');

  c.push(granted);
  c.push(granted);
  await tick();
  ok(runs === 1, 'repeated pushes of the same grant did not (' + runs + ' runs)');

  c.setResponse({ ok: true, queue: emptyState() });
  settle({ ok: true });
  await p;
}

// An entry that is never completed keeps its turn until the grant expires, so
// holding every other editor up for two minutes because of a local error is
// worse than the error.
async function scenarioFailureIsStillReported() {
  console.log('\nA failed apply still reports back');
  const c = loadClient();
  c.setResponse({ entryId: 'e1', state: 'waiting', queue: emptyState() });
  // The rejection handler is attached HERE, not after the push that triggers
  // it. Node treats a rejection with no handler yet as fatal, and the real
  // caller attaches its .catch in the same chain as the enqueue — so waiting
  // until later would be testing a shape the product never has.
  let rejected = null;
  const p = c.Q.enqueue({ targetFlowIds: ['tabA'],
    apply: function () { throw new Error('apply blew up'); } });
  p.catch(function (e) { rejected = e; });
  await tick();

  c.setResponse({ ok: true, queue: emptyState() });
  c.push(stateWith([
    { id: 'e1', clientId: c.Q._clientId(), source: 'sidebar', label: 'x',
      targets: ['tabA'], state: 'granted', blockedBy: null },
  ]));
  await tick();

  const complete = c.posts.find((x) => /complete$/.test(x.url));
  ok(!!complete, 'the server was told');
  ok(complete.body.ok === false, 'that it failed, so no flows are held');

  await tick();
  ok(rejected && /blew up/.test(rejected.message),
    'and the caller sees the original error');
}

// A push carries every editor's entries, not just this one's. Running someone
// else's grant would apply their edit in this browser too.
async function scenarioOtherClientsGrantsAreIgnored() {
  console.log("\nAnother editor's grant is not run here");
  const c = loadClient();
  let runs = 0;
  c.setResponse({ entryId: 'mine', state: 'waiting', queue: emptyState() });
  c.Q.enqueue({ targetFlowIds: ['tabA'], apply: function () { runs++; return { ok: true }; } });
  await tick();

  c.push(stateWith([
    { id: 'theirs', clientId: 'someone-else', source: 'node', label: 'their edit',
      targets: ['tabB'], state: 'granted', blockedBy: null },
    { id: 'mine', clientId: c.Q._clientId(), source: 'sidebar', label: 'mine',
      targets: ['tabA'], state: 'waiting', blockedBy: 'deploy' },
  ]));
  await tick();

  ok(runs === 0, 'the other grant did not run anything here');
  const list = c.Q.list();
  ok(list.length === 2, 'but both entries are listed for the panel');
  ok(list.find((e) => e.id === 'theirs').mine === false,
    "and the other editor's is marked as not ours");
  ok(list.find((e) => e.id === 'mine').mine === true, 'while ours is');
}

async function scenarioConnectSubscribesAndSeeds() {
  console.log('\nconnect() subscribes and takes the current state once');
  const c = loadClient();   // calls connect()
  await tick();
  ok(c.commsBound(), 'it subscribed to the comms topic');
  // The GET is not redundant with the retained comms message: subscribe only
  // delivers a retained value if one has been published, and on a freshly
  // started runtime none has.
  ok(c.gets.filter((u) => /apply-queue$/.test(u)).length === 1,
    'and read the current state once over HTTP');
  c.Q.connect();
  await tick();
  ok(c.gets.filter((u) => /apply-queue$/.test(u)).length === 1,
    'a second call does not subscribe or fetch again');
}

async function scenarioListenersAreNotified() {
  console.log('\nSubscribers are told when the queue changes');
  const c = loadClient();
  const seen = [];
  c.Q.onChange((entries) => seen.push(entries.length));
  c.push(stateWith([
    { id: 'e1', clientId: 'other', source: 'node', label: 'x',
      targets: ['tabA'], state: 'waiting', blockedBy: 'deploy' },
  ]));
  ok(seen.length >= 1, 'a push notifies (' + seen.length + ')');
  ok(seen[seen.length - 1] === 1, 'with the entry count the panel renders');
}

async function run() {
  await scenarioWaitsForTheGrant();
  await scenarioGrantIsNotAppliedTwice();
  await scenarioFailureIsStillReported();
  await scenarioOtherClientsGrantsAreIgnored();
  await scenarioConnectSubscribesAndSeeds();
  await scenarioListenersAreNotified();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
