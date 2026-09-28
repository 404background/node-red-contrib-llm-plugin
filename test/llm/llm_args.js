// Command-line arguments for the live suites, turned into the LLM_TEST_*
// environment variables they already read, so a flag and a variable mean the
// same thing and a flag wins.
//
//   --url <host|url>     Ollama server; a bare host gets http:// and :11434
//   --model <a[,b]>      model, or several (the scenarios compare them)
//   --only <a[,b]>       scenarios whose name contains one of these
//   --runs <n>           each scenario n times, no retries, with a pass rate
//   --provider <name>    ollama (default) or openai
//   --show-failed        print the replies that failed
const USAGE = [
  'usage: npm run test:llm -- [--url <host|url>] [--model <a[,b]>] [--only <a[,b]>]',
  '                           [--runs <n>] [--provider ollama|openai] [--show-failed]',
  'e.g.   npm run test:llm -- --url 192.0.2.10 --model gemma3:4b,gemma4:e4b',
].join('\n');

const VALUED = {
  '--url': (v) => { process.env.LLM_TEST_URL = ollamaUrl(v); },
  '--model': (v) => { process.env.LLM_TEST_MODELS = v; process.env.LLM_TEST_MODEL = v.split(',')[0].trim(); },
  '--only': (v) => { process.env.LLM_TEST_ONLY = v; },
  '--runs': (v) => { process.env.LLM_TEST_RUNS = v; },
  '--provider': (v) => { process.env.LLM_TEST_PROVIDER = v; },
};

function ollamaUrl(v) {
  let url = /^[a-z]+:\/\//i.test(v) ? v : 'http://' + v;
  const u = new URL(url);
  if (!u.port && !/^[a-z]+:\/\//i.test(v)) u.port = '11434';
  return u.toString().replace(/\/$/, '');
}

function applyArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const [flag, inline] = token.split(/=(.*)/s);
    if (flag === '--help' || flag === '-h') { console.log(USAGE); process.exit(0); }
    if (flag === '--show-failed') { process.env.LLM_TEST_SHOW_FAILED = '1'; continue; }
    const set = VALUED[flag];
    const value = inline !== undefined ? inline : argv[++i];
    if (!set || value === undefined || value === '') {
      console.error('unknown or incomplete argument: ' + token + '\n' + USAGE);
      process.exit(1);
    }
    set(value);
  }
}

module.exports = { applyArgs, ollamaUrl, USAGE };
