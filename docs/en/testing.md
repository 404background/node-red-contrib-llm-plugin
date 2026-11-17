# Tests

Everything about this project's tests lives here: what the suites are, what each
one protects, and how to run the live suites. The rest of the developer
documentation is in [`docs/`](../README.md).

## Running

```bash
npm test                   # test/unit: the static suites — nothing but Node required
npm run test:llm           # test/llm: the node, the round-trip and the scenarios against a real LLM
npm run test:llm:accuracy  # test/llm: the pass rate of every model on every configured server
```

```
test/
  helpers.js              shared by both
  unit/                   the plugin's code, no model: npm test
  llm/                    a real model's replies: npm run test:llm, test:llm:accuracy
    llm-test-config.json  this machine's servers and models (git-ignored)
    results/              what the runs produced (git-ignored)
```

`npm test` is the gate: it makes no network call, needs no model, and is the one
that must pass before a change lands. `npm run test:llm` is deliberately
separate — it talks to an actual model, so it cannot be deterministic.

## Offline suites

Each suite states the guarantee it protects in its own header comment, and that
comment — not the assertion names — is the place to look first. `npm test` is
`test/unit/run_all.js`: it finds every `*.test.js` in `test/unit/` and runs each in
its own process, in name order, so a new suite runs the moment it is written.
Every suite is run even after one fails, and the tally at the end names the
ones that did.

| Suite | Guards |
|-------|--------|
| `canvas_layout` | The layout engine: one uniform `dy` for cross-component push, insertion reflow anchored in place, a component the edit did not touch translated as a whole rather than sheared, every box fitted and aligned, and `settleCollisions` leaving no node, caption or box on another (a stray note is the one that moves). Everything the layout places or moves lands on the grid (centre y, left edge), sequences one pitch apart boxed or not. |
| `chat_history` | Several chats, or all of them, are deleted together behind one confirmation that says how many; deleting the open chat starts a new one; cancelling deletes nothing. Opening a chat hands back the flows it was working on. |
| `flow_converter_core` | Auto-stub creation — a config node's own value props (an `mqtt-broker`'s `broker: "localhost"`) are not dangling config references — and that the single-line `func` pretty-printer only ever changes whitespace. |
| `flow_selection` | In jsdom, through the editor's start-up order (tabs added one by one, then `flows:loaded`): a restart keeps the saved selection, the latest chat restores its flows, a new chat takes the open flow, and a selection whose flows are gone becomes the open flow. |
| `llm_core` | The credential key is the plugin's own and survives the user setting `credentialSecret`; older blobs still decrypt; a failed settings write reaches the caller; settings and the key an older build kept in the runtime settings move into `<userDir>/llm-plugin`, where everything the plugin keeps is; a configured API key escapes through none of its exits; a request with no key set says so; the system prompt ships in the package. |
| `schema_conventions` | Both directions of the Vibe Schema boundary: `_`-prefixed metadata reaches neither the LLM nor the canvas, and the editor flags (`disabled` / `showLabel`) map to `d` / `l` only when set. |
| `junction_preserve` | The two entities an apply loses first: a junction survives an edit **with its wires** (it sits mid-chain, so losing it breaks the path silently), group membership survives, a deleted member is pruned from the group's `nodes`, and a locked workspace falls back rather than half-detaching. Junctions are the user's: an edit that leaves its targets in place does not move one, and none rewires it or lands on it; routing between two boxes follows the box it feeds when that box is pushed down; the context reads a wire through a junction or a link out → link in pair as a connection to where it leads, and restating that connection adds no wire, while removing it cuts it inside the routing, keeps every other connection and takes down the routing left idle — across two tabs too when both are in the context, never touching a tab outside it; a link node's hover-only virtual link does not join two sequences. |
| `cross_flow_isolation` | The flow selection is the boundary: an edit may only write to the flows that were sent. A reply is read against the alias numbering the model was shown over every context flow, so an alias names one node and it is edited on its own tab; node ids inside properties round-trip as aliases. |
| `import_safety` | Deletions reach the flow that owns them and no other; a failed import rolls back completely, junctions, groups and already-rewritten config nodes included; flow context follows config references transitively and through arrays. |
| `node_secret_exit` | The `llm-request` node's error exit is a secret exit — an endpoint that echoes the Authorization header into its error body must not put the stored key on a Catch node's `msg.error`. |
| `reply_rendering` | In jsdom, with the scripts the editor loads: a reply's raw HTML is text, unsafe links lose their `href`, an image becomes a link, code blocks and tables still render, and the plugin's DOMPurify leaves the editor's global one alone. |
| `deploy_churn` | Applying an edit does not make the runtime restart nodes it did not edit: key-set fidelity against `diffNodes`, so no stray property lands on an untouched node. |
| `incremental_apply` | An edit touches only what it edits. The work done is asserted — which entities were removed, which nodes were handed to `import()`, which links were cut and made — not just the end state. |
| `http_transport` | The provider adapters against a real loopback server: Ollama, chat completions (Custom) and the Responses API (OpenAI) each join a streamed reply, a timeout surfaces as `code === 'ETIMEDOUT'`, and a stream cut before its end marker — or an OpenAI response that ends `incomplete` or `failed` — is an error, not a short reply. |
| `json_repair` | A reply whose JSON is not quite JSON: what is recovered (an unterminated string, unescaped quotes inside a value, a JSONata expression whose own outer quotes the repair ate) and what is left to fail loudly — a block that was already valid is never "repaired", an expression that already reads correctly is not re-quoted, and a block that was recovered is not also reported as a failure. Also `parseJsonBlock`, the reading the sidebar folds a JSON block on. |
| `ui_templates` | The seam between `llm_plugin.html` and `ui_core.js`: every id the JS clones exists, every template has a single well-formed root, and the classes reached for after cloning are in the markup. Also the two static seams that rot silently — the docs link in the header, and the `llm-request` node, which must stay a thin caller of the shared core (no editor path, no plugin logic in its html), be registered and published by `package.json`, and keep a help panel short enough to read. And the plugin raises no editor notification of its own: nothing calls `RED.notify`, and a warning is a line in the chat. |
| `server_api` | The admin routes' guarantees: the unauthenticated `src/` routes serve exactly what `client.js` loads, checkpoint `meta` is bounded, an unknown provider is refused, a chat is deleted by id. |
| `group_schema` | Group boxes are the user's: a reply cannot create, edit or delete one, and the context shows none without moving any node alias. An edit keeps a box around its one sequence: a new node wired into it joins the box, a comment follows the node its `above` names into (or out of) a box, a box stays when emptied, and every box is refitted around where its members end up, clear of the next sequence. A branch added inside a box lands clear of the others in port order. |

`helpers.js` holds the assertion counter and `loadPluginSandbox(RED, opts)`, which
runs the real client modules in a vm context in the same order `client.js` uses —
so a load-order dependency cannot pass here and fail in production. Pass
`opts.fetch` when the requests going out are what the suite asserts. `coreRED()`
is its runtime counterpart: the minimal Node-RED that `llm_core` and the
`llm-request` node need to be constructed. Beyond those, each suite keeps its own
`buildRED`: the registries it sets up and the state it captures are the point of
that suite.

## Live suites (`npm run test:llm`)

`llm_node.test.js` sends messages through the `llm-request` node to a real model:
the reply comes back on `msg.payload` with the other properties untouched,
`msg.llm` is filled in, the node's system prompt is followed and `msg.system`
overrides it, an object payload is sent as JSON, `msg.model` and `msg.timeout`
are honoured, and a blank payload is refused before any request.

`llm_roundtrip.test.js` drives the same engine the sidebar and the `llm-request`
node use — prompt construction, a real HTTP call to the provider, Vibe Schema
extraction from the reply, and conversion into an importable flow — so it catches
breakage that only shows up against an actual model.

Model output is not deterministic, so its assertions are structural rather than
exact: a schema must be extractable, and the flow it yields must be one
`RED.nodes.import` would accept.

`llm_scenarios.test.js` goes one step further: realistic requests — building, inserting, editing properties (inject, function, change with JSONata, debug), renaming, disabling, deleting nodes and single connections (also through a junction or link nodes), comments, layout, group boxes, config nodes (reuse, never invent), several sequences, switches and multi-output functions, other flows, a request for a node that does not exist, and questions in both modes — are sent to the model, applied to a mocked editor through the real importer, and the canvas is checked for the outcome the user asked for, plus two invariants (every wire lands on a node, nothing overlaps). Each scenario gets `attempts` tries. `LLM_TEST_MODELS=gemma3:4b,gemma4:e2b` runs it against several models and prints a table; `LLM_TEST_SHOW_FAILED=1` prints the replies that failed. `LLM_TEST_ONLY=delete,switch` runs only the scenarios whose name contains one of them. `LLM_TEST_RUNS=5` runs each scenario 5 times without retries and reports how many passed, plus an overall pass rate per model (a run the endpoint never answered, even after retries, is counted apart as unanswered); `LLM_TEST_URL` points it at another Ollama server (a Tailscale address works). `LLM_TEST_PROVIDER=openai` runs it against OpenAI with the key in `LLM_TEST_OPENAI_KEY` or the git-ignored `.credentials.json` at the repository root (`{ "OpenAI": "sk-..." }`); the tokens the API reports (reasoning included) are counted, and `LLM_TEST_TOKEN_BUDGET=200000` stops before the next scenario once that many are spent. `LLM_TEST_REPLAY=run.log[,more.log]` sends nothing: it takes the failed replies a run logged with `LLM_TEST_SHOW_FAILED=1`, judges them again against the code as it is now, and reports which would pass (a reply longer than the 3000 characters the log keeps is marked as cut) — a way to see what a parser or importer change buys without the server.

`npm run test:llm` is `test/llm/run_llm.js`: the node test and the round-trip once
per model given, then the scenarios.

Endpoint and model come from `test/llm/llm-test-config.json`, next to the suites it
configures. That file is git-ignored, so copy the template to create it:

```bash
cp test/llm/llm-test-config.example.json test/llm/llm-test-config.json
```

| Field | Meaning |
|-------|---------|
| `ollamaUrl` | Endpoint to test against (default `http://localhost:11434`) |
| `model` | Model name (default `gemma3:4b`) |
| `timeoutMs` | Per-request timeout |
| `attempts` | Retries allowed for a reply to contain a parseable schema — small models sometimes answer in prose first |
| `showReplies` | Print the model's raw replies so you can see what it actually said |

Arguments override the file for a single run (`npm run test:llm -- --help`):

```bash
npm run test:llm -- --url 192.0.2.10 --model gemma3:4b,gemma4:e4b
npm run test:llm -- --url http://192.0.2.10:11434 --model gemma3:4b --only delete,switch --runs 5
```

| Argument | Meaning |
|----------|---------|
| `--url <host\|url>` | Ollama server. A bare host gets `http://` and port `11434` |
| `--model <a[,b]>` | Model, or several: the round-trip runs once per model, the scenarios print a table |
| `--only <a[,b]>` | Scenarios whose name contains one of these |
| `--runs <n>` | Each scenario n times without retries, with a pass rate |
| `--provider <name>` | `ollama` (default) or `openai` |
| `--show-failed` | Print the replies that failed |

Each flag sets the matching `LLM_TEST_*` variable (`LLM_TEST_URL`, `LLM_TEST_MODEL(S)`,
`LLM_TEST_ONLY`, `LLM_TEST_RUNS`, `LLM_TEST_PROVIDER`, `LLM_TEST_SHOW_FAILED`), so the
variables still work, and a flag wins over them. Each suite also takes the flags when
run directly (`node test/llm/llm_scenarios.test.js --url …`).

### Accuracy (`npm run test:llm:accuracy`)

`test/llm/llm_accuracy.js` measures how well each model does the sidebar's job: for
every server under `accuracy.servers` in the config, it lists the models the server
has (embedding models aside, and cloud models: those run at ollama.com whichever server
relays them, so they are measured once, on a server marked `"cloud": true`, which measures
only them), checks each one loads, and runs the scenarios
with `runs` per scenario. Servers run in parallel, the models on one server one after
another. `--server`, `--model` and `--runs` narrow a run. An entry with
`"provider": "openai"` measures the `models` it lists through the OpenAI API (the key as
for the scenarios), and with `tokenBudget` stops before the next scenario once the tokens
the API reports reach it, to stay within a free daily quota; the report shows the tokens used.

```json
"accuracy": { "runs": 3, "servers": [
  { "name": "gpu-box", "url": "http://192.0.2.10:11434" },
  { "name": "slow-box", "url": "http://192.0.2.11:11434", "runs": 1, "skip": ["llama3.2-vision:latest"] },
  { "name": "ollama-cloud", "url": "http://localhost:11434", "cloud": true },
  { "name": "openai", "provider": "openai", "models": ["gpt-5.4"], "tokenBudget": 200000 } ] }
```

The results stay on this machine, in `test/llm/results/`: `accuracy.md` (the latest
pass rate of each server and model, with a per-scenario table), `accuracy.json` (every
run, appended) and the raw log of each run in a dated folder.

Exit codes: `0` passed, `1` failed, `2` skipped — the endpoint was unreachable,
the model was not installed, or the endpoint failed to serve the request.

## Adding a suite

1. Open with a header comment naming the guarantee and why it exists — the
   history that made it necessary is the useful part.
2. Name it `<what it guards>.test.js`. A suite that needs no model goes in
   `test/unit/`, where the runner discovers it; one that talks to a model goes in
   `test/llm/` and is added to `run_llm.js`.
3. One behaviour, one suite. Where two suites drive the same path — the apply
   is the obvious one — each asserts its own layer and says in its header what
   it deliberately leaves to the other: `incremental_apply` owns the work the
   editor does, `deploy_churn` owns whether the runtime would restart a node,
   `junction_preserve` owns junctions and groups. Asserting a behaviour twice
   means two suites to update for one change, and neither one tells you which
   is authoritative.
4. Test code is tracked. `.gitignore` leaves out only what describes this machine or
   a run of it: `test/llm/llm-test-config.json` (it names hosts), `test/llm/results/`
   and the suites' `.tmp-*` storage. Tests are not published to npm (`files` in
   `package.json`).
