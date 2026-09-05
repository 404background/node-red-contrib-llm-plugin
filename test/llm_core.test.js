// The shared engine's two durability guarantees, plus the packaging
// assumption it now depends on.
//
// (1) CREDENTIAL KEY — `_credentialSecret` belongs to the Node-RED runtime.
//     It generates that key, and it DELETES it the moment the user sets their
//     own `credentialSecret` in settings.js. An earlier build both wrote to it
//     and derived from it, so that (documented, encouraged) change silently
//     made every stored API key undecryptable. The plugin now keeps its own
//     secret and only READS the runtime's to decrypt older blobs.
//
// (2) SETTINGS WRITES — `RED.settings.set` is asynchronous. Dropping the
//     promise means an unhandled rejection in the Node-RED process and a
//     "saved" setting that was never written.
//
// (3) PACKAGING — the system prompt has no embedded fallback, so it must ship.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ok, summary } = require('./helpers.js');

const CORE = path.resolve(__dirname, '..', 'src', 'llm_core.js');

// llm_core is a per-process singleton, so a "restart" has to be a real
// subprocess. `store` stands in for Node-RED's settings storage and is handed
// back out as JSON so the next session can start from it.
const BOOT = `
let store = JSON.parse(process.env.STORE);
const calls = [];
const RED = {
  settings: {
    userDir: process.env.DIR,
    get: (k) => store[k],
    set: (k, v) => { calls.push(k); store[k] = v; return Promise.resolve(); }
  },
  log: { info() {}, warn() {}, error() {} }
};
const core = require(${JSON.stringify(CORE)})(RED);
`;

function session(dir, store, body) {
  return execFileSync(process.execPath, ['-e', BOOT + body], {
    env: { ...process.env, DIR: dir, STORE: JSON.stringify(store) }, encoding: 'utf8'
  }).trim();
}

function tmpUserDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function credentialKeyIsPluginOwned() {
  console.log('The credential key is the plugin\'s own, not the runtime\'s');
  const dir = tmpUserDir('llmp-key-');

  const store = JSON.parse(session(dir, {}, `
    (async () => {
      await core.savePluginSettings({ provider: 'openai', openaiApiKey: 'sk-persisted-key' });
      console.log(JSON.stringify({ store, calls }));
    })();
  `)).store;

  ok(typeof store.llmPluginCredentialSecret === 'string' && store.llmPluginCredentialSecret.length > 0,
    'the plugin minted and stored a secret of its own');
  ok(!('_credentialSecret' in store),
    "the runtime's _credentialSecret was left untouched");
  ok(!JSON.stringify(store.llmPluginSettings).includes('sk-'),
    'the API key is not left in plain settings');

  // The user now sets their own credentialSecret, which is when Node-RED
  // drops _credentialSecret. The stored key must still open.
  store.credentialSecret = 'the-users-own-secret';
  const recovered = session(dir, store, `console.log(core.getPluginSettings().openaiApiKey);`);
  ok(recovered === 'sk-persisted-key',
    'the stored key survives the user setting their own credentialSecret');
}

function legacyBlobsStillOpen() {
  console.log('\nAn existing install keeps its key');
  const crypto = require('crypto');
  const dir = tmpUserDir('llmp-legacy-');
  fs.mkdirSync(path.join(dir, 'llm-plugin'), { recursive: true });

  // A blob as the previous build wrote it: keyed off the runtime secret.
  const legacySecret = 'deadbeef'.repeat(8);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm', crypto.createHash('sha256').update(legacySecret).digest(), iv);
  const body = cipher.update(JSON.stringify({ openaiApiKey: 'sk-legacy-key' }), 'utf8', 'base64') +
    cipher.final('base64');
  fs.writeFileSync(path.join(dir, 'llm-plugin', 'credentials.json'), JSON.stringify({
    $: 'g1:' + iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + body
  }));

  const store = { _credentialSecret: legacySecret };
  const out = session(dir, store, `console.log(core.getPluginSettings().openaiApiKey);`);
  ok(out === 'sk-legacy-key', 'a blob written by the previous build still decrypts');
}

function settingsWritesAreAwaited() {
  console.log('\nSettings writes are awaited, not dropped');
  const dir = tmpUserDir('llmp-async-');

  // A rejecting store must surface through savePluginSettings, not become an
  // unhandled rejection.
  const out = execFileSync(process.execPath, ['-e', `
    const RED = {
      settings: { userDir: process.env.DIR, get: () => undefined,
                  set: () => Promise.reject(new Error('storage is read-only')) },
      log: { info() {}, warn() {}, error() {} }
    };
    process.on('unhandledRejection', () => { console.log('UNHANDLED'); process.exit(0); });
    const core = require(${JSON.stringify(CORE)})(RED);
    core.savePluginSettings({ provider: 'ollama' })
      .then(() => console.log('RESOLVED'))
      .catch((e) => console.log('REJECTED:' + e.message));
  `], { env: { ...process.env, DIR: dir }, encoding: 'utf8' }).trim();

  ok(out.startsWith('REJECTED:'),
    'a failed settings write reaches the caller (got: ' + out + ')');
  ok(!out.includes('UNHANDLED'), 'and never becomes an unhandled rejection');
}

function onlyTheStorageItUses() {
  console.log('\nOnly the storage it actually uses');

  // chats/ and checkpoints/ are created up front — creating them IS the
  // writability probe that picks baseDir.
  const bare = tmpUserDir('llmp-dirs-');
  session(bare, {}, `(async () => { await core.savePluginSettings({ provider: 'ollama' }); })();`);
  const bareEntries = fs.readdirSync(path.join(bare, 'llm-plugin')).sort();
  ok(bareEntries.join(',') === 'chats,checkpoints',
    'no API key configured -> no credentials file (got: ' + bareEntries.join(',') + ')');

  const keyed = tmpUserDir('llmp-dirs2-');
  session(keyed, {}, `
    (async () => { await core.savePluginSettings({ provider: 'openai', openaiApiKey: 'sk-x' }); })();
  `);
  const keyedEntries = fs.readdirSync(path.join(keyed, 'llm-plugin')).sort();
  ok(keyedEntries.join(',') === 'chats,checkpoints,credentials.json',
    'and nothing beyond credentials.json once one is (got: ' + keyedEntries.join(',') + ')');
  ok(!keyedEntries.some((f) => f.includes('client-events')),
    'no client-events log: nothing ever read it, and RED.log already carries those events');
}

// A configured key must not escape through any of the four routes out of the
// engine: an error string, the masked form the settings form reads, the file
// on disk, or the prompt.
function apiKeysDoNotEscape() {
  console.log('\nA configured API key stays put');
  const dir = tmpUserDir('llmp-sec-');
  const OPENAI = 'sk-proj-AAAABBBBCCCCDDDDEEEE';
  // Deliberately not `sk-`-shaped: a custom endpoint's key can be anything,
  // so pattern-based redaction alone never covers it.
  const CUSTOM = 'f3a91c4e-77bd-4a2e-9c10-8de55b0f1a22';

  const out = JSON.parse(session(dir, {}, `
    (async () => {
      await core.savePluginSettings({
        provider: 'custom', customBaseUrl: 'http://llm.internal:8080/v1',
        openaiApiKey: ${JSON.stringify(OPENAI)}, customApiKey: ${JSON.stringify(CUSTOM)}
      });
      const prompt = core.buildMessages('hi', [{
        id: 'n1', type: 'mqtt in', z: 't', broker: 'b1', x: 1, y: 1, wires: [[]],
        credentials: { user: 'admin', password: 'hunter2' }
      }], 't')[0].content;
      console.log(JSON.stringify({
        store: store,
        echoed: core.redactSecrets('Endpoint said: {"error":"bad token ${CUSTOM}"}'),
        thrown: core.redactSecrets('request failed for ${OPENAI}'),
        maskedLong: core.maskApiKey(${JSON.stringify(OPENAI)}),
        maskedShortA: core.maskApiKey('abc123'),
        maskedShortB: core.maskApiKey('abcdefgh1'),
        prompt: prompt
      }));
    })();
  `));

  ok(!out.echoed.includes(CUSTOM),
    'a custom key echoed back by the endpoint is redacted from the error');
  ok(!out.thrown.includes(OPENAI), 'an OpenAI key in an error is redacted');
  ok(out.maskedShortA === out.maskedShortB,
    'a mask does not disclose the length of a short key');
  ok(out.maskedLong !== OPENAI && out.maskedLong.length < OPENAI.length,
    'a long key is only ever shown masked');

  const raw = fs.readFileSync(path.join(dir, 'llm-plugin', 'credentials.json'), 'utf8');
  ok(!raw.includes(OPENAI) && !raw.includes(CUSTOM), 'neither key is at rest in plaintext');
  ok(!JSON.stringify(out.store).includes(OPENAI) && !JSON.stringify(out.store).includes(CUSTOM),
    'neither key reaches the Node-RED settings store');
  ok(fs.readdirSync(path.join(dir, 'llm-plugin')).every((f) => !f.includes('.tmp')),
    'the atomic write leaves no temp copy of the credentials behind');

  ok(!out.prompt.includes('hunter2') && !out.prompt.includes('credentials'),
    'node credentials are stripped from the flow context sent to the model');
  ok(!out.prompt.includes(OPENAI) && !out.prompt.includes(CUSTOM),
    'and no API key is in the prompt');
}

function systemPromptShips() {
  console.log('\nPackaging');
  const prompt = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'prompt_system.txt'), 'utf8');
  ok(prompt.length > 500, 'prompt_system.txt is present and not truncated');
  ok(/Vibe Schema/.test(prompt), 'and still describes the Vibe Schema');
  ok(typeof require('../src/llm_core.js') === 'function',
    'llm_core loads, which is what proves the prompt is readable');
}

credentialKeyIsPluginOwned();
legacyBlobsStillOpen();
settingsWritesAreAwaited();
onlyTheStorageItUses();
apiKeysDoNotEscape();
systemPromptShips();
summary();
