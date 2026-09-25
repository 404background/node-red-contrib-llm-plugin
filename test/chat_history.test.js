// Chat history: several chats go in one delete, behind one confirmation.
const { ok, summary, loadPluginSandbox, buildEditorMock } = require('./helpers.js');

function load(confirmAnswer) {
  const deleted = [];
  const questions = [];
  const mock = buildEditorMock({ tabs: [{ id: 'tab1', type: 'tab', label: 'Flow 1' }], nodes: [], activeId: 'tab1' });
  const P = loadPluginSandbox(mock.RED, {
    confirm: (q) => { questions.push(q); return confirmAnswer; },
    fetch: (url, opts) => {
      if (/chats\/delete/.test(url)) deleted.push(JSON.parse(opts.body).chatId);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    },
  });
  const ids = [];
  for (let i = 0; i < 3; i++) {
    P.ChatManager.startNewChat();
    P.ChatManager.addMessage('prompt ' + i, true);
    ids.push(P.ChatManager.getCurrentChatId());
  }
  return { P, ids, deleted, questions };
}

const run = (P, ids) => new Promise((resolve) => P.ChatManager.deleteChats(ids, resolve));

async function scenarioSeveralChatsGoInOneDelete() {
  console.log('Several chats are deleted together');
  const { P, ids, deleted, questions } = load(true);
  const ok1 = await run(P, [ids[0], ids[1]]);
  const left = Object.keys(P.ChatManager.getChatHistory());
  ok(ok1 === true, 'the delete reports success');
  ok(questions.length === 1 && /Delete 2 chats\?/.test(questions[0]),
    'behind one confirmation that says how many (' + questions.join(' | ') + ')');
  ok(deleted.length === 2 && deleted.indexOf(ids[0]) !== -1 && deleted.indexOf(ids[1]) !== -1,
    'each is deleted on the server (' + deleted.join(',') + ')');
  ok(left.indexOf(ids[0]) === -1 && left.indexOf(ids[1]) === -1 && left.indexOf(ids[2]) !== -1,
    'and only those leave the history');
}

async function scenarioAllIncludingTheOpenChat() {
  console.log('\nDeleting every chat, the open one included, starts a new chat');
  const { P, ids } = load(true);
  await run(P, ids.slice());
  const current = P.ChatManager.getCurrentChatId();
  ok(ids.indexOf(current) === -1, 'the open chat is replaced by a fresh one');
  ok(Object.keys(P.ChatManager.getChatHistory()).every((id) => ids.indexOf(id) === -1),
    'and none of the deleted chats remains');
}

async function scenarioCancelDeletesNothing() {
  console.log('\nCancelling deletes nothing');
  const { P, ids, deleted } = load(false);
  const res = await run(P, ids.slice());
  ok(res === false && deleted.length === 0, 'nothing reaches the server');
  ok(ids.every((id) => !!P.ChatManager.getChatHistory()[id]), 'and every chat is still there');
}

(async () => {
  await scenarioSeveralChatsGoInOneDelete();
  await scenarioAllIncludingTheOpenChat();
  await scenarioCancelDeletesNothing();
  summary();
})().catch((e) => { console.error(e); process.exit(1); });
