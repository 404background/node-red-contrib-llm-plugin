# LLM Plugin — Source Implementation Guide

Technical reference for the client and server modules behind the LLM
Plugin sidebar.

## Big picture

```
Editor sidebar (vibe_ui)  ──Send──►  /llm-plugin/{generate,agent-generate}  ──►  Ollama / OpenAI
        ▲                                              │
        │                                              ▼
   addMessageToUI                          response { applyMode, response }
   importFlowFromMessage  ◄──────────────────────────────┘
        │
        ├── extractFlowNodes  (LLMJsonParser → Vibe Schema → FlowConverterCore.toNodeRed)
        ├── rebuildWorkspaceFromSnapshot (additive wires + property preservation)
        └── replaceWorkspaceFlow → RED.nodes.import → CanvasLayout positions x / y
```

Three independent core modules under `src/core/` form the conversion +
layout backbone:

| Module | Owns | Reference |
|--------|------|-----------|
| `flow_converter_core.js` | Vibe Schema ↔ Node-RED JSON + type detection helpers | [core/VIBE_SCHEMA.md](./core/VIBE_SCHEMA.md) |
| `canvas_layout.js` | Topological layout, width-aware spacing, comment placement | [core/LAYOUT.md](./core/LAYOUT.md) |
| `llm_json_parser.js` | JSON repair, fuzzy alias matching, schema extraction | (inline JSDoc) |

The rest of `src/` is plugin-specific glue: `importer.js` orchestrates
the import; `chat_manager.js` handles session persistence; `ui_core.js`
+ `vibe_ui.js` build the sidebar; `server.js` exposes HTTP endpoints.

## File map

```
llm_plugin.js           Node-RED plugin entry point — loads server.js
llm_plugin.html         Settings template + CDN links
llm-plugin_styles.css   All plugin CSS
src/
  client.js             Sequential script loader (browser entry)
  prompt_system.txt     System prompt template (server-side)
  core/
    canvas_layout.js    Layout engine (UMD)             ← core/LAYOUT.md
    flow_converter_core.js  Vibe Schema converter (UMD) ← core/VIBE_SCHEMA.md
    llm_json_parser.js  LLM JSON parsing (UMD)
    LAYOUT.md
    VIBE_SCHEMA.md
  chat_manager.js       Chat session CRUD + checkpoint persistence
  importer.js           Extract LLM output, rebuild & import into editor
  ui_core.js            Message rendering, flow export
  settings.js           Settings dialog controller
  vibe_ui.js            Sidebar build + generation workflow
  server.js             HTTP endpoints, prompts, LLM adapters
```

## Loading sequence (client)

`llm_plugin.html` includes `<script src="llm-plugin/src/client.js">`,
which fetches and runs the rest **in order**:

```
canvas_layout → flow_converter_core → llm_json_parser
              → chat_manager → importer → ui_core → settings → vibe_ui
```

`canvas_layout` must precede `flow_converter_core` because the
converter's `toNodeRed` delegates layout to it. All modules use the IIFE
pattern and communicate via `window.LLMPlugin`.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/llm-plugin/generate` | Send prompt + flow context to LLM |
| POST | `/llm-plugin/agent-generate` | Agent-mode generation (auto-import on the client) |
| GET / POST | `/llm-plugin/settings` | Read / write settings (whitelisted fields; API key masked on read) |
| GET | `/llm-plugin/ollama/models` | List available Ollama models |
| GET | `/llm-plugin/chat-histories` | List persisted chats |
| POST | `/llm-plugin/save-chat` | Persist a chat |
| POST | `/llm-plugin/delete-chat` | Delete by filename or chat id |
| POST | `/llm-plugin/checkpoint/save` | Save flow snapshot |
| GET | `/llm-plugin/checkpoint/:id` | Load saved checkpoint |
| POST | `/llm-plugin/client-log` | Write a structured client event to the server log |
| GET | `/llm-plugin_styles.css` | Serve plugin stylesheet |
| GET | `/llm-plugin/src/*` | Serve client JS modules |

All routes register on `RED.httpAdmin`, picking up Node-RED's own
`adminAuth` middleware automatically.

## Module reference

### `client.js`

Minimal sequential script loader.

### `core/flow_converter_core.js` — Vibe Schema converter

UMD (`window.LLMPlugin.FlowConverterCore`, alias `Configurator`).
Bi-directional converter plus type-detection helpers (`isConfigNode`,
`isCanvasNode`, `isNoInputType`, `isNoOutputType`, `setRuntimeGetType`).
See [core/VIBE_SCHEMA.md](./core/VIBE_SCHEMA.md).

### `core/canvas_layout.js` — layout engine

UMD (`window.LLMPlugin.CanvasLayout`). Standalone — no plugin
dependencies. See [core/LAYOUT.md](./core/LAYOUT.md).

### `core/llm_json_parser.js` — LLM output parser

UMD (`window.LLMPlugin.LLMJsonParser`). Tolerates the way LLMs format
JSON: comment stripping, quote repair, fuzzy alias matching, and Vibe
Schema extraction from prose-mixed responses.

| Category | Functions |
|----------|-----------|
| Token normalization | `normalizeToken`, `normalizeTokenLoose`, `putUniqueToken`, `resolveUniqueApprox` |
| JSON repair | `stripJsonComments`, `repairJsonQuotes`, `collectBalancedJsonSnippets` |
| Schema extraction | `extractVibeSchema`, `extractConnectionHints`, `extractFlowDirectives` |
| Flow lookup | `buildFlowLookup` (alias / name / ID → node ID, fuzzy fallback) |
| Node extraction | `normalizeSchemaForConversion`, `tryParseFlowNodes`, `extractFlowNodes` |
| Agent helper | `resolveAliasInSchema`, `mergeAgentPartialSchemaWithCurrentFlow` |

### `chat_manager.js`

Chat session lifecycle.

| API | Description |
|-----|-------------|
| `getCurrentChatId()` / `getChatHistory()` / `startNewChat()` | In-memory session control. |
| `addMessage(content, isUser, meta?, targetFlowIds?)` | Append + persist; renders via `UI.addMessageToUI`. |
| `saveChatToServer(chatId)` | `POST /save-chat`. |
| `loadChatHistoriesFromServer()` | `GET /chat-histories`. Auto-loads the most recent if none open. |
| `loadChat(chatId)` | Replay messages into the chat area. |
| `showChatList()` / `deleteChat(chatId, cb)` | Chat-list modal. |
| `ensureBaselineCheckpoint(chatId?, flowIds?)` | Save the pre-edit baseline at chat start (Agent mode). |
| `savePreSendCheckpoint(chatId?, flowIds?)` | Snapshot the flow at send time; ID attached to the assistant message. |
| `updateMessageMeta(messageId, patch)` | Patch stored message metadata. |

### `importer.js`

Extracts Node-RED flow JSON from LLM responses and imports it into the
editor.

**`extractFlowNodes(messageContent)`** —
Scan fenced ```` ```json ```` / ```` ```javascript ```` blocks (picking
the *last* valid block), parse with `LLMJsonParser`, prefer Vibe Schema
via `Configurator.toNodeRed()`, fall back to raw Node-RED arrays or
inline JSON outside code fences. Comment stripping is string-safe so
`//` inside `function` code is preserved.

**`importFlowFromMessage(messageContent, options)`** —
Full import workflow with these guarantees:

1. Resolve `applyMode` from the JSON response; safe fallback to
   `edit-only`.
2. **Additive wire merge** — when a proposed node matches an existing
   one, its `wires` are unioned with the existing wires (per port).
   Connections are only severed by explicit `remove` directives.
3. **Property preservation** — properties the LLM did NOT mention are
   restored from the existing node. Mentioned-key set comes from
   `_llmSpecKeys` (Vibe Schema path) or `n[key] !== undefined`
   (raw-JSON path), so normaliser-default values don't override user
   settings.
4. **Comment placement** — comments only survive if they appear
   immediately before a canvas node in schema declaration order (a
   leading summary header); other positions are dropped. See
   [core/LAYOUT.md](./core/LAYOUT.md#comment-placement).
5. **Config Node Protection** — the LLM cannot create or delete config
   nodes; it can only reference existing ones by alias.
6. Replace the active workspace atomically; layout is delegated to
   `CanvasLayout`.

**`restoreCheckpoint(checkpointId)`** — Load a saved checkpoint and
replace the workspace flow (with a deferred SVG redraw to avoid the
"wires-only" render race).

### `ui_core.js`

| API | Purpose |
|-----|---------|
| `addMessageToUI(content, isUser, showActions, messageMeta?)` | Render message + retry / import buttons; assistant messages show a `mode / model / 1.5s` badge. |
| `formatMessage(text)` | `marked.parse` with XSS-safe pre-escape of `<` / `>`. |
| `createRestoreCheckpointButton(checkpointId)` | Shared Restore button used by chat-baseline rows and per-message restore rows. |
| `getFlowsByIds(flowIds)` / `getCurrentFlow(flowIds?)` | Export selected workspace tabs + referenced config nodes (credentials stripped via `RED.nodes.createExportableNodeSet`). |
| `getActiveWorkspaceId()` / `extractWorkspaceIds(nodes)` | Workspace ID helpers. |
| `retryLastUserMessage()` | Re-send the most recent user prompt. |

### `settings.js`

Settings dialog controller; binds to the form template in
`llm_plugin.html`. Returns `{ load, save, updateVisibility }`. Provider
toggle, masked API-key placeholder, max prompt length (100–100 000).

### `vibe_ui.js`

Main sidebar entry. `createLLMPluginUI()` builds the DOM;
`initializeClientApp()` wires events:

- Generate / Stop toggle (single click handler + `classList`,
  Ctrl+Enter double-trigger guard).
- `AbortController` for fetch cancellation.
- **Mode UX**: `change` toast on dropdown switch; dropdown disabled
  during in-flight requests; per-message mode badge in the elapsed
  line.
- **Flow selector**: subscribes to `flows:add` / `flows:change` /
  `flows:remove` and `workspace:change`, prunes stale ids, displays
  *Current Open Flow* when only the active tab is selected.
- Settings dialog: focus management, Escape key, backdrop click.

`initializeWhenReady()` polls `RED.sidebar` and registers the tab.

### `server.js`

| Section | Key functions |
|---------|---------------|
| Settings | `getPluginSettings`, `savePluginSettings`, `maskApiKey`, `redactSecrets` |
| Ollama discovery | `listOllamaModels` (CLI + HTTP), `listOllamaModelsFromApi` |
| Chat history | `saveChatHistory`, `loadAllChatHistories` (per-chat JSON files) |
| Prompt construction | `buildFlowContextDescription`, `buildMessages` (loads `prompt_system.txt`, calls `Configurator.toIntermediate`) |
| LLM adapters | `generateWithOllamaChat` (`/api/chat`), `generateWithOpenAI` (SDK) |
| HTTP admin endpoints | All `RED.httpAdmin.*` routes |

Prompt assembly:

```
messages[0] = {
  role: "system",
  content: <user system prompt (from settings), if set>
           + <contents of prompt_system.txt>
           + optional "CURRENT FLOW (Vibe Schema): ..."
}
messages[1] = { role: "user", content: <user prompt> }
```

`prompt_system.txt` lists the four valid `applyMode` values; the LLM
picks one and includes it in its JSON response.
`detectApplyModeFromResponse` extracts it server-side as a fallback. No
chat history is sent — each request is stateless to the LLM.

#### Security measures

- All endpoints sit on `RED.httpAdmin` (picks up `adminAuth` when
  configured).
- API key never returned to the client; masked via `maskApiKey()`. POST
  whitelist prevents field injection.
- Server-side `maxPromptLength` cap (default 10 000 chars, range
  100–100 000).
- Path traversal blocked by `path.basename` + `startsWith` containment
  on file-serving / deletion routes.
- `redactSecrets` strips API keys, URLs, and IPs from all error
  messages and client logs.
- Credentials stripped from flow context before sending to the LLM.

## Development notes

- **No jQuery** in client modules; vanilla DOM + `fetch`.
- **Module communication**: `window.LLMPlugin` namespace
  (`CanvasLayout`, `FlowConverterCore` / `Configurator`,
  `LLMJsonParser`, `ChatManager`, `UI`, `Importer`).
- **Chat storage**: `<plugin-root>/.logs/llm-plugin/chats/` with
  `YYYY-MM-DD-<title>-<id>.json`. Checkpoints alongside in
  `.logs/llm-plugin/checkpoints/`.
- **Settings storage**: `RED.settings.get/set('llmPluginSettings')` —
  in Node-RED's internal config, not in exported flows.
- **Adding a new endpoint**: add to `server.js`, restart Node-RED.
- **Adding a new client module**: drop file under `src/`, add to the
  load list in `client.js`, expose on `window.LLMPlugin`.
