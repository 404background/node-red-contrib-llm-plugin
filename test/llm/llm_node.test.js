// The llm-request node against a real Ollama: msg.payload in, the reply out.
// Not part of `npm test`; run by `npm run test:llm` (see llm_args.js for the
// flags). Endpoint and model: llm-test-config.json, overridden by
// --url / --model (LLM_TEST_URL / LLM_TEST_MODEL).
//
// What the node promises, each against a real model: a reply on msg.payload,
// the other msg properties untouched, msg.llm filled in, the node's system
// prompt followed and msg.system overriding it, an object payload sent as
// JSON, msg.model and msg.timeout honoured, a blank payload refused before
// any request.
//
// Exit codes: 0 = passed, 1 = failed, 2 = skipped (endpoint or model absent).
const fs = require('fs');
const os = require('os');
const path = require('path');
require('./llm_args.js').applyArgs(process.argv.slice(2));

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = (function() {
  const cfg = { ollamaUrl: 'http://localhost:11434', model: 'gemma3:4b' };
  const file = path.join(__dirname, 'llm-test-config.json');
  if (fs.existsSync(file)) Object.assign(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  if (process.env.LLM_TEST_URL) cfg.ollamaUrl = process.env.LLM_TEST_URL;
  if (process.env.LLM_TEST_MODEL) cfg.model = process.env.LLM_TEST_MODEL;
  return cfg;
})();

let passed = 0, failed = 0;
function ok(cond, msg) {
  console.log((cond ? '  ok  ' : '  FAIL ') + msg);
  if (cond) passed++; else failed++;
}

// The node needs createNode / on / status; llm_core needs settings + log.
const statuses = [];
const store = {};
const RED = {
  settings: {
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'llm-node-')),
    get: (k) => store[k], set: (k, v) => { store[k] = v; return Promise.resolve(); },
  },
  log: { info() {}, warn() {}, error() {} },
  nodes: {
    createNode(node) {
      node.handlers = {};
      node.on = (ev, fn) => { node.handlers[ev] = fn; };
      node.status = (s) => statuses.push(s);
      node.warn = () => {};
      node.error = () => {};
      node.id = 'live';
    },
    registerType(name, ctor) { this._ctor = ctor; },
  },
};

function send(config, msg) {
  const node = {};
  RED.nodes._ctor.call(node, config);
  const started = Date.now();
  return new Promise((resolve) => {
    let out = null;
    node.handlers.input.call(node, msg, (m) => { out = m; }, (err) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (out) console.log('       ' + secs + 's: ' + JSON.stringify(String(out.payload).slice(0, 120)));
      resolve({ out, err });
    });
  });
}

(async () => {
  console.log('  endpoint : ' + CONFIG.ollamaUrl);
  console.log('  model    : ' + CONFIG.model);
  let tags;
  try {
    tags = await (await fetch(CONFIG.ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(15000) })).json();
  } catch (e) {
    console.log('SKIP: cannot reach ' + CONFIG.ollamaUrl);
    process.exit(2);
  }
  if (!(tags.models || []).some((m) => m.name === CONFIG.model)) {
    console.log('SKIP: not installed: ' + CONFIG.model);
    process.exit(2);
  }

  const core = require(path.join(ROOT, 'src', 'llm_core.js'))(RED);
  await core.savePluginSettings({ provider: 'ollama', ollamaUrl: CONFIG.ollamaUrl });
  require(path.join(ROOT, 'node', 'llm-request', 'llm-request.js'))(RED);
  const base = { provider: 'ollama', model: CONFIG.model, systemPrompt: '', timeout: 1800 };

  console.log('\nA plain prompt');
  let r = await send(base, { payload: 'What is 2 + 3? Answer with the number only.', topic: 'keep' });
  ok(!r.err && typeof r.out.payload === 'string' && /5/.test(r.out.payload), 'the reply is on msg.payload');
  ok(r.out && r.out.topic === 'keep', 'the other msg properties pass through');
  ok(r.out && r.out.llm && r.out.llm.provider === 'ollama' && r.out.llm.model === CONFIG.model && r.out.llm.elapsed > 0,
    'msg.llm names the provider, the model and the elapsed time');
  ok(statuses.length && statuses[statuses.length - 1].fill === 'green', 'the status ends green');

  console.log('\nThe system prompt');
  r = await send(Object.assign({}, base, { systemPrompt: 'Translate the user\'s text into Japanese. Reply with the translation only.' }),
    { payload: 'Good morning.' });
  ok(!r.err && /[぀-ヿ一-鿿]/.test(r.out.payload), 'the node\'s system prompt is followed');
  r = await send(Object.assign({}, base, { systemPrompt: 'Translate into Japanese.' }),
    { payload: 'Good morning.', system: 'Reply only with the word PINEAPPLE, whatever the user says.' });
  ok(!r.err && /pineapple/i.test(r.out.payload), 'msg.system overrides it');

  console.log('\nThe payload and the overrides');
  r = await send(base, { payload: { city: 'Tokyo', question: 'Which country is this city in? One word.' } });
  ok(!r.err && /japan/i.test(r.out.payload), 'an object payload is sent as JSON and answered');
  r = await send(base, { payload: 'hi', model: 'no-such-model:0b' });
  ok(r.err && /no-such-model|not found/i.test(r.err.message), 'msg.model is the model asked for');
  r = await send(base, { payload: 'Write a long essay about the sea.', timeout: 1 });
  ok(r.err && r.err.code === 'ETIMEDOUT' && statuses[statuses.length - 1].text === 'timeout',
    'msg.timeout bounds the request, and the status says timeout');
  r = await send(base, { payload: '   ' });
  ok(r.err && /empty/.test(r.err.message), 'a blank payload is refused without a request');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
