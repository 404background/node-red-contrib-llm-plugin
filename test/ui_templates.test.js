// The sidebar's markup lives in llm_plugin.html, and ui_core.js clones bits
// of it by id. That split is the point — markup reads as markup — but it puts
// the two halves in different files, where a rename on one side is invisible
// to the other until someone opens the sidebar and finds the Import button
// missing.
//
// So this suite checks the seam: every id ui_core.js clones exists, every
// template is a single well-formed root, and the classes the JS reaches for
// after cloning are actually in the markup it cloned.
//
// Deliberately no DOM library. jsdom resolves here today only because
// something else pulled it in; testing against an undeclared transitive
// dependency is how a suite starts failing on an unrelated `npm update`.
// These are textual facts about two files, and reading them as text is
// honest about what is being checked.
const fs = require('fs');
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

const HTML = fs.readFileSync(path.join(ROOT, 'llm_plugin.html'), 'utf8');
const UI_CORE = fs.readFileSync(path.join(ROOT, 'src', 'ui_core.js'), 'utf8');
const VIBE_UI = fs.readFileSync(path.join(ROOT, 'src', 'vibe_ui.js'), 'utf8');
const CHAT_MANAGER = fs.readFileSync(path.join(ROOT, 'src', 'chat_manager.js'), 'utf8');
const COMMON = fs.readFileSync(path.join(ROOT, 'src', 'common.js'), 'utf8');

// Every module that builds UI from a template has the same seam to check.
// cloneTemplate itself lives in common.js — it was copied into two files
// before a third needed it.
const CLONERS = [
  ['ui_core.js', UI_CORE],
];
const CSS = fs.readFileSync(path.join(ROOT, 'llm-plugin_styles.css'), 'utf8');
const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'client.js'), 'utf8');
const AGENT_APPLY = fs.readFileSync(path.join(ROOT, 'src', 'agent_apply.js'), 'utf8');
const NODE_JS = fs.readFileSync(path.join(ROOT, 'node', 'llm-request', 'llm-request.js'), 'utf8');
const NODE_HTML = fs.readFileSync(path.join(ROOT, 'node', 'llm-request', 'llm-request.html'), 'utf8');

// id -> inner markup, for every <script type="text/html"> block.
function readTemplates(html) {
  const out = {};
  const re = /<script\s+type="text\/html"\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out[m[1]] = m[2];
  return out;
}

const templates = readTemplates(HTML);

function idsClonedBy(src) {
  const out = [];
  const re = /cloneTemplate\(\s*'([^']+)'\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function idsFromTemplateHelper(src) {
  const out = [];
  const re = /fromTemplate\([^,]+,\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

function scenarioEveryClonedIdExists() {
  console.log('Every template the JS clones is present in llm_plugin.html');
  CLONERS.forEach(([name, src]) => {
    const cloned = idsClonedBy(src);
    ok(cloned.length > 0, name + ' clones templates (' + cloned.length + ' call sites)');
    const missing = cloned.filter((id) => !templates[id]);
    ok(missing.length === 0,
      name + ': no cloned id is missing from the HTML (' +
        (missing.join(', ') || 'none missing') + ')');
  });

  // vibe_ui.js builds the sidebar shell the same way, through its own helper.
  const shell = idsFromTemplateHelper(VIBE_UI);
  const shellMissing = shell.filter((id) => !templates[id]);
  ok(shellMissing.length === 0,
    'and neither is any sidebar shell template (' + (shellMissing.join(', ') || 'none missing') + ')');
}

// cloneTemplate returns `firstElementChild`, so anything after the first root
// element is silently dropped. A template that grew a second sibling would
// lose it with no error at all.
function scenarioTemplatesHaveOneRoot() {
  console.log('\nEach cloned template has exactly one root element');
  const everyId = [];
  CLONERS.forEach(([, src]) => idsClonedBy(src).forEach((id) => {
    if (everyId.indexOf(id) === -1) everyId.push(id);
  }));
  everyId.forEach((id) => {
    const inner = (templates[id] || '').trim();
    // Count top-level tags by tracking depth across the markup.
    let depth = 0;
    let roots = 0;
    const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g;
    let m;
    while ((m = tag.exec(inner)) !== null) {
      const closing = m[1] === '/';
      const selfClosing = /\/\s*$/.test(m[3]) || /^(br|hr|img|input|meta|link)$/i.test(m[2]);
      if (closing) { depth--; continue; }
      if (depth === 0) roots++;
      if (!selfClosing) depth++;
    }
    ok(roots === 1, id + ' has a single root element (found ' + roots + ')');
  });
}

// The half a rename actually breaks: JS reaching into cloned markup by class.
function scenarioSelectorsMatchTheMarkup() {
  console.log('\nThe classes the JS reaches for exist in the markup it cloned');
  const cases = [
    ['llm-plugin-message-actions-template', 'retry-btn', 'the retry click handler'],
    ['llm-plugin-flow-actions-template', 'import-btn', 'the import click handler'],
  ];
  cases.forEach(([id, cls, why]) => {
    const inner = templates[id] || '';
    ok(inner.indexOf('class="' + cls + '"') !== -1 ||
       new RegExp('class="[^"]*\\b' + cls + '\\b[^"]*"').test(inner),
      id + ' contains .' + cls + ' — ' + why + ' binds to it');
    const usedSomewhere = CLONERS.some(([, src]) =>
      src.indexOf("querySelector('." + cls + "')") !== -1 ||
      src.indexOf("querySelectorAll('." + cls + "')") !== -1);
    ok(usedSomewhere, 'and the JS looks it up by that exact class');
  });

  // The restore button is cloned whole rather than looked up, and the code
  // sets .dataset.checkpointId on it, so it must BE the button.
  const restore = (templates['llm-plugin-restore-btn-template'] || '').trim();
  ok(/^<button\b/.test(restore),
    'the restore template is the button itself, not a wrapper (' +
      restore.slice(0, 30) + ')');
  ok(/class="[^"]*\brestore-btn\b/.test(restore),
    'and carries .restore-btn, which the message queries to replace it');
}

// The reason cloneTemplate is allowed to throw: it cannot be reached unless
// llm_plugin.html loaded, so a missing template is a packaging bug, not a
// runtime state to degrade around.
function scenarioMissingTemplateIsLoud() {
  console.log('\nA missing template fails loudly rather than silently');
  ok(/Common\.cloneTemplate = function[\s\S]{0,500}throw new Error/.test(COMMON),
    'cloneTemplate throws when the template is absent');
  ok(!/function cloneTemplate\(/.test(UI_CORE) && !/function cloneTemplate\(/.test(CHAT_MANAGER),
    'and there is only the one definition, in common.js');
  ok(/flow actions not rendered/.test(UI_CORE),
    'it logs what failed instead');
}

// The way out of the sidebar to the documentation. It is one static link, so
// what can rot is the icon (an FA5-only name renders as an empty box) and the
// rel that keeps the opened tab from reaching back into the editor.
function scenarioDocsLinkIsWired() {
  console.log('\nThe sidebar links out to the documentation');
  const shell = templates['llm-plugin-sidebar-template'] || '';
  const link = /<a[^>]*class="header-link"[^>]*>/.exec(shell);
  ok(!!link, 'the header has the docs link');
  const tag = link ? link[0] : '';
  ok(/href="https:\/\/github\.com\/[^"]+#readme"/.test(tag),
    'pointing at the README on GitHub');
  ok(/target="_blank"/.test(tag) && /rel="noopener"/.test(tag),
    'opening in a new tab without handing it a window reference');
  // fa-github is Font Awesome 4.7, which is what the editor bundles.
  ok(/fa-github/.test(shell), 'using an icon that exists in FA 4.7');
  ok(CSS.indexOf('.header-link {') !== -1, 'and the link has a stylesheet rule');
}

// The llm-request node is meant to be a thin caller of the plugin: the runtime
// half publishes a reply, and the PLUGIN applies it. The seam between them is
// a comms topic spelled out in two files, and the node's html is where editor
// logic creeps back in.
function scenarioNodeLeansOnThePlugin() {
  console.log('\nThe llm-request node stays a thin caller of the plugin');
  const topicOf = (src) => (/'(llm-plugin\/agent-apply)'/.exec(src) || [])[1];
  ok(!!topicOf(NODE_JS) && topicOf(NODE_JS) === topicOf(AGENT_APPLY),
    'the node publishes on the topic the plugin subscribes to');
  ok(!/LLMPlugin/.test(NODE_HTML) && !/RED\.comms/.test(NODE_HTML),
    'and its html holds no plugin logic of its own');
  // agent_apply.js applies the moment a reply arrives, so it has to load
  // after the modules it reaches for.
  const order = (f) => CLIENT.indexOf('src/' + f);
  ['chat_manager.js', 'importer.js'].forEach((dep) => {
    ok(order(dep) !== -1 && order(dep) < order('agent_apply.js'),
      'client.js loads ' + dep + ' before agent_apply.js');
  });
}

// A help panel nobody reads documents nothing. What a user needs at the node
// is what to wire and what it costs; the rest belongs in docs/, one link away.
function scenarioNodeHelpStaysShort() {
  console.log('\nThe node help says what the node needs, and links out for the rest');
  const help = (/<script[^>]*data-help-name="llm-request">([\s\S]*?)<\/script>/.exec(NODE_HTML) || [])[1] || '';
  ok(help.length > 0, 'the node has a help panel');
  ok(help.length < 3000, 'that is still short enough to read (' + help.length + ' chars)');
  ok(/github\.com\/[^"]*docs\/en\/llm-request\.md/.test(help),
    'and points at the full documentation on GitHub');
}

// Enter sends. That makes the IME guard load-bearing for anyone typing
// Japanese, Chinese or Korean: the Enter that closes a conversion is the same
// keydown, so without `isComposing` every confirmed phrase sends the message
// mid-sentence. It is one condition, it looks redundant, and it is exactly
// the kind of thing a refactor drops — hence a test.
function scenarioPromptKeysAreWired() {
  console.log('\nEnter sends, Shift+Enter is a newline, Esc stops');
  const handler = (/promptInput\.addEventListener\('keydown',([\s\S]*?)\n        \}\);/
    .exec(VIBE_UI) || [])[1] || '';

  ok(handler.length > 0, 'the prompt box has a keydown handler');
  ok(/e\.key[^\n]*'Enter'/.test(handler) && /handleGenerate\(\)/.test(handler),
    'Enter is what sends');
  ok(/e\.shiftKey/.test(handler), 'Shift+Enter is let through as a newline');
  ok(/e\.isComposing/.test(handler) && /keyCode === 229/.test(handler),
    'an Enter closing an IME conversion is not a send');
  ok(/e\.preventDefault\(\)/.test(handler),
    'and the send does not also type a newline into the box');
  ok(/e\.key === 'Escape'/.test(handler) && /stopGeneration\(\)/.test(handler),
    'Esc stops a running request');
  ok(/function stopGeneration\(\)/.test(VIBE_UI) &&
     VIBE_UI.split('stopGeneration()').length - 1 >= 3,
    'which is the same stop the button does, not a second copy of it');
}

// Restore and Apply Again are one control in two halves: rewind to the flow
// that was there, or put the model's proposal back. In Agent mode the Import
// button below the message is hidden, so losing Apply Again would leave a
// rewound proposal with no way back.
function scenarioRestoreAndReapplyArePaired() {
  console.log('\nRestore and Apply Again are rendered together');
  const templates = readTemplates(HTML);
  ok(!!templates['llm-plugin-reapply-btn-template'], 'the Apply Again button has a template');
  ok(/class="reapply-btn"/.test(templates['llm-plugin-reapply-btn-template'] || ''),
    'carrying the class the JS reaches for');
  ok(CSS.indexOf('.reapply-btn {') !== -1, 'and the button has a stylesheet rule');

  const pair = (/function showPostImportActions\(([\s\S]*?)\n    \}/.exec(UI_CORE) || [])[1] || '';
  ok(/placeRestoreAboveThePrompt\(/.test(pair) && /placeReapplyOnTheSchema\(/.test(pair),
    'one function places both, so neither can be shown without the other');
  ok(/runImport\(message, content, messageMeta\)/.test(UI_CORE.slice(UI_CORE.indexOf('function createReapplyButton'))),
    'Apply Again runs the same import as Import');

  // Restore rewinds everything the prompt led to, so it belongs above the
  // prompt — which means it is inserted among the message's NEIGHBOURS, not
  // inside it, and only once the message is in the chat.
  const restorePlacer = (/function placeRestoreAboveThePrompt\(([\s\S]*?)\n    \}/
    .exec(UI_CORE) || [])[1] || '';
  ok(/promptAbove\(message\)/.test(restorePlacer), 'it looks up the prompt above the reply');
  ok(/parent\.insertBefore\(bar, anchor\)/.test(restorePlacer), 'and inserts the bar before it');
  ok(/data-restore-for="/.test(restorePlacer) && /\.remove\(\)/.test(restorePlacer),
    'the bar this reply left last time is removed first, so applies do not stack');
  ok(/chatArea\.appendChild\(message\);[\s\S]{0,400}appendFlowActions\(/.test(UI_CORE),
    'and the actions run after the message joins the chat, or it has no neighbours');

  // Apply Again rides on the schema block, so the control sits with what it
  // applies. Inside a <summary> a plain click is the disclosure toggle.
  const reapplyPlacer = (/function placeReapplyOnTheSchema\(([\s\S]*?)\n    \}/
    .exec(UI_CORE) || [])[1] || '';
  ok(/json-collapsible\[data-vibe-schema\] > summary/.test(reapplyPlacer),
    'it hangs off the Vibe Schema block header');
  ok(/dataset\.vibeSchema = 'true'/.test(UI_CORE), 'which the fold marks as it builds the block');
  ok(/e\.stopPropagation\(\)/.test(UI_CORE) && /e\.preventDefault\(\)/.test(UI_CORE),
    'and the click does not toggle the block open');
  ok(CSS.indexOf('.json-collapsible > summary .reapply-btn') !== -1,
    'the button has a rule for sitting in that header');

  // Two buttons, one choice: they read as a pair only while they look alike,
  // and `.flow-actions button` colours the Restore bar without ever reaching
  // Apply Again in its <summary>. So the pair's colour is declared once, for
  // both selectors at once — a value each could drift from is the bug.
  ok(/\.pre-chat-actions \.restore-btn,\s*\n\.reapply-btn \{[^}]*background:/.test(CSS),
    'Restore and Apply Again take their colour from one rule');
  ok(/\.pre-chat-actions \.restore-btn:hover,\s*\n\.reapply-btn:hover \{/.test(CSS),
    'and their hover state from one too');
  ok(CSS.indexOf('.pre-chat-actions {') !== -1 &&
     /\.pre-chat-actions \{[^}]*text-align: right/.test(CSS),
    'and the Restore bar sits on the prompt\'s side of the chat');

  // Expanding the block must not reflow the header the button sits on.
  ok(/classList\.add\('has-json-block'\)/.test(UI_CORE),
    'a bubble holding a JSON block is marked as such');
  ok(/\.message-content\.has-json-block \{[^}]*width: 100%/.test(CSS),
    'and takes the width it will need open, so the folded header is as wide');
}

// Retry is two ordinary things in order — rewind, then ask again — and the
// asking has to be the SAME path a typed prompt takes, or everything that
// follows a reply (the apply, its checkpoint, its Restore / Apply Again) has
// to be reimplemented for it. It used to poke the textarea and click Send.
function scenarioRetryReusesTheSendPath() {
  console.log('\nRetry rewinds, then sends the prompt the ordinary way');
  ok(/LLMPlugin\.sendPrompt = function/.test(VIBE_UI),
    'vibe_ui publishes the Send path it uses itself');
  ok(/function handleGenerate\(promptOverride\)/.test(VIBE_UI),
    'which takes the prompt to send, rather than reading the box');

  const retry = (/UI\.retryLastUserMessage = function\(([\s\S]*?)\n    \};/.exec(UI_CORE) || [])[1] || '';
  ok(retry.length > 0, 'the retry handler is there');
  ok(/restoreCheckpoint\(checkpointId\)/.test(retry) && /send\(prompt\)/.test(retry),
    'it restores the checkpoint, then sends');
  ok(!/generateBtn|getElementById/.test(retry),
    'without clicking the button or reaching for the DOM');
  ok(/promptForReply\(messageMeta\)/.test(retry),
    'and re-asks the prompt THIS reply answered, not merely the newest one');
  ok(/\.catch\(/.test(retry) && retry.indexOf('.then(function() { send(prompt); })') !== -1,
    'a failed rewind still asks, against the flow as it stands');
}

// The answer is only useful if the user can get from it to the node it is
// about, and that holds for BOTH modes: Ask names the node at fault, Agent
// names the ones it built. So the annotation must not be one of the things
// the sidebar does differently per mode — and both prompts have to ask for
// the backticked alias it keys off.
function scenarioNodeLinksAreModeIndependent() {
  console.log('\nNode names in a reply link to the canvas, whichever mode asked');
  const render = (/if \(!isUser\) \{([\s\S]*?)\n        \}/.exec(UI_CORE) || [])[1] || '';
  ok(/annotateNodeReferences\(messageContent, targetFlowIds\)/.test(render),
    'every assistant reply is annotated as it is rendered');
  ok(!/'agent'|'ask'/.test(render),
    'and nothing in that path asks which mode produced it');
  ok(/reannotateAllAssistantMessages/.test(UI_CORE) &&
     /assistant-message/.test(UI_CORE),
    'the refresh pass covers assistant messages as a class, not a mode');
  ok(CSS.indexOf('.llm-node-ref') !== -1, 'and the links have a stylesheet rule');

  const prompts = ['prompt_system.txt', 'prompt_ask.txt'].map((f) =>
    fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
  prompts.forEach((p, i) => {
    ok(/backticks/.test(p) && /alias/.test(p),
      ['the Agent prompt', 'the Ask prompt'][i] + ' asks for the alias in backticks');
  });
}

// Mode and model are one setting read two ways — which engine, asked how — so
// they share a row. The sidebar is a panel the user can drag narrow, which is
// why the row wraps rather than squeezing the model name into nothing.
function scenarioModeAndModelShareARow() {
  console.log('\nMode and model sit on one row that wraps');
  const shell = templates['llm-plugin-sidebar-template'] || '';
  const row = (/<div class="session-row">([\s\S]*?)<\/div>\s*<\/details>/.exec(shell) || [])[1] || '';
  ok(row.indexOf('id="llm-plugin-mode"') !== -1 && row.indexOf('id="llm-plugin-model"') !== -1,
    'both controls are inside the same row');
  ok(/\.session-row \{[^}]*display: flex/.test(CSS), 'the row is a flex row');
  ok(/\.session-row \{[^}]*flex-wrap: wrap/.test(CSS),
    'that wraps instead of squeezing the model name');
  ok(/\.session-row \.model-input \{[^}]*flex: 1 1/.test(CSS),
    'and the model input is the half that gives, since its text is the long one');
  ok(/\.session-row \.mode-select \{[^}]*width: auto/.test(CSS),
    'the mode select is as wide as its options, not the editor\'s 220px');
}

function scenarioThePluginRaisesNoNotifications() {
  console.log('\nThe plugin raises no editor notifications; warnings go in the chat');
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(dir + '/' + e.name)
      : (/\.(js|html)$/.test(e.name) ? [[dir + '/' + e.name, fs.readFileSync(path.join(ROOT, dir, e.name), 'utf8')]] : []));
  const files = walk('src').concat(walk('node')).concat([['llm_plugin.html', HTML]]);
  const callers = files.filter(([, text]) => /RED\.notify\s*\(/.test(text)).map(([name]) => name);
  ok(callers.length === 0, 'nothing calls RED.notify (' + callers.join(', ') + ')');
  ok(/Common\.notice = function/.test(COMMON) && /llm-plugin-chat/.test(COMMON),
    'Common.notice writes into the chat');
  ok(/\.llm-plugin-notice \{/.test(CSS), 'and the line has a stylesheet rule');
}

function run() {
  scenarioEveryClonedIdExists();
  scenarioTemplatesHaveOneRoot();
  scenarioSelectorsMatchTheMarkup();
  scenarioMissingTemplateIsLoud();
  scenarioDocsLinkIsWired();
  scenarioNodeLeansOnThePlugin();
  scenarioNodeHelpStaysShort();
  scenarioPromptKeysAreWired();
  scenarioRestoreAndReapplyArePaired();
  scenarioRetryReusesTheSendPath();
  scenarioNodeLinksAreModeIndependent();
  scenarioModeAndModelShareARow();
  scenarioThePluginRaisesNoNotifications();
  summary();
}

run();
