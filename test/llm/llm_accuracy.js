// How well each model on each Ollama server does the sidebar's job: runs
// llm_scenarios.test.js with `runs` per scenario for every model a server
// has, and records the pass rate. Not part of `npm test`; run with
//
//     npm run test:llm:accuracy [-- --server <a[,b]> --model <a[,b]> --runs <n>]
//
// Servers come from the git-ignored llm-test-config.json (see the example):
//
//     "accuracy": { "runs": 3, "servers": [
//         { "name": "gpu-box", "url": "http://<host>:11434" },
//         { "name": "slow-box", "url": "http://<host>:11434", "runs": 1, "skip": ["llama3.2-vision:latest"] } ] }
//
// Results go to results/ next to this file (git-ignored like the config:
// they name the servers): the raw log of every run, accuracy.json (every run,
// appended) and accuracy.md (the latest run of each server and model).
// Servers run in parallel, the models on one server one after another — two
// models at once on one server only swap each other out.

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const DIR = __dirname;
const RESULTS = path.join(DIR, 'results');
const HISTORY = path.join(RESULTS, 'accuracy.json');
const REPORT = path.join(RESULTS, 'accuracy.md');
const USAGE = 'usage: npm run test:llm:accuracy -- [--server <a[,b]>] [--model <a[,b]>] [--runs <n>]';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag === '--help' || flag === '-h') { console.log(USAGE); process.exit(0); }
    const value = inline !== undefined ? inline : argv[++i];
    const list = () => String(value).split(',').map((s) => s.trim()).filter(Boolean);
    if (flag === '--server' && value) out.servers = list();
    else if (flag === '--model' && value) out.models = list();
    else if (flag === '--runs' && parseInt(value, 10) > 0) out.runs = parseInt(value, 10);
    else { console.error('unknown or incomplete argument: ' + argv[i] + '\n' + USAGE); process.exit(1); }
  }
  return out;
}

function config() {
  const file = path.join(DIR, 'llm-test-config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const acc = cfg.accuracy || {};
  if (!Array.isArray(acc.servers) || !acc.servers.length) {
    console.log('SKIP: no servers - add "accuracy": { "servers": [{ "name", "url" }] } to ' +
      path.relative(process.cwd(), file) + ' (see llm-test-config.example.json)');
    process.exit(2);
  }
  return acc;
}

// Chat models only: a cloud model does not run on the server, and an
// embedding model cannot answer.
function usable(name) {
  return !/[:-]cloud$/.test(name) && !/embed/i.test(name);
}

async function getJson(url) {
  return (await fetch(url, { signal: AbortSignal.timeout(15000) })).json();
}

// A model that cannot load fails every scenario the same way; say so once.
async function loadError(url, model) {
  try {
    const res = await fetch(url + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: 'hi', stream: false, options: { num_predict: 1 } }),
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    return res.ok ? null : (await res.text()).slice(0, 200);
  } catch (e) {
    return String((e && e.message) || e).slice(0, 200);
  }
}

function runScenarios(url, model, runs, logFile) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile);
    const child = spawn(process.execPath, [path.join(DIR, 'llm_scenarios.test.js')], {
      env: Object.assign({}, process.env, {
        LLM_TEST_URL: url, LLM_TEST_MODELS: model, LLM_TEST_MODEL: model, LLM_TEST_RUNS: String(runs),
      }),
    });
    let text = '';
    const take = (c) => { text += c; log.write(c); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('close', (code) => { log.end(); resolve({ code, text }); });
  });
}

// The suite's summary: a row per scenario ("p/n"), then the pass rate.
function parse(text) {
  const at = text.lastIndexOf('=== summary ===');
  if (at === -1) return null;
  const scenarios = {};
  let rate = null, lost = 0;
  text.slice(at).split(/\r?\n/).slice(2).forEach((line) => {
    const m = /^(.*?)\s{2,}(\S.*?)\s*$/.exec(line);
    if (!m) return;
    if (m[1] === 'pass rate') rate = parseFloat(m[2]);
    else if (m[1] === 'unanswered') lost = parseInt(m[2], 10) || 0;
    else scenarios[m[1]] = m[2];
  });
  let pass = 0, total = 0;
  Object.keys(scenarios).forEach((k) => {
    const r = /^(\d+)\/(\d+)/.exec(scenarios[k]);
    if (r) { pass += +r[1]; total += +r[2]; }
  });
  return (rate === null || isNaN(rate)) ? null : { rate, pass, total, lost, scenarios };
}

function history() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (e) { return []; }
}

function save(record) {
  const all = history();
  all.push(record);
  fs.writeFileSync(HISTORY, JSON.stringify(all, null, 2) + '\n');
  fs.writeFileSync(REPORT, report(all));
}

// The latest record for each server and model, best first.
function report(all) {
  const latest = {};
  all.forEach((r) => { latest[r.server + '\u0000' + r.model] = r; });
  const rows = Object.keys(latest).map((k) => latest[k]);
  const servers = Array.from(new Set(rows.map((r) => r.server))).sort();
  const score = (r) => (r.error ? -1 : r.rate);
  let md = '# LLM accuracy (sidebar scenarios)\n\n' +
    'Pass rate of `llm_scenarios.test.js`: every scenario run `Runs` times, no retries. ' +
    'The latest run of each server and model; every run is in `accuracy.json`, the raw output in the dated folders.\n';
  servers.forEach((s) => {
    const list = rows.filter((r) => r.server === s).sort((a, b) => score(b) - score(a));
    md += '\n## ' + s + ' (' + list[0].url + (list[0].ollama ? ', Ollama ' + list[0].ollama : '') + ')\n\n' +
      '| Model | Pass rate | Passed | Runs | Unanswered | Minutes | Date | Commit |\n' +
      '|-------|----------:|-------:|-----:|-----------:|--------:|------|--------|\n';
    list.forEach((r) => {
      md += '| ' + r.model + ' | ' + (r.error ? '—' : r.rate + '%') + ' | ' + (r.error ? '—' : r.pass + '/' + r.total) +
        ' | ' + r.runs + ' | ' + (r.error ? '—' : r.lost) + ' | ' + r.minutes + ' | ' + r.date + ' | ' + r.commit + ' |\n';
    });
    list.filter((r) => r.error).forEach((r) => { md += '\n- ' + r.model + ': ' + r.error.replace(/\s+/g, ' ') + '\n'; });
    const judged = list.filter((r) => !r.error);
    if (!judged.length) return;
    const names = Object.keys(judged[0].scenarios);
    md += '\n<details><summary>Per scenario</summary>\n\n| Scenario | ' + judged.map((r) => r.model).join(' | ') +
      ' |\n|---|' + judged.map(() => '---:').join('|') + '|\n';
    names.forEach((n) => { md += '| ' + n + ' | ' + judged.map((r) => r.scenarios[n] || '').join(' | ') + ' |\n'; });
    md += '\n</details>\n';
  });
  return md;
}

async function measure(s, opts, defaults, date, commit) {
  const url = String(s.url).replace(/\/$/, '');
  const runs = opts.runs || s.runs || defaults.runs || 3;
  let models, ollama = null;
  try {
    models = ((await getJson(url + '/api/tags')).models || []).map((m) => m.name).filter(usable).sort();
    ollama = (await getJson(url + '/api/version')).version || null;
  } catch (e) {
    console.log('[' + s.name + '] unreachable: ' + ((e && e.message) || e));
    return;
  }
  models = models.filter((m) => (!opts.models || opts.models.indexOf(m) !== -1) &&
    (!s.models || s.models.indexOf(m) !== -1) && (s.skip || []).indexOf(m) === -1);
  console.log('[' + s.name + '] Ollama ' + ollama + ', runs ' + runs + ': ' + (models.join(', ') || '(no models)'));
  const dir = path.join(RESULTS, date, s.name);
  fs.mkdirSync(dir, { recursive: true });

  for (const model of models) {
    const started = Date.now();
    const minutes = () => Math.round((Date.now() - started) / 6000) / 10;
    const base = { date, commit, server: s.name, url, ollama, model, runs };
    const cannot = await loadError(url, model);
    if (cannot) {
      console.log('[' + s.name + '] ' + model + ': does not load (' + cannot + ')');
      save(Object.assign(base, { error: 'does not load: ' + cannot, minutes: minutes() }));
      continue;
    }
    console.log('[' + s.name + '] ' + model + ': running');
    const run = await runScenarios(url, model, runs, path.join(dir, model.replace(/[^\w.-]+/g, '_') + '.log'));
    const r = parse(run.text);
    if (!r) {
      const why = (run.text.match(/SKIP: .*|Error: .*/) || ['no summary (exit ' + run.code + ')'])[0];
      console.log('[' + s.name + '] ' + model + ': ' + why);
      save(Object.assign(base, { error: why, minutes: minutes() }));
      continue;
    }
    console.log('[' + s.name + '] ' + model + ': ' + r.rate + '% (' + r.pass + '/' + r.total + ', ' + minutes() + ' min)');
    save(Object.assign(base, { rate: r.rate, pass: r.pass, total: r.total, lost: r.lost, minutes: minutes(), scenarios: r.scenarios }));
  }
}

(async () => {
  const opts = args(process.argv.slice(2));
  const acc = config();
  const date = new Date().toISOString().slice(0, 10);
  let commit = '?';
  try { commit = execSync('git rev-parse --short HEAD', { cwd: DIR }).toString().trim(); } catch (e) { /* not a checkout */ }
  fs.mkdirSync(RESULTS, { recursive: true });
  const servers = acc.servers.filter((s) => !opts.servers || opts.servers.indexOf(s.name) !== -1);
  await Promise.all(servers.map((s) => measure(s, opts, acc, date, commit)));
  console.log('\nreport: ' + path.relative(process.cwd(), REPORT));
})().catch((e) => { console.error(e); process.exit(1); });
