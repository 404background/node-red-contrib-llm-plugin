// Which flows the sidebar sends as context: kept across a restart and with
// the chat, the open flow for a new chat. Driven in jsdom through the editor's
// own start-up order — tabs added one by one, then `flows:loaded`.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { ok, summary, ROOT, CLIENT_MODULES } = require('./helpers.js');

const TABS = [{ id: 't1', type: 'tab', label: 'Flow 1' }, { id: 't2', type: 'tab', label: 'Flow 2' },
  { id: 't3', type: 'tab', label: 'Flow 3' }];

// An editor that has not loaded its flows yet. `saved`: the last session's
// selection in localStorage; `chats`: what the server holds.
function editor(saved, chats) {
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const w = dom.window;
  if (saved) w.localStorage.setItem('llm-plugin-selected-flows', JSON.stringify(saved));
  w.document.body.innerHTML = fs.readFileSync(path.join(ROOT, 'llm_plugin.html'), 'utf8');
  const tabs = [], handlers = {};
  let active = 0;
  w.RED = {
    events: {
      on: (e, fn) => { (handlers[e] = handlers[e] || []).push(fn); },
      emit: (e, arg) => (handlers[e] || []).forEach((fn) => fn(arg)),
    },
    sidebar: { addTab: (t) => w.document.body.appendChild(t.content) },
    workspaces: { active: () => active, count: () => tabs.length, show() {} },
    nodes: {
      eachWorkspace: (fn) => tabs.forEach(fn),
      workspace: (id) => tabs.find((t) => t.id === id) || null,
      getType: () => null, node: () => null, eachConfig() {}, eachNode() {},
      filterNodes: () => [], junctions: () => [], groups: () => [], createExportableNodeSet: (n) => n,
    },
    settings: { get: () => null },
    view: { redraw() {}, reveal() {} },
  };
  w.createLLMPluginSettings = () => ({ load() {}, save: () => ({}) });
  w.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(
    /chats$/.test(url) ? { chatHistories: chats || {} } : {}) });
  CLIENT_MODULES.concat(['src/vibe_ui.js']).forEach((m) => w.eval(fs.readFileSync(path.join(ROOT, m), 'utf8')));
  return {
    w,
    // The editor's own order: each tab arrives with a `flows:add`, then the
    // open tab is shown and `flows:loaded` fires.
    load(activeId) {
      TABS.forEach((t) => { tabs.push(t); w.RED.events.emit('flows:add', t); });
      active = activeId;
      w.RED.events.emit('flows:loaded');
    },
    selected: () => JSON.parse(w.localStorage.getItem('llm-plugin-selected-flows') || '[]').sort().join(','),
    label: () => w.document.getElementById('llm-plugin-flow-label').textContent,
  };
}
// The sidebar wires itself up 100 ms after it is built.
const settle = () => new Promise((r) => setTimeout(r, 250));

(async () => {
  console.log('A restart keeps the flows that were selected');
  let e = editor(['t2', 't3']);
  await settle();
  e.load('t1');
  ok(e.selected() === 't2,t3', 'tabs arriving one by one do not prune the saved selection (' + e.selected() + ')');
  ok(/Flow 2/.test(e.label()) && /Flow 3/.test(e.label()), 'and the label names them (' + e.label() + ')');

  console.log('\nThe latest chat brings back its own flows');
  e = editor(['t1'], { c1: { id: 'c1', created: '2026-09-27T00:00:00Z', flowIds: ['t3'], messages: [{ id: 'm', content: 'hi', isUser: true }] } });
  await settle();
  e.load('t1');
  ok(e.selected() === 't3', 'the chat opened on start restores what it was working on (' + e.selected() + ')');

  console.log('\nWith nothing saved, the open flow');
  e = editor(null);
  await settle();
  ok(e.selected() === '', 'nothing is chosen before the flows are loaded');
  e.load('t2');
  ok(e.selected() === 't2', 'then the open flow (' + e.selected() + ')');

  console.log('\nA new chat takes the open flow');
  e = editor(['t1', 't3']);
  await settle();
  e.load('t2');
  e.w.LLMPlugin.ChatManager.startNewChat();
  ok(e.selected() === 't2', 'only the open flow (' + e.selected() + ')');

  console.log('\nA saved flow that was deleted is dropped once the flows are loaded');
  e = editor(['t9']);
  await settle();
  e.load('t1');
  ok(e.selected() === 't1', 'a selection left with nothing becomes the open flow (' + e.selected() + ')');

  summary();
})().catch((err) => { console.error(err); process.exit(1); });
