# LLM Plugin — Source Implementation Guide

Technical reference for the client and server modules behind the LLM
Plugin sidebar.

## Big picture

```
Editor sidebar (vibe_ui)  ──Send──►  /llm-plugin/{generate,agent-generate}  ──►  Ollama / OpenAI
        ▲                                              │
        │                                              ▼
   addMessageToUI                          response { response, model, elapsed }
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
| `addMessage(content, isUser, meta?)` | Append + persist; renders via `UI.addMessageToUI`. |
| `saveChatToServer(chatId)` | `POST /save-chat`. |
| `loadChatHistoriesFromServer()` | `GET /chat-histories`. Auto-loads the most recent if none open. |
| `loadChat(chatId)` | Replay messages into the chat area. |
| `showChatList()` / `deleteChat(chatId, cb)` | Chat-list modal. |
| `saveImportCheckpoint(chatId?, flowIds?)` | Snapshot the flow immediately before an import; ID attached to the message so the per-message Restore button rewinds to that point. Called by the UI at import-button click time — not on every chat send. |
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

1. **Merge semantics** — every import adds/updates listed nodes,
   deletes aliases mapped to `null`, and leaves everything not mentioned
   alone. There is no `applyMode` field; one schema can freely combine
   adds, updates, and deletions.
2. **Additive wire merge** — when a proposed node matches an existing
   one, its `wires` are unioned with the existing wires (per port).
   Connections are only severed by explicit `remove` directives.
3. **Property preservation** — properties the LLM did NOT mention are
   restored from the existing node. Mentioned-key set comes from
   `_llmSpecKeys` (Vibe Schema path) or `n[key] !== undefined`
   (raw-JSON path), so normaliser-default values don't override user
   settings.
4. **Comment placement** — every comment names its target canvas node
   via `above: <alias>` and lands directly atop that node with zero grid
   gap. New comments stack above any existing comment touching the same
   target instead of overlapping. Legacy schemas without `above` fall
   back to "next canvas node in declaration order"; trailing comments
   are dropped. See [core/LAYOUT.md](./core/LAYOUT.md#comment-placement).
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
| `addMessageToUI(content, isUser, showActions, messageMeta?)` | Render message + retry / import buttons; assistant messages show a `mode / model / 1.5s` badge. Also runs `annotateNodeReferences` on assistant messages so inline backtick'd node names become clickable. |
| `formatMessage(text)` | `marked.parse` with XSS-safe pre-escape of `<` / `>`. |
| `annotateNodeReferences(rootEl)` | Two-pass scan that makes node mentions clickable. **Pass 1**: every inline `<code>` (skipping `<pre>`-nested ones) is resolved via `LlmJsonParser.buildFlowLookup(...).resolve` against the live `RED.nodes` set; matches become `code.llm-node-ref` with a focus handler. **Pass 2**: walks the remaining text nodes (skipping `<code>/<pre>/<a>/<script>/<style>`) and replaces any token that exactly matches a known alias (length ≥ 3) — this catches plain-prose mentions when the LLM forgets to backtick. Both singleton aliases (`inject`, `debug`) and compound ones (`change_create_sensor_json`) are matched; sort-longest-first plus `\b` boundaries make sure `change_temperature_series` beats `change` on overlapping spans. Tabs are skipped; config nodes ARE included (they open the edit dialog on click). The system prompt also instructs the LLM to backtick node aliases, so Pass 1 is the primary path. |
| `focusCanvasNode(nodeId)` | Debug-sidebar-style focus for canvas nodes: switch to the node's tab via `RED.workspaces.show`, set `node.highlighted = true` for a flash, call `RED.view.reveal(node.id)` to centre the viewport (matches the Debug sidebar's exact invocation), force `RED.view.redraw()`, then clear the flash after ~2.5 s. Config nodes have no canvas position, so they open via `RED.editor.editConfig('', node.type, node.id)` (with `RED.editor.edit(node)` as fallback). Notifies if the node has since been deleted. Exposed as `LLMPlugin.UI.focusCanvasNode`. |
| `reannotateAllAssistantMessages()` | Re-runs `annotateNodeReferences` on every assistant message in the chat panel. Registered once at module load against `RED.events` (`flows:loaded` / `deploy` / `workspace:change` / `nodes:add` / `nodes:remove` / `nodes:change`) and debounced 200 ms. Solves the cold-start race where the side panel renders chat history before `RED.nodes` is populated, and also keeps existing badges in sync when the user edits / deploys / imports new nodes. |
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
| Settings + credentials | `getPluginSettings`, `savePluginSettings`, `loadCreds` / `persistCreds` / `setCredField`, `maskApiKey`, `redactSecrets` |
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

No chat history is sent — each request is stateless to the LLM.

#### Security measures

- All endpoints sit on `RED.httpAdmin` (picks up `adminAuth` when
  configured).
- API key is stored encrypted in `<userDir>/llm-plugin/credentials.json`
  using AES-256-CTR with Node-RED's `credentialSecret` (or auto-generated
  `_credentialSecret`) — the same algorithm used for `flows_cred.json`,
  but in a plugin-owned file so `cleanCredentials` can't strip it on
  deploy. Plaintext keys from older installs (and any leftover from the
  earlier synthetic-id `addCredentials` attempt) are migrated
  automatically on first boot.
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
- **Chat / checkpoint storage**: server-side, in the first writable
  location of: `<RED.settings.userDir>/llm-plugin/`,
  `<os.tmpdir()>/llm-plugin/`, or **memory-only** (logs a warning and
  keeps everything in RAM until the server restarts). The plugin no
  longer writes to its own install directory, so it installs cleanly on
  sandboxed cloud Node-RED hosts (enebular, etc.) where the plugin
  directory is read-only.
- **`prompt_system.txt`** is loaded from the plugin install dir on
  startup; if that read fails (extreme sandbox), a minimal embedded
  prompt is used as fallback.
- **Settings storage**: non-secret fields live in
  `RED.settings.get/set('llmPluginSettings')` (Node-RED's internal
  config, not in exported flows). The OpenAI API key is split off into
  the encrypted credentials store — see Security measures above.
- **Adding a new endpoint**: add to `server.js`, restart Node-RED.
- **Adding a new client module**: drop file under `src/`, add to the
  load list in `client.js`, expose on `window.LLMPlugin`.
