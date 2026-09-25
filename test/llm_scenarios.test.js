// Live scenarios: realistic requests, sent to a real model, applied to a
// mocked editor through the real importer. Not part of `npm test`; run with
//
//     npm run test:llm
//
// llm_roundtrip checks that a reply converts; this checks that what a user
// asks for is what ends up on the canvas. Model output varies, so each
// scenario gets `attempts` tries (a user pressing Send again) and its checks
// are about the outcome, not the wording.
//
// Models: LLM_TEST_MODELS="gemma3:4b,gemma4:e2b" (default: the model in
// llm-test-config.json). LLM_TEST_ONLY="delete" runs the scenarios whose name
// contains it. Endpoint: llm-test-config.json / LLM_TEST_URL.
// Exit codes: 0 = every scenario passed for every model, 1 = some failed,
// 2 = skipped (endpoint or model absent).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPluginSandbox, buildEditorMock, clone } = require('./helpers.js');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = (function() {
  const cfg = { ollamaUrl: 'http://localhost:11434', model: 'gemma3:4b', timeoutMs: 180000, attempts: 2 };
  const file = path.join(__dirname, 'llm-test-config.json');
  if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  if (process.env.LLM_TEST_URL) cfg.ollamaUrl = process.env.LLM_TEST_URL;
  cfg.models = (process.env.LLM_TEST_MODELS || process.env.LLM_TEST_MODEL || cfg.model)
    .split(',').map((m) => m.trim()).filter(Boolean);
  return cfg;
})();

function makeCore() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-scenarios-'));
  const store = { llmPluginSettings: { provider: 'ollama', ollamaUrl: CONFIG.ollamaUrl } };
  const RED = {
    settings: { userDir, get: (k) => store[k], set: (k, v) => { store[k] = v; return Promise.resolve(); } },
    log: { info() {}, warn() {}, error() {} },
    nodes: {},
  };
  return require(path.join(ROOT, 'src', 'llm_core.js'))(RED);
}

// ------------------------------------------------------------------ //
//  Canvas helpers                                                     //
// ------------------------------------------------------------------ //

const TAB1 = { id: 't1', type: 'tab', label: 'Flow 1' };
const TAB2 = { id: 't2', type: 'tab', label: 'Flow 2' };
const n = (id, type, name, x, y, wires, extra) =>
  Object.assign({ id, type, z: 't1', name, x, y, wires: wires || [] }, extra || {});

function byType(flow, type) { return flow.filter((x) => x.type === type); }

// Where a node's messages go, through junctions and link nodes.
function reached(flow, fromId, port) {
  const byId = {};
  flow.forEach((x) => { byId[x.id] = x; });
  const out = new Set(), seen = new Set();
  const start = byId[fromId];
  if (!start) return out;
  let queue = [];
  (start.wires || []).forEach((p, i) => { if (port === undefined || port === i) queue = queue.concat(p || []); });
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const x = byId[id];
    if (!x) continue;
    if (x.type === 'junction' || x.type === 'link in') {
      (x.wires || []).forEach((p) => { queue = queue.concat(p || []); });
    } else if (x.type === 'link out') {
      queue = queue.concat(x.links || []);
    } else {
      out.add(id);
    }
  }
  return out;
}

// Wired sequences of at least two nodes.
function sequences(flow) {
  const nodes = flow.filter((x) => x.type !== 'tab' && x.type !== 'group' && x.type !== 'comment' && x.type !== 'junction');
  const parent = {};
  const find = (a) => (parent[a] === a ? a : (parent[a] = find(parent[a])));
  nodes.forEach((x) => { parent[x.id] = x.id; });
  nodes.forEach((x) => (x.wires || []).forEach((p) => (p || []).forEach((t) => {
    if (parent[t] !== undefined) parent[find(x.id)] = find(t);
  })));
  const sizes = {};
  nodes.forEach((x) => { const r = find(x.id); sizes[r] = (sizes[r] || 0) + 1; });
  return Object.values(sizes).filter((s) => s >= 2).length;
}

// What must hold after ANY apply: every wire lands on a node, and no two
// nodes sit on each other.
function invariants(P, flow) {
  const problems = [];
  const ids = new Set(flow.map((x) => x.id));
  flow.forEach((x) => (x.wires || []).forEach((p) => (p || []).forEach((t) => {
    if (!ids.has(t)) problems.push(x.type + ' wires to a missing node');
  })));
  const boxes = flow.filter((x) => typeof x.x === 'number' && x.type !== 'group' && x.type !== 'tab').map((x) => {
    const w = x.type === 'junction' ? 10 : P.CanvasLayout.getNodeWidth(x, {});
    return { x, l: x.x - w / 2, r: x.x + w / 2, t: x.y - 15, b: x.y + 15 };
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.x.z !== b.x.z) continue;
      if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) {
        problems.push((a.x.name || a.x.type) + ' overlaps ' + (b.x.name || b.x.type));
      }
    }
  }
  return problems;
}

// ------------------------------------------------------------------ //
//  Scenarios                                                          //
// ------------------------------------------------------------------ //

const TICK_LOG = () => ({
  tabs: [TAB1],
  nodes: [n('a', 'inject', 'tick', 150, 100, [['b']], { repeat: '1', props: [{ p: 'payload' }], payloadType: 'date' }),
          n('b', 'debug', 'log', 350, 100, [], { active: true, complete: 'payload' })],
});

const SCENARIOS = [
  {
    name: 'build a flow from nothing (ja)', mode: 'agent',
    prompt: '1秒ごとに現在時刻を送り、debugノードに表示するフローを作ってください。',
    canvas: () => ({ tabs: [TAB1], nodes: [] }),
    check: (f) => {
      const inj = byType(f, 'inject')[0], dbg = byType(f, 'debug')[0];
      if (!inj || !dbg) return 'no inject or no debug';
      if (!reached(f, inj.id).has(dbg.id) && !byType(f, 'debug').some((d) => [...reached(f, inj.id)].some((id) => reached(f, id).has(d.id)))) return 'inject does not lead to the debug';
      return null;
    },
  },
  {
    name: 'insert a node between two', mode: 'agent',
    prompt: 'Add a function node between `inject_tick` and `debug_log` that converts msg.payload to an uppercase string.',
    canvas: TICK_LOG,
    check: (f) => {
      const fn = byType(f, 'function')[0];
      if (!fn) return 'no function node';
      if (!reached(f, 'a').has(fn.id)) return 'inject does not feed the function';
      if (!reached(f, fn.id).has('b')) return 'the function does not feed debug_log';
      return null;
    },
  },
  {
    name: 'change a property', mode: 'agent',
    prompt: '`inject_tick` の送信間隔を5秒に変更してください。',
    canvas: TICK_LOG,
    check: (f) => {
      const inj = f.find((x) => x.id === 'a');
      if (!inj) return 'inject_tick is gone';
      if (String(inj.repeat) !== '5') return 'repeat is ' + JSON.stringify(inj.repeat);
      if (!reached(f, 'a').has('b')) return 'the wire to debug_log was lost';
      return null;
    },
  },
  {
    name: 'delete a node', mode: 'agent',
    prompt: 'Delete the node `debug_extra`. Keep everything else.',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b', 'c']]),
      n('b', 'debug', 'log', 350, 100, []),
      n('c', 'debug', 'extra', 350, 180, []),
    ] }),
    check: (f) => {
      if (f.find((x) => x.id === 'c')) return 'debug_extra is still there';
      if (!f.find((x) => x.id === 'b') || !reached(f, 'a').has('b')) return 'debug_log or its wire was lost';
      return null;
    },
  },
  {
    name: 'remove one connection', mode: 'agent',
    prompt: '`inject_tick` から `debug_extra` への接続だけを削除してください。ノードは消さないでください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b', 'c']]),
      n('b', 'debug', 'log', 350, 100, []),
      n('c', 'debug', 'extra', 350, 180, []),
    ] }),
    check: (f) => {
      if (!f.find((x) => x.id === 'c')) return 'debug_extra was deleted';
      if (reached(f, 'a').has('c')) return 'inject still reaches debug_extra';
      if (!reached(f, 'a').has('b')) return 'the other wire was cut too';
      return null;
    },
  },
  {
    name: 'remove a connection through a junction', mode: 'agent',
    prompt: 'Remove the connection from `inject_tick` to `debug_a`. `debug_b` must still receive messages.',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['j']]),
      n('da', 'debug', 'a', 450, 60, []),
      n('db', 'debug', 'b', 450, 140, []),
    ], junctions: [{ id: 'j', type: 'junction', z: 't1', x: 300, y: 100, wires: [['da', 'db']] }] }),
    check: (f) => {
      if (reached(f, 'a').has('da')) return 'inject still reaches debug_a';
      if (!reached(f, 'a').has('db')) return 'debug_b no longer receives';
      return null;
    },
  },
  {
    name: 'add a comment', mode: 'agent',
    prompt: 'このフローの説明コメントを `inject_tick` の上に追加してください。',
    canvas: TICK_LOG,
    check: (f) => (byType(f, 'comment').length >= 1 ? null : 'no comment node'),
  },
  {
    name: 'several independent sequences', mode: 'agent',
    prompt: 'Create two independent flows in this tab: one that injects a temperature value every 2 seconds into a debug node, and one that injects a humidity value every 3 seconds into another debug node.',
    canvas: () => ({ tabs: [TAB1], nodes: [] }),
    check: (f) => (sequences(f) >= 2 ? null : 'found ' + sequences(f) + ' wired sequence(s)'),
  },
  {
    name: 'a switch with two routes', mode: 'agent',
    prompt: 'msg.payload が 10 以上なら `high` という名前の debug に、それ以外なら `low` という名前の debug に送る switch ノードを `inject_tick` の後ろに追加してください。',
    canvas: TICK_LOG,
    check: (f) => {
      const sw = byType(f, 'switch')[0];
      if (!sw) return 'no switch node';
      const w = sw.wires || [];
      if (w.length < 2) return 'the switch has ' + w.length + ' output(s)';
      const first = reached(f, sw.id, 0), second = reached(f, sw.id, 1);
      if (first.size === 0 || second.size === 0) return 'an output of the switch is unwired';
      if ([...first].some((id) => second.has(id))) return 'both outputs reach the same node';
      return null;
    },
  },
  {
    name: 'edit a node on the second flow', mode: 'agent',
    prompt: 'Rename the debug node on Flow 2 to "result". Do not change Flow 1.',
    tabs: ['t1', 't2'],
    canvas: () => ({ tabs: [TAB1, TAB2], nodes: [
      n('a1', 'inject', '', 150, 100, [['d1']]), n('d1', 'debug', '', 350, 100, []),
      Object.assign(n('a2', 'inject', '', 150, 100, [['d2']]), { z: 't2' }),
      Object.assign(n('d2', 'debug', '', 350, 100, []), { z: 't2' }),
    ] }),
    check: (f) => {
      const d2 = f.find((x) => x.id === 'd2'), d1 = f.find((x) => x.id === 'd1');
      if (!d2 || d2.name !== 'result') return 'the Flow 2 debug is named ' + JSON.stringify(d2 && d2.name);
      if (!d1 || d1.name) return 'the Flow 1 debug changed';
      return null;
    },
  },
  {
    name: 'ask: explain the flow', mode: 'ask',
    prompt: 'このフローは何をしていますか？',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['f']], { repeat: '1' }),
      n('f', 'function', 'double', 320, 100, [['b']], { func: 'msg.payload = msg.payload * 2;\nreturn msg;', outputs: 1 }),
      n('b', 'debug', 'log', 480, 100, []),
    ] }),
    checkReply: (reply, schema) => {
      if (!reply || reply.trim().length < 20) return 'the answer is empty';
      if (schema) return 'Ask proposed a flow';
      return null;
    },
  },
  {
    name: 'ask: diagnose why it never fires', mode: 'ask',
    prompt: 'Why does this flow never print anything on its own?',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b']], { repeat: '', once: false }),
      n('b', 'debug', 'log', 350, 100, []),
    ] }),
    checkReply: (reply, schema) => {
      if (schema) return 'Ask proposed a flow';
      if (!/inject/i.test(reply)) return 'the answer never names the inject node';
      return null;
    },
  },
];

// ------------------------------------------------------------------ //
//  Runner                                                             //
// ------------------------------------------------------------------ //

async function runOnce(core, model, sc) {
  const canvas = sc.canvas();
  const mock = buildEditorMock({ tabs: canvas.tabs, nodes: clone(canvas.nodes), junctions: clone(canvas.junctions || []),
    activeId: 't1' });
  const P = loadPluginSandbox(mock.RED);
  const ids = sc.tabs || ['t1'];
  const context = canvas.nodes.length || (canvas.junctions || []).length
    ? P.UI.getFlowsByIds(ids, { includeCanvasExtras: true }) : null;
  const settings = core.getPluginSettings();
  const messages = core.buildMessages(sc.prompt, context, 't1', settings, { mode: sc.mode });
  const reply = await core.generateWithProvider('ollama', settings, model, messages, { timeoutMs: CONFIG.timeoutMs });
  const schema = P.LLMJsonParser.extractVibeSchema(reply, P.FlowConverterCore);
  if (sc.mode === 'ask') return { problem: sc.checkReply(reply, schema), reply };

  if (!schema) return { problem: 'no Vibe Schema in the reply', reply };
  const res = await P.Importer.importFlowFromMessage(reply, { mode: 'agent', allowedWorkspaceIds: ids });
  if (!res || !res.ok) return { problem: 'import failed: ' + (res && res.error), reply };
  const flow = [].concat(...canvas.tabs.map((t) => mock.snapshot(t.id)));
  const broken = invariants(P, flow);
  if (broken.length) return { problem: 'invariant: ' + broken.slice(0, 3).join('; '), reply };
  return { problem: sc.check(flow), reply };
}

async function main() {
  const core = makeCore();
  let tags;
  try {
    tags = await (await fetch(CONFIG.ollamaUrl + '/api/tags')).json();
  } catch (e) {
    console.log('SKIP: cannot reach ' + CONFIG.ollamaUrl);
    process.exit(2);
  }
  const have = (tags.models || []).map((m) => m.name);
  const missing = CONFIG.models.filter((m) => have.indexOf(m) === -1);
  if (missing.length) { console.log('SKIP: not installed: ' + missing.join(', ')); process.exit(2); }

  const table = {};
  let failed = 0;
  for (const model of CONFIG.models) {
    console.log('\n=== ' + model + ' ===');
    table[model] = {};
    for (const sc of SCENARIOS.filter((s) => !process.env.LLM_TEST_ONLY || s.name.indexOf(process.env.LLM_TEST_ONLY) !== -1)) {
      let result = null, tries = 0;
      for (tries = 1; tries <= CONFIG.attempts; tries++) {
        const started = Date.now();
        try {
          result = await runOnce(core, model, sc);
        } catch (e) {
          result = { problem: 'error: ' + (e && e.message ? e.message : e), reply: '' };
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log('  [' + sc.name + '] attempt ' + tries + ' (' + secs + 's): ' + (result.problem || 'ok'));
        if (!result.problem) break;
      }
      if (result.problem && process.env.LLM_TEST_SHOW_FAILED) {
        console.log(String(result.reply).split('\n').map((l) => '      | ' + l).join('\n').slice(0, 3000));
      }
      table[model][sc.name] = result.problem ? 'FAIL' : (tries === 1 ? 'ok' : 'ok (' + tries + ')');
      if (result.problem) failed++;
    }
  }

  console.log('\n=== summary ===');
  const width = Math.max(...SCENARIOS.map((s) => s.name.length));
  console.log(' '.repeat(width) + '  ' + CONFIG.models.join('  |  '));
  SCENARIOS.filter((sc) => table[CONFIG.models[0]][sc.name]).forEach((sc) => {
    console.log(sc.name.padEnd(width) + '  ' + CONFIG.models.map((m) => table[m][sc.name].padEnd(m.length)).join('  |  '));
  });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
