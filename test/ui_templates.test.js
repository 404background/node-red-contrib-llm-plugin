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
  const cloned = idsClonedBy(UI_CORE);
  ok(cloned.length >= 4,
    'ui_core.js clones templates at all (' + cloned.length + ' call sites)');
  const missing = cloned.filter((id) => !templates[id]);
  ok(missing.length === 0,
    'no cloned id is missing from the HTML (' + (missing.join(', ') || 'none missing') + ')');

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
  idsClonedBy(UI_CORE).forEach((id) => {
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
    ok(UI_CORE.indexOf("querySelector('." + cls + "')") !== -1,
      'and ui_core.js looks it up by that exact class');
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
  ok(/function cloneTemplate[\s\S]{0,400}throw new Error/.test(UI_CORE),
    'cloneTemplate throws when the template is absent');
  ok(UI_CORE.indexOf('} catch (e) {}\n            } else') === -1 &&
     !/\} catch \(e\) \{\}\s*\n\s*\}\s*\n\s*chatArea\.appendChild/.test(UI_CORE),
    'the flow-actions block no longer swallows every error bare');
  ok(/flow actions not rendered/.test(UI_CORE),
    'it logs what failed instead');
}

function run() {
  scenarioEveryClonedIdExists();
  scenarioTemplatesHaveOneRoot();
  scenarioSelectorsMatchTheMarkup();
  scenarioMovedStylesAreInTheStylesheet();
  scenarioMissingTemplateIsLoud();
  summary();
}

run();
