// Shared test scaffolding: the pass/fail counter, and the vm sandbox that
// runs the real client modules against a mocked editor.
//
// Each suite keeps its own `buildRED` — the registries and the state a
// scenario captures are the point of that suite.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// The editor's own load order (see src/client.js). Keeping it identical is
// deliberate: a load-time dependency that only holds in one order must fail
// here too, not only in production.
const CLIENT_MODULES = [
  'src/common.js',
  'src/core/canvas_layout.js',
  'src/core/flow_converter_core.js',
  'src/core/llm_json_parser.js',
  'src/chat_manager.js',
  'src/importer.js',
  'src/ui_core.js',
];

let assertions = 0, failures = 0;

function ok(cond, msg) {
  assertions++;
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// A thrown assert is a failure, not a crash.
function it(label, fn) {
  assertions++;
  try {
    fn();
    console.log('  ok  ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + label);
    console.log('       ' + (e && e.message ? e.message : e));
  }
}

function describe(label, fn) {
  console.log('\n' + label);
  fn();
}

// Call once, at the end.
function summary() {
  console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// The fenced block an LLM would emit.
function fence(obj) {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

// A FRESH context per scenario — the client modules hold singletons.
// → the sandbox's `window.LLMPlugin`
function loadPluginSandbox(RED) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    requestAnimationFrame: (cb) => cb(),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
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

module.exports = {
  ROOT,
  ok, assert, it, describe, summary,
  clone, fence, loadPluginSandbox,
};
