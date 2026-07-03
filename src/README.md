# LLM Plugin — Source Implementation Guide

Technical reference for the client and server modules behind the LLM
Plugin sidebar.

## Big picture

```
Editor sidebar (vibe_ui)  ──Send──►  /llm-plugin/generate  ──►  Ollama / OpenAI / Custom
        ▲                                              │
        │                                              ▼
   addMessageToUI                          response { response, model, elapsed }
   importFlowFromMessage  ◄──────────────────────────────┘
        │
        ├── extractFlowNodes  (LLMJsonParser → Vibe Schema → FlowConverterCore.toNodeRed)
        ├── rebuildWorkspaceFromSnapshot (additive wires + property preservation
        │                                 + CanvasLayout positions x / y)
        └── replaceWorkspaceFlow → RED.nodes.import (canvas already laid out)
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
+ `vibe_ui.js` build the sidebar; `llm_core.js` is the shared LLM engine;
`server.js` exposes HTTP endpoints. The runtime workflow nodes under
`node/` reuse `llm_core.js` so they share one settings + credentials store
with the sidebar.

## File map

```
llm_plugin.js           Node-RED plugin entry point — loads server.js
llm_plugin.html         Sidebar + settings HTML templates, marked.js include
llm-plugin_styles.css   All plugin CSS
src/
  client.js             Script loader (browser entry) + settings dialog controller
  common.js             Shared helpers (escapeHtml, notify, el, randomId, …)
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
  vibe_ui.js            Sidebar build + generation workflow
  llm_core.js           Shared LLM engine (settings/creds/providers/prompts)
  server.js             HTTP endpoints + chat/checkpoint persistence
node/                   Runtime workflow node (category: llm-plugin)
  lib/admin_api.js      Local Node-RED Admin API client (GET/POST /flows)
  llm-request/          "LLM" node — Ask / Agent against msg.payload
```

## Loading sequence (client)

`llm_plugin.html` includes `<script src="llm-plugin/src/client.js">`,
which fetches and runs the rest **in order**:

```
common → canvas_layout → flow_converter_core → llm_json_parser
       → chat_manager → importer → ui_core → vibe_ui
```

`canvas_layout` must precede `flow_converter_core` because the
converter's `toNodeRed` delegates layout to it. All modules use the IIFE
pattern and communicate via `window.LLMPlugin`.

## HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/llm-plugin/generate` | Send prompt + flow context to LLM (both Ask and Agent; Agent's auto-import is client-side) |
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

Sequential script loader, plus the settings dialog controller
(`window.createLLMPluginSettings`): binds to the form template in
`llm_plugin.html`, returns `{ load, save, updateVisibility }` (provider
toggle, masked API-key placeholders, max prompt length 100–100 000).

### `common.js`

Shared helpers on `LLMPlugin.Common`: `escapeHtml`, `escapeRegExp`,
`notify` (RED.notify with guard), `el` (createElement shorthand),
`randomId`.

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
| Diagnostics | `diagnoseJsonExtractionFailure` — when `extractFlowNodes` returns null, re-parses each fenced block and returns the first concrete `JSON.parse` error with line/column/snippet so the importer can show "JSON parse failed at line X" instead of the generic "no JSON found". |
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

**`extractFlowNodes(messageContent, options?)`** —
Scan fenced ```` ```json ```` / ```` ```javascript ```` blocks (picking
the *last* valid block), parse with `LLMJsonParser`, prefer Vibe Schema
via `Configurator.toNodeRed()`, fall back to raw Node-RED arrays or
inline JSON outside code fences. Comment stripping is string-safe so
`//` inside `function` code is preserved. `options` accepts
`{ mode, currentFlow }` — when `mode === 'agent'`, the parser merges
the LLM's partial schema against the current flow (via
`mergeAgentPartialSchemaWithCurrentFlow`) so connection-resolution can
reach unmentioned nodes.

**`importFlowFromMessage(messageContent, options)`** —
Full import workflow with these guarantees:

1. **Merge semantics** — every import adds/updates listed nodes,
   deletes aliases mapped to `null`, and leaves everything not mentioned
   alone. There is no `applyMode` field; one schema can freely combine
   adds, updates, and deletions.
2. **Implicit flow inference** — when the schema omits `flow` tags but
   its nodes / connections reference existing aliases on multiple
   workspaces (a common LLM mistake when the conversation spans MCU /
   Server style splits), `inferImplicitFlowTagging` scans every
   workspace, seeds the tag for any schema alias that matches an
   existing canvas node, then propagates the tag through `connections`
   so brand-new nodes inherit the flow of their existing-node
   neighbors. The inferred-tagged schema is then handed to
   `collectFlowGroupsFromSchema` so the multi-flow dispatch fires even
   without explicit `flow` markers.
3. **Strict delete → add → connect ordering** —
   `rebuildWorkspaceFromSnapshot` runs three labeled phases so a single
   schema cannot contradict itself mid-merge:
   - *Phase 1 (Delete)* drops every node named in a delete directive
     from the snapshot.
   - *Phase 2 (Add/Update)* merges remaining proposals into `byId`,
     skipping any whose ID or `_llmAlias` was just removed in Phase 1.
   - *Phase 3 (Connect)* builds a unified alias map (existing
     auto-aliases ∪ new-node `_llmAlias` ∪ names ∪ IDs), prunes
     dangling wires, applies `removeConnections`, then adds the
     schema's `connections` via the same lookup so new-node aliases
     resolve regardless of which mode (ask / agent) produced them.
4. **Additive wire merge** — when a proposed node matches an existing
   one, its `wires` are unioned with the existing wires (per port).
   Connections are only severed by explicit `remove` directives.
5. **Property preservation** — properties the LLM did NOT mention are
   restored from the existing node. Mentioned-key set comes from
   `_llmSpecKeys` (Vibe Schema path) or `n[key] !== undefined`
   (raw-JSON path), so normaliser-default values don't override user
   settings.
6. **Comment placement** — every comment names its target canvas node
   via `above: <alias>` and lands directly atop that node with zero grid
   gap, **left edge aligned** with the target's left edge (not its
   centre). New comments stack above any existing comment touching the
   same target instead of overlapping. Comments with `above` are
   kept regardless of declaration order — only comments WITHOUT `above`
   AND with no canvas node later in the list are dropped. Legacy
   schemas without `above` fall back to "next canvas node in
   declaration order". See [core/LAYOUT.md](./core/LAYOUT.md#comment-placement).
7. **Config Node Protection** — the LLM cannot create or delete config
   nodes; it can only reference existing ones by alias.
8. **Reposition without ID churn** — a top-level `reposition: [alias…]`
   directive (see [core/VIBE_SCHEMA.md](./core/VIBE_SCHEMA.md#reposition-directive))
   reflows just the named canvas-node subset while keeping IDs, props,
   and wires. The subset is anchored to its previous top-left so the
   rest of the canvas doesn't visibly shift.
9. Replace the active workspace atomically; layout is delegated to
   `CanvasLayout`.

**`restoreCheckpoint(checkpointId)`** — Load a saved checkpoint and
replace the workspace flow (with a deferred SVG redraw to avoid the
"wires-only" render race).

### `ui_core.js`

| API | Purpose |
|-----|---------|
| `addMessageToUI(content, isUser, showActions, messageMeta?)` | Render message + retry / import buttons; assistant messages show a `mode / model / 1.5s` badge. Also runs `annotateNodeReferences` on assistant messages so inline backtick'd node names become clickable. |
| `formatMessage(text)` | `marked.parse` with XSS-safe pre-escape of `<` / `>`. |
| `annotateNodeReferences(rootEl, targetFlowIds?)` | Two-pass scan that makes node mentions clickable. **Pass 1**: every inline `<code>` (skipping `<pre>`-nested ones) is resolved via `LlmJsonParser.buildFlowLookup(...).resolve`; matches become `code.llm-node-ref` with a focus handler. **Pass 2**: walks the remaining text nodes (skipping `<code>/<pre>/<a>/<script>/<style>`) and replaces any token that exactly matches a known alias (length ≥ 3) — this catches plain-prose mentions when the LLM forgets to backtick. Both singleton aliases (`inject`, `debug`) and compound ones (`change_create_sensor_json`) are matched; sort-longest-first plus `\b` boundaries make sure `change_temperature_series` beats `change` on overlapping spans. Tabs are skipped; config nodes ARE included (they open the edit dialog on click). When `targetFlowIds` is provided, the alias map is rebuilt from `UI.getFlowsByIds(targetFlowIds)` — the exact same export the LLM saw — so numbered duplicate aliases (`change_2`, …) resolve back to the same node IDs. Without it, every node on the canvas is scanned. The system prompt also instructs the LLM to backtick node aliases, so Pass 1 is the primary path. |
| `focusCanvasNode(nodeId)` | Debug-sidebar-style focus for canvas nodes: switch to the node's tab via `RED.workspaces.show`, set `node.highlighted = true` for a flash, call `RED.view.reveal(node.id)` to centre the viewport (matches the Debug sidebar's exact invocation), force `RED.view.redraw()`, then clear the flash after ~2.5 s. Config nodes have no canvas position, so they open via `RED.editor.editConfig('', node.type, node.id)` (with `RED.editor.edit(node)` as fallback). Notifies if the node has since been deleted. Exposed as `LLMPlugin.UI.focusCanvasNode`. |
| `reannotateAllAssistantMessages()` | Re-runs `annotateNodeReferences` on every assistant message in the chat panel. Registered once at module load against `RED.events` (`flows:loaded` / `deploy` / `workspace:change` / `nodes:add` / `nodes:remove` / `nodes:change`) and debounced 200 ms. Solves the cold-start race where the side panel renders chat history before `RED.nodes` is populated, and also keeps existing badges in sync when the user edits / deploys / imports new nodes. |
| `createRestoreCheckpointButton(checkpointId)` | Shared Restore button. Inserted above the assistant message that triggered the import so a single click rewinds the workspace to the pre-edit snapshot. |
| `getFlowsByIds(flowIds)` / `getCurrentFlow(flowIds?)` | Export selected workspace tabs + referenced config nodes (credentials stripped via `RED.nodes.createExportableNodeSet`). |
| `getActiveWorkspaceId()` / `extractWorkspaceIds(nodes)` | Workspace ID helpers. |
| `retryLastUserMessage(messageMeta?)` | Restore the checkpoint attached to the retried assistant message (if any) and re-send the most recent user prompt, so the next request sees the pre-edit flow instead of the already-applied edit. Falls back to a plain re-send when the message has no associated checkpoint. |

### `vibe_ui.js`

Main sidebar entry. `createLLMPluginUI()` builds the DOM from the
`llm-plugin-sidebar-template` / `llm-plugin-settings-template` HTML
templates in `llm_plugin.html`; `initializeClientApp()` wires events:

- Generate / Stop toggle (single click handler + `classList`,
  Ctrl+Enter double-trigger guard).
- `AbortController` for fetch cancellation.
- **Mode UX**: `change` toast on dropdown switch; dropdown disabled
  during in-flight requests; per-message mode badge in the elapsed
  line.
- **Flow selector**: subscribes to `flows:add` / `flows:change` /
  `flows:remove` and `workspace:change`, prunes stale ids, displays
  *Current Open Flow* when only the active tab is selected.
- **Session preferences** (browser `localStorage`): model input
  (`llm-plugin-last-model`), mode dropdown (`llm-plugin-last-mode`),
  and flow selection (`llm-plugin-selected-flows`) are restored on
  sidebar init and saved on user change. Stale flow IDs are pruned
  lazily on workspace events. Each load is wrapped in try/catch so
  disabled storage falls back silently to the defaults.
- **Chat history navigation**: Up/Down arrows on the prompt textarea
  walk through this chat's previous user messages (shell-style); any
  manual edit aborts the walk.
- Settings dialog: focus management, Escape key, backdrop click.

`initializeWhenReady()` polls `RED.sidebar` and registers the tab.

### `llm_core.js` — shared LLM engine

`require('./llm_core.js')(RED)` returns the stateless engine used by both
`server.js` (sidebar) and the runtime nodes under `node/`. Centralising it
here is what lets a node "inherit" the provider / API key the user set in the
sidebar — there is only one settings + credentials store.

| Section | Key functions |
|---------|---------------|
| Storage resolution | `chatsDir` / `checkpointsDir` / `clientEventsLog` / `persistenceEnabled` (first writable of userDir → tmpdir → memory), `writeFileAtomic` |
| Settings + credentials | `getPluginSettings`, `savePluginSettings`, encrypted `credentials.json` (AES-256-CTR), legacy-key migration, `maskApiKey`, `redactSecrets` |
| Ollama discovery | `listOllamaModels` (CLI + HTTP) |
| Prompt construction | `buildMessages` (loads `prompt_system.txt`, `Configurator.toIntermediate`; `options.extraSystem` appends node-specific guidance), `buildChatMessages` (plain Ask-mode chat) |
| LLM adapters | `generateWithProvider(provider, settings, model, messages, {timeoutMs})` → `generateWithOllamaChat` (`/api/chat`) or `generateWithOpenAICompatible` (SDK; `baseURL` null = OpenAI, set = llama.cpp / LM Studio / vLLM / LocalAI) |

### `server.js`

Thin HTTP layer over `llm_core.js`, plus the sidebar-only persistence.

| Section | Key functions |
|---------|---------------|
| Chat history | `saveChatHistory`, `loadAllChatHistories` (per-chat JSON files) |
| Checkpoints | `saveCheckpoint` (per-import flow snapshots) |
| Client logging | `writeClientEvent` (structured, secret-redacted) |
| HTTP admin endpoints | All `RED.httpAdmin.*` routes (delegating generation to the engine) |

### `node/` — runtime workflow node

The `llm-request` node (and its Admin-API helper) reuse this engine. It is
documented separately in **[../node/README.md](../node/README.md)**. Note: the
sidebar's chat history retains the target flow **name** (`ui_core.js` badge +
`vibe_ui.js` `metaOpts.targetFlowName`).

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
- API keys (OpenAI and Custom-endpoint) are stored encrypted in
  `<userDir>/llm-plugin/credentials.json` using AES-256-CTR with
  Node-RED's `credentialSecret` (or auto-generated `_credentialSecret`)
  — the same algorithm used for `flows_cred.json`, but in a plugin-owned
  file so `cleanCredentials` can't strip them on deploy. Plaintext keys
  from older installs (and any leftover from the earlier synthetic-id
  `addCredentials` attempt) are migrated automatically on first boot.
- API keys are never returned to the client; masked via `maskApiKey()`.
  POST whitelist prevents field injection.
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
  config, not in exported flows). API keys (OpenAI and Custom-endpoint)
  are split off into the encrypted credentials store — see Security
  measures above. The Custom endpoint's API key may be left blank for
  servers that don't require authentication.
- **Adding a new endpoint**: add to `server.js`, restart Node-RED.
- **Adding a new client module**: drop file under `src/`, add to the
  load list in `client.js`, expose on `window.LLMPlugin`.
