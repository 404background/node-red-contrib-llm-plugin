// Ordering between everything that writes to the same flows.
//
// The sidebar's Import button and the Agent node both apply flow edits, and
// the node's reply arrives whenever the model finishes — not at a moment
// anyone chose. Interleaved, the damage lands on the FIRST edit, not the
// second: the first is still on the canvas and undeployed when the second
// takes its snapshot, merges against it and applies on top, so the second
// checkpoint rewinds to a state that already contains the first change and
// neither can be undone cleanly.
//
// The rule: a flow applied but not yet deployed is held, and anything else
// targeting it waits; among those waiting, the earlier request goes first.
// Different flows never wait for each other.
//
// These drive the SERVER module, because that is where the rule lives. A
// browser-side queue could only order one editor's own requests, and would
// learn about a deploy only from the browser that made it.
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

const createApplyQueue = require(path.join(ROOT, 'src', 'apply_queue_server.js'));

// Records what would be pushed to the editors, and lets a runtime deploy be
// fired the way the flow engine fires it.
function fakeRED() {
  const published = [];
  const handlers = {};
  return {
    published,
    log: { info() {}, warn() {}, error() {} },
    comms: { publish: (topic, data, retained) => published.push({ topic, data, retained }) },
    events: { on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); } },
    // The flow engine emits this after a deploy completes, whoever triggered
    // it — another editor, the Agent node's auto deploy, or the Admin API.
    deploy: () => (handlers['runtime-event'] || []).forEach((fn) =>
      fn({ id: 'runtime-deploy', payload: { revision: 'rev1' } })),
  };
}

function boot() {
  const RED = fakeRED();
  const Q = createApplyQueue(RED);
  Q.bindDeployListener();
  return { RED, Q };
}

function entryFor(state, id) {
  return (state.entries || []).find((e) => e.id === id) || null;
}

function scenarioDifferentFlowsDoNotWait() {
  console.log('Edits to different flows are granted together');
  const { Q } = boot();

  const a = Q.request({ clientId: 'c1', source: 'sidebar', targetFlowIds: ['tabA'] });
  ok(a.state === 'granted', 'the first is granted immediately (' + a.state + ')');
  Q.complete(a.entryId, true);

  // tabA is now held: applied, not deployed. tabB is untouched.
  const b = Q.request({ clientId: 'c2', source: 'node', targetFlowIds: ['tabB'] });
  ok(b.state === 'granted',
    'an edit to a different flow does not wait (' + b.state + ')');
}

function scenarioSameFlowWaitsForDeploy() {
  console.log('\nAn edit to a held flow waits until the deploy');
  const { RED, Q } = boot();

  const a = Q.request({ clientId: 'c1', source: 'sidebar', targetFlowIds: ['tabA'] });
  Q.complete(a.entryId, true);
  ok(Q.state().holding, 'the flow is held after the apply');

  const b = Q.request({ clientId: 'c2', source: 'node', label: 'llm-request node', targetFlowIds: ['tabA'] });
  ok(b.state === 'waiting', 'the second is not granted (' + b.state + ')');

  const waiting = entryFor(Q.state(), b.entryId);
  ok(waiting && waiting.blockedBy === 'deploy',
    'and the panel can say why (' + (waiting && waiting.blockedBy) + ')');
  ok(waiting && waiting.source === 'node', 'with the producer it came from');

  RED.deploy();
  const after = entryFor(Q.state(), b.entryId);
  ok(after && after.state === 'granted', 'the deploy released it');
  ok(!Q.state().holding, 'and nothing is held any more');
}

// The reason this belongs on the server: the release signal is the runtime's
// own deploy event, so a deploy made in ANOTHER editor frees this flow too. A
// per-browser queue sees only its own deploys.
function scenarioDeployFromAnywhereReleases() {
  console.log('\nA deploy from any editor releases the hold');
  const { RED, Q } = boot();

  const mine = Q.request({ clientId: 'editor-1', targetFlowIds: ['tabA'] });
  Q.complete(mine.entryId, true);

  const theirs = Q.request({ clientId: 'editor-2', targetFlowIds: ['tabA'] });
  ok(theirs.state === 'waiting', "the other editor's request waits");

  // Nothing here says which editor deployed; the runtime event carries no
  // client at all, which is exactly why it works for all of them.
  RED.deploy();
  ok(entryFor(Q.state(), theirs.entryId).state === 'granted',
    'and is released by a deploy it did not make');
}

function scenarioFirstComeFirstServed() {
  console.log('\nTwo waiting edits are granted in the order they arrived');
  const { RED, Q } = boot();

  const first = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  Q.complete(first.entryId, true);

  const second = Q.request({ clientId: 'c1', label: 'second', targetFlowIds: ['tabA'] });
  const third = Q.request({ clientId: 'c2', label: 'third', targetFlowIds: ['tabA'] });
  ok(second.state === 'waiting' && third.state === 'waiting', 'both wait while held');

  RED.deploy();
  let s = Q.state();
  ok(entryFor(s, second.entryId).state === 'granted', 'the earlier request goes first');
  ok(entryFor(s, third.entryId).state === 'waiting',
    'and the later one still waits — it wants the same flow');
  ok(entryFor(s, third.entryId).blockedBy === 'queue',
    'blocked by the queue rather than by a hold (' +
      entryFor(s, third.entryId).blockedBy + ')');

  Q.complete(second.entryId, true);
  ok(entryFor(Q.state(), third.entryId).state === 'waiting',
    'once that one applies, the third waits for the next deploy');
  RED.deploy();
  ok(entryFor(Q.state(), third.entryId).state === 'granted', 'and is granted after it');
}

// A failed apply commits nothing (the importer rolls back), so holding its
// flows would make the next request wait for a deploy that has no reason to
// happen — the queue would wedge on an error.
function scenarioFailedApplyHoldsNothing() {
  console.log('\nA failed apply does not hold its flows');
  const { Q } = boot();

  const a = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  Q.complete(a.entryId, false);
  ok(!Q.state().holding, 'nothing is held after the failure');

  const b = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  ok(b.state === 'granted', 'the next request is granted immediately');
}

function scenarioUnknownScopeIsConservative() {
  console.log('\nAn edit with no declared scope conflicts with everything');
  const { RED, Q } = boot();

  const a = Q.request({ clientId: 'c1', targetFlowIds: [] });
  ok(a.state === 'granted', 'it runs when nothing is held');
  Q.complete(a.entryId, true);
  ok(Q.state().heldEverything, 'and then holds everything');

  const b = Q.request({ clientId: 'c1', targetFlowIds: ['tabZ'] });
  ok(b.state === 'waiting', 'an unrelated flow still waits');
  RED.deploy();
  ok(entryFor(Q.state(), b.entryId).state === 'granted', 'until the deploy');

  // And the other direction: an unscoped request waits for any existing hold.
  const c = Q.request({ clientId: 'c1', targetFlowIds: ['tabQ'] });
  Q.complete(c.entryId, true);
  const d = Q.request({ clientId: 'c1', targetFlowIds: [] });
  ok(d.state === 'waiting', 'and an unscoped request waits for a scoped hold');
}

function scenarioCancelAndRelease() {
  console.log('\nA waiting entry can be cancelled, and the hold released');
  const { Q } = boot();

  const a = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  Q.complete(a.entryId, true);

  const b = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  ok(Q.cancel(b.entryId).ok === true, 'the waiting entry is cancelled');
  ok(entryFor(Q.state(), b.entryId) === null, 'and is gone from the queue');

  // A granted entry is mid-apply; abandoning it there is what leaves a
  // half-changed canvas.
  const c = Q.request({ clientId: 'c1', targetFlowIds: ['tabOther'] });
  ok(c.state === 'granted', 'a non-conflicting request is granted');
  ok(Q.cancel(c.entryId).ok === false, 'a granted entry cannot be cancelled');

  ok(Q.state().holding, 'the hold outlives the cancellation');
  Q.releaseHold();
  ok(!Q.state().holding, 'releasing clears it');
  const d = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  ok(d.state === 'granted', 'and the next request goes through');
}

// A browser that takes its turn and then closes would otherwise hold the queue
// for everyone. The grant expires; the cost of being wrong is one duplicate
// apply attempt, against a queue that never moves again.
function scenarioAbandonedGrantExpires() {
  console.log('\nA grant nobody completes expires');
  const { Q } = boot();

  const gone = Q.request({ clientId: 'closed-tab', targetFlowIds: ['tabA'] });
  ok(gone.state === 'granted', 'the doomed client took its turn');

  const waiting = Q.request({ clientId: 'c2', targetFlowIds: ['tabA'] });
  ok(waiting.state === 'waiting', 'and the next request is behind it');

  // Advance past the grant timeout rather than waiting it out.
  const realNow = Date.now;
  Date.now = () => realNow() + Q._constants.GRANT_TIMEOUT_MS + 1000;
  try {
    const s = Q.state();
    ok(entryFor(s, gone.entryId) === null, 'the abandoned grant is dropped');
    ok(entryFor(s, waiting.entryId).state === 'granted',
      'and the queue moves on');
  } finally {
    Date.now = realNow;
  }
}

// The panel renders whatever was last pushed, so a change nobody publishes is
// a change nobody sees — and the queue would look like a hang.
function scenarioStateIsPushedToEditors() {
  console.log('\nEvery change is pushed to the editors');
  const { RED, Q } = boot();

  const before = RED.published.length;
  const a = Q.request({ clientId: 'c1', targetFlowIds: ['tabA'] });
  ok(RED.published.length > before, 'requesting publishes');

  const last = RED.published[RED.published.length - 1];
  ok(last.topic === Q.COMMS_TOPIC, 'on the queue topic (' + last.topic + ')');
  ok(last.retained === true,
    'retained, so an editor opened later sees the queue as it stands');
  ok(Array.isArray(last.data.entries), 'carrying the entries');

  const n = RED.published.length;
  Q.complete(a.entryId, true);
  ok(RED.published.length > n, 'completing publishes');
  const n2 = RED.published.length;
  RED.deploy();
  ok(RED.published.length > n2, 'and so does the deploy that releases the hold');
}

// The entries carry the client that asked, so an editor can tell its own
// request from one belonging to somebody else's browser — the difference
// between "mine is waiting" and "someone else holds this flow".
function scenarioEntriesNameTheirClient() {
  console.log('\nEntries say which editor asked');
  const { Q } = boot();
  const a = Q.request({ clientId: 'editor-1', targetFlowIds: ['tabA'] });
  Q.complete(a.entryId, true);
  const b = Q.request({ clientId: 'editor-2', label: 'theirs', targetFlowIds: ['tabA'] });

  const e = entryFor(Q.state(), b.entryId);
  ok(e && e.clientId === 'editor-2', 'the entry names its client (' + (e && e.clientId) + ')');
  ok(e && e.label === 'theirs', 'and what it is');
  ok(Q.state().heldFlows.indexOf('tabA') !== -1,
    'and the held flows are listed (' + Q.state().heldFlows.join(',') + ')');
}

function run() {
  scenarioDifferentFlowsDoNotWait();
  scenarioSameFlowWaitsForDeploy();
  scenarioDeployFromAnywhereReleases();
  scenarioFirstComeFirstServed();
  scenarioFailedApplyHoldsNothing();
  scenarioUnknownScopeIsConservative();
  scenarioCancelAndRelease();
  scenarioAbandonedGrantExpires();
  scenarioStateIsPushedToEditors();
  scenarioEntriesNameTheirClient();
  summary();
}

run();
