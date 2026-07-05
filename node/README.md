# LLM Plugin — Workflow Node

Runtime node registered alongside the sidebar (palette category **llm-plugin**)
so a flow can call an LLM. Provider, model and the target flows are set on the
node; API keys and URLs are inherited from the **LLM Plugin sidebar** (Settings).

## `LLM` node (`llm-request`)

| Field | Notes |
|-------|-------|
| Mode | **Ask** — reply on `msg.payload`. **Agent** — same, then applies the changes live in the open editor. |
| Provider | Ollama / OpenAI / Custom. Keys & URLs come from the sidebar. |
| Model | Free text (e.g. `llama3.1`, `gpt-4o-mini`). `msg.model` overrides per message. |
| Flows | Multi-select (none / one / many). Sent to the LLM as context in **both** modes; the list refreshes when the node is opened. |
| Editor URL | Used to read flow context. Blank = auto-detect (works when embedded in Express on a non-1880 port). `msg.editorUrl` overrides. |
| Timeout | Seconds; default **3600** (1 h — local LLMs can be slow). `0` = no limit. `msg.timeout` overrides per message. |
| Auto deploy | **Agent only, developer feature.** When checked, the editor deploys immediately after applying the changes (`RED.actions.invoke('core:deploy-flows')` — same as clicking Deploy, so the dirty state clears properly). The deploy is async: the editor's own deploy toast reports the outcome. No review step; keep a single editor open; prefer the Modified Nodes/Flows deploy type; use only on disposable dev instances. |

**Inputs:** `payload` (prompt; strings are newline-normalised, objects are
JSON-stringified). **Outputs:** `payload` (text reply — do not `JSON.parse` it),
`llm` (mode/provider/model/elapsed), and in Agent mode `flow`
(`{ targetFlows, dispatchedToEditor }`).

**Status:** blue dot while requesting (ticks the elapsed seconds), green
`done (…)` / `sent to editor` on success, red `error` / `timeout` on failure.

## How Agent mode applies changes

A runtime node can't edit the browser canvas directly, so it publishes the reply
over Node-RED's comms channel; a subscriber in `llm-request.html` (running in the
editor) applies it with the plugin's importer — the same path as the sidebar.

- An **editor must be open** with the plugin loaded; headless runs have no canvas.
- **No chat history** and **no Restore Checkpoint** for node interactions (unlike
  the sidebar). Review on the canvas before Deploy; use the editor's undo if needed.
- There is intentionally **no "deploy" node**: a server-side node cannot reproduce
  the editor's Deploy button (it deploys the browser's editor state — purely
  client-side). Agent mode applies edits live, which you then Deploy yourself —
  or check **Auto deploy** and the editor-side subscriber invokes the editor's
  own Deploy action right after applying (that's why it works where a server-side
  deploy node couldn't: the browser itself deploys).

## Files

```
node/
  lib/admin_api.js          GET /flows client (read flow context; auto-detects the instance)
  llm-request/llm-request.js    runtime: prompt build + provider call + comms publish
  llm-request/llm-request.html  editor: config UI + comms subscriber that applies via the importer
```

The shared LLM engine (settings, credentials, provider adapters, prompt build)
lives in [`../src/llm_core.js`](../src/llm_core.js) and is reused by the sidebar.

## Examples

Import via **Menu → Import → Examples** (or the JSON files in `examples/`):

- `llm-request-simple` — minimal inject → LLM (Ask) → debug.
- `llm-nodes` — Ask and Agent side by side.
- `llm-self-feedback` — **developer sample**: Agent + Auto deploy self-feedback
  loop over HTTP in/request nodes, hard-capped at 5 iterations (each loop costs
  one LLM request and one deploy — never remove the cap). The LLM's edit target
  sits on a separate tab; select the **Modified Flows** deploy type before
  running so the loop flow itself is never restarted mid-iteration. Non-default
  host/port: set the `LLM_LOOP_BASE` env var.
