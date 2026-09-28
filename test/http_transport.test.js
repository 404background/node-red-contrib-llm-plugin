// The provider adapters, against a real local server.
//
// A transport swap is invisible to the rest of the suite: nothing else here
// makes a network call, so the unit tests would pass just as happily against
// a broken client. These scenarios exercise the real thing on a loopback
// server, and pin the two behaviours callers actually depend on:
//
//   * the timeout still arrives as `code === 'ETIMEDOUT'`. The node reads
//     that to show "timeout" instead of "error"; an aborted fetch throws a
//     TimeoutError with no `code` at all, so it has to be put back.
//   * a stream cut before its end marker is an error, not a short reply.
const http = require('http');
const path = require('path');
const { ok, summary, ROOT } = require('./helpers.js');

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

async function scenarioOllamaRoundTrip() {
  console.log('\nthe Ollama adapter posts and reads a chat completion');
  let body = null;
  const s = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = { url: req.url, method: req.method, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: 'hello from the model' }, done: true }));
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
    ok(body && body.json && body.json.stream === true, 'streamed, so fetch never waits 300 s for headers');
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
    res.end(JSON.stringify({ message: { content: 'ok' }, done: true }));
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

// Ollama streams one JSON object per line, split across chunks at random.
async function scenarioOllamaReadsAStream() {
  console.log('\na streamed Ollama reply is joined, and a mid-stream error surfaces');
  let fail = false;
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const lines = [{ message: { content: 'hel' } }, { message: { content: 'lo 日本' } },
      fail ? { error: 'model crashed' } : { message: { content: '語' }, done: true }]
      .map((o) => JSON.stringify(o) + '\n').join('');
    const bytes = Buffer.from(lines, 'utf8');
    // Cut inside a line and inside a multi-byte character.
    const cuts = [5, bytes.indexOf(Buffer.from('本')) + 1, bytes.length - 3];
    let at = 0;
    cuts.forEach((c) => { res.write(bytes.slice(at, c)); at = c; });
    res.end(bytes.slice(at));
  });
  try {
    const core = createLLMCore(fakeRED());
    const out = await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port },
      'm', [{ role: 'user', content: 'hi' }], {});
    ok(out === 'hello 日本語', 'the pieces are joined (' + out + ')');

    fail = true;
    let msg = '';
    try {
      await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port },
        'm', [{ role: 'user', content: 'hi' }], {});
    } catch (e) { msg = e.message || ''; }
    ok(/model crashed/.test(msg), 'an error line rejects with what Ollama said (' + msg + ')');
  } finally { await s.close(); }
}

// The timeout bounds the whole reply, not just the wait for headers.
async function scenarioOllamaTimeoutMidStream() {
  console.log('\na generation that times out mid-stream still reports ETIMEDOUT');
  const s = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: 'partial' } }) + '\n');
    // ...and never finishes.
  });
  try {
    const core = createLLMCore(fakeRED());
    let err = null;
    try {
      await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port },
        'm', [{ role: 'user', content: 'hi' }], { timeoutMs: 300 });
    } catch (e) { err = e; }
    ok(err && err.code === 'ETIMEDOUT', 'code ETIMEDOUT (' + (err && (err.code || err.message)) + ')');
  } finally { await s.close(); }
}

// OpenAI-compatible endpoints (llama.cpp, LM Studio, vLLM, OpenAI itself)
// answer a streamed request with server-sent events.
async function scenarioOpenAICompatibleReadsAStream() {
  console.log('\nthe OpenAI-compatible adapter streams and joins the reply');
  let body = null;
  let mode = 'ok';
  const s = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = { url: req.url, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      if (mode === 'hang') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] }) + '\n\n');
        return;
      }
      if (mode === 'text') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not an API</html>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      ['hel', 'lo 日本', '語'].forEach((c) => {
        res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm',
          choices: [{ index: 0, delta: { content: c }, finish_reason: c === '語' ? 'stop' : null }] }) + '\n\n');
      });
      res.end('data: [DONE]\n\n');
    });
  });
  const settings = { customBaseUrl: 'http://127.0.0.1:' + s.port + '/v1' };
  try {
    const core = createLLMCore(fakeRED());
    const out = await core.generateWithProvider('custom', settings, 'm', [{ role: 'user', content: 'hi' }], {});
    ok(out === 'hello 日本語', 'the deltas are joined (' + out + ')');
    ok(body && body.url === '/v1/chat/completions' && body.json.stream === true, 'posted streamed to /v1/chat/completions');

    mode = 'hang';
    let err = null;
    try {
      await core.generateWithProvider('custom', settings, 'm', [{ role: 'user', content: 'hi' }], { timeoutMs: 300 });
    } catch (e) { err = e; }
    ok(err && err.code === 'ETIMEDOUT', 'a reply that stalls mid-stream times out with ETIMEDOUT (' + (err && (err.code || err.message)) + ')');

    mode = 'text';
    err = null;
    try {
      await core.generateWithProvider('custom', settings, 'm', [{ role: 'user', content: 'hi' }], {});
    } catch (e) { err = e; }
    ok(!!err, 'a page that is not an API rejects (' + (err && String(err.message).slice(0, 80)) + ')');
  } finally { await s.close(); }
}

// A proxy that drops the connection mid-reply ends the stream as cleanly as
// the model does. Only the end marker (`done` / `finish_reason`) tells them apart.
async function scenarioACutStreamIsNotAReply() {
  console.log('\na stream cut off before its end marker is an error, not a short reply');
  let provider = 'ollama';
  const s = await serve((req, res) => {
    if (provider === 'ollama') {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { content: 'half an ans' } }) + '\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }] }) + '\n\n');
    }
  });
  try {
    const core = createLLMCore(fakeRED());
    let err = null;
    try {
      await core.generateWithProvider('ollama', { ollamaUrl: 'http://127.0.0.1:' + s.port }, 'm', [{ role: 'user', content: 'hi' }], {});
    } catch (e) { err = e; }
    ok(err && err.code === 'ECONNRESET', 'Ollama: rejects with ECONNRESET (' + (err && (err.code || err.message)) + ')');

    provider = 'custom';
    err = null;
    try {
      await core.generateWithProvider('custom', { customBaseUrl: 'http://127.0.0.1:' + s.port + '/v1' }, 'm',
        [{ role: 'user', content: 'hi' }], {});
    } catch (e) { err = e; }
    ok(err && err.code === 'ECONNRESET', 'OpenAI-compatible: rejects with ECONNRESET (' + (err && (err.code || err.message)) + ')');
  } finally { await s.close(); }
}

// OpenAI itself is called through the Responses API: newer models are served
// there and some nowhere else. The SDK reads OPENAI_BASE_URL when no base is
// given, which points it at the loopback server.
async function scenarioOpenAIUsesTheResponsesApi() {
  console.log('\nthe OpenAI provider posts to /v1/responses and joins the text deltas');
  let body = null;
  let mode = 'ok';
  const s = await serve((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      body = { url: req.url, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (ev) => res.write('event: ' + ev.type + '\ndata: ' + JSON.stringify(ev) + '\n\n');
      send({ type: 'response.created', sequence_number: 0, response: { id: 'r', status: 'in_progress' } });
      ['hel', 'lo 日本', '語'].forEach((d, i) => send({ type: 'response.output_text.delta', sequence_number: i + 1,
        item_id: 'm', output_index: 0, content_index: 0, delta: d }));
      if (mode === 'ok') send({ type: 'response.completed', sequence_number: 9, response: { id: 'r', status: 'completed' } });
      if (mode === 'incomplete') send({ type: 'response.incomplete', sequence_number: 9,
        response: { id: 'r', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
      if (mode === 'failed') send({ type: 'response.failed', sequence_number: 9,
        response: { id: 'r', status: 'failed', error: { code: 'server_error', message: 'the model fell over' } } });
      res.end();
    });
  });
  const saved = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:' + s.port + '/v1';
  const settings = { openaiApiKey: 'sk-test' };
  const messages = [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }];
  try {
    const core = createLLMCore(fakeRED());
    const out = await core.generateWithProvider('openai', settings, 'gpt-5-mini', messages, {});
    ok(out === 'hello 日本語', 'the deltas are joined (' + out + ')');
    ok(body && body.url === '/v1/responses', 'posted to /v1/responses (' + (body && body.url) + ')');
    ok(body && body.json.stream === true && body.json.store === false, 'streamed, and not stored on OpenAI');
    ok(body && body.json.instructions === 'be brief', 'the system message is sent as instructions');
    ok(body && JSON.stringify(body.json.input) === JSON.stringify([{ role: 'user', content: 'hi' }]),
      'and only the rest as input (' + JSON.stringify(body && body.json.input) + ')');

    mode = 'incomplete';
    let err = null;
    try { await core.generateWithProvider('openai', settings, 'm', messages, {}); } catch (e) { err = e; }
    ok(err && /cut short \(max_output_tokens\)/.test(err.message), 'an incomplete reply is an error that says why (' + (err && err.message) + ')');

    mode = 'failed';
    err = null;
    try { await core.generateWithProvider('openai', settings, 'm', messages, {}); } catch (e) { err = e; }
    ok(err && /the model fell over/.test(err.message), 'a failed response reports what OpenAI said (' + (err && err.message) + ')');

    mode = 'cut';
    err = null;
    try { await core.generateWithProvider('openai', settings, 'm', messages, {}); } catch (e) { err = e; }
    ok(err && err.code === 'ECONNRESET', 'a stream with no end event is not a reply (' + (err && (err.code || err.message)) + ')');
  } finally {
    if (saved === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = saved;
    await s.close();
  }
}

async function run() {
  await scenarioOllamaRoundTrip();
  await scenarioOllamaSurfacesHttpErrors();
  await scenarioOllamaTimeoutKeepsItsCode();
  await scenarioOllamaHonoursABasePath();
  await scenarioOllamaReadsAStream();
  await scenarioOllamaTimeoutMidStream();
  await scenarioOpenAICompatibleReadsAStream();
  await scenarioOpenAIUsesTheResponsesApi();
  await scenarioACutStreamIsNotAReply();
  summary();
}

run().catch((e) => { console.error(e); process.exit(1); });
