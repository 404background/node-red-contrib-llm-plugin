// Applying an edit must not make Node-RED RESTART the nodes it did not edit.
//
// This is about the DEPLOY, not the canvas — the sibling guarantee to
// incremental_apply.test.js, which covers what the editor touches. What the
// runtime restarts is decided by `diffNodes` in
// @node-red/runtime/lib/flows/util.js: it compares node configs by id and
// deliberately IGNORES `x`, `y` and `wires` (and, for a group, `nodes` /
// `style` / `w` / `h`). So a node keeps running through a move or a rewire,
// and only a material property change stops it.
//
// The guarantee that can actually break is key-set fidelity: diffNodes calls a
// node changed the moment its NUMBER of keys differs, so an apply that added a
// stray property (a layout hint, an `_`-prefixed marker) to a node the user
// never mentioned would restart a running node — an mqtt subscription
// reconnecting, an inject timer resetting — for an edit somewhere else in the
// tab. That is what is asserted here.
const { ok, summary, clone, fence, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

// --- Node-RED's own restart criterion, mirrored in behaviour ---
// @node-red/runtime/lib/flows/util.js (4.1.2). A node that lands in
// diff.changed is stopped and restarted on deploy.
function nodeRedWouldRestart(oldNode, newNode) {
  if (oldNode == null) return true;
  const keyFilter = (p) => p !== 'x' && p !== 'y' && p !== 'wires';
  const groupKeyFilter = (p) =>
    keyFilter(p) && p !== 'nodes' && p !== 'style' && p !== 'w' && p !== 'h';
  const pick = (n) => Object.keys(n).filter(n.type === 'group' ? groupKeyFilter : keyFilter);
  const oldKeys = pick(oldNode);
  const newKeys = pick(newNode);
  if (oldKeys.length !== newKeys.length) return true;
  for (const p of newKeys) {
    if (JSON.stringify(oldNode[p]) !== JSON.stringify(newNode[p])) return true;
  }
  return false;
}

const TABS = [{ id: 't1', type: 'tab', label: 'Main' }];

// A running flow worth not restarting: an mqtt subscription (a live broker
// connection), an inject on a repeat timer, and a function in between.
function livingFlow() {
  return [
    { id: 'mq1', type: 'mqtt in', z: 't1', name: 'sensor feed', topic: 'sensors/#',
      qos: '2', datatype: 'auto', broker: 'brk', nl: false, rap: true, rh: 0,
      x: 120, y: 100, wires: [['fn1']] },
    { id: 'tick', type: 'inject', z: 't1', name: 'every 5s', repeat: '5',
      crontab: '', once: true, onceDelay: 0.1, topic: '', payloadType: 'date',
      x: 120, y: 200, wires: [['fn1']] },
    { id: 'fn1', type: 'function', z: 't1', name: 'shape', func: 'return msg;',
      outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
      x: 320, y: 150, wires: [['dbg']] },
    { id: 'dbg', type: 'debug', z: 't1', name: 'out', active: true, tosidebar: true,
      console: false, complete: 'payload', targetType: 'msg', statusVal: '',
      x: 520, y: 150, wires: [] },
  ];
}

async function applyEdit(before, message) {
  const mock = buildEditorMock({ tabs: TABS, nodes: clone(before), activeId: 't1' });
  const LLMPlugin = loadPluginSandbox(mock.RED);
  const res = await LLMPlugin.Importer.importFlowFromMessage(message, {
    mode: 'agent',
    allowedWorkspaceIds: ['t1'],
  });
  // The flow as it now stands. Reading import()'s payload instead would only
  // see the nodes that were re-created, which under an incremental apply is
  // exactly the set this suite is asserting stays EMPTY for untouched nodes.
  const applied = {};
  mock.snapshot('t1').forEach((n) => { if (n && n.id) applied[n.id] = n; });
  return { res, applied, captured: mock.captured };
}

function reportUntouched(before, applied, untouchedIds, label) {
  const beforeById = {};
  before.forEach((n) => { beforeById[n.id] = n; });
  untouchedIds.forEach((id) => {
    const a = applied[id];
    ok(!!a, label + ': ' + id + ' still exists after the edit');
    if (!a) return;
    const restarted = nodeRedWouldRestart(beforeById[id], a);
    if (restarted) {
      console.log('       before: ' + JSON.stringify(beforeById[id]));
      console.log('       after : ' + JSON.stringify(a));
    }
    ok(!restarted, label + ': Node-RED would NOT restart ' + id + ' on deploy');
  });
}

async function editingOneNodeRestartsOnlyThatNode() {
  console.log('Editing one node leaves the other running nodes untouched');
  const before = livingFlow();
  const msg = 'Tweaking the function.\n' + fence({
    nodes: { function_shape: { props: { func: 'msg.payload = msg.payload * 2;\nreturn msg;' } } },
  });

  const { res, applied } = await applyEdit(before, msg);
  ok(res && res.ok, 'the edit applied');
  ok(!!(applied.fn1 && String(applied.fn1.func).indexOf('* 2') !== -1),
    'the function really was edited');
  reportUntouched(before, applied, ['mq1', 'tick', 'dbg'], 'edit');
}

async function addingANodeRestartsNothingExisting() {
  console.log('\nAdding a node restarts nothing that was already there');
  const before = livingFlow();
  const msg = 'Adding a second logger.\n' + fence({
    nodes: { debug_audit: { type: 'debug', props: { name: 'audit' } } },
    connections: [['function_shape', 'debug_audit']],
  });

  const { res, applied } = await applyEdit(before, msg);
  ok(res && res.ok, 'the edit applied');
  // fn1 gains a wire, which diffNodes ignores; the other three are untouched
  // outright. All four must survive a Modified Nodes deploy without a restart.
  reportUntouched(before, applied, ['mq1', 'tick', 'dbg', 'fn1'], 'add');
}

async function deletingANodeRestartsNothingElse() {
  console.log('\nDeleting a node restarts nothing else');
  const before = livingFlow();
  // A delete-only reply: `remove` is the schema's ONLY key. The directive
  // extractor has always accepted a top-level remove array, but isVibeSchema
  // keyed on `nodes` / `connections` / `reposition`, so this shape was thrown
  // out one step earlier as "No JSON flow found in message" — the tolerance
  // was unreachable in exactly the case it exists for.
  const msg = 'Dropping the debug.\n' + fence({ remove: ['debug_out'] });

  const { res, applied } = await applyEdit(before, msg);
  ok(res && res.ok, 'a schema whose only key is `remove` is recognised as an edit');
  ok(!applied.dbg, 'the debug node is gone');
  reportUntouched(before, applied, ['mq1', 'tick', 'fn1'], 'delete');
}

(async () => {
  await editingOneNodeRestartsOnlyThatNode();
  await addingANodeRestartsNothingExisting();
  await deletingANodeRestartsNothingElse();
  summary();
})();
