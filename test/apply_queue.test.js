// Ordering between the two producers that write to the same canvas.
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
// targeting it waits. Different flows never wait for each other.
const path = require('path');
const vm = require('vm');
const fs = require('fs');
const { ok, summary, ROOT } = require('./helpers.js');

// The queue only needs a window to hang off and RED.events to listen on.
function loadQueue() {
  const handlers = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    RED: {
      events: {
        on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.LLMPlugin = { Common: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'apply_queue.js'), 'utf8'),
    sandbox, { filename: 'src/apply_queue.js' });
  const Q = sandbox.window.LLMPlugin.ApplyQueue;
  Q.bindDeployListener();
  return {
    Q,
    // Stand in for the editor's own deploy event, which Node-RED emits only
    // from the success path of a deploy — the user's button and the node's
    // auto deploy alike.
    deploy: () => (handlers.deploy || []).forEach((fn) => fn()),
  };
}

// A controllable apply: records that it ran, settles when told to.
function pendingApply(log, name, result) {
  let settle;
  const fn = function () {
    log.push(name);
    return new Promise((resolve) => { settle = resolve; });
  };
  fn.finish = (value) => settle(value !== undefined ? value : (result || { ok: true }));
  return fn;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function scenarioDifferentFlowsDoNotWait() {
  console.log('Edits to different flows do not wait for each other');
  const { Q } = loadQueue();
  const log = [];
  const a = pendingApply(log, 'A');
  const b = pendingApply(log, 'B');

  const pa = Q.enqueue({ source: 'sidebar', targetFlowIds: ['tabA'], apply: a });
  a.finish({ ok: true });
  await pa;

  // tabA is now held (applied, not deployed) — but B wants tabB.
  const pb = Q.enqueue({ source: 'node', targetFlowIds: ['tabB'], apply: b });
  await tick();
  ok(log.indexOf('B') !== -1, 'the second edit ran without waiting');
  b.finish({ ok: true });
  await pb;
  ok(log.join(',') === 'A,B', 'both ran, in order (' + log.join(',') + ')');
}

async function scenarioSameFlowWaitsForDeploy() {
  console.log('\nAn edit to a held flow waits until the deploy');
  const { Q, deploy } = loadQueue();
  const log = [];
  const a = pendingApply(log, 'A');
  const b = pendingApply(log, 'B');

  const pa = Q.enqueue({ source: 'sidebar', targetFlowIds: ['tabA'], apply: a });
  a.finish({ ok: true });
  await pa;

  const pb = Q.enqueue({ source: 'node', targetFlowIds: ['tabA'], apply: b });
  await tick();
  ok(log.indexOf('B') === -1, 'the second edit has NOT run (' + log.join(',') + ')');

  const waiting = Q.list();
  ok(waiting.length === 1, 'it is listed as waiting (' + waiting.length + ')');
  ok(waiting[0].blockedBy === 'deploy',
    'and the panel can say why (' + waiting[0].blockedBy + ')');
  ok(waiting[0].source === 'node', 'with the producer it came from');
  ok(Q.isHolding(), 'the queue reports the flow as held');

  deploy();
  await tick();
  ok(log.indexOf('B') !== -1, 'the deploy released it');
  b.finish({ ok: true });
  await pb;
  ok(Q.list().length === 0, 'and the queue is empty again');
}

async function scenarioFirstComeFirstServed() {
  console.log('\nTwo waiting edits run in the order they arrived');
  const { Q, deploy } = loadQueue();
  const log = [];
  const first = pendingApply(log, 'first');
  const second = pendingApply(log, 'second');
  const third = pendingApply(log, 'third');

  const p0 = Q.enqueue({ targetFlowIds: ['tabA'], apply: first });
  first.finish({ ok: true });
  await p0;

  Q.enqueue({ targetFlowIds: ['tabA'], apply: second, label: 'second' });
  Q.enqueue({ targetFlowIds: ['tabA'], apply: third, label: 'third' });
  await tick();
  ok(log.length === 1, 'neither of the two ran while the flow was held');

  deploy();
  await tick();
  ok(log[1] === 'second', 'the earlier request went first (' + log.join(',') + ')');
  ok(log.indexOf('third') === -1,
    'and the later one still waits — it wants the same flow');

  second.finish({ ok: true });
  await tick();
  // `second` now holds tabA in its turn, so `third` waits for the next deploy
  // rather than following straight on.
  ok(log.indexOf('third') === -1, 'third waits for the next deploy too');
  deploy();
  await tick();
  ok(log[2] === 'third', 'and runs after it (' + log.join(',') + ')');
  third.finish({ ok: true });
}

// A failed apply commits nothing (the importer rolls back), so holding its
// flows would make the next request wait for a deploy that has no reason to
// happen — the queue would deadlock on an error.
async function scenarioFailedApplyHoldsNothing() {
  console.log('\nA failed apply does not hold its flows');
  const { Q } = loadQueue();
  const log = [];
  const a = pendingApply(log, 'A');
  const b = pendingApply(log, 'B');

  const pa = Q.enqueue({ targetFlowIds: ['tabA'], apply: a });
  a.finish({ ok: false, error: 'simulated failure' });
  await pa;
  ok(!Q.isHolding(), 'nothing is held after the failure');

  const pb = Q.enqueue({ targetFlowIds: ['tabA'], apply: b });
  await tick();
  ok(log.indexOf('B') !== -1, 'the next request runs immediately');
  b.finish({ ok: true });
  await pb;
}

// An apply with no declared scope may have written anywhere, so it cannot be
// reasoned about — it waits for everything, and everything waits for it.
async function scenarioUnknownScopeIsConservative() {
  console.log('\nAn edit with no declared scope conflicts with everything');
  const { Q, deploy } = loadQueue();
  const log = [];
  const a = pendingApply(log, 'A');
  const b = pendingApply(log, 'B');

  const pa = Q.enqueue({ targetFlowIds: [], apply: a });
  a.finish({ ok: true });
  await pa;

  Q.enqueue({ targetFlowIds: ['tabZ'], apply: b });
  await tick();
  ok(log.indexOf('B') === -1,
    'an unrelated flow still waits (' + log.join(',') + ')');
  deploy();
  await tick();
  ok(log.indexOf('B') !== -1, 'and is released by the deploy');
  b.finish({ ok: true });
}

async function scenarioCancelAndRelease() {
  console.log('\nA waiting entry can be cancelled, and the hold released');
  const { Q } = loadQueue();
  const log = [];
  const a = pendingApply(log, 'A');
  const b = pendingApply(log, 'B');
  const c = pendingApply(log, 'C');

  const pa = Q.enqueue({ targetFlowIds: ['tabA'], apply: a });
  a.finish({ ok: true });
  await pa;

  const pb = Q.enqueue({ targetFlowIds: ['tabA'], apply: b });
  const id = Q.list()[0].id;
  let rejected = null;
  pb.catch((e) => { rejected = e; });

  ok(Q.cancel(id) === true, 'the waiting entry is cancelled');
  await tick();
  ok(rejected && /Cancelled/.test(rejected.message),
    'its caller is told, rather than left hanging');
  ok(log.indexOf('B') === -1, 'and it never ran');

  // The hold outlives the cancellation: tabA is still applied-not-deployed.
  ok(Q.isHolding(), 'the flow is still held');
  const pc = Q.enqueue({ targetFlowIds: ['tabA'], apply: c });
  await tick();
  ok(log.indexOf('C') === -1, 'so a new request still waits');

  // The way out when the edit was undone or restored instead of deployed.
  Q.releaseHold();
  await tick();
  ok(log.indexOf('C') !== -1, 'releasing the hold lets it through');
  c.finish({ ok: true });
  await pc;
}

// The panel subscribes to this; if it stopped firing the queue would still be
// correct and completely invisible, which is the failure that gets reported
// as "the plugin stopped responding".
async function scenarioChangesAreObservable() {
  console.log('\nQueue changes are announced to subscribers');
  const { Q } = loadQueue();
  const seen = [];
  Q.onChange((entries) => seen.push(entries.length));

  const log = [];
  const a = pendingApply(log, 'A');
  const pa = Q.enqueue({ targetFlowIds: ['tabA'], apply: a });
  ok(seen.length >= 1, 'enqueuing notifies (' + seen.length + ' events)');
  a.finish({ ok: true });
  await pa;
  ok(seen[seen.length - 1] === 0, 'and the last event reports an empty queue');
}

async function run() {
  await scenarioDifferentFlowsDoNotWait();
  await scenarioSameFlowWaitsForDeploy();
  await scenarioFirstComeFirstServed();
  await scenarioFailedApplyHoldsNothing();
  await scenarioUnknownScopeIsConservative();
  await scenarioCancelAndRelease();
  await scenarioChangesAreObservable();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
