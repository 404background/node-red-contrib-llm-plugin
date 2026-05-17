# LLM Plugin — Source Implementation Guide

Technical reference for the client and server modules that make up the LLM Plugin sidebar.

---

## Architecture Overview

```
llm_plugin.js          Node-RED plugin entry point — loads server.js
llm_plugin.html        Settings template (<script type="text/html">) + CDN links
llm-plugin_styles.css  All plugin CSS
src/
  client.js            Browser entry — sequential script loader
  core/
    canvas_layout.js        Standalone layout engine (UMD) — see core/LAYOUT.md
    flow_converter_core.js  Vibe Schema ⇄ Node-RED JSON converter (UMD) — see core/VIBE_SCHEMA.md
    llm_json_parser.js      LLM output parsing utilities — JSON repair, fuzzy matching, schema extraction (UMD)
    LAYOUT.md               Layout engine reference
    VIBE_SCHEMA.md          Intermediate-format reference
  chat_manager.js      Chat CRUD, server persistence (fetch API)
  importer.js          JSON extraction from LLM output + Node-RED import
  ui_core.js           Message rendering, flow export, retry logic
  settings.js          Settings dialog controller (provider toggle, load/save)
  vibe_ui.js           Main sidebar UI construction + generation workflow
  server.js            All backend logic — endpoints, prompts, LLM adapters
  prompt_system.txt    System prompt template (loaded at startup by server.js)
```

### Loading sequence

1. Node-RED loads `llm_plugin.html` which includes CDN resources (Font Awesome, marked.js) and the settings form template.
2. `llm_plugin.html` loads `llm-plugin/src/client.js`.
3. `client.js` dynamically injects the remaining scripts **in order**:
  `core/canvas_layout.js` → `core/flow_converter_core.js` → `core/llm_json_parser.js` → `chat_manager.js` → `importer.js` → `ui_core.js` → `settings.js` → `vibe_ui.js`
  (`canvas_layout` must precede `flow_converter_core` because the converter's `toNodeRed` delegates layout to it.)
4. `vibe_ui.js` polls for `RED.sidebar` availability, then registers the sidebar tab.

All client modules use the **IIFE pattern** `(function(){ ... })()` and communicate through the shared `window.LLMPlugin` namespace.

---

## Client Modules

### client.js

Minimal sequential script loader. Loads each module via dynamic `<script>` tags. Order matters because later modules depend on earlier ones.

### core/flow_converter_core.js — Vibe Schema converter

**UMD module** (`window.LLMPlugin.FlowConverterCore`, also aliased as
`Configurator`). Bi-directional converter between LLM-friendly Vibe
Schema and Node-RED's native JSON, plus type-detection helpers
(`isConfigNode`, `isCanvasNode`, `isNoInputType`, `isNoOutputType`,
`setRuntimeGetType`).

Full reference: **[core/VIBE_SCHEMA.md](./core/VIBE_SCHEMA.md)** — schema
shape, alias rules, round-trip semantics, detection helpers.

### core/canvas_layout.js — layout engine

**UMD module** (`window.LLMPlugin.CanvasLayout`). Standalone layout for
Node-RED node arrays. No dependency on the converter; can be used by any
tool that produces Node-RED flows.

Full reference: **[core/LAYOUT.md](./core/LAYOUT.md)** — `layoutNodes` /
`reflowCanvasNodes` / `placeAddedNodesNearNeighbors` with every pass
documented, plus standalone usage examples.

### core/llm_json_parser.js — LLM output parser

**UMD module** (`window.LLMPlugin.LLMJsonParser`). Handles the ambiguity
that LLMs produce when generating JSON:

| Category | Functions |
|---|---|
| Token normalization | `normalizeToken`, `normalizeTokenLoose`, `putUniqueToken`, `resolveUniqueApprox` |
| JSON repair | `stripJsonComments`, `repairJsonQuotes`, `collectBalancedJsonSnippets` |
| Vibe Schema extraction | `extractVibeSchema`, `extractConnectionHints`, `extractFlowDirectives` |
| Flow lookup | `buildFlowLookup` — alias/name/ID → node ID resolution with fuzzy fallback |
| Schema resolution | `resolveAliasInSchema`, `mergeAgentPartialSchemaWithCurrentFlow` |
| Flow node extraction | `normalizeSchemaForConversion`, `tryParseFlowNodes`, `extractFlowNodes` |

No dependency on plugin globals; callers pass a converter object
explicitly.

### chat_manager.js

Manages the chat session lifecycle.

| API | Description |
|-----|-------------|
| `ChatManager.getCurrentChatId()` | Returns (or creates) the active chat ID |
| `ChatManager.getChatHistory()` | Returns the in-memory chat history object |
| `ChatManager.startNewChat()` | Creates a fresh chat session, clears UI |
| `ChatManager.addMessage(content, isUser, meta?)` | Appends message + metadata to history/UI and persists |
| `ChatManager.saveChatToServer(chatId)` | `POST /llm-plugin/save-chat` |
| `ChatManager.loadChatHistoriesFromServer()` | `GET /llm-plugin/chat-histories` |
| `ChatManager.loadChat(chatId)` | Replays messages into the chat area |
| `ChatManager.showChatList()` | Builds and shows the chat history modal |
| `ChatManager.deleteChat(chatId, cb)` | `POST /llm-plugin/delete-chat` |
| `ChatManager.ensureBaselineCheckpoint(chatId?)` | Saves pre-edit checkpoint at chat start |
| `ChatManager.getBaselineCheckpointId(chatId?)` | Returns the baseline checkpoint ID for a chat |
| `ChatManager.updateMessageMeta(messageId, patch)` | Patches stored message metadata |

Uses **`fetch`** for all server calls. DOM manipulation uses plain `document.createElement` / `document.getElementById`.

### importer.js

Extracts Node-RED flow JSON from LLM responses and imports it into the editor.

**`extractFlowNodes(messageContent)`** — Main extraction pipeline:
1. Scan for fenced code blocks (` ```json `, ` ``` `, ` ```javascript ` — case-insensitive).
2. Try parsing each block as JSON; pick the **last valid** block (LLMs tend to refine output).
3. If parsed JSON is Vibe Schema, convert it with `Configurator.toNodeRed()`.
4. Fallback: raw Node-RED arrays `[…]`, `{nodes:[…]}`, or single `{type:"…"}` objects.
5. Fallback: parse balanced raw JSON objects/arrays outside code fences (supports explanation text + inline JSON).
6. Comment stripping is string-safe, so `//` in function code strings is preserved.

**`importFlowFromMessage(messageContent, options)`** — Full import workflow:
1. Extract nodes via `extractFlowNodes`.
2. Resolve `applyMode` from the top-level response JSON when available; safe fallback to `edit-only`.
3. Collect connection / deletion directives and rebuild a full workspace snapshot.
4. **Additive wire merge**: when an LLM-proposed node matches an existing one, its proposed `wires` are unioned with the existing wires (per port). Connections are only severed by explicit `remove` directives in `connections`.
5. **Property preservation**: properties the LLM did NOT mention are restored from the existing node. The exact "mentioned" set is taken from `_llmSpecKeys` (Vibe Schema path) or, for raw Node-RED JSON, every defined key on the proposed node.
6. Comment nodes are repositioned by their schema declaration order so they land between the canvas nodes the LLM listed them next to (see [core/LAYOUT.md](./core/LAYOUT.md)).
7. Replace active workspace flow atomically.

**`restoreCheckpoint(checkpointId)`** — Loads a saved checkpoint from the server and replaces the active workspace flow.

**`hasFlowDirectives(messageContent)`** — Returns `true` if the message contains connection hints or deletion directives (used to show the Import button even when no nodes are extracted).

### ui_core.js

Rendering and utility layer.

- **`escapeHtml(str)`** — XSS protection for the fallback formatter.
- **`formatMessage(text)`** — Uses `marked.parse()` when available; otherwise falls back to a simple regex-based Markdown→HTML converter.
- **`addMessageToUI(content, isUser, showActions)`** — Creates the message DOM element, attaches retry/import buttons.
- **`retryLastUserMessage()`** — Finds the last user message and re-triggers generation.
- **`getFlowsByIds(flowIds)`** — Exports all nodes on the given workspace tabs (deduped) plus their referenced config nodes (BFS, e.g. `ui_button` → `ui-group` → `ui-tab`). Uses `RED.nodes.createExportableNodeSet` to strip credentials; falls back to manual cloning on older Node-RED versions.
- **`getCurrentFlow()`** — Convenience wrapper that calls `getFlowsByIds([RED.workspaces.active()])`.

### settings.js

Small controller that binds to the settings form defined in `llm_plugin.html`.

- Accepts a **raw DOM element** as `root` (the settings dialog container).
- Returns `{ load, save, updateVisibility }`.
- Provider toggle: shows/hides Ollama URL vs OpenAI API key fields.
- API key is never pre-filled; a masked placeholder is shown instead.
- Max Prompt Length: configurable limit (100 - 100,000 characters) enforced server-side.

### vibe_ui.js

The main entry module. Builds the entire sidebar DOM tree and wires up all interactive behaviour.

**`createLLMPluginUI()`**
  - Constructs the sidebar layout using HTML string literals (header, chat area, input area, settings overlay).
  - Initialises the settings manager.
  - Schedules `initializeClientApp()` after a short delay.

**`initializeClientApp(settingsManager)`**
  - Binds all event listeners (generate, stop, settings open/close/save, Ctrl+Enter).
  - Manages the generate/stop toggle using a single click handler + `classList` state, with a Ctrl+Enter double-trigger guard.
  - Uses `AbortController` for fetch cancellation.
  - Mode UX: `change` toast confirms dropdown switches; mode dropdown is disabled while a request is in flight; assistant messages render a per-turn mode badge (`ask|agent / model / 1.5s`).
  - Flow selector: subscribes to `flows:add/change/remove` + `workspace:change` to prune deleted flow IDs from the selection.
  - Settings dialog: focus management, Escape key, backdrop click.

**`initializeWhenReady()`** — Polls `RED.sidebar` and calls `RED.sidebar.addTab(…)` to register the tab.

---

## Server Module (server.js)

Node.js module loaded by `llm_plugin.js`. Exports `createLLMPluginServer(RED)`.

### Section layout

| Section | Key functions |
|---------|--------------|
| Settings persistence | `getPluginSettings()`, `savePluginSettings()`, `maskApiKey()`, `redactSecrets()` |
| Ollama model discovery | `listOllamaModels()` (CLI + HTTP), `listOllamaModelsFromApi()` |
| Chat history persistence | `saveChatHistory()`, `loadAllChatHistories()` — per-chat JSON files |
| Prompt construction | `buildFlowContextDescription()`, `buildMessages()` — loads `prompt_system.txt`, uses Configurator |
| LLM adapters | `generateWithOllamaChat()` (`/api/chat`), `generateWithOpenAI()` (SDK) |
| HTTP admin endpoints | All `RED.httpAdmin.*` routes |

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/llm-plugin/generate` | Send prompt + flow context to LLM |
| POST | `/llm-plugin/agent-generate` | Agent mode generation (single validation pass) |
| GET | `/llm-plugin/settings` | Read settings (API key masked) |
| POST | `/llm-plugin/settings` | Write settings (whitelisted fields) |
| GET | `/llm-plugin/ollama/models` | List available Ollama models |
| GET | `/llm-plugin/chat-histories` | List all persisted chats |
| POST | `/llm-plugin/save-chat` | Persist a chat session |
| POST | `/llm-plugin/delete-chat` | Delete by filename or ID |
| POST | `/llm-plugin/checkpoint/save` | Save flow snapshot for restore |
| GET | `/llm-plugin/checkpoint/:id` | Load saved checkpoint |
| POST | `/llm-plugin/client-log` | Write structured client event to server log |
| GET | `/llm-plugin_styles.css` | Serve plugin stylesheet |
| GET | `/llm-plugin/src/*` | Serve client JS modules |

### Security measures

- **Authentication**: all endpoints are registered on `RED.httpAdmin`, which applies Node-RED's `adminAuth` middleware when configured. No plugin-level access control is added to avoid conflicting with Node-RED's built-in security model.
- **API key**: never returned to the client; masked via `maskApiKey()`. POST whitelist prevents field injection.
- **Prompt length limit**: configurable `maxPromptLength` setting (default 10,000 characters) enforced server-side on both `/generate` and `/agent-generate`.
- **Path traversal**: `path.basename()` + `startsWith()` containment check on file-serving and deletion routes.
- **Error sanitisation**: `redactSecrets()` strips API keys, URLs, and IP addresses from all error messages and client logs before output.
- **Credentials**: stripped from flow context before sending to the LLM.

### Prompt structure

The system prompt is stored in **`src/prompt_system.txt`** — a plain-text file loaded once at startup by `server.js`. This makes it easy to review and edit the prompt without touching code.

At runtime, `buildMessages()` builds chat messages with optional flow context (Vibe Schema):

```
messages[0] = {
  role: "system",
  content: <user system prompt (from settings), if set>
           + <contents of prompt_system.txt>
           + optional "CURRENT FLOW (Vibe Schema): ..."
}
messages[1] = {
  role: "user",
  content: <user prompt>
}
```

`prompt_system.txt` lists the four valid `applyMode` values; the LLM picks one in its JSON response (`detectApplyModeFromResponse` extracts it on the server side as a fallback).

The existing flow is automatically converted to Vibe Schema via `Configurator.toIntermediate()` before being included in the prompt, so the LLM sees a consistent format in both directions.

No chat history is sent — each request is stateless from the LLM's perspective.

---

## Data Flow

```
User types prompt
      │
      ▼
  vibe_ui.handleGenerate()
      │  reads model, prompt, checkbox
      │  calls ChatManager.addMessage(prompt, true)
      │  optionally calls UI.getCurrentFlow()
      │
      ▼
  fetch POST /llm-plugin/generate  ──────────────────►  server.js
  (or /llm-plugin/agent-generate)                           │
      │                                          Configurator.toIntermediate(flow)
      │                                                     │
      │                                               buildMessages(prompt, currentFlow)
      │                                              (system message + user message; optional CURRENT FLOW)
      │                                                     │
      │                                         ┌───────────┴──────────┐
      │                                 Ollama chat adapter      OpenAI adapter
      │                                  (/api/chat HTTP)        (openai SDK)
      │                                         └───────────┬──────────┘
      │                                                     │
      ◄──────── JSON { response, elapsed, applyMode, agent? }
      │
      ▼
  ChatManager.addMessage(response, false)
      │  persists to server (POST /save-chat)
      │  calls UI.addMessageToUI(response, …)
      │     └── Importer.extractFlowNodes(response)
      │            → detects Vibe Schema → Configurator.toNodeRed()
      │            → or parses raw JSON object/array from mixed text (backward compatible)
      │            → shows "Import Flow" button if nodes found
      │            → Agent mode auto-imports extracted flow
      ▼
  Chat area updated
```

---

## Development Notes

- **No jQuery**: All client modules use vanilla DOM APIs and the `fetch` API. jQuery is available in the Node-RED editor environment but is intentionally not used.
- **Module communication**: Via `window.LLMPlugin` namespace (`CanvasLayout`, `FlowConverterCore` / `Configurator`, `LLMJsonParser`, `ChatManager`, `UI`, `Importer`).
- **Core load order**: `canvas_layout.js` first (no deps), then `flow_converter_core.js` (depends on it), then `llm_json_parser.js` (independent). Both the converter and the parser are also required by `server.js`.
- **Backward compatibility**: The importer auto-detects both Vibe Schema and raw Node-RED JSON. If an LLM outputs the old format, it still works.
- **Adding a new endpoint**: Add the route in the *HTTP admin endpoints* section of `server.js`. Restart Node-RED to apply.
- **Adding a new client module**: Create a new file under `src/`, add it to the load list in `client.js`, and expose its API on `window.LLMPlugin`.
- **Chat storage**: JSON files in `<plugin-root>/.logs/llm-plugin/chats/` with pattern `YYYY-MM-DD-<title>-<id>.json`. Checkpoints live alongside in `.logs/llm-plugin/checkpoints/`.
- **Settings storage**: `RED.settings.get/set('llmPluginSettings')` — persisted in Node-RED's internal config, not in exported flows.