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
// llm-test-config.json). LLM_TEST_ONLY="delete,switch" runs the scenarios whose
// name contains one of them. LLM_TEST_RUNS=10 runs each scenario 10 times without retries
// and reports how often it passed. Endpoint: llm-test-config.json / LLM_TEST_URL.
// Exit codes: 0 = every scenario passed for every model, 1 = some failed,
// 2 = skipped (endpoint or model absent).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadPluginSandbox, buildEditorMock, clone } = require('./helpers.js');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = (function() {
  const cfg = { ollamaUrl: 'http://localhost:11434', model: 'gemma3:4b', timeoutMs: 1800000, attempts: 2 };
  const file = path.join(__dirname, 'llm-test-config.json');
  if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  if (process.env.LLM_TEST_URL) cfg.ollamaUrl = process.env.LLM_TEST_URL;
  cfg.models = (process.env.LLM_TEST_MODELS || process.env.LLM_TEST_MODEL || cfg.model)
    .split(',').map((m) => m.trim()).filter(Boolean);
  cfg.runs = Math.max(0, parseInt(process.env.LLM_TEST_RUNS, 10) || 0);
  return cfg;
})();

const TRANSPORT = /^error: .*(fetch failed|ECONN|socket|terminated|timed out|ETIMEDOUT|EAI_AGAIN)/i;
// LLM_TEST_ONLY: comma-separated parts of scenario names.
const ONLY = (process.env.LLM_TEST_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const selected = (sc) => !ONLY.length || ONLY.some((part) => sc.name.indexOf(part) !== -1);

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
function byId(flow, id) { return flow.find((x) => x.id === id); }
function configCount(mock) { let c = 0; mock.RED.nodes.eachConfig(() => { c++; }); return c; }
// Every listed id is still on the canvas.
function kept(flow, ids) {
  const gone = ids.filter((id) => !byId(flow, id));
  return gone.length ? 'lost ' + gone.join(', ') : null;
}

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
  // ---------------------------------------------------------------- //
  //  Deletes, flags, renames                                          //
  // ---------------------------------------------------------------- //
  {
    name: 'delete two nodes at once', mode: 'agent',
    prompt: '`debug_extra1` と `debug_extra2` を削除してください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b', 'c', 'd']]),
      n('b', 'debug', 'log', 350, 60, []),
      n('c', 'debug', 'extra1', 350, 120, []),
      n('d', 'debug', 'extra2', 350, 180, []),
    ] }),
    check: (f) => {
      if (byId(f, 'c') || byId(f, 'd')) return 'an extra debug is still there';
      if (!byId(f, 'b') || !reached(f, 'a').has('b')) return 'debug_log or its wire was lost';
      return null;
    },
  },
  {
    name: 'disable a node', mode: 'agent',
    prompt: 'Disable `debug_log` but keep it on the canvas.',
    canvas: TICK_LOG,
    check: (f) => {
      const b = byId(f, 'b');
      if (!b) return 'debug_log was deleted';
      if (b.d !== true) return 'debug_log is not disabled';
      if (!reached(f, 'a').has('b')) return 'its wire was lost';
      return null;
    },
  },
  {
    name: 're-enable a node', mode: 'agent',
    prompt: '無効になっている `debug_log` を有効に戻してください。',
    canvas: () => { const c = TICK_LOG(); c.nodes[1].d = true; return c; },
    check: (f) => {
      const b = byId(f, 'b');
      if (!b) return 'debug_log was deleted';
      if (b.d) return 'debug_log is still disabled';
      return null;
    },
  },
  {
    name: 'rename a node', mode: 'agent',
    prompt: 'Rename `debug_log` to "output".',
    canvas: TICK_LOG,
    check: (f) => {
      const b = byId(f, 'b');
      if (!b) return 'debug_log was replaced instead of renamed';
      if (b.name !== 'output') return 'its name is ' + JSON.stringify(b.name);
      if (!reached(f, 'a').has('b')) return 'its wire was lost';
      if (f.filter((x) => x.type === 'debug').length !== 1) return 'a second debug appeared';
      return null;
    },
  },
  {
    name: 'two edits in one request', mode: 'agent',
    prompt: 'Make `inject_tick` fire every 10 seconds, and rename `debug_log` to "clock".',
    canvas: TICK_LOG,
    check: (f) => {
      const a = byId(f, 'a'), b = byId(f, 'b');
      if (!a || !b) return kept(f, ['a', 'b']);
      if (String(a.repeat) !== '10') return 'repeat is ' + JSON.stringify(a.repeat);
      if (b.name !== 'clock') return 'the debug is named ' + JSON.stringify(b.name);
      return null;
    },
  },
  {
    name: 'delete a node that does not exist', mode: 'agent', allowNoSchema: true,
    prompt: 'Delete `debug_missing`.',
    canvas: TICK_LOG,
    check: (f) => kept(f, ['a', 'b']) || (reached(f, 'a').has('b') ? null : 'the existing wire was cut'),
  },

  // ---------------------------------------------------------------- //
  //  Properties of common nodes                                        //
  // ---------------------------------------------------------------- //
  {
    name: 'edit function code', mode: 'agent',
    prompt: '`function_double` を、msg.payload を2倍ではなく3倍にするよう変更してください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['f']], { repeat: '1', payloadType: 'num', payload: '1' }),
      n('f', 'function', 'double', 320, 100, [['b']], { func: 'msg.payload = msg.payload * 2;\nreturn msg;', outputs: 1 }),
      n('b', 'debug', 'log', 480, 100, []),
    ] }),
    check: (f) => {
      const fn = byId(f, 'f');
      if (!fn) return 'function_double was replaced';
      let out;
      try { out = new Function('msg', fn.func)({ payload: 2 }); } catch (e) { return 'func does not run: ' + e.message; }
      if (!out || out.payload !== 6) return 'func turns 2 into ' + JSON.stringify(out && out.payload);
      if (!reached(f, 'a').has('f') || !reached(f, 'f').has('b')) return 'a wire was lost';
      return null;
    },
  },
  {
    name: 'a change node with JSONata', mode: 'agent',
    prompt: 'Insert a change node between `inject_tick` and `debug_log` that sets msg.payload with a JSONata expression to the text "time: " followed by the current payload.',
    canvas: TICK_LOG,
    check: (f) => {
      const ch = byType(f, 'change')[0];
      if (!ch) return 'no change node';
      const rule = (ch.rules || [])[0];
      if (!rule || rule.tot !== 'jsonata') return 'the rule is not JSONata: ' + JSON.stringify(rule);
      if (!/time/.test(String(rule.to))) return 'the expression is ' + JSON.stringify(rule.to);
      if (!reached(f, 'a').has(ch.id) || !reached(f, ch.id).has('b')) return 'the change node is not in between';
      return null;
    },
  },
  {
    name: 'debug shows the whole message', mode: 'agent',
    prompt: '`debug_log` にメッセージ全体を表示させてください。',
    canvas: TICK_LOG,
    check: (f) => {
      const b = byId(f, 'b');
      if (!b) return 'debug_log was replaced';
      if (String(b.complete) !== 'true') return 'complete is ' + JSON.stringify(b.complete);
      return null;
    },
  },
  {
    name: 'a function with two outputs', mode: 'agent',
    prompt: 'After `inject_tick`, add a function node with two outputs: even seconds go to a debug named "even", odd seconds to a debug named "odd".',
    canvas: TICK_LOG,
    check: (f) => {
      const fn = byType(f, 'function')[0];
      if (!fn) return 'no function node';
      if (fn.outputs !== 2) return 'outputs is ' + JSON.stringify(fn.outputs);
      if (!reached(f, 'a').has(fn.id)) return 'inject does not feed the function';
      const p0 = reached(f, fn.id, 0), p1 = reached(f, fn.id, 1);
      if (!p0.size || !p1.size) return 'an output is unwired';
      if ([...p0].some((id) => p1.has(id))) return 'both outputs reach the same node';
      return null;
    },
  },
  {
    name: 'build an HTTP endpoint', mode: 'agent',
    prompt: 'Create an HTTP endpoint: GET /hello responds with the text "hello world".',
    canvas: () => ({ tabs: [TAB1], nodes: [] }),
    check: (f) => {
      const hin = byType(f, 'http in')[0], hout = byType(f, 'http response')[0];
      if (!hin || !hout) return 'no http in or no http response';
      if (!/\/hello/.test(String(hin.url))) return 'url is ' + JSON.stringify(hin.url);
      if (!reached(f, hin.id).has(hout.id) && ![...reached(f, hin.id)].some((id) => reached(f, id).has(hout.id)))
        return 'http in does not lead to http response';
      return null;
    },
  },

  // ---------------------------------------------------------------- //
  //  Wiring and layout                                                 //
  // ---------------------------------------------------------------- //
  {
    name: 'wire two existing nodes', mode: 'agent',
    prompt: 'Connect `inject_tick` to `debug_log`.',
    canvas: () => ({ tabs: [TAB1], nodes: [n('a', 'inject', 'tick', 150, 100, []), n('b', 'debug', 'log', 350, 100, [])] }),
    check: (f) => kept(f, ['a', 'b']) || (reached(f, 'a').has('b') ? null : 'not wired') ||
      (f.length === 2 ? null : 'nodes were added'),
  },
  {
    name: 'tidy the layout', mode: 'agent',
    prompt: 'ノードをきれいに整列してください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 500, 300, [['f']]),
      n('f', 'function', 'fmt', 120, 40, [['b']], { func: 'return msg;', outputs: 1 }),
      n('b', 'debug', 'log', 330, 220, []),
    ] }),
    check: (f) => kept(f, ['a', 'f', 'b']) ||
      (reached(f, 'a').has('f') && reached(f, 'f').has('b') ? null : 'a wire was lost') ||
      (f.length === 3 ? null : 'nodes were added'),
  },
  {
    name: 'move a comment', mode: 'agent',
    prompt: 'Move the comment `comment_about` so it sits above `debug_log`.',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('cm', 'comment', 'about', 150, 60, [], { info: 'Sends the time.' }),
      n('a', 'inject', 'tick', 150, 100, [['b']]),
      n('b', 'debug', 'log', 450, 100, []),
    ] }),
    check: (f) => {
      const cm = byId(f, 'cm'), a = byId(f, 'a'), b = byId(f, 'b');
      if (!cm) return 'the comment was replaced';
      if (byType(f, 'comment').length !== 1) return 'a second comment appeared';
      if (Math.abs(cm.x - b.x) >= Math.abs(cm.x - a.x)) return 'the comment is still nearer inject_tick';
      if (cm.y >= b.y) return 'the comment is not above debug_log';
      return null;
    },
  },
  {
    name: 'insert into a larger flow', mode: 'agent',
    prompt: 'Add a 1 second delay node between `json_parse` and `switch_status`.',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('i', 'inject', 'poll', 100, 100, [['h']], { repeat: '60' }),
      n('h', 'http request', 'fetch', 250, 100, [['j']], { method: 'GET', url: 'http://example.com/api', ret: 'txt' }),
      n('j', 'json', 'parse', 400, 100, [['s']]),
      n('s', 'switch', 'status', 550, 100, [['c'], ['e']], { property: 'payload.ok', rules: [{ t: 'true' }, { t: 'else' }], outputs: 2 }),
      n('c', 'change', 'pick', 720, 60, [['d']], { rules: [{ t: 'set', p: 'payload', pt: 'msg', to: 'payload.value', tot: 'msg' }] }),
      n('d', 'debug', 'value', 880, 60, []),
      n('e', 'debug', 'error', 720, 160, []),
    ] }),
    check: (f) => {
      const lost = kept(f, ['i', 'h', 'j', 's', 'c', 'd', 'e']);
      if (lost) return lost;
      const dl = byType(f, 'delay')[0];
      if (!dl) return 'no delay node';
      if (!reached(f, 'j').has(dl.id) || !reached(f, dl.id).has('s')) return 'the delay is not in between';
      if (!reached(f, 's', 0).has('c') || !reached(f, 's', 1).has('e')) return 'the switch outputs changed';
      return null;
    },
  },

  // ---------------------------------------------------------------- //
  //  Groups, link nodes, config nodes                                  //
  // ---------------------------------------------------------------- //
  {
    name: 'insert into a group box', mode: 'agent',
    prompt: 'Insert a change node between `inject_tick` and `debug_log` that sets msg.topic to "clock".',
    canvas: () => {
      const c = TICK_LOG();
      c.nodes.forEach((x) => { x.g = 'grp'; });
      c.groups = [{ id: 'grp', type: 'group', z: 't1', name: 'Clock', style: { label: true }, nodes: ['a', 'b'], x: 90, y: 60, w: 330, h: 80 }];
      return c;
    },
    check: (f) => {
      const ch = byType(f, 'change')[0], grp = byId(f, 'grp');
      if (!ch) return 'no change node';
      if (!grp) return 'the group was dropped';
      if (ch.g !== 'grp' || grp.nodes.indexOf(ch.id) === -1) return 'the change node is outside the box';
      if (!reached(f, 'a').has(ch.id) || !reached(f, ch.id).has('b')) return 'the change node is not in between';
      return null;
    },
  },
  {
    name: 'delete a node inside a group box', mode: 'agent',
    prompt: 'Delete `debug_extra`.',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b', 'c']], { g: 'grp' }),
      n('b', 'debug', 'log', 350, 100, [], { g: 'grp' }),
      n('c', 'debug', 'extra', 350, 180, [], { g: 'grp' }),
    ], groups: [{ id: 'grp', type: 'group', z: 't1', name: 'Clock', style: { label: true }, nodes: ['a', 'b', 'c'], x: 90, y: 60, w: 330, h: 160 }] }),
    check: (f) => {
      if (byId(f, 'c')) return 'debug_extra is still there';
      const grp = byId(f, 'grp');
      if (!grp) return 'the group was dropped';
      if (grp.nodes.indexOf('a') === -1 || grp.nodes.indexOf('b') === -1) return 'a node left the box';
      return null;
    },
  },
  {
    name: 'remove a connection through link nodes', mode: 'agent',
    prompt: '`inject_tick` から `debug_log` への接続を削除してください。`debug_other` には引き続き届くようにしてください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['lo']]),
      n('lo', 'link out', 'send', 300, 100, [], { mode: 'link', links: ['li'] }),
      n('li', 'link in', 'recv', 150, 220, [['b', 'c']], { links: ['lo'] }),
      n('b', 'debug', 'log', 350, 180, []),
      n('c', 'debug', 'other', 350, 260, []),
    ] }),
    check: (f) => {
      if (reached(f, 'a').has('b')) return 'inject still reaches debug_log';
      if (!reached(f, 'a').has('c')) return 'debug_other no longer receives';
      return kept(f, ['b', 'c']);
    },
  },
  {
    name: 'reuse an existing config node', mode: 'agent',
    prompt: 'Add an mqtt in node that subscribes to "sensors/temp" using the existing broker, and send its messages to `debug_log`.',
    canvas: () => {
      const c = TICK_LOG();
      c.configs = [{ id: 'br', type: 'mqtt-broker', name: 'local', broker: 'localhost', port: '1883' }];
      c.nodes.push(n('m0', 'mqtt out', 'status', 150, 200, [], { topic: 'status', broker: 'br' }));
      return c;
    },
    check: (f, ctx) => {
      const m = byType(f, 'mqtt in')[0];
      if (!m) return 'no mqtt in node';
      if (m.broker !== 'br') return 'broker is ' + JSON.stringify(m.broker);
      if (configCount(ctx.mock) !== 1) return 'a config node was invented';
      if (!reached(f, m.id).has('b')) return 'mqtt in does not reach debug_log';
      return null;
    },
  },
  {
    name: 'no config node to reuse', mode: 'agent', allowNoSchema: true,
    prompt: 'Add an mqtt out node after `inject_tick` that publishes to "alerts".',
    canvas: TICK_LOG,
    check: (f, ctx) => (configCount(ctx.mock) === 0 ? null : 'a config node was invented') || kept(f, ['a', 'b']),
  },

  // ---------------------------------------------------------------- //
  //  Other flows                                                       //
  // ---------------------------------------------------------------- //
  {
    name: 'edit nodes on both flows', mode: 'agent',
    prompt: 'Flow 1 と Flow 2 の debug ノードを両方とも無効にしてください。',
    tabs: ['t1', 't2'],
    canvas: () => ({ tabs: [TAB1, TAB2], nodes: [
      n('a1', 'inject', 'one', 150, 100, [['d1']]), n('d1', 'debug', 'one', 350, 100, []),
      Object.assign(n('a2', 'inject', 'two', 150, 100, [['d2']]), { z: 't2' }),
      Object.assign(n('d2', 'debug', 'two', 350, 100, []), { z: 't2' }),
    ] }),
    check: (f) => {
      const d1 = byId(f, 'd1'), d2 = byId(f, 'd2');
      if (!d1 || !d2) return kept(f, ['d1', 'd2']);
      if (d1.d !== true || d2.d !== true) return 'disabled: Flow 1 ' + !!d1.d + ', Flow 2 ' + !!d2.d;
      if (d1.z !== 't1' || d2.z !== 't2') return 'a debug moved flow';
      return null;
    },
  },
  {
    name: 'build on the second flow', mode: 'agent',
    prompt: 'On Flow 2, add an inject node that sends "hello" into a debug node. Do not change Flow 1.',
    tabs: ['t1', 't2'],
    canvas: () => ({ tabs: [TAB1, TAB2], nodes: TICK_LOG().nodes }),
    check: (f) => {
      const t2 = f.filter((x) => x.z === 't2');
      const inj = t2.find((x) => x.type === 'inject'), dbg = t2.find((x) => x.type === 'debug');
      if (!inj || !dbg) return 'Flow 2 has ' + t2.map((x) => x.type).join(', ');
      if (!reached(f, inj.id).has(dbg.id)) return 'not wired on Flow 2';
      if (f.filter((x) => x.z === 't1').length !== 2) return 'Flow 1 changed';
      return null;
    },
  },

  {
    name: 'add error handling', mode: 'agent',
    prompt: 'Add error handling to this tab: catch errors from any node and show them in a new debug node named "errors".',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['f']]),
      n('f', 'function', 'risky', 320, 100, [['b']], { func: 'return msg;', outputs: 1 }),
      n('b', 'debug', 'log', 480, 100, []),
    ] }),
    check: (f) => {
      const c = byType(f, 'catch')[0];
      if (!c) return 'no catch node';
      if (![...reached(f, c.id)].some((id) => byId(f, id).type === 'debug' && id !== 'b')) return 'catch does not reach a new debug';
      return kept(f, ['a', 'f', 'b']);
    },
  },
  {
    name: 'a request that names no node', mode: 'agent',
    prompt: 'Make it fire every 5 seconds instead.',
    canvas: TICK_LOG,
    check: (f) => {
      const a = byId(f, 'a');
      if (!a) return 'the inject was replaced';
      if (String(a.repeat) !== '5') return 'repeat is ' + JSON.stringify(a.repeat);
      return f.length === 2 ? null : 'nodes were added';
    },
  },
  {
    name: 'a template node', mode: 'agent',
    prompt: '`inject_tick` と `debug_log` の間に、msg.payload を「Time is {{payload}}」という文字列に整形する template ノードを入れてください。',
    canvas: TICK_LOG,
    check: (f) => {
      const t = byType(f, 'template')[0];
      if (!t) return 'no template node';
      if (!/\{\{\s*payload\s*\}\}/.test(String(t.template))) return 'template is ' + JSON.stringify(t.template);
      if (!reached(f, 'a').has(t.id) || !reached(f, t.id).has('b')) return 'the template is not in between';
      return null;
    },
  },
  {
    name: 'delete everything on the tab', mode: 'agent',
    prompt: 'このタブのノードをすべて削除してください。',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['f']]),
      n('f', 'function', 'fmt', 320, 100, [['b']], { func: 'return msg;', outputs: 1 }),
      n('b', 'debug', 'log', 480, 100, []),
    ] }),
    check: (f) => (f.length === 0 ? null : f.length + ' node(s) left'),
  },

  // ---------------------------------------------------------------- //
  //  Mode boundaries                                                   //
  // ---------------------------------------------------------------- //
  {
    name: 'agent asked only to explain', mode: 'agent', allowNoSchema: true,
    prompt: 'このフローが何をしているか説明してください。',
    canvas: TICK_LOG,
    check: (f, ctx) => {
      if (ctx.schema) return 'Agent proposed a change to a question';
      if (!ctx.reply || ctx.reply.trim().length < 20) return 'the answer is empty';
      return kept(f, ['a', 'b']);
    },
  },
  {
    name: 'ask: asked to change something', mode: 'ask',
    prompt: '`debug_log` を削除してください。',
    canvas: TICK_LOG,
    checkReply: (reply, schema) => {
      if (schema) return 'Ask proposed a flow';
      if (!reply || reply.trim().length < 10) return 'the answer is empty';
      return null;
    },
  },
  {
    name: 'ask: how to fire at startup', mode: 'ask',
    prompt: 'How can I make `inject_tick` fire once when Node-RED starts?',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 150, 100, [['b']], { repeat: '', once: false }),
      n('b', 'debug', 'log', 350, 100, []),
    ] }),
    checkReply: (reply, schema) => {
      if (schema) return 'Ask proposed a flow';
      if (!/once|起動|start/i.test(reply)) return 'the answer never mentions firing once at start';
      return null;
    },
  },
  {
    name: 'ask: where a message goes', mode: 'ask',
    prompt: 'msg.payload が 5 のとき、メッセージはどのノードに届きますか？',
    canvas: () => ({ tabs: [TAB1], nodes: [
      n('a', 'inject', 'tick', 100, 100, [['s']]),
      n('s', 'switch', 'level', 260, 100, [['h'], ['l']], { property: 'payload', rules: [{ t: 'gte', v: '10', vt: 'num' }, { t: 'else' }], outputs: 2 }),
      n('h', 'debug', 'high', 420, 60, []),
      n('l', 'debug', 'low', 420, 140, []),
    ] }),
    checkReply: (reply, schema) => {
      if (schema) return 'Ask proposed a flow';
      if (!/debug_low|\blow\b/i.test(reply)) return 'the answer does not name debug_low';
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
    groups: clone(canvas.groups || []), configs: clone(canvas.configs || []), activeId: 't1' });
  const P = loadPluginSandbox(mock.RED);
  const ids = sc.tabs || ['t1'];
  const context = canvas.nodes.length || (canvas.junctions || []).length
    ? P.UI.getFlowsByIds(ids, { includeCanvasExtras: true }) : null;
  const settings = core.getPluginSettings();
  const messages = core.buildMessages(sc.prompt, context, 't1', settings, { mode: sc.mode });
  const reply = await core.generateWithProvider('ollama', settings, model, messages, { timeoutMs: CONFIG.timeoutMs });
  const schema = P.LLMJsonParser.extractVibeSchema(reply, P.FlowConverterCore);
  if (sc.mode === 'ask') return { problem: sc.checkReply(reply, schema), reply };

  if (!schema && !sc.allowNoSchema) return { problem: 'no Vibe Schema in the reply', reply };
  if (schema) {
    const res = await P.Importer.importFlowFromMessage(reply, { mode: 'agent', allowedWorkspaceIds: ids });
    if (!res || !res.ok) return { problem: 'import failed: ' + (res && res.error), reply };
  }
  const flow = [].concat(...canvas.tabs.map((t) => mock.snapshot(t.id)));
  const broken = invariants(P, flow);
  if (broken.length) return { problem: 'invariant: ' + broken.slice(0, 3).join('; '), reply };
  return { problem: sc.check(flow, { mock, reply, schema }), reply };
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

  const table = {}, rates = {};
  let failed = 0;
  for (const model of CONFIG.models) {
    console.log('\n=== ' + model + ' ===');
    table[model] = {};
    rates[model] = { pass: 0, total: 0, lost: 0 };
    for (const sc of SCENARIOS.filter(selected)) {
      let result = null, tries = 0, passes = 0, lost = 0;
      const tryLimit = CONFIG.runs || CONFIG.attempts;
      for (tries = 1; tries <= tryLimit; tries++) {
        const started = Date.now();
        // A dropped connection or a timeout says nothing about the model:
        // try again rather than count it.
        for (let net = 0; ; net++) {
          try {
            result = await runOnce(core, model, sc);
          } catch (e) {
            result = { problem: 'error: ' + (e && e.message ? e.message : e), reply: '' };
          }
          if (!TRANSPORT.test(result.problem || '') || net >= 3) break;
          console.log('  [' + sc.name + '] transport error, retrying: ' + result.problem);
          await new Promise((res) => setTimeout(res, 15000));
        }
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log('  [' + sc.name + '] attempt ' + tries + ' (' + secs + 's): ' + (result.problem || 'ok'));
        if (result.problem && process.env.LLM_TEST_SHOW_FAILED) {
          console.log(String(result.reply).split('\n').map((l) => '      | ' + l).join('\n').slice(0, 3000));
        }
        if (!result.problem) passes++;
        // Still unreachable after the retries: no answer to judge.
        if (TRANSPORT.test(result.problem || '')) lost++;
        if (!result.problem && !CONFIG.runs) break;
      }
      if (CONFIG.runs) {
        const judged = CONFIG.runs - lost;
        table[model][sc.name] = passes + '/' + judged + (lost ? ' (' + lost + ' unanswered)' : '');
        rates[model].pass += passes;
        rates[model].total += judged;
        rates[model].lost += lost;
        if (passes < CONFIG.runs) failed++;
      } else {
        table[model][sc.name] = result.problem ? 'FAIL' : (tries === 1 ? 'ok' : 'ok (' + tries + ')');
        if (result.problem) failed++;
      }
    }
  }

  console.log('\n=== summary ===');
  const width = Math.max(...SCENARIOS.map((s) => s.name.length));
  console.log(' '.repeat(width) + '  ' + CONFIG.models.join('  |  '));
  SCENARIOS.filter((sc) => table[CONFIG.models[0]][sc.name]).forEach((sc) => {
    console.log(sc.name.padEnd(width) + '  ' + CONFIG.models.map((m) => table[m][sc.name].padEnd(m.length)).join('  |  '));
  });
  if (CONFIG.runs) {
    console.log('pass rate'.padEnd(width) + '  ' + CONFIG.models.map((m) =>
      (Math.round(1000 * rates[m].pass / rates[m].total) / 10 + '%').padEnd(m.length)).join('  |  '));
    console.log('unanswered'.padEnd(width) + '  ' + CONFIG.models.map((m) => String(rates[m].lost).padEnd(m.length)).join('  |  '));
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
