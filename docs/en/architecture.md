# Architecture — Source Implementation Guide

Technical reference for the client and server modules behind the LLM
Plugin sidebar.

> **The design rationale — processing flow, rules, priorities and *why* they
> are the way they are — lives in [design.md](./design.md).** This document is
> the "what each module does" catalog; design.md covers "why this order / rule".

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
| `flow_converter_core.js` | Vibe Schema ↔ Node-RED JSON + type detection helpers | [vibe-schema.md](./vibe-schema.md) |
| `canvas_layout.js` | Topological layout, width-aware spacing, comment placement | [layout.md](./layout.md) |
| `llm_json_parser.js` | JSON repair, fuzzy alias matching, schema extraction | (inline JSDoc) |

Everything else is plugin-specific glue — see the file map below, then
the module reference for each file.

## File map

```
llm_plugin.js           Node-RED plugin entry point — loads server.js
llm_plugin.html         Sidebar + settings HTML templates, marked.js include
llm-plugin_styles.css   All plugin CSS
docs/                   All developer docs (this folder) — en/ + jp/
src/
  client.js             Script loader (browser entry) + settings dialog controller
  common.js             Shared helpers (escapeHtml, notify, el, randomId, …)
  prompt_system.txt     System prompt template (server-side)
  core/
    canvas_layout.js    Layout engine (UMD)
    flow_converter_core.js  Vibe Schema converter (UMD)
    llm_json_parser.js  LLM JSON parsing (UMD)
  chat_manager.js       Chat session CRUD + checkpoint persistence
  importer.js           Extract LLM output, rebuild & import into editor
  ui_core.js            Message rendering, flow export
  vibe_ui.js            Sidebar build + generation workflow
  llm_core.js           Shared LLM engine (settings/creds/providers/prompts)
  server.js             HTTP endpoints + chat/checkpoint persistence
node/                   Runtime workflow node (category: llm-plugin)
  lib/admin_api.js      Local Node-RED Admin API client (read-only GET /flows)
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
| GET | `/llm-plugin/chat-histories` | List persisted chats |
| POST | `/llm-plugin/save-chat` | Persist a chat |
| POST | `/llm-plugin/delete-chat` | Delete by filename or chat id |
| POST | `/llm-plugin/checkpoint/save` | Save flow snapshot |
| GET | `/llm-plugin/checkpoint/:id` | Load saved checkpoint |
| POST | `/llm-plugin/client-log` | Write a structured client event to the server log |
| GET | `/llm-plugin/vendor/marked.js` | Serve the bundled marked.js (offline Markdown rendering) |
| GET | `/llm-plugin_styles.css` | Serve plugin stylesheet |
| GET | `/llm-plugin/src/*` | Serve client JS modules |

All routes register on `RED.httpAdmin` — see
[Security measures](#security-measures).

## Module reference

### `client.js`

Sequential script loader, plus the settings dialog controller
(`window.createLLMPluginSettings`): binds to the form template in
`llm_plugin.html`, returns `{ load, save }` (provider
toggle, masked API-key placeholders, max prompt length 100–100 000).

### `common.js`

Shared helpers on `LLMPlugin.Common`: `escapeHtml`, `escapeRegExp`,
`notify` (RED.notify with guard), `el` (createElement shorthand),
`randomId`, `flowLabels` (workspace ids → tab labels).

### `core/flow_converter_core.js` — Vibe Schema converter

UMD (`window.LLMPlugin.FlowConverterCore`).
Bi-directional converter plus type-detection helpers (`isConfigNode`,
`isCanvasNode`, `isNoInputType`, `isNoOutputType`, `setRuntimeGetType`).
Also owns the metadata convention (`isMetaProp`): `_`-prefixed properties
are never emitted to the LLM and never accepted from it.
See [vibe-schema.md](./vibe-schema.md).

### `core/canvas_layout.js` — layout engine

UMD (`window.LLMPlugin.CanvasLayout`). Standalone — no plugin
dependencies. See [layout.md](./layout.md).

### `core/llm_json_parser.js` — LLM output parser

UMD (`window.LLMPlugin.LLMJsonParser`). Tolerates the way LLMs format
JSON: comment stripping, quote repair, fuzzy alias matching, and Vibe
Schema extraction from prose-mixed responses.

| Export | Purpose |
|--------|---------|
| Schema extraction | `extractVibeSchema`, `extractConnectionHints`, `extractFlowDirectives` |
| Flow lookup | `buildFlowLookup` (alias / name / ID → node ID, fuzzy fallback) |
| Node extraction | `extractFlowNodes` |
| Diagnostics | `diagnoseJsonExtractionFailure` — when `extractFlowNodes` returns null, re-parses each fenced block and returns the first concrete `JSON.parse` error with line/column/snippet so the importer can show "JSON parse failed at line X" instead of the generic "no JSON found". |

Token normalization, JSON repair (comment stripping, quote fixing,
balanced-snippet scanning) and the Agent partial-schema merge are internal
steps of those four entry points — they are not exported.

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
| `saveImportCheckpoint(chatId?, flowIds?)` | Snapshot the flow immediately before an import; ID attached to the message so the per-message Restore button rewinds to that point. Called by the UI at import-button click time — not on every chat send. The snapshot opts into `includeCanvasExtras` so junctions/groups are recorded (see [design.md](./design.md#7-snapshot-completeness--junction--group)). |
| `updateMessageMeta(messageId, patch)` | Patch stored message metadata. |

### `importer.js`

Extracts Node-RED flow JSON from LLM responses and imports it into the
editor.

**`extractFlowNodes(messageContent, options?)`** —
Scan fenced ```` ```json ```` / ```` ```javascript ```` blocks (picking
the *last* valid block), parse with `LLMJsonParser`, prefer Vibe Schema
via `FlowConverterCore.toNodeRed()`, fall back to raw Node-RED arrays or
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
   alone. Merge is the only apply mode — the schema has no field that
   selects a different one — so one schema can freely combine adds,
   updates, and deletions.
2. **Workspace scope** — `options.allowedWorkspaceIds` (the sidebar
   passes the message's `targetFlowIds`, i.e. the flows that were sent
   to the model as context) confines every workspace decision to those
   flows. `resolveFlowLabelToWorkspace`, `inferImplicitFlowTagging` and
   `dispatchMultiFlowImport` all skip out-of-scope tabs, the default
   target falls back to a context flow when the active tab is not one,
   and a final check before `replaceWorkspaceFlow` aborts the import
   rather than writing outside the scope. This is a correctness
   requirement, not a nicety: auto-generated aliases (`inject`,
   `debug_1`, …) are unique only *within* a flow, and the rebuild clears
   its target's canvas before re-importing — so an unscoped resolution
   can destructively rewrite a flow the conversation never saw. An empty
   / absent scope means "no flow context was selected" and keeps the
   legacy active-tab behaviour. Regression test:
   `test/cross_flow_isolation.test.js`.
3. **Implicit flow inference** — when the schema omits `flow` tags but
   its nodes / connections reference existing aliases on multiple
   context workspaces (a common LLM mistake when the conversation spans
   MCU / Server style splits), `inferImplicitFlowTagging` scans the
   in-scope workspaces, seeds the tag for any schema alias that matches
   an existing canvas node, then propagates the tag through
   `connections` so brand-new nodes inherit the flow of their
   existing-node neighbors. The inferred-tagged schema is then handed to
   `collectFlowGroupsFromSchema` so the multi-flow dispatch fires even
   without explicit `flow` markers.
4. **Strict delete → add → connect ordering** —
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
5. **Additive wire merge** — when a proposed node matches an existing
   one, its `wires` are unioned with the existing wires (per port).
   Connections are only severed by explicit `remove` directives.
6. **Property preservation** — properties the LLM did NOT mention are
   restored from the existing node. Mentioned-key set comes from
   `_llmSpecKeys` (Vibe Schema path) or `n[key] !== undefined`
   (raw-JSON path), so normaliser-default values don't override user
   settings. The editor flags ride along: an unmentioned `d` / `l` is
   preserved, while `disabled: false` deletes `d` yet still lists it as
   mentioned, so re-enabling is not undone by the restore
   (see [vibe-schema.md](./vibe-schema.md#editor-flags-disabled-showlabel)).
7. **Comment placement** — every comment names its target canvas node
   via `above: <alias>` and lands directly atop that node with zero grid
   gap, **left edge aligned** with the target's left edge (not its
   centre). New comments stack above any existing comment touching the
   same target instead of overlapping. Comments with `above` are
   kept regardless of declaration order — only comments WITHOUT `above`
   AND with no canvas node later in the list are dropped. A schema that
   omits `above` anyway falls back to "next canvas node in declaration
   order". See [layout.md](./layout.md#comment-placement).
8. **Config Node Protection** — the LLM cannot create or delete config
   nodes; it can only reference existing ones by alias.
9. **Junction / group preservation** — the rebuild snapshot includes the
   workspace's junctions and groups (`includeCanvasExtras`), so the
   remove-then-reimport cycle never deletes them and wires that target a
   junction are not pruned. See [design.md](./design.md#7-snapshot-completeness--junction--group).
10. **Reposition without ID churn** — a top-level `reposition: [alias…]`
   directive (see [vibe-schema.md](./vibe-schema.md#reposition-directive))
   reflows just the named canvas-node subset while keeping IDs, props,
   and wires. The subset is anchored to its previous top-left so the
   rest of the canvas doesn't visibly shift.
11. **Metadata sweep** — every `_`-prefixed property the converter added
   is stripped before the nodes reach the canvas: once right after the
   merge (keeping only `_llmOrder` / `_llmAboveId`, which the layout
   passes still consume) and once after layout. Nothing metadata-shaped
   is ever imported. See [design.md](./design.md) §0.1.
12. Replace the target workspace atomically; layout is delegated to
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
| `focusCanvasNode(nodeId)` | Debug-sidebar-style focus for canvas nodes: switch to the node's tab via `RED.workspaces.show`, set `node.highlighted = true` for a flash, call `RED.view.reveal(node.id)` to centre the viewport (matches the Debug sidebar's exact invocation), force `RED.view.redraw()`, then clear the flash after ~2.5 s. Config nodes have no canvas position, so they open via `RED.editor.editConfig('', node.type, node.id)` (with `RED.editor.edit(node)` as fallback). Notifies if the node has since been deleted. |
| `reannotateAllAssistantMessages()` | Re-runs `annotateNodeReferences` on every assistant message in the chat panel. Registered once at module load against `RED.events` (`flows:loaded` / `deploy` / `workspace:change` / `nodes:add` / `nodes:remove` / `nodes:change`) and debounced 200 ms. Solves the cold-start race where the side panel renders chat history before `RED.nodes` is populated, and also keeps existing badges in sync when the user edits / deploys / imports new nodes. |
| `createRestoreCheckpointButton(checkpointId)` | Shared Restore button. Inserted above the assistant message that triggered the import so a single click rewinds the workspace to the pre-edit snapshot. |
| `getFlowsByIds(flowIds, opts?)` / `getCurrentFlow(flowIds?, opts?)` | Export selected workspace tabs + referenced config nodes (credentials stripped via `RED.nodes.createExportableNodeSet`). `opts.includeCanvasExtras` also appends the tabs' junctions and groups — used by the rebuild/checkpoint callers, NOT by the LLM-context path, so the alias numbering the model sees is unchanged. See [design.md](./design.md#7-snapshot-completeness--junction--group). |
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
| Settings + credentials | `getPluginSettings`, `savePluginSettings`, encrypted `credentials.json` (AES-256-GCM), legacy-key migration, `maskApiKey`, `redactSecrets` |
| Prompt construction | `buildMessages` (loads `prompt_system.txt`, `FlowConverterCore.toIntermediate`), `buildChatMessages` (plain Ask-mode chat) |
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
documented separately in **[runtime-node.md](./runtime-node.md)**. Note: the
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

- **Authentication.** Every endpoint that reads data, writes data, or
  spends money is wrapped in `RED.auth.needsPermission`
  (`llm-plugin.read` for the two GET routes, `llm-plugin.write` for the
  rest), and the client attaches the editor's bearer token through
  `Common.apiFetch`. This is required, not automatic: Node-RED does
  **not** apply `adminAuth` to routes a plugin registers on
  `RED.httpAdmin` — the core Admin API guards its own routes with
  `needsPermission` individually, and anything added afterwards is open
  unless it does the same. `needsPermission` is a no-op when `adminAuth`
  is unset, so single-user installs behave exactly as before.
  The three static-asset routes (`vendor/marked.js`, the stylesheet,
  `src/*`) stay unauthenticated because `<script>` / `<link>` tags cannot
  send an auth header; they serve only the plugin's own published client
  code and `src/*` is restricted to `.js` / `.css` / `.json`.
- API keys (OpenAI and Custom-endpoint) are stored encrypted in
  `<userDir>/llm-plugin/credentials.json` using AES-256-GCM with
  Node-RED's `credentialSecret` (or auto-generated `_credentialSecret`),
  in a plugin-owned file so `cleanCredentials` can't strip them on
  deploy. GCM rather than the CTR that Node-RED uses for
  `flows_cred.json`: CTR is unauthenticated, so a tampered file decrypts
  to attacker-chosen bits without error, while GCM rejects it. Blobs
  written in the old CTR format are still read (prefix `g1:` marks GCM),
  and the next save rewrites them. Plaintext keys from older installs
  (and any leftover from the earlier synthetic-id `addCredentials`
  attempt) are migrated automatically on first boot.
- API keys are never returned to the client; masked via `maskApiKey()`.
  POST whitelist prevents field injection. A stored key is **not**
  carried across an endpoint change: sending the `__EXISTING_KEY__`
  sentinel while `customBaseUrl` changes in the same request is rejected,
  so the settings form cannot be used to redirect a key the client is not
  allowed to read to an endpoint of the caller's choosing. Endpoint URLs
  must be `http:` or `https:`.
- Server-side `maxPromptLength` cap (default 10 000 chars, range
  100–100 000), plus an independent 1 MB cap on the flow context —
  both land in the same system message, so without the second cap the
  first is bypassable by moving the payload into `currentFlow`.
- Stored documents are bounded: 5 MB per chat and per checkpoint,
  `client-events.log` rotates at 5 MB, and checkpoints are pruned
  oldest-first past 200 files.
- Path traversal blocked by `path.basename` + `startsWith` containment
  on file-serving / deletion routes.
- `redactSecrets` strips API keys, URLs, and IPs from all error messages
  and client logs — including the `meta` object written to
  `client-events.log`, not only its console preview.
- Credentials stripped from flow context before sending to the LLM. The
  runtime node narrows the context further: only the config nodes its
  selected flows actually reference (transitively), rather than every
  config node in the instance.

#### Agent mode runs what the model writes

This is a deliberate property of the feature, not an oversight, and it is
the largest risk in the plugin:

- Agent mode applies the model's reply to the canvas with **no
  confirmation step**, and `Auto deploy` deploys it immediately.
- There is **no node-type allowlist**. Generated flows may contain
  `function` nodes (arbitrary JavaScript in the runtime process) and
  `exec` nodes (arbitrary shell commands). Restricting what the model may
  build would defeat the point of the mode, so it is not restricted.

Consequently, whoever controls the model's output controls the Node-RED
host. Treat the configured LLM endpoint as trusted infrastructure, and
**do not route untrusted text into an Agent node** — an `http in`
payload, an inbound MQTT message, scraped page content. With `Auto
deploy` on, that is a direct path from a remote string to code execution
on the host. The `llm-self-feedback` sample is a developer toy for
disposable instances for exactly this reason.

## Development notes

- **No jQuery** in client modules; vanilla DOM + `fetch`.
- **Module communication**: `window.LLMPlugin` namespace
  (`CanvasLayout`, `FlowConverterCore`,
  `LLMJsonParser`, `ChatManager`, `UI`, `Importer`).
- **Chat / checkpoint storage**: server-side, resolved by `llm_core.js`
  (storage resolution above). The plugin never writes to its own install
  directory, so it installs cleanly on sandboxed cloud Node-RED hosts
  (enebular, etc.) where that directory is read-only; if nothing on disk
  is writable it degrades to memory-only and logs a warning.
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
