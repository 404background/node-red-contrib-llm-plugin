// The two server-side HTTP callers, against a real local server.
//
// Both used to pick between the `http` and `https` modules by hand and build
// requests out of host/port/path parts. They are on global `fetch` now, which
// speaks both schemes through one path — so the parts that had to be carried
// by hand (a scheme flag, 443/80 defaults, chunk collection) are gone.
//
// A transport swap is invisible to the rest of the suite: nothing else here
// makes a network call, so the unit tests would pass just as happily against
// a broken client. These scenarios exercise the real thing on a loopback
// server, and pin the two behaviours callers actually depend on:
//
//   * the timeout still arrives as `code === 'ETIMEDOUT'`. The node reads
//     that to show "timeout" instead of "error"; an aborted fetch throws a
//     TimeoutError with no `code` at all, so it has to be put back.
//   * a >=400 body still names the PATH, never the full URL. The base can
//     carry `user:pass@` (it may come from `msg.editorUrl`), and that message
//     travels out through done(err) to the log and `msg.error`.
const http = require('http');
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

const createAdminApi = require(path.join(ROOT, 'node', 'lib', 'admin_api.js'));
const createLLMCore = require(path.join(ROOT, 'src', 'llm_core.js'));

// Start a loopback server; resolve once its real port is known.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port,
                close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Minimal RED stand-in. `userDir: null` keeps llm_core in its memory-only
// mode so the suite never writes to the developer's Node-RED directory.
function fakeRED() {
  return {
    settings: {
      userDir: null,
      uiPort: 1880,
      httpAdminRoot: '/',
      get: () => ({}),
      set: () => Promise.resolve(),
    },
    server: null,
    log: { info() {}, warn() {}, error() {} },
    nodes: { registerType() {} },
  };
}

async function scenarioAdminApiReadsFlows() {
  console.log('admin_api GETs the flows endpoint over fetch');
  let seen = null;
  const s = await serve((req, res) => {
    seen = { url: req.url, accept: req.headers.accept, apiVersion: req.headers['node-red-api-version'] };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ rev: 'abc', flows: [{ id: 't1', type: 'tab' }] }));
  });
  try {
    const api = createAdminApi(fakeRED());
    const out = await api.getFlows({ url: 'http://127.0.0.1:' + s.port + '/' });
    ok(!!out && Array.isArray(out.flows), 'the JSON body comes back parsed');
    ok(out.rev === 'abc', 'and complete (rev=' + out.rev + ')');
    ok(seen && seen.url === '/flows', 'it hit /flows (' + (seen && seen.url) + ')');
    ok(seen && seen.apiVersion === 'v2', 'with the v2 API header');
    ok(seen && /json/.test(seen.accept || ''), 'and an Accept of JSON');
  } finally { await s.close(); }
}

async function scenarioAdminApiKeepsUrlOutOfErrors() {
  console.log('\nadmin_api names the path, not the URL, on an error status');
  const s = await serve((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('boom');
  });
  try {
    const api = createAdminApi(fakeRED());
    // Userinfo in the base is the case that matters: it must not be quoted
    // back into an error that reaches the log and msg.error.
    let msg = '';
    try {
      await api.getFlows({ url: 'http://user:s3cret@127.0.0.1:' + s.port + '/' });
    } catch (e) { msg = e.message || ''; }
    ok(/failed \(500\)/.test(msg), 'the status is reported (' + msg.slice(0, 60) + ')');
    ok(msg.indexOf('s3cret') === -1, 'the password is NOT in the message');
    ok(msg.indexOf('user:') === -1, 'nor the username');
    ok(/\/flows/.test(msg), 'but the path still is, which is the useful half');
  } finally { await s.close(); }
}

async function scenarioAdminApiRejectsForeignSchemes() {
  console.log('\nadmin_api still refuses a scheme it has no business opening');
  const api = createAdminApi(fakeRED());
  let msg = '';
  try { await api.getFlows({ url: 'file:///etc/passwd' }); }
  catch (e) { msg = e.message || ''; }
  ok(/must use http/.test(msg), 'file:// is refused (' + msg.slice(0, 50) + ')');

  msg = '';
  try { await api.getFlows({ url: 'not a url' }); }
  catch (e) { msg = e.message || ''; }
  ok(/not a valid URL/.test(msg), 'and so is a non-URL');
}

async function scenarioOllamaRoundTrip() {
  console.log('\nthe Ollama adapter posts and reads a chat completion');
  let body = null;
  const s = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = { url: req.url, method: req.method, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: 'hello from the model' } }));
    });
  });
  try {
    const core = createLLMCore(fakeRED());
    const out = await core.generateWithProvider(
      'ollama',
      { ollamaUrl: 'http://127.0.0.1:' + s.port },
      'llama3.2', [{ role: 'user', content: 'hi' }], {});
    ok(out === 'hello from the model', 'the content is returned (' + out + ')');
    ok(body && body.method === 'POST', 'it was a POST');
    ok(body && body.url === '/api/chat', 'to /api/chat (' + (body && body.url) + ')');
    ok(body && body.json && body.json.stream === false, 'with streaming off');
    ok(body && body.json && body.json.model === 'llama3.2', 'and the model named');
  } finally { await s.close(); }
}

async function scenarioOllamaSurfacesHttpErrors() {
  console.log('\nan Ollama error status becomes a readable error');
  const s = await serve((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('model not found');
  });
  try {
    const core = createLLMCore(fakeRED());
    let msg = '';
    try {
      await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port },
        'nope', [{ role: 'user', content: 'hi' }], {});
    } catch (e) { msg = e.message || ''; }
    ok(/404/.test(msg), 'the status code is in the message (' + msg.slice(0, 60) + ')');
    ok(/model not found/.test(msg), 'along with what the endpoint said');
  } finally { await s.close(); }
}

// The one behavioural dependency the transport swap could have broken.
async function scenarioOllamaTimeoutKeepsItsCode() {
  console.log('\na timed-out generation still reports code ETIMEDOUT');
  // Accept the request and never answer: exactly the case the timeout is for.
  const s = await serve(() => { /* deliberately no response */ });
  try {
    const core = createLLMCore(fakeRED());
    let err = null;
    try {
      await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port },
        'slow', [{ role: 'user', content: 'hi' }], { timeoutMs: 300 });
    } catch (e) { err = e; }
    ok(!!err, 'it rejects rather than hanging');
    ok(err && err.code === 'ETIMEDOUT',
      'with code ETIMEDOUT, which is what the node matches on (' +
        (err && err.code) + ')');
    ok(err && /timed out/i.test(err.message || ''), 'and a message that says so');
  } finally { await s.close(); }
}

// A path on the base URL has to survive; a bare host must not grow a double
// slash. Both were hand-assembled before.
async function scenarioOllamaHonoursABasePath() {
  console.log('\na base URL with a path prefix is preserved');
  let seenUrl = null;
  const s = await serve((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: 'ok' } }));
  });
  try {
    const core = createLLMCore(fakeRED());
    await core.generateWithProvider('ollama',
      { ollamaUrl: 'http://127.0.0.1:' + s.port + '/proxy/ollama' },
      'm', [{ role: 'user', content: 'hi' }], {});
    ok(seenUrl === '/proxy/ollama/api/chat',
      'the prefix is kept and joined once (' + seenUrl + ')');

    seenUrl = null;
    await core.generateWithProvider('ollama',
      { ollamaUrl: 'http://127.0.0.1:' + s.port + '/' },
      'm', [{ role: 'user', content: 'hi' }], {});
    ok(seenUrl === '/api/chat', 'a bare root does not double the slash (' + seenUrl + ')');
  } finally { await s.close(); }
}

async function run() {
  await scenarioAdminApiReadsFlows();
  await scenarioAdminApiKeepsUrlOutOfErrors();
  await scenarioAdminApiRejectsForeignSchemes();
  await scenarioOllamaRoundTrip();
  await scenarioOllamaSurfacesHttpErrors();
  await scenarioOllamaTimeoutKeepsItsCode();
  await scenarioOllamaHonoursABasePath();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
