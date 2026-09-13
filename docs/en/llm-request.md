# `llm-request` node

The node registered alongside the LLM Plugin sidebar (palette category
**llm-plugin**) so a flow can call an LLM.
Provider, model and the target flows are set on the `llm-request` node; API keys
and URLs are inherited from the **LLM Plugin sidebar** (Settings).

## Configuring an `llm-request` node

| Field | Notes |
|-------|-------|
| Mode | **Ask** — reply on `msg.payload`. **Agent** — same, then applies the changes live in the open editor. |
| Provider | Ollama / OpenAI / Custom. Keys & URLs come from the sidebar. |
| Model | Free text (e.g. `llama3.1`, `gpt-4o-mini`); **required**. `msg.model` overrides per message. |
| Flows | Multi-select (none / one / many). Sent to the LLM as context in **both** modes; the list refreshes when the `llm-request` node is opened. |
| API URL | Admin API base used to read flow context — normally the URL the editor is served at (standalone `http://localhost:1880`; embedded: the `httpAdminRoot` base, e.g. `http://localhost:8000/red`). Accepts a string or a **flow/global** context variable. Blank = auto-detect (recommended; works when embedded on a non-1880 port). `msg.editorUrl` overrides; if the configured URL fails, the node falls back to auto-detection with a warning. |
| Timeout | Seconds; default **3600** (1 h — local LLMs can be slow). `0` = no limit. `msg.timeout` overrides per message. |
| Auto deploy | **Agent only, developer feature.** When checked, the editor deploys immediately after applying the changes (`RED.actions.invoke('core:deploy-flows', true)` — the editor's own Deploy with validation skipped, so no confirmation dialog can stall an unattended loop and the dirty state clears properly). The deploy is async: the editor's own deploy toast reports the outcome. No review step; keep a single editor open; prefer the Modified Nodes/Flows deploy type; use only on disposable dev instances. **Security:** with no review step and no node-type restriction, a generated `function` / `exec` node runs on this host — never drive an `llm-request` node in Agent mode from untrusted input. |

**Inputs:** `payload` (prompt; strings are newline-normalised, objects are
JSON-stringified). **Outputs:** `payload` (text reply — do not `JSON.parse` it),
`llm` (mode/provider/model/elapsed), and in Agent mode `flow`
(`{ targetFlows, dispatchedToEditor }`).

**Status:** blue dot while requesting (ticks the elapsed seconds), green
`done (…)` / `sent to editor` on success, red `error` / `timeout` on failure.

## How Agent mode applies changes

The `llm-request` node runs on the runtime side, so it can't edit the browser
canvas directly. It publishes the reply over Node-RED's comms channel instead,
and the node's editor half (`llm-request.html`) applies it with the plugin's
importer — the same path as the sidebar.

- The `llm-request` node's **Flows** selection is passed to the importer as the write scope, exactly as the sidebar passes a message's `targetFlowIds`: the flows sent to the model are the only flows the reply may modify. Selecting nothing sends no flow context and keeps the legacy active-tab behaviour. See [docs/en/architecture.md](./architecture.md) — `importer.js`, guarantee 2.
- An **editor must be open** with the plugin loaded; headless runs have no canvas.
- **No chat history** for anything driven through an `llm-request` node (unlike
  the sidebar), but the edit is still undoable: the editor saves a checkpoint of
  the target flows immediately before applying, tagged `node-apply`, and the
  sidebar's **Restore Points** dialog is where to find it — a node checkpoint has
  no chat message to hang a Restore button off. If the checkpoint cannot be
  saved the edit still applies and the notification says so. Review on the canvas
  before Deploy; the editor's undo works too.
- **Applies are queued.** A reply arrives whenever the model finishes, which
  may be while an edit of your own is applied and not yet deployed. Rather than
  merge on top of uncommitted work, the edit waits for that deploy — see
  [design.md §13](./design.md). With **Auto deploy** the node releases its own
  hold; without it the wait ends when you deploy.
- **Auto deploy skips validation.** The editor half invokes
  `core:deploy-flows` with the deploy action's `skipValidation` flag, which is
  the path behind the confirm dialog's own Confirm button. Without it a single
  unconfigured or unknown node **anywhere** in the workspace pops a modal that
  an unattended loop can never answer. The deploy is asynchronous, so the
  editor's own deploy notification — not the node's — reports the outcome.
- There is intentionally **no "deploy" node**: a server-side node cannot reproduce
  the editor's Deploy button (it deploys the browser's editor state — purely
  client-side). Agent mode applies edits live, which you then Deploy yourself —
  or check the `llm-request` node's **Auto deploy** and its editor half invokes
  the editor's own Deploy action right after applying (that's why it works where a
  server-side deploy node couldn't: the browser itself deploys).

## Files

The files that make up the `llm-request` node:

```
node/
  lib/admin_api.js              GET /flows client (read flow context; auto-detects the instance)
  llm-request/llm-request.js    runtime side: prompt build + provider call + comms publish
  llm-request/llm-request.html  editor side: config UI + comms subscriber that applies via the importer
```

The shared LLM engine (settings, credentials, provider adapters, prompt build)
lives in [`src/llm_core.js`](../../src/llm_core.js) and is reused by the sidebar.

## Examples

Import via **Menu → Import → Examples** (or the JSON files in `examples/`):

- `llm-nodes` — two `llm-request` nodes, Ask and Agent side by side (core nodes
  only). The Agent row's edit is applied live in the open editor; you review and
  Deploy manually — nothing deploys automatically.
- `llm-self-feedback` — **developer sample**: an Agent-mode `llm-request` node
  with Auto deploy in a self-feedback loop over HTTP in/request nodes,
  hard-capped at 5 iterations (each loop costs
  one LLM request and one deploy — never remove the cap). Iteration 1 creates a
  small demo flow on a separate target tab and later iterations each improve it,
  until the LLM judges it complete and replies `END` (checked by the loop's
  `next loop URL` function) or the cap is hit; select the
  **Modified Flows** deploy type before running so the loop flow itself is never
  restarted mid-iteration. The instance's HTTP API endpoint base is set once in
  a change node (flow variable `apiBase`, default `http://127.0.0.1:1880`) —
  edit it there for embedded instances (e.g. `http://127.0.0.1:8000/api`).
