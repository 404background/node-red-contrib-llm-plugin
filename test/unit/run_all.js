// The `npm test` runner: every `*.test.js` in this folder, in one child
// process each, in name order. The live suites that need a real LLM are in
// ../llm and run through `npm run test:llm`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIR = __dirname;

const suites = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.js')).sort();

if (!suites.length) {
    console.error('No suites found in ' + DIR);
    process.exit(1);
}

const failed = [];
for (const suite of suites) {
    console.log('\n=== ' + suite + ' ===');
    const run = spawnSync(process.execPath, [path.join(DIR, suite)], { stdio: 'inherit' });
    if (run.status !== 0) failed.push(suite);
}

console.log('\n' + (suites.length - failed.length) + '/' + suites.length + ' suites passed');
if (failed.length) {
    console.log('failed: ' + failed.join(', '));
    process.exit(1);
}
