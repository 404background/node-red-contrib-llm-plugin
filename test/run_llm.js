// The `npm run test:llm` runner: the live round-trip, then the live scenarios,
// with the same arguments (see llm_args.js). The round-trip takes one model,
// so it runs once per model given.
//
// Exit codes: 0 = all passed, 1 = something failed, 2 = skipped (no endpoint).

const path = require('path');
const { spawnSync } = require('child_process');
const { applyArgs } = require('./llm_args.js');

applyArgs(process.argv.slice(2));

function run(file, env) {
  console.log('\n=== ' + file + ' ===');
  return spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: 'inherit', env: Object.assign({}, process.env, env || {}),
  }).status;
}

const models = (process.env.LLM_TEST_MODELS || '').split(',').map((m) => m.trim()).filter(Boolean);
const codes = [];
(models.length ? models : [null]).forEach((m) => {
  codes.push(run('llm_roundtrip.test.js', m ? { LLM_TEST_MODEL: m } : null));
});
// No endpoint: the scenarios would only say the same.
if (codes.every((c) => c === 2)) process.exit(2);
codes.push(run('llm_scenarios.test.js'));

process.exit(codes.some((c) => c === 1 || c === null) ? 1 : codes.every((c) => c === 2) ? 2 : 0);
