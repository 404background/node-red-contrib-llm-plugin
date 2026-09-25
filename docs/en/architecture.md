# Architecture — Source Implementation Guide

Technical reference for the client and server modules behind the LLM
Plugin sidebar.

> **The design rationale — processing flow, rules, priorities and *why* they
> are the way they are — lives in [docs/en/design.md](./design.md).** This document is
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
        └── applyWorkspaceDiff → remove / update-in-place / addLink-removeLink
                               → RED.nodes.import for the ADDED nodes only
                               (falls back to replaceWorkspaceFlow = clear +
                                re-import, when the diff cannot express it)
```

Three independent core modules under `src/core/` form the conversion +
layout backbone:

| Module | Owns | Reference |
|--------|------|-----------|
| `flow_converter_core.js` | Vibe Schema ↔ Node-RED JSON + type detection helpers | [docs/en/vibe-schema.md](./vibe-schema.md) |
| `canvas_layout.js` | Topological layout, width-aware spacing, comment placement, group boxes, collision settling | [docs/en/layout.md](./layout.md) |
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
  common.js             Shared helpers (escapeHtml, notice, el, randomId, …)
  prompt_system.txt     System prompt for Agent: the Vibe Schema rules
  prompt_ask.txt        System prompt for Ask: read the flow, explain it
  core/
    canvas_layout.js    Layout engine (UMD)
    flow_converter_core.js  Vibe Schema converter (UMD)
    llm_json_parser.js  LLM JSON parsing (UMD)
  chat_manager.js       Chat session CRUD + checkpoint persistence
  importer.js           Extract LLM output, rebuild & import into editor
  ui_core.js            Message rendering, flow export
  vibe_ui.js            Sidebar build + generation workflow
  agent_apply.js        Editor half of the `llm-request` node: comms → importer
  agent_dispatch.js     Runtime: one Agent-node reply, claimed by one editor
  llm_core.js           Shared LLM engine (settings/creds/providers/prompts/context)
  server.js             HTTP endpoints + chat/checkpoint persistence
node/                   The `llm-request` node (palette category: llm-plugin)
  lib/admin_api.js      Local Node-RED Admin API client (read-only GET /flows)
  llm-request/          "LLM" node — Ask / Agent against msg.payload; the
                        editor half of Agent mode is src/agent_apply.js
```

## Loading sequence (client)

`llm_plugin.html` includes `<script src="llm-plugin/src/client.js">`,
which fetches and runs the rest **in order**:

```
common → canvas_layout → flow_converter_core → llm_json_parser
       → chat_manager → importer → ui_core → vibe_ui
       → agent_apply
```

`canvas_layout` must precede `flow_converter_core` because the
converter's `toNodeRed` delegates layout to it. `agent_apply` is last: an
`llm-request` reply can arrive the moment it binds, and applying one uses
everything above. All modules use the IIFE pattern and communicate via
`window.LLMPlugin`.

## HTTP endpoints

| Method | Path | Permission | Purpose |
|--------|------|------------|---------|
| POST | `/llm-plugin/generate` | write | Send prompt + flow context to the LLM. `mode: "ask"` asks for an explanation of the flow, anything else asks for a schema — the mode picks the system prompt, so it is decided here, not in the browser. Times out after an hour, and is abandoned when the sidebar closes the connection (Stop) |
| GET | `/llm-plugin/settings` | read | Read settings (API key masked) |
| POST | `/llm-plugin/settings` | write | Write settings (whitelisted fields) |
| GET | `/llm-plugin/chats` | read | List persisted chats |
| POST | `/llm-plugin/chats/save` | write | Persist a chat |
| POST | `/llm-plugin/chats/delete` | write | Delete a chat, and its checkpoints, by chat id |
| POST | `/llm-plugin/checkpoints/save` | write | Save flow snapshot |
| POST | `/llm-plugin/agent-apply/claim` | write | Claim an Agent-node reply; only the first editor to claim it applies it |
| GET | `/llm-plugin/checkpoints` | read | List restore points (the Agent node's have no message to find them by) |
| GET | `/llm-plugin/checkpoints/:id` | read | Load saved checkpoint |
| POST | `/llm-plugin/client-log` | write | Report a client-side failure into the Node-RED log |
| GET | `/llm-plugin/vendor/marked.js` | **none** | Serve the bundled marked.js (offline Markdown rendering) |
| GET | `/llm-plugin/styles.css` | **none** | Serve plugin stylesheet |
| GET | `/llm-plugin/src/<file>` | **none** | Serve the client modules `client.js` loads, one route per file |

Permissions are `llm-plugin.read` / `llm-plugin.write`. Every route that
reads data, writes data or spends money has one; the three unauthenticated
ones are static assets a `<script>`/`<link>` tag must fetch without headers.

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
`notice` (a warning or error as a line in the chat), `el` (createElement shorthand),
`randomId`, `flowLabels` (workspace ids → tab labels).

### `core/flow_converter_core.js` — Vibe Schema converter

UMD (`window.LLMPlugin.FlowConverterCore`).
Bi-directional converter plus type-detection helpers (`isConfigNode`,
`isCanvasNode`, `isNoInputType`, `isNoOutputType`, `setRuntimeGetType`).
Also owns the metadata convention (`isMetaProp`): `_`-prefixed properties
are never emitted to the LLM and never accepted from it.
See [docs/en/vibe-schema.md](./vibe-schema.md).

### `core/canvas_layout.js` — layout engine

UMD (`window.LLMPlugin.CanvasLayout`). Standalone — no plugin
dependencies. See [docs/en/layout.md](./layout.md).

### `core/llm_json_parser.js` — LLM output parser

UMD (`window.LLMPlugin.LLMJsonParser`). Tolerates the way LLMs format
JSON: comment stripping, quote repair, fuzzy alias matching, and Vibe
Schema extraction from prose-mixed responses.

| Export | Purpose |
|--------|---------|
| Block reading | `parseJsonBlock(text)` → `{ value, repaired }`, or null when even the repairs cannot read it. `repaired` says the text as written was not valid JSON. The sidebar folds a JSON block on this, so the panel and the import read a reply the same way. |
| Schema extraction | `extractVibeSchema`, `extractConnectionHints`, `extractFlowDirectives` |
| Flow lookup | `buildFlowLookup` (alias / name / ID → node ID, fuzzy fallback) |
| Node extraction | `extractFlowNodes` |
| Diagnostics | `diagnoseJsonExtractionFailure` — when `extractFlowNodes` returns null, re-parses each fenced block and returns the first concrete `JSON.parse` error with line/column/snippet so the importer can show "JSON parse failed at line X" instead of the generic "no JSON found". |

**Repair order.** `parseJsonRelaxed` tries `JSON.parse` first, then each repair
in turn, from the least assumed to the most, and takes the first result that
parses: as-is → unescaped quotes inside values → an unterminated string closed
at the end of its line → an unterminated string treated as a multi-line value.
The last two are the two readings of a raw newline inside a string, which JSON
forbids and which therefore means the string was never closed. Which reading is
right cannot be known in advance, so neither is assumed: only the one that
yields valid JSON is used, and a block that was already valid never reaches a
repair at all. One dropped quote in a forty-node schema otherwise costs the
whole reply. Guarded by `test/json_repair.test.js`.

**Expression values.** A value the quote repair had to touch is then tested
against the two readings of where its string literals begin and end, because
the repair's own reading eats the outer quotes of a JSONata expression — which
Node-RED rejects. See
[docs/en/design.md §14](./design.md#14-two-readings-of-a-value-the-model-broke).

Token normalization, JSON repair (comment stripping, quote fixing,
balanced-snippet scanning) and the Agent partial-schema merge are internal
steps of those entry points. The repairs are reachable only through
`parseJsonBlock`, which exists so the sidebar can read a block exactly as the
importer will.

### `chat_manager.js`

Chat session lifecycle.

| API | Description |
|-----|-------------|
| `getCurrentChatId()` / `getChatHistory()` / `startNewChat()` | In-memory session control. |
| `addMessage(content, isUser, meta?)` | Append + persist; renders via `UI.addMessageToUI`. |
| `saveChatToServer(chatId)` | `POST /chats/save`. |
| `loadChatHistoriesFromServer()` | `GET /chats`. Auto-loads the most recent if none open. |
| `loadChat(chatId)` | Replay messages into the chat area. |
| `showChatList()` / `deleteChat(chatId, cb)` | Chat-list modal. |
| `saveImportCheckpoint(chatId?, flowIds?)` | Snapshot the flow immediately before an import; ID attached to the message so the per-message Restore button rewinds to that point. Called by the UI at import-button click time — not on every chat send. The snapshot opts into `includeCanvasExtras` so junctions/groups are recorded (see [docs/en/design.md](./design.md#7-snapshot-completeness--junction--group)). |
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
   flows. `resolveFlowLabelToWorkspace`, `planByWorkspace` and
   `dispatchToWorkspaces` all skip out-of-scope tabs, the default
   target falls back to a context flow when the active tab is not one,
   and a final check before the apply aborts the import
   rather than writing outside the scope. This is a correctness
   requirement, not a nicety: an apply deletes
   what the merged end state does not contain — so an unscoped
   resolution can destructively rewrite a flow the conversation never
   saw. An empty
   / absent scope means "no flow context was selected" and keeps the
   legacy active-tab behaviour. Regression test:
   `test/cross_flow_isolation.test.js`.
3. **One alias, one node** — the model is shown one alias numbering over
   every context flow, so each alias names exactly one node.
   `contextAliasTable` rebuilds that numbering from `UI.getFlowsByIds`, and
   `planByWorkspace` reads the reply against it before anything else,
   splitting it into one sub-schema per context flow in the aliases that
   flow's own import resolves. An existing node is edited on the tab it is
   on, whatever `flow` the reply gave it. A new node goes to its `flow`
   tab, else to the flow of what it is wired to or captions, else to the
   default flow, and is renamed if its tab already gives its alias to
   another node. Deletions, `reposition` tokens and removed connections go
   to the flow of the node they name; a token that is not exactly an alias
   is looked up on each flow and applied only where exactly one flow has
   it, else reported in the chat. A wire between two tabs is not made.
   Node ids inside properties (`scope: [...]`) are aliases to the model at
   any depth, and `restoreNodeRefs` turns them back. Regression tests:
   `test/cross_flow_isolation.test.js` scenarios 9–11 and
   `test/import_safety.test.js` scenarios A1–A3.
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
   (see [docs/en/vibe-schema.md](./vibe-schema.md#editor-flags-disabled-showlabel)).
7. **Comment placement** — every comment names its target canvas node
   via `above: <alias>` and lands directly atop that node with zero grid
   gap, **left edge aligned** with the target's left edge (not its
   centre). New comments stack above any existing comment touching the
   same target instead of overlapping. Comments with `above` are
   kept regardless of declaration order — only comments WITHOUT `above`
   AND with no canvas node later in the list are dropped. A schema that
   omits `above` anyway falls back to "next canvas node in declaration
   order". See [docs/en/layout.md](./layout.md#comment-placement).
8. **Config Node Protection** — the LLM cannot create or delete config
   nodes; it can only reference existing ones by alias.
9. **Junction / group preservation** — the snapshot includes the
   workspace's junctions and groups (`includeCanvasExtras`), so they are
   never deleted and wires that target a junction are not pruned. An
   incremental apply leaves an unmentioned junction or group alone
   outright; the fallback rebuild still needs them in the snapshot. See
   [docs/en/design.md](./design.md#7-snapshot-completeness--junction--group).
10. **Incremental apply** — the merged end state is applied as a DIFF:
   only added / removed / changed entities are touched, wiring changes go
   through `RED.nodes.addLink` / `removeLink` (the editor's links are
   objects in their own registry, and `wires` is derived from them), and
   untouched nodes are never handed to Node-RED at all. Deleting a grouped
   node goes through `RED.group.removeFromGroup` before the removal, so the
   group never names a node that is gone. Falls back to the destructive
   rebuild for group membership and type changes, and for a grouped-node
   deletion when the group API is unusable (a locked workspace). See
   [docs/en/design.md](./design.md#12-applying-as-a-diff-not-a-rebuild).
11. **Reposition without ID churn** — a top-level `reposition: [alias…]`
   directive (see [docs/en/vibe-schema.md](./vibe-schema.md#reposition-directive))
   reflows just the named canvas-node subset while keeping IDs, props,
   and wires. The subset is anchored to its previous top-left so the
   rest of the canvas doesn't visibly shift.
12. **Keeping boxes around their sequences** (`keepBoxesAroundTheirSequences`)
   — group boxes are the user's: a reply cannot create, edit or delete one,
   and a box stays even when empty. After the merge, a new node wired into a
   boxed sequence joins that box when every box among its neighbours is the
   same one, and a comment the reply gives an `above` follows that node into
   its box (or out of its old one), since the padding is one row and it would
   otherwise sit on the top edge. `CanvasLayout.fitGroups` then fits every box
   around its members' final positions. See
   [docs/en/design.md](./design.md#15-a-flow-a-tab-and-a-group).
13. **Metadata sweep** — every `_`-prefixed property the converter added
   is stripped before the nodes reach the canvas: once right after the
   merge (keeping only `_llmOrder` / `_llmAboveId`, which the layout
   passes still consume) and once after layout. Nothing metadata-shaped
   is ever imported. See [docs/en/design.md](./design.md) §0, the metadata boundary.
14. Apply the end state to the target workspace as a diff (with the
   destructive rebuild as the fallback); layout is delegated to
   `CanvasLayout`.

**`restoreCheckpoint(checkpointId)`** — Load a saved checkpoint and
replace the workspace flow (with a deferred SVG redraw to avoid the
"wires-only" render race). Every caller
goes through here — the per-message Restore button, the restore-point list,
and Retry, which restores before re-asking.

### `ui_core.js`

| API | Purpose |
|-----|---------|
| `addMessageToUI(content, isUser, messageMeta?)` | Render message + import buttons; assistant messages show a `mode / model / 1.5s` badge. Also runs `annotateNodeReferences` on assistant messages so inline backtick'd node names become clickable, and ends with `refreshRetryButton()`. |
| `refreshRetryButton()` | Move the single Retry button onto the last message in the panel, dropping every other copy. Retry always re-sends the **last** user prompt, so a button on an older message would lie about what it does; keeping placement in one pass — rather than at render time — is also what gives the button to a chat reloaded from history (rendered with no buttons at all before), to an `Error: …` reply, and to a turn the user stopped. Skipped while the `Generating...` placeholder is last, since there is nothing to retry yet. Called at the end of `addMessageToUI`, right after the placeholder is marked, and in the request's `finally` (the cancel path removes the placeholder without adding a reply). |
| `formatMessage(text)` | `marked.parse` with a renderer whose `html()` escapes raw HTML to text, then `sanitizeRenderedHtml`. The escape belongs to the renderer, not to the source text: pre-escaping `<` / `>` before parsing put `&lt;` inside code blocks, where marked escapes again and the reader is shown `&lt;`. A reply that is nothing but JSON is emitted as one `language-json` block instead — its indented lines are not prose. |
| `collapseJsonBlocks(container)` | Fold each JSON code block into `<details class="json-collapsible">`, labelled `Vibe Schema JSON` / `Flow JSON (n nodes)` / `JSON`, and lift a schema's `description` out of the fold as prose. The block is read with `LLMJsonParser.parseJsonBlock`, so a reply the importer repaired folds too — labelled `(repaired)`, since the block then shows that reading and not the text the model sent. A block fenced as `json` that cannot be read at all still folds (`JSON (could not be read)`): a reply the model broke is the one a reader most needs out of the way. |
| `annotateNodeReferences(rootEl, targetFlowIds?)` | Two-pass scan that makes node mentions clickable. **Pass 1**: every inline `<code>` (skipping `<pre>`-nested ones) is resolved via `LlmJsonParser.buildFlowLookup(...).resolve`; matches become `code.llm-node-ref` with a focus handler. **Pass 2**: walks the remaining text nodes (skipping `<code>/<pre>/<a>/<script>/<style>`) and replaces any token that exactly matches a known alias (length ≥ 3) — this catches plain-prose mentions when the LLM forgets to backtick. Both singleton aliases (`inject`, `debug`) and compound ones (`change_create_sensor_json`) are matched; sort-longest-first plus `\b` boundaries make sure `change_temperature_series` beats `change` on overlapping spans. Tabs are skipped; config nodes ARE included (they open the edit dialog on click). When `targetFlowIds` is provided, the alias map is rebuilt from `UI.getFlowsByIds(targetFlowIds)` — the exact same export the LLM saw — so numbered duplicate aliases (`change_2`, …) resolve back to the same node IDs. Without it, every node on the canvas is scanned. The system prompt also instructs the LLM to backtick node aliases, so Pass 1 is the primary path. |
| `focusCanvasNode(nodeId)` | Debug-sidebar-style focus for canvas nodes: switch to the node's tab via `RED.workspaces.show`, set `node.highlighted = true` for a flash, call `RED.view.reveal(node.id)` to centre the viewport (matches the Debug sidebar's exact invocation), force `RED.view.redraw()`, then clear the flash after ~2.5 s. Config nodes have no canvas position, so they open via `RED.editor.editConfig('', node.type, node.id)`. Notifies if the node has since been deleted. A single try/catch wraps the whole routine — focus is best-effort, so every failure has the same answer (stop and log). |
| `reannotateAllAssistantMessages()` | Re-runs `annotateNodeReferences` on every assistant message in the chat panel. Registered once at module load against `RED.events` (`flows:loaded` / `deploy` / `workspace:change` / `nodes:add` / `nodes:remove` / `nodes:change`) and debounced 200 ms. Solves the cold-start race where the side panel renders chat history before `RED.nodes` is populated, and also keeps existing badges in sync when the user edits / deploys / imports new nodes. |
| `createRestoreCheckpointButton(checkpointId)` | Shared Restore button. Inserted above the assistant message that triggered the import so a single click rewinds the workspace to the pre-edit snapshot. |
| `showPostImportActions(message, checkpointId, content, messageMeta)` | The two halves of one choice, each placed where it acts. **Restore Checkpoint** goes above the PROMPT (`placeRestoreAboveThePrompt` → `promptAbove`, the first user message above the reply; a retry has no prompt between two replies, so the walk stops at the previous reply), because everything below it is what a rewind undoes — it is inserted among the message's neighbours, which is why `appendFlowActions` runs after the message joins the chat. **Apply Again** goes on the schema block's own header (`placeReapplyOnTheSchema` → `.json-collapsible[data-vibe-schema] > summary`, marked as the fold builds it), so the control that applies a proposal sits with the proposal; its click stops propagation, or it would just toggle the block. Switching between the two is how the versions get compared, and in Agent mode (where the Import button is hidden) Apply Again is the only way back to a rewound proposal. Both are removed before being re-added, so repeated applies do not stack. |
| `runImport(message, content, messageMeta)` | The one path every sidebar import takes, Import and Apply Again alike: read the chat id at click time, save a checkpoint of the flows in scope, then import. Each run takes its own checkpoint, so Restore undoes that apply. |
| `getFlowsByIds(flowIds, opts?)` / `getCurrentFlow(flowIds?, opts?)` | Export selected workspace tabs + referenced config nodes (credentials stripped via `RED.nodes.createExportableNodeSet`). Config nodes come in **by reference only** — the flow selection is the user's statement of what may leave the machine — and references are followed **transitively** (an `mqtt-broker` pointing at a `tls-config`) and through **array** properties (`servers: ["id", …]`), matching `flowContextFor` in the `llm-request` node. `opts.includeCanvasExtras` also appends the tabs' junctions **and** groups — for the rebuild, the checkpoint and the LLM context. The alias numbering the model sees is unchanged: the converter drops groups ([§15](./design.md#15-a-flow-a-tab-and-a-group)) and reads a wire through a junction or a `link out` → `link in` pair as a connection to where it leads. See [docs/en/design.md](./design.md#7-snapshot-completeness--junction--group). |
| `getActiveWorkspaceId()` / `extractWorkspaceIds(nodes)` | Workspace ID helpers. |
| `retryLastUserMessage(messageMeta?)` | Restore the checkpoint attached to the retried assistant message (if any) and re-send the most recent user prompt, so the next request sees the pre-edit flow instead of the already-applied edit. Falls back to a plain re-send when the message has no associated checkpoint. |

### `vibe_ui.js`

Main sidebar entry. `createLLMPluginUI()` builds the DOM from the
`llm-plugin-sidebar-template` / `llm-plugin-settings-template` HTML
templates in `llm_plugin.html`; `initializeClientApp()` wires events:

- Generate / Stop toggle (single click handler + `classList`, guarded
  against a second trigger while a request is in flight).
- **Prompt keys**: **Enter** sends, **Shift+Enter** is a newline, **Esc**
  stops a running request (from anywhere in the sidebar, except while the
  settings dialog has it). The send is skipped while `e.isComposing` (or
  `keyCode === 229`) — for an IME the Enter that closes a conversion is the
  same keydown, so without that guard every confirmed Japanese phrase would
  send the message it was confirming. Esc and the Stop button run the same
  `stopGeneration()`.
- `AbortController` for fetch cancellation.
- **Mode UX**: dropdown disabled
  during in-flight requests; per-message mode badge in the elapsed
  line.
- **Flow selector**: subscribes to `flows:add` / `flows:change` /
  `flows:remove` and `workspace:change`, prunes stale ids, displays
  *Current Open Flow* when only the active tab is selected. The panel
  opens with an **All flows** row (select-all / clear-all, shown
  indeterminate while only some are selected) followed by the **active
  flow pinned first** — it is the default context and the one reached
  for most often, and a long tab bar otherwise buries it wherever tab
  order puts it. The remaining flows keep tab order, so nothing else
  moves between openings.
- **A new chat resets the selection to the open flow**
  (`ChatManager.onNewChat` → `selectActiveFlowOnly`). The flow context
  belongs to the conversation: it is the scope every edit may write to
  and the scope each checkpoint covers, so inheriting a selection made
  for an earlier question silently widens both. Loading an existing
  chat does not touch the selection.
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

`require('./src/llm_core.js')(RED)` returns the stateless engine used by both
`server.js` (the sidebar) and the `llm-request` node under `node/`. Centralising it
here is what lets a node "inherit" the provider / API key the user set in the
sidebar — there is only one settings + credentials store.

| Section | Key functions |
|---------|---------------|
| Storage resolution | `chatsDir` / `checkpointsDir` / `persistenceEnabled` (`<userDir>/llm-plugin`, else memory only), `writeFileAtomic` |
| Settings + credentials | `getPluginSettings`, `savePluginSettings`, encrypted `credentials.json` (AES-256-GCM), legacy-key migration, `maskApiKey`, `redactSecrets` |
| Prompt construction | `buildMessages(prompt, flowContext, activeWorkspaceId, settings, options?)` — `options.mode === 'ask'` uses `prompt_ask.txt` (explain the flow, propose nothing), anything else `prompt_system.txt` (the Vibe Schema rules); the flow context is built the same way for both. `buildChatMessages` is the `llm-request` node's plain chat, with no flow context at all |
| LLM adapters | `generateWithProvider(provider, settings, model, messages, {timeoutMs})` → `generateWithOllamaChat` (`/api/chat`) or `generateWithOpenAICompatible` (SDK; `baseURL` null = OpenAI, set = llama.cpp / LM Studio / vLLM / LocalAI) |

### `server.js`

Thin HTTP layer over `llm_core.js`, plus the sidebar-only persistence.

| Section | Key functions |
|---------|---------------|
| Chat history | `saveChatHistory`, `loadAllChatHistories` (per-chat JSON files) |
| Checkpoints | `saveCheckpoint` (per-import flow snapshots) |
| Client logging | `writeClientEvent` (secret-redacted, into `RED.log`) |
| HTTP admin endpoints | All `RED.httpAdmin.*` routes (delegating generation to the engine) |

### `node/` — the `llm-request` node

The `llm-request` node (and its Admin-API helper) reuse this engine. It is
documented separately in **[docs/en/llm-request.md](./llm-request.md)**. Note: the
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
  spends money is wrapped in `RED.auth.needsPermission` — see the
  permission column in [HTTP endpoints](#http-endpoints) — and the client
  attaches the editor's bearer token through `Common.apiFetch`. This is required, not automatic: Node-RED does
  **not** apply `adminAuth` to routes a plugin registers on
  `RED.httpAdmin` — the core Admin API guards its own routes with
  `needsPermission` individually, and anything added afterwards is open
  unless it does the same. `needsPermission` is a no-op when `adminAuth`
  is unset, so single-user installs behave exactly as before.
  The static-asset routes (`vendor/marked.js`, the stylesheet, the client
  modules) stay unauthenticated because `<script>` / `<link>` tags cannot
  send an auth header. Each serves one fixed file: the modules are exactly
  the list `client.js` loads, so the server-side modules beside them in
  `src/` are never served (`test/server_api.test.js` keeps the lists equal).
- **Reply rendering.** A reply is Markdown, rendered inside the editor, which
  holds admin privileges — so raw HTML in it is text, never markup. That is
  enforced in the renderer (`html()` escapes the token) rather than by
  escaping `<` / `>` in the source text, which had the side effect of
  double-escaping every entity a code block contained. A Markdown **image
  becomes a link**: rendering it would fetch its URL, and a reply steered
  by text inside the flow could put the flow's contents in that URL. A link
  sends nothing until clicked. `sanitizeRenderedHtml` then resolves each
  `href` **through the DOM** of an inert document and drops any that is
  not `http(s)` / `mailto:` / `tel:` — resolving through
  the DOM rather than matching a regex is what makes entity-encoded
  `javascript:` no different from the plain spelling. There is deliberately
  no fallback path: the only one available is the `innerHTML` this avoids.
- API keys (OpenAI and Custom-endpoint) are stored encrypted in
  `<userDir>/llm-plugin/credentials.json` using AES-256-GCM, in a
  plugin-owned file so `cleanCredentials` can't strip them on deploy.
  The key comes from the plugin's **own** secret
  (`llmPluginCredentialSecret`, generated on first use). It is deliberately
  NOT derived from Node-RED's `_credentialSecret`: that setting belongs to
  the runtime, which generates it *and deletes it* the moment the user sets
  their own `credentialSecret` in `settings.js` — so deriving from it made
  that documented change silently destroy every stored key. Both runtime
  secrets are still READ, so blobs written by an older build still decrypt
  and are re-encrypted with the plugin key on the next save. GCM rather than the CTR that Node-RED uses for
  `flows_cred.json`: CTR is unauthenticated, so a tampered file decrypts
  to attacker-chosen bits without error, while GCM rejects it. Blobs
  written in the old CTR format are still read (prefix `g1:` marks GCM),
  and the next save rewrites them. Plaintext keys from older installs
  (and any leftover from the earlier synthetic-id `addCredentials`
  attempt) are migrated automatically on first boot.
- API keys are never returned to the client; masked via `maskApiKey()`.
  A stored key always yields a NON-EMPTY mask: the settings form reads an
  empty mask as "no key stored", shows a blank field, and the next save
  would then delete the key it was only meant to keep. Keys too short to
  mask by prefix/suffix without giving most of themselves away get a
  fixed-length placeholder instead.
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
- Stored documents are bounded: 5 MB per chat and per checkpoint (`meta`
  included), and checkpoints are pruned oldest-first past 200 files.
- No route takes a path. A chat is found by its sanitised id, a checkpoint
  id must match `cp_<digits>_<hex>`, and static files are a fixed list.
- `provider` must be `ollama`, `openai` or `custom`.
- `redactSecrets` strips API keys, URLs and IPs from every error message
  and client-reported event, `meta` included. The configured key VALUES are
  matched literally, first: a custom endpoint's key can be any shape at all,
  so no pattern covers it, and an endpoint that echoes the Authorization
  header into its error body would otherwise put it in the Node-RED log.
  The patterns remain as a net for keys that were never stored here.
- `credentials.json` is written atomically with the file created `0600` —
  a mode passed to a plain write is ignored once the target exists, and a
  crash mid-write would otherwise truncate the blob and lose every key.
- A key too short to mask by its ends gets a FIXED-width placeholder, so the
  mask never publishes the length of the secret.
- Client-reported events have newlines collapsed before they reach the
  line-oriented log, so caller-supplied text cannot forge a log entry.
- Credentials stripped from flow context before sending to the LLM. The
  `llm-request` node narrows the context further: only the config nodes its
  selected flows actually reference (transitively), rather than every
  config node in the instance.

#### Agent mode runs what the model writes

This is a deliberate property of the feature, not an oversight, and it is
the largest risk in the plugin:

- Agent mode applies the model's reply to the canvas with **no
  confirmation step**, and `Auto deploy` deploys it immediately.
- The reply is published to every open editor, but only the first to
  claim it (`POST /agent-apply/claim`, write permission) applies it. A
  second editor, or a read-only user's, drops it.
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

## Tests

Test documentation lives with the tests, in
**[`test/README.md`](../../test/README.md)**: what each suite guards, the
shared `helpers.js` sandbox, and how to configure the live round-trip
(`npm run test:llm`).

## Development notes

- **No jQuery** in client modules; vanilla DOM + `fetch`.
- **Module communication**: `window.LLMPlugin` namespace
  (`CanvasLayout`, `FlowConverterCore`,
  `LLMJsonParser`, `ChatManager`, `UI`, `Importer`).
- **Chat / checkpoint storage**: server-side, resolved by `llm_core.js`.
  There is exactly one location — `<userDir>/llm-plugin` — and memory-only
  if that is not writable (logged once; nothing survives a restart, API keys
  included).

  Two places it deliberately does **not** fall back to. The OS temp dir used
  to be second in line, which is where the encrypted `credentials.json`
  landed on any host with a read-only userDir: world-readable on some
  systems, cleared on no schedule the plugin controls, and left behind after
  an uninstall. The plugin's own install directory is not a candidate either
  — npm replaces that whole tree on a version upgrade, so it would lose the
  history on precisely the event that has to preserve it.

  What userDir buys is the intended lifecycle: **a plugin update keeps the
  chat history; removing `<userDir>/llm-plugin` resets it.** It is also
  where the rest of the plugin's state already is — the non-secret settings
  and the credential secret both go through `RED.settings`, i.e.
  `<userDir>/.config.runtime.json`.
- **`prompt_system.txt` and `prompt_ask.txt`** are read from the plugin install dir at module
  load. There is no embedded fallback: the file ships in the package and
  sits beside the module that reads it, so a failure is a packaging bug,
  and a stand-in prompt would keep generating flows while silently
  dropping the alias / `flow` / `above` / `reposition` rules the importer
  depends on. Presence is asserted by `npm test`.
- **Settings storage**: non-secret fields live in
  `RED.settings.get/set('llmPluginSettings')` (Node-RED's internal
  config, not in exported flows). API keys (OpenAI and Custom-endpoint)
  are split off into the encrypted credentials store — see Security
  measures above. The Custom endpoint's API key may be left blank for
  servers that don't require authentication.
- **A broken install fails loudly.** `llm_plugin.js` logs and RETHROWS, so
  Node-RED marks the plugin as failed to load. Swallowing the error left the
  sidebar loading against endpoints that all 404, with nothing in the log.
- **Node-RED API shapes that have already caused bugs here:**
  `RED.log.info/warn/error` take ONE message — unlike `console.error(a, b, c)`,
  extra arguments are dropped. `RED.settings.set` returns a Promise and throws
  synchronously when the runtime has no settings store, so it must be both
  awaited and try/caught. `_credentialSecret` is owned by the runtime, which
  deletes it when the user sets `credentialSecret` — never derive from it or
  write to it.
- **Adding a new endpoint**: add to `server.js`, restart Node-RED.
- **Adding a new client module**: drop file under `src/`, add to the
  load list in `client.js`, expose on `window.LLMPlugin`.
