// A flow change made by the Agent NODE must be undoable.
//
// The sidebar's Import button has always taken a checkpoint immediately
// before applying, and the Restore button next to the message rewinds to it.
// The node path took none: it was the one way to change a flow that could not
// be undone — and with auto deploy the edit reaches the running runtime with
// nobody watching.
//
// The node has no chat, so it cannot reuse `saveImportCheckpoint`. Borrowing
// whatever chat happens to be open in the sidebar would file the node's edit
// under an unrelated conversation and delete it with that chat. So the
// checkpoint is saved with `chatId: null` and `meta.source: 'node-apply'`,
// which is also what the server's pruning uses to give node-driven
// checkpoints their own budget.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, summary, clone, buildEditorMock, ROOT } = require('./helpers.js');

const CLIENT_MODULES = [
  'src/common.js',
  'src/core/canvas_layout.js',
  'src/core/flow_converter_core.js',
  'src/core/llm_json_parser.js',
  'src/chat_manager.js',
  'src/importer.js',
  'src/ui_core.js',
];

// Same sandbox as the shared helper, with `fetch` recorded rather than
// stubbed blind: what this suite asserts is the request that goes out.
function loadWithFetchLog(RED, log) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    requestAnimationFrame: (cb) => cb(),
    fetch: (url, opts) => {
      log.push({ url: String(url), opts: opts || {} });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ checkpointId: 'cp_1_abcdef' }),
      });
    },
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    },
    RED,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of CLIENT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  return sandbox.window.LLMPlugin;
}

const TABS = [{ id: 'tab1', type: 'tab', label: 'Flow 1' }];
const NODES = [
  { id: 'n1', type: 'inject', z: 'tab1', name: 'tick', x: 100, y: 100, wires: [['n2']] },
  { id: 'n2', type: 'debug', z: 'tab1', name: 'log', x: 300, y: 100, wires: [] },
];
const JUNCTIONS = [{ id: 'j1', type: 'junction', z: 'tab1', x: 200, y: 200, wires: [[]] }];
const GROUPS = [{ id: 'g1', type: 'group', z: 'tab1', name: 'Box', style: {}, nodes: ['n1'] }];

function setup() {
  const mock = buildEditorMock({
    tabs: TABS,
    nodes: clone(NODES),
    junctions: clone(JUNCTIONS),
    groups: clone(GROUPS),
    activeId: 'tab1',
  });
  const log = [];
  return { P: loadWithFetchLog(mock.RED, log), log };
}

function checkpointPost(log) {
  const hit = log.find((e) => /checkpoint\/save/.test(e.url));
  if (!hit) return null;
  try { return JSON.parse(hit.opts.body); } catch (e) { return null; }
}

async function scenarioNodeApplyIsRecorded() {
  console.log('A node-driven apply saves a checkpoint of its own');
  const { P, log } = setup();

  ok(typeof P.ChatManager.saveNodeApplyCheckpoint === 'function',
    'ChatManager exposes saveNodeApplyCheckpoint');

  const id = await P.ChatManager.saveNodeApplyCheckpoint(
    { id: 'llm1', name: 'nightly tidy' }, ['tab1']);

  const body = checkpointPost(log);
  ok(!!body, 'a checkpoint save was posted');
  ok(id === 'cp_1_abcdef', 'the checkpoint id is handed back to the caller (' + id + ')');
  ok(body.chatId === null,
    'it is NOT filed under a chat (' + JSON.stringify(body.chatId) + ')');
  ok(body.meta && body.meta.source === 'node-apply',
    'source marks it as node-driven (' + (body.meta && body.meta.source) + ')');
  ok(body.meta && body.meta.node && body.meta.node.id === 'llm1',
    'it records which node made the change');
  ok(body.meta && body.meta.node && body.meta.node.name === 'nightly tidy',
    'including the name, so the label is readable');
  ok(body.meta && Array.isArray(body.meta.targetFlowIds) &&
     body.meta.targetFlowIds.indexOf('tab1') !== -1,
    'and which flows were in scope');
}

// The snapshot is what Restore re-imports, so anything missing from it is
// deleted by the restore rather than restored. Junctions and groups are the
// entities that go missing first (see design.md section 7), which is why the
// node path has to use the same snapshot helper as the sidebar and not a
// plain node listing.
async function scenarioSnapshotIsComplete() {
  console.log('\nThe snapshot it stores is the complete flow');
  const { P, log } = setup();
  await P.ChatManager.saveNodeApplyCheckpoint({ id: 'llm1', name: null }, ['tab1']);

  const body = checkpointPost(log);
  ok(!!body && Array.isArray(body.flow), 'the post carries a flow array');
  const types = (body.flow || []).map((n) => n.type);
  ok(types.indexOf('junction') !== -1, 'the junction is in the snapshot');
  ok(types.indexOf('group') !== -1, 'the group is in the snapshot');
  ok(types.indexOf('inject') !== -1 && types.indexOf('debug') !== -1,
    'the regular nodes are there too');
  ok(typeof body.label === 'string' && /node-apply/.test(body.label),
    'the label says what kind of checkpoint this is (' + body.label + ')');
}

// An EMPTY target tab still gets a checkpoint, and must.
//
// The tempting reading is "nothing to snapshot, skip it" — but the edit about
// to run is the one that fills the tab, and the empty state is exactly what
// undoing it has to restore. The snapshot is `[tab]` rather than `[]`, which
// is why it survives the emptiness check at all; asserting that here keeps a
// future "don't bother saving an empty flow" tidy-up from quietly removing
// the undo for every node that builds a flow from scratch.
async function scenarioEmptyTargetIsStillCheckpointed() {
  console.log('\nAn empty target flow is still checkpointed');
  const mock = buildEditorMock({ tabs: TABS, nodes: [], activeId: 'tab1' });
  const log = [];
  const P = loadWithFetchLog(mock.RED, log);

  const id = await P.ChatManager.saveNodeApplyCheckpoint({ id: 'llm1' }, ['tab1']);
  const body = checkpointPost(log);
  ok(id === 'cp_1_abcdef', 'a checkpoint id comes back (' + id + ')');
  ok(!!body, 'a checkpoint save was posted');
  ok(body && Array.isArray(body.flow) && body.flow.length === 1 &&
     body.flow[0].type === 'tab',
    'the snapshot is the bare tab — restoring it empties the flow again');
}

async function run() {
  await scenarioNodeApplyIsRecorded();
  await scenarioSnapshotIsComplete();
  await scenarioEmptyTargetIsStillCheckpointed();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
