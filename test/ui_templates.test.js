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
  ['chat_manager.js', CHAT_MANAGER],
  ['vibe_ui.js', VIBE_UI],
];
const CSS = fs.readFileSync(path.join(ROOT, 'llm-plugin_styles.css'), 'utf8');

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
    ['llm-plugin-checkpoint-modal-template', 'checkpoint-list', 'the restore-point rows'],
    ['llm-plugin-checkpoint-modal-template', 'close-btn', 'the dialog close handler'],
    ['llm-plugin-checkpoint-item-template', 'checkpoint-source', 'the source badge'],
    ['llm-plugin-checkpoint-item-template', 'checkpoint-what', 'the description line'],
    ['llm-plugin-checkpoint-item-template', 'restore-btn', 'the restore click handler'],
    ['llm-plugin-queue-item-template', 'llm-queue-source', 'the producer badge'],
    ['llm-plugin-queue-item-template', 'llm-queue-label', 'the request description'],
    ['llm-plugin-queue-item-template', 'llm-queue-why', 'the reason it is waiting'],
    ['llm-plugin-queue-item-template', 'llm-queue-cancel', 'the cancel handler'],
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

// These moved out of JS (`el.style.marginTop = '0'`, duplicated at two call
// sites) and into the stylesheet. If the rule went missing the button row
// would still render, just in the wrong place — the kind of thing no
// assertion elsewhere would notice.
function scenarioMovedStylesAreInTheStylesheet() {
  console.log('\nThe styles that moved out of JS are in the stylesheet');
  ok(/\.pre-chat-actions\s*\{[^}]*margin-bottom:\s*10px/.test(CSS),
    '.pre-chat-actions carries its own spacing');
  ok(UI_CORE.indexOf("style.marginBottom") === -1,
    'and ui_core.js no longer sets that margin inline');
  ok(/\.retry-btn i\.fa-refresh\s*\{[^}]*color:/.test(CSS),
    'the retry icon colour is a CSS rule');
  ok(UI_CORE.indexOf("retryIcon.style.color") === -1,
    'and is not also assigned in JS');
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
  ok(UI_CORE.indexOf('} catch (e) {}\n            } else') === -1 &&
     !/\} catch \(e\) \{\}\s*\n\s*\}\s*\n\s*chatArea\.appendChild/.test(UI_CORE),
    'the flow-actions block no longer swallows every error bare');
  ok(/flow actions not rendered/.test(UI_CORE),
    'it logs what failed instead');
}

// The dialog is only reachable through a header button, and the button is
// markup while the handler is JS — the same split, one more seam.
function scenarioRestorePointsButtonIsWired() {
  console.log('\nThe restore-points button and its handler agree');
  const shell = templates['llm-plugin-sidebar-template'] || '';
  ok(/data-action="restore-points"/.test(shell),
    'the sidebar template has the button');
  ok(VIBE_UI.indexOf('[data-action="restore-points"]') !== -1,
    'and vibe_ui.js binds that exact action');
  ok(/showCheckpointList/.test(VIBE_UI) && /ChatManager\.showCheckpointList = function/.test(CHAT_MANAGER),
    'to a handler ChatManager actually defines');
  // fa-history exists in Font Awesome 4.7, which is what the editor bundles;
  // an FA5-only icon renders as an empty box with no error.
  ok(/fa-history/.test(shell), 'using an icon that exists in FA 4.7');
}

// The queue panel is markup in the sidebar template and behaviour in
// vibe_ui.js. It is the only sign that a request is waiting rather than
// lost, so a broken seam here reads as "the plugin stopped responding".
function scenarioQueuePanelIsWired() {
  console.log('\nThe queue panel markup and its handlers agree');
  const shell = templates['llm-plugin-sidebar-template'] || '';
  ok(/id="llm-plugin-queue-panel"/.test(shell), 'the sidebar has the panel');
  ok(/id="llm-plugin-queue-list"/.test(shell), 'and the list it renders into');
  ok(/class="llm-queue-release"/.test(shell), 'and the release control');
  ['#llm-plugin-queue-panel', '#llm-plugin-queue-list', '.llm-queue-release'].forEach((sel) => {
    ok(VIBE_UI.indexOf("querySelector('" + sel + "')") !== -1,
      'vibe_ui.js looks up ' + sel);
  });
  // Hidden via the `hidden` attribute, so an idle panel takes no space and
  // the prompt below it does not shift when the queue empties.
  ok(shell.indexOf('hidden>') !== -1 && VIBE_UI.indexOf('panel.hidden =') !== -1,
    'and hides it with the hidden attribute rather than a style toggle');
  ok(CSS.indexOf('.llm-queue-panel {') !== -1, 'the panel has a stylesheet rule');
}

function run() {
  scenarioEveryClonedIdExists();
  scenarioTemplatesHaveOneRoot();
  scenarioSelectorsMatchTheMarkup();
  scenarioMovedStylesAreInTheStylesheet();
  scenarioMissingTemplateIsLoud();
  scenarioRestorePointsButtonIsWired();
  scenarioQueuePanelIsWired();
  summary();
}

run();
