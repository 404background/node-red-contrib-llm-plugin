# Design Notes — Processing Flow, Rules, Priorities, and Their Rationale

This document describes, for "user instruction → LLM response → applying it to the
flow", **in what order, by what rules, and with what priorities** the LLM Plugin
operates — and **why it is implemented that way**. It is meant as the shared basis
for discussing the implementation.

- Module-by-module "what does what" reference → [docs/en/architecture.md](./architecture.md)
- The intermediate format (Vibe Schema) spec → [docs/en/vibe-schema.md](./vibe-schema.md)
- Layout engine details → [docs/en/layout.md](./layout.md)

This note does not duplicate those; it focuses on the **"why" behind the design
decisions and priorities**.

---

## 0. Design pillars (why this shape)

| Decision | Reason |
|----------|--------|
| **Deterministic work in code, meaning in the LLM** | This split is the premise every other pillar rests on. **Anything with exactly one right answer** — generating and de-colliding node IDs, coordinates, assembling `wires` arrays, alias numbering, preserving junctions/groups — is always the code's job: `flow_converter_core.js` / `canvas_layout.js` / `importer.js`. **The LLM is trusted with exactly two things: the logical connections between nodes, and the settings inside a node.** Give deterministic work to a probabilistic output and it fails as duplicate IDs, broken coordinates, and mis-targeted wires — failures that are also hard to verify. Conversely, "make this inject fire every 5 minutes and feed the debug" is a meaning the code cannot decide. |
| **Interpose an intermediate "Vibe Schema"** | The boundary that enforces the split structurally. Raw Node-RED JSON carries random IDs, coordinates, and type-specific internal arrays that an LLM cannot meaningfully generate/edit. Abstracting to human-readable `{type}_{name}` aliases without coordinates means the LLM *cannot* invent IDs and has no positions to worry about. `flow_converter_core.js` handles raw JSON ↔ Vibe Schema. |
| **`_`-prefixed properties are metadata, never shown to the LLM** | Code-side hand-offs — aliases, declaration order, a comment's anchor target — ride on nodes as `_llmAlias` / `_llmOrder` / `_llmAboveId` and friends. Both directions of the boundary hang off that naming convention (§0, the metadata boundary). |
| **Applying is always a "merge"** | The LLM does not return the whole flow every time (partial edits are the norm). Fixing the rule to "only add/update what is listed, delete what maps to `null`, leave the unmentioned as-is" keeps an incomplete LLM response from breaking the existing flow. There is no branch that lets the model choose how to apply — a misfire there falls on the side of destroying the existing flow. |
| **Applying happens on the editor (browser) side** | Writing back from the server via the Admin API cannot clear the open editor's unsaved state (dirty/highlights), so it diverges from what the user sees. `RED.nodes.import` is used to apply directly to the canvas inside the browser (both sidebar and Agent node). |
| **Always checkpoint before a destructive change** | An LLM apply rewrites the original flow in one click. A snapshot is saved immediately before applying, enabling per-message "undo". `RED.history` is not used; the plugin's own checkpoints rewind. |
| **The snapshot must be the "complete flow"** | The snapshot is both the merge base and the rollback state, and the fallback apply still clears the target workspace, so any canvas entity missing from it can still disappear. → junctions / groups must be included (§7). |
| **Keep what the reply does not name** | One rule behind several mechanisms: anything a reply does not mention stays as it is, and removing something takes an explicit instruction. Wires are added, never cut by omission (§4.1). Properties that are not mentioned keep their values (§4.2). Config nodes are never created or deleted (§5). Junctions and groups are kept in the snapshot (§7). A group box is the user's: a reply cannot create, edit or delete one, and it is never removed because it became empty (§15). **Position is the exception**: the layout tidies the whole canvas, whoever placed things. Every box is fitted and aligned, and every overlap is resolved. Only a flow's shape is kept, since an untouched flow is translated, never reflowed ([layout.md](./layout.md)). A new mechanism starts from this default. |
| **The plugin raises no notifications** | Only Node-RED's own system notices (a deploy result, for one) reach the user as notifications. The plugin says nothing when things work, and a warning or error it has to report is a line in the chat panel (`Common.notice`), not kept in the chat history. |

### The metadata boundary (`_`-prefixed properties)

The test lives in exactly one place — `FlowConverterCore.isMetaProp(key)` (= `key` starts
with `_`) — and it constrains **both directions** of the boundary.

| Direction | Rule | Where |
|-----------|------|-------|
| **Outbound (to the LLM)** | `toIntermediate` never emits a `_`-prefixed key. IDs, `z`, `x`/`y`, `wires`, `g` are dropped the same way (`META_KEYS`). What the model receives is **aliases, `type`, `name`, type-specific properties, and connections — nothing else**. | `flow_converter_core.js` `toIntermediate` |
| **Inbound (from the LLM)** | `toNodeRed` **ignores** `_`-prefixed keys coming from the schema (both at the spec root and inside `props`). Only this module authors metadata; the model cannot forge it. Even the auto-created config stub is tracked in a local `autoStubAliases` map rather than as a flag on the spec. | `flow_converter_core.js` `toNodeRed` |
| **To the canvas** | The importer strips metadata in two sweeps: the first (after the merge) removes everything except `_llmOrder` / `_llmAboveId`, which the layout passes still need; the second (after layout) removes the rest. **By the time nodes reach `RED.nodes.import`, zero `_`-prefixed keys remain.** | `importer.js` `rebuildWorkspaceFromSnapshot` |

- **Reason**: Deleting metadata key by key means every new metadata key is a fresh chance to
  forget one — `_llmAboveId` did exactly that, riding into the canvas after the layout pass
  consumed it. Making it a naming convention lets the boundary hold automatically as new
  metadata is added.
- **"The model cannot forge it" is part of the rule**: if a schema could set `_llmSpecKeys`
  (which decides property preservation, §4.2) or `_autoStub` (which feeds config protection,
  §5), the LLM's output could bend the merge rules themselves.
- Regression test: `test/schema_conventions.test.js` (registered in `npm test`).

---

## 1. Data flow (overview)

```
User input
   │  (mode = Ask / Agent, target flow selection)
   ▼
vibe_ui.js  ──POST /llm-plugin/generate──►  server.js ─► llm_core.js ─► Ollama / OpenAI / Custom
   │                                                          │
   │   ┌── LLM context: getCurrentFlow(targets, {includeCanvasExtras}) → toIntermediate(Vibe Schema)
   │   │   (a wire through a junction reads as a connection to where it leads;
   │   │    groups are dropped; alias numbering is unchanged either way — §7, §15)
   ▼   ▼
Response text (explanation + optionally a ```json``` Vibe Schema block)
   │
   ├─ Ask  : applied when the user clicks the "Import" button
   └─ Agent: applied automatically once the response arrives
   │
   ▼
Importer.importFlowFromMessage(response, {mode})   ← the heart of applying
   │
   ├─ 0) Save checkpoint (ChatManager.saveImportCheckpoint, run by the UI on button click)
   ├─ 1) Multi-flow decision / implicit flow tagging (§6)
   ├─ 2) Parse the response (extractFlowNodes / connectionHints / flowDirectives)
   ├─ 3) Take the snapshot (safeGetCurrentFlow, includeCanvasExtras)
   ├─ 4) rebuildWorkspaceFromSnapshot (3 phases: delete → add → connect, §3)
   └─ 5) applyWorkspaceDiff (apply the end state as a diff, §12)
        └─ falls back to replaceWorkspaceFlow (clear + re-import) only when
           the diff cannot express the change (§12)
```

The Agent node (`node/llm-request`) also publishes the response to the editor via
`RED.comms.publish`, and an editor-side subscriber calls the same
`Importer.importFlowFromMessage`. **The apply logic is fully shared with the sidebar.**

---

## 2. Ask / Agent difference and rationale

| | Ask | Agent |
|--|-----|-------|
| The question | "What does this flow do, and what is wrong with it?" | "Change this flow" |
| System prompt | `prompt_ask.txt` — read the flow, explain it, do NOT propose one | `prompt_system.txt` — the Vibe Schema rules |
| The reply | Prose: which node is at fault, which property to change. Node aliases in backticks | A schema, applied to the canvas |
| In common | The flow context, the engine, the provider — and, when a reply does carry a schema, every rule for applying it | same |

- **The two are different questions, not one question handled differently
  afterwards.** They used to send the identical request and differ only in what
  the sidebar did with the reply, which left Ask answering "add a debug node"
  with a flow the user then had to import by hand — the mode said "read only"
  and the model proposed anyway. Ask now gets its own instructions: it is given
  the flow (it cannot explain what it cannot see) and told that a schema is
  useless here, because nothing in that mode can apply one.
- **Node references are not a mode feature.** Both prompts ask for the node's alias in backticks, and the sidebar annotates every assistant reply the same way, so a name in an answer is a link that reveals the node on the canvas — which is most of what makes a diagnosis useful.
- **A prompt holds only what the model decides.** What the code settles on its own is left out: merge semantics beyond "a delta, `null` deletes", layout, comment stacking, which box a wired node joins, what happens to an emptied box, the tab an untagged node lands on. Describing it costs tokens on every turn, and the prompt goes stale as the code changes. Rationale belongs here, not in the prompt.
- **The apply side still does not branch on mode.** Splitting the apply body is
  how you get bugs that break one side only, so `importFlowFromMessage` barely
  looks at it (only `mode==='agent'` reaches the parser, for partial-schema
  merging). What the mode decides is which prompt goes out, and the server
  decides that — it is the half that chooses what the model is told.

---

## 3. The three apply phases (delete → add → connect) and why that order

`rebuildWorkspaceFromSnapshot()` always processes in the following order. **The order
itself is a rule**, designed so a single schema cannot break even if it contradicts itself.

### Phase 1: Delete
- Remove nodes named by `removeTokens` (= alias→`null`) from the snapshot.
- Record removed IDs in `removedIdSet` so **Phase 2 is forbidden from reintroducing the same alias**.
- **Reason**: For "delete and recreate" style responses, even if a new node shares a name with a deletion target, the deletion intent can take priority.

### Phase 2: Add / Update
- Turn the remaining snapshot into `byId` and merge in the proposed nodes.
- **Config Node Protection**: do not add config nodes that don't already exist (§5).
- **Additive wire merge**: when matched to an existing node, union the existing wires with the proposed wires per port. **Connections are only cut by an explicit `remove`** (§4).
- **Property preservation**: keys the LLM did not touch are restored from the existing value (§4).

### Phase 3: Connect
- Build a **unified alias map** (the reason matters):
  - existing nodes' auto aliases ∪ new nodes' `_llmAlias` ∪ name ∪ ID
  - Without this, `{from: "inject_existing", to: "function_new"}` resolves the source (existing) but not the target (new). A new node auto-numbers to just `function`, which doesn't match the LLM-chosen `function_new`.
- Prune wires pointing at non-existent IDs → apply `removeConnections` → add the schema's `connections`.
- **Why connect last**: both endpoints of a connection must be resolved against the *final* node set (after delete and add). Fixing connections before delete/add would point at removed or not-yet-added nodes.

---

## 4. Merge rules (priorities for not breaking the existing flow)

### 4.1 Wires: default is "add", cut only when explicit
- existing wires ∪ proposed wires (deduped per port).
- Cut only when the LLM explicitly states `connections: [{ remove: { from, to } }]`.
- **Reason**: The LLM tends to omit the wires of the node it is editing. Interpreting omission as "cut" would silently drop unrelated existing connections. This default prevents the user complaint "connections get cut on their own."

### 4.2 Properties: "keys not mentioned keep the existing value"
- The set of keys the LLM explicitly set:
  - Vibe Schema path → `_llmSpecKeys` (recorded at conversion time)
  - raw JSON path → keys whose value is not `undefined`
- All other keys are restored from the existing node (`preserveUnmentionedProperties`).
- `MERGE_SKIP_KEYS` (id/type/z/x/y/wires/dirty/…) and `_`-prefixed metadata (§0, the metadata boundary) are excluded (identity, coordinates, editor state, and metadata are not carried over). Group membership (`g`) is deliberately **not** in that list — the group pass writes only the nodes this edit placed in a box (§15), so every other node's membership has to survive the merge (§12, "Where it declines").
- **Reason**: Even when a normaliser fills in a default value (e.g. debug's `complete`), it must not overwrite a value the user set earlier. Guarantees "settings you didn't touch are preserved."
- A **new** node takes its type's default for every property the reply left out (`applyTypeDefaults`), as a node dropped from the palette does. Without it a required property with no value (a `split` with no `property`) fails validation and the node shows the warning mark. A config reference with no default gets "", which is what the edit dialog writes for "none": left undefined, merely opening the node and closing it marks the flow undeployed (`http in`'s `swaggerDoc`). An edited node is re-validated after the write (`RED.editor.validateNode`), since the editor only validates on import and when its dialog closes.

### 4.3 Node matching: exact-alias only, no fuzzy
- When assigning a proposed node to an existing node, decide by **exact alias only** (`exactOnly: true`).
- **Reason**: The LLM is given every existing alias in the prompt. A non-matching alias means "new". Allowing fuzzy here would let a new `inject_py_1` prefix-match an existing `inject` and silently overwrite an unrelated node. **"Add as new" is safer than "overwrite the wrong one".**

---

## 5. Config Node Protection

- The LLM can **neither create nor delete** config nodes (broker, venv-config, etc.). It may only reference existing ones by alias. Enforced both in the prompt (`prompt_system.txt`) and on the apply side (`applyNodeDeletions` / Phase 2).
- A reference is resolved in this order: the target flow's own alias table, then the alias table of **all** the context flows, then a singleton reuse by type.
  - The middle step exists because a config node has no flow. The prompt numbers aliases across every context flow at once, so the model can read `ui_group_test_2` straight out of its context while the target flow's own table calls that node `ui_group_test` — or does not list it at all. Rebuilding the model's own table (from the same `UI.getFlowsByIds` export the prompt was built from) is what makes the reference it was given resolve to the node it was given. Node *identity* deliberately does not widen this way: aliases collide across flows and the apply may only write to the target (§6).
  - Any prop whose value is exactly a config node's alias is resolved, not only the key names `toNodeRed` recognises (`broker`, `group`, …). A contrib node nobody here has heard of names its config property whatever it likes, and `toIntermediate` already wrote an alias there on the way out; this is the other half of that round trip. Guarded by "a different type than the referring node", the same rule that keeps an `mqtt-broker`'s `broker: "localhost"` a hostname.
- A singleton config reuses the single existing match by type (prevents duplicate creation).
- A reference that resolves to **nothing** is cleared and reported ("Config node(s) not found: …"). The alternative was to leave the generated stub id in place, which pointed at a node that does not exist: invalid in a way that reads as a broken node rather than an unconfigured one, and silent either way.
- **Reason**: Config nodes are shared resources (credentials, endpoints) whose breakage has wide impact. Preventing the LLM from creating/deleting them avoids accidents that drag in other flows. All configs are put into the context as "free to reference, cannot create/delete".

---

## 6. Multi-flow: one alias, one node

- **The model is shown one alias numbering over every context flow**, so each alias names exactly one node. The importer reads a reply against that same numbering (`contextAliasTable`, rebuilt from `UI.getFlowsByIds`) before anything else, and `planByWorkspace` splits the reply into one sub-schema per context flow, written in the aliases that flow's own import resolves.
- **An existing node is edited on the tab it is on.** A `flow` on it is ignored; nothing moves between tabs.
- **A new node** goes to its `flow` tab when that is a context flow, else to the flow of what it is wired to or captions, else to the default flow. It is renamed when its tab already gives that alias to another node.
- A deletion, a `reposition` and a removed connection go to the flow of the node they name. A token that is not exactly an alias is looked up on each flow and applied only where exactly one flow has it.
- A wire between two tabs is not made. A removed connection across two context tabs (through link nodes) is cut by `severAcrossFlows` ([vibe-schema.md](./vibe-schema.md)).
- The llm-request node builds its context on the runtime (`flowContextFor`) with tabs in the order selected and config nodes in id order — the order `UI.getFlowsByIds` gives — so both sides number alike.
- **Reason**: each tab on its own numbers its nodes independently, so two tabs both have a `debug`. Reading a reply tab by tab, or guessing the tab from the first one that had the alias, is how an edit landed on the wrong node. The numbering the model saw has no such ambiguity.

### The scan is confined to the context flows (mandatory)

Inference, label resolution, and dispatch all scan **only the flows sent to the LLM as context** (`options.allowedWorkspaceIds` ← the message's `targetFlowIds`). Never every workspace.

- **Reason**: auto-generated aliases (`inject`, `debug_1`, `function_2`, …) are unique only *within* a flow and collide freely across tabs. The alias→tab map is first-wins, so a global scan lets an unrelated flow that merely sits earlier in the tab bar claim `inject` and take the whole edit with it. And an apply **deletes** whatever the merged end state does not contain (and the fallback path clears the target's canvas outright), so a misroute is destructive rather than additive. The checkpoint only covers the context flows, so Restore cannot undo it either.
- Scoping makes "flows written ⊆ flows checkpointed" hold, which is what keeps Restore meaningful.
- When the active tab is out of scope (the user switched tabs after Send), the target is a context flow, not the active tab. Only an empty scope (no flow selected) keeps the legacy active-tab behaviour.
- A final check right before the apply **aborts** the import if the target escaped the scope.
- Regression test: `test/cross_flow_isolation.test.js` (alias collision / tab switch / fan-out / out-of-scope `flow` tag / unscoped backwards compatibility / one alias one node / node ids in properties / runtime and editor numbering alike).

---

## 7. Snapshot completeness — junction / group

### Premises (Node-RED editor internals)
- `RED.nodes.filterNodes({z})` **returns regular nodes only**. In the editor, junctions live in `junctionsByZ` and groups in `groupsByZ`, **separate registries**, reachable only via `RED.nodes.junctions(z)` / `RED.nodes.groups(z)` (verified in the Node-RED 4.1.7 editor-client).
- `restoreMultiFlowCheckpoint` (restore), and `replaceWorkspaceFlow` when the diff falls back to it, **remove all** junctions / groups of the target workspace before re-importing, so anything missing from the snapshot is gone. On top of that, Phase 3's wire prune drops wires "targeting an ID not in rebuilt", so a missing junction also gets its `node→junction` wires cut as dangling.

### Design (opt-in inclusion)
- Added **`opts.includeCanvasExtras`** to `getFlowsByIds(flowIds, opts)` / `getCurrentFlow(flowIds, opts)`. Only when enabled, junctions / groups are included in the snapshot (`createExportableNodeSet` emits junctions correctly, with their wires).
- The rebuild base (`importer.safeGetCurrentFlow`), the checkpoint save (`chat_manager.snapshotCurrentFlow`) and the LLM context (`vibe_ui.js`) opt in.
- **Routing is the user's, and the model is not offered it.** Junctions and `link in` / `link out` nodes (`isRoutingNode`) get no alias in `toIntermediate`, and a wire through them reads as a connection to where it leads: `A → junction → B`, and `A → link out ⇢ link in → B`, both show as `A → B`. The model understands where messages go, and the alias numbering is the same with or without routing. A reply that restates such a connection would add a direct wire beside the routing, and the node would get every message twice: `dropWiresBesideRouting` drops a wire the reply added when the same port already reaches that node through routing. A reply that removes the connection is cut inside the routing (`severConnections`), and routing the edit left idle is taken down (`removeIdleRouting`), so every other connection reads the same afterwards; see [vibe-schema.md](./vibe-schema.md). The model never adds or places routing itself. (`link call` is not routing: it is a step that returns, and stays an ordinary node.)

### Excluding groups from layout
- A junction has x/y/wires, so `isCanvasNode` is true. It is a real routing point and stays in the layout adjacency graph, so a chain is laid out through it; then it goes back where it was. **The layout never places a junction** itself: it moves only with what it serves. A junction or link node outside a box follows the nodes it leads to (a `link out`, the nodes feeding it) by as much as they moved, so one between two boxes goes with the lower box when a node added above pushes it down ([layout.md](./layout.md#routing-follows-what-it-serves)). It is measured at its real 10×10, and `settleCollisions` moves whatever lands on one (a junction on a box edge is an ordinary route and is left alone).
- A group also has x/y, so `isCanvasNode` is true too, but **a group's bounding box encloses its own members**. Feeding it to the collision-resolution passes makes it "collide with its own contents" and break.
- → Added `isLayoutNode()` (= `isCanvasNode && type!=='group'`), applied to all layout calls. **Groups are excluded from layout** (their positions are kept as-is).
- Regression test: `test/junction_preserve.test.js` (registered in `npm test`). Edits an `A→junction→B` flow and verifies the junction and both wire directions survive; that no edit moves a junction whose targets stayed put, rewires it or lands on it; that routing between two boxes follows the box it feeds when that box is pushed down; that the context reads through junctions and a restated connection adds no wire; that a removed connection is cut through junctions and link nodes with every other connection kept and idle routing removed; and that a link node's hover-only virtual link does not join two sequences.

### The rollback snapshot is subject to the same rule
- Both appliers take their own backup before touching the workspace, so a failing `RED.nodes.import` can put the flow back. That backup used to hold **regular nodes only** — so the error path, the one case that is supposed to change nothing, deleted the workspace's junctions and groups for good.
- The backup now covers junctions and groups too, and is produced with `createExportableNodeSet` rather than a plain JSON clone: a *live* group's `nodes` array holds node **objects**, which a naive clone would serialise into the backup where the import format expects ids.
- Regression test: `test/import_safety.test.js` scenario B.

---

## 8. Layout priorities (details in layout.md)

- **When an existing flow is present, incremental** (`placeAddedNodesNearNeighbors`): restore existing node coordinates from `basePositions` and place only the new nodes to the right/left of neighbors, so the existing shape is preserved.
- **Only for a brand-new flow, reflow** (`reflowCanvasNodes`). Long chains are **not wrapped**: a box already makes a sequence readable, and a wrap that moved one or two nodes to a row of their own read worse than a long row.
- **Gaps are "edge-to-edge clearance"** (visible whitespace), not center-to-center distance. Node width uses the editor's measured value (`RED.nodes.node(id).w`) when possible, falling back to an estimate on rename.
- The `reposition` directive relayouts only the named subset and translates it back to its previous top-left so nothing else moves (re-arrange without changing IDs; avoids delete→recreate which changes IDs).

---

## 9. Checkpoint (rewind) semantics

- **Immediately before** applying, save a snapshot of the target flow (`saveImportCheckpoint`). Bind the ID to the message; the Restore button next to the message rewinds.
- Checkpoints are pruned oldest-first past `MAX_CHECKPOINT_FILES`.
- An `llm-request` node's edit takes no checkpoint and has no restore UI: the sidebar's chat history is how an edit is followed, and a node's edits are reviewed on the canvas before Deploy.
- Pruning happens **after** the write, not before. Pruning first left the directory at cap+1 once the new record landed, so the limit never meant what it said, and the memory-only branch (which inserts then trims) disagreed with the on-disk one about the same constant.
- Restore (`restoreMultiFlowCheckpoint`) removes all non-tab entities of the target workspace (regular nodes + subflow instances + junctions + groups) via type-specific APIs, then re-imports the snapshot.
- That the snapshot includes junctions/groups (§7) is the prerequisite for them not vanishing on restore.
- Restore marks the workspace dirty so it can be Deployed to commit.

---

## 10. Security / boundary defaults (assumptions)

- All HTTP endpoints are on `RED.httpAdmin`, and each data/action route carries `RED.auth.needsPermission` explicitly — Node-RED does not extend `adminAuth` to plugin-registered routes on its own. The client sends the editor bearer token via `Common.apiFetch`. Static asset routes are intentionally left open (tag-loaded, cannot send headers; plugin's own published code only).
- API keys are encrypted (`<userDir>/llm-plugin/credentials.json`, beside the plugin's other state, AES-256-GCM, legacy CTR still readable). Logs, errors, and client logs are masked via `redactSecrets`. Credentials are also stripped from the flow context sent to the LLM.
- **Agent mode is an accepted-risk boundary**: the model's output is applied without confirmation and may contain `function` / `exec` nodes, so it is arbitrary code execution by design. No node-type allowlist — constraining it would defeat the mode. See architecture.md.

---

## 11. Points to discuss / known trade-offs

Main points to discuss on top of this document:

1. **Group type classification**: In `isConfigNode`'s structural fallback, a group is treated as config before export and as canvas after export (with x/y). Currently reconciled by "excluding it from layout only" — should `type==='group'`/`'junction'` be made explicit in the type check?
2. **Fuzzy matching scope**: Node matching is exact-only, while prose annotation and hint resolution use fuzzy (minLen 8). Is this boundary (how much approximate matching to allow) appropriate?
3. **adminAuth support**: Should authenticated environments be brought into the supported scope?

### Reference: alias resolution priority (`buildFlowLookup().resolve`)
```
exact ID → exact alias → normalized alias → node name
   → [exactOnly stops here]
   → loose alias → fuzzy approximate (minLen default 8, only when unique)
```
- `exactOnly` is used in node matching (§4.3) and hint/directive pre-resolution to prevent a weak match from stealing another node's ID.

---

## 12. Applying as a diff, not a rebuild

### The problem with rebuilding
`rebuildWorkspaceFromSnapshot` produces the **complete desired end state** for the
workspace, and the original applier realised it the blunt way: remove every node,
junction and group in the tab, then `RED.nodes.import` the whole merged set back with
the same ids. The end state was right, but the route there destroyed and recreated
every node in the flow — including the ones the edit never mentioned. That made the
editor's own undo incoherent and turned any gap in the snapshot into a silent
deletion (which is how junctions and groups were lost, §7).

(The canvas selection is cleared either way: `refreshCanvasView` invokes
`core:select-none` before redrawing, on both paths, because a removed node must not
stay in the selection. The diff narrows what is destroyed, not what is deselected.)

### What is NOT the problem
The deployed runtime was never restarted by this. `diffNodes` in
`@node-red/runtime/lib/flows/util.js` decides what a deploy stops and starts, and it
compares node configs by id while deliberately ignoring `x`, `y` and `wires` (and, for
a group, `nodes` / `style` / `w` / `h`). Since the rebuild preserves ids and carries
untouched nodes through from the snapshot unchanged, they never land in
`diff.changed`. Pinned by `test/deploy_churn.test.js`, which re-implements that exact
criterion. (A **Full** deploy restarts everything regardless, and the **Modified
Flows** deploy type also restarts `linked` and `rewired` nodes — both are the deploy
type's doing, not the applier's.)

### `applyWorkspaceDiff`
Same end state, applied as a diff against the live workspace:

| Class | Action |
| --- | --- |
| live, no longer wanted | `RED.nodes.remove` / `removeJunction` / `removeGroup` |
| wanted, not yet live | collected and handed to one `RED.nodes.import` |
| in both, properties differ | written onto the live node in place |
| in both, only x/y differ | position assigned, `moved` set |
| in both, wiring differs | link surgery (below) |
| in both, identical | **not touched at all** |

### Wires are links, not an array
`node.wires` is not the source of truth in the editor. Links are separate objects
(`{ source, sourcePort, target }`) in their own registry, and `createExportableNodeSet`
*derives* `wires` from them — assigning to `node.wires` changes nothing. So a wiring
change goes through `RED.nodes.addLink` / `removeLink` against the live node objects.
`removeLink` matches by object **identity**, so the links to cut have to come from
`RED.nodes.getNodeLinks(id, 0)`; a reconstructed link object silently matches nothing.
Added nodes are imported **before** the wire pass, because a new link needs both ends
to exist.

Two ordering details follow from this:
- An added node's own `wires` become links during the import. Wires pointing **at** it
  from nodes that were not re-imported do not — that is what the rewire pass covers.
- A property update that repoints a config reference de-registers against the **old**
  value (`updateConfigNodeUsers(node, {action:'remove'})`) before writing and
  re-registers after, or the config node's `users` list keeps a node that no longer
  uses it.

### Where it declines
The diff hands back `fallback: true` and the caller runs `replaceWorkspaceFlow`
instead when it meets something it cannot express safely:
- an existing id changed `type`
- a live entity that does not round-trip through an export
- there is a group on either side **and the group API is unavailable** (see below)

**`g` has to survive the merge for any of this to mean anything.** It is not in
`MERGE_SKIP_KEYS`, and must not be: nothing else restores it, so skipping it made
every edited node come back without its group. That was a silent data loss on its
own (the node left the group while the group went on listing it), and it also made
the "group membership changed" test fire on every ordinary property edit — so on any
flow that uses groups, the diff declined every time and the destructive rebuild ran
instead. Carrying `g` blindly is safe because it is a `META_KEY` in the converter:
the schema can neither read nor write it, so the existing value is the only value
there can be.

A node belongs to exactly ONE box, so a member the schema moves has to leave the
list of the box it came from. While both lists named it, the old box stayed
stretched across the canvas to reach a node it no longer held, and which half of
the membership won came down to the order the groups happened to be written in.
And "put this node in that box" moves membership, not the node. Because a box
holds one sequence (§15), a node that joins one is always part of the sequence
already in it, so the ordinary pass has already placed it beside its neighbours.

The other half of that relationship is the group's own `nodes` list, and Node-RED
does not maintain it for us — `RED.nodes.remove` has no group bookkeeping at all
(the editor's delete action calls `RED.group.removeFromGroup` first). Both halves
have to be kept in step, in two different places:

- **In the merged end state.** The deletion phase prunes removed ids out of every
  group's `nodes`, the same way it prunes wires, so the flow the applier is handed
  is already consistent.
- **On the live canvas.** Before removing a node the diff calls
  `RED.group.removeFromGroup`, which is the only correct way to do it: a group holds
  its members as node **objects**, so the list cannot be edited through the exported
  id form. Removing the node first would leave the group naming something that no
  longer exists.

That is why the group's `nodes` is excluded from the property comparison alongside
`w`/`h`. All three are derived from the members; the authoritative half of
membership is each node's `g`, which **is** compared. Comparing the list as well
would report every membership change twice.

**Applying the other half: `applyGroupMembership`.** The schema asks the model for
boxes now (§15), so an edit that changes membership is the common case rather than
the rare one — declining it meant the destructive rebuild ran on most replies, with
the deploy churn and the log line that go with it. The diff writes membership itself
instead, after the import, because a member added by this edit has to exist before it
can be put in a box:

- **Members leaving first.** A node that left its box, or whose box this edit
  deleted, is detached through `RED.group.removeFromGroup`. `RED.nodes.removeGroup`
  does not clear its members' `g`, and `g` is the half the editor draws from.
- **Then the list is assigned**, not spliced: the desired members, resolved to their
  live objects. An entry the editor left behind as an id rather than an object is
  exactly the shape that draws an empty box.
- **And the box with it.** Node-RED recomputes a group's bounds only when a user
  drags a member, so the box the layout fitted is the box the user sees. This is also
  why the pass does not call `RED.group.addToGroup`: that one recomputes the box from
  `n.w` / `n.h`, which a node that has not been drawn yet does not have.
- **It runs whenever there is a box on either side.** The box and the member list are
  derived, so they are not compared, which means "nothing changed" is not something
  the diff can read off them. The pass is idempotent — for an untouched group it
  writes back what it already had.

`removeFromGroup` is a silent no-op on a locked workspace, and a silent no-op is the
worst outcome available here — the node would go while the group went on naming it.
So the diff checks for a usable group API first and declines if it has none. The
destructive rebuild does not need the API (it re-imports the group wholesale) and
reaches the same consistent end state, just by the broader route.

Correctness still never depends on the diff covering every case: the rebuild
reaches the same end state by the broader route, and every group case can fall back
to it.

### Rollback
A throw part-way through a diff leaves a half-applied workspace, which a plain
re-import cannot undo (it would not remove what was added). The error path therefore
clears the tab and re-imports the "before" export — the same export used as the
comparison baseline, so the two can never disagree about what "before" was.

**Config nodes need their own undo.** They have no `z`, so they are not in the
workspace export at all and restoring the canvas cannot reach them — a failed apply
used to leave the flow looking untouched while the broker it talks to had already
been repointed. `applyConfigNodeUpdates` therefore records, per config node it
touches, either "this one was not live, remove it again" or the prior value of every
key it overwrites (`hasOwnProperty`, so a key that was genuinely absent is deleted
rather than written back as `undefined`). The undo runs newest-first, and after the
canvas restore: removing the workspace's nodes de-registers them from the config
nodes' `users` lists first. `changed` is restored along with the values, because
that flag is what a deploy reads — leaving it set would restart a config node for an
edit that never landed.

- Regression tests: `test/incremental_apply.test.js` (what gets touched),
  `test/deploy_churn.test.js` (what gets restarted), `test/import_safety.test.js`
  scenario B (canvas rollback) and scenario D (config-node rollback).

---

## 13. Two producers, one canvas

The sidebar and the `llm-request` node both apply edits to the canvas, and a
node reply arrives whenever its model finishes. **They are not ordered**: each
apply lands when it arrives, merged onto the canvas as it stands at that moment.

- Each apply saves its checkpoint immediately before it runs. Restoring it puts
  its flows back as they were then, which also takes away anything applied
  after it.
- A node reply reaches every open editor, and only the first to claim it
  (`agent-apply/claim`) applies it, so it is applied once.
- The write itself is still Node-RED's to guard: a deploy against an old
  revision returns `409` and opens the editor's merge-conflict dialog.
- **Why there is no queue.** An applied-but-undeployed flow used to be held
  until a deploy, and every other edit to it waited. That protected the review
  window, but a follow-up instruction in the same chat then waited on a deploy
  nobody meant to make yet, and a panel, a Release button and timeouts were
  needed just to get out of it. Review now rests on the checkpoint, and on
  deploying being the user's decision.

## 14. Two readings of a value the model broke

A reply's JSON arrives with a quote missing, or one too many, far more often
than it arrives truncated, so `llm_json_parser` repairs it rather than losing
the whole reply. The quote repair reads a value the way a person would:
everything from the opening quote up to the quote that is followed by a `,`,
`}` or `]` is the value, and the quotes in between are escaped.

That reading is right for a string. It is wrong for an expression.

```
"to": "WARN " & payload.line & "C",
```

The model meant the JSONata expression `"WARN " & payload.line & "C"`, whose
own first and last characters are quotes. The repair reads those two as the
value's delimiters and escapes the two in the middle, which yields valid JSON,
a valid Vibe Schema, and an expression Node-RED rejects — the node imports and
then reports a JSONata error. Nothing downstream can catch it, because by then
the expression is just a string that happens not to parse.

Both readings are real, so the parser does not prefer one on principle. It asks
which one is an expression at all. In JSONata a string literal is glued to what
surrounds it by an operator, so the code between two literals both starts and
ends with one; split the value at each quote the repair escaped, and only one
reading survives that test:

| Value the repair produced | Read as written | Read as an expression |
|---|---|---|
| `WARN " & payload.line & "C` | `WARN ` is not code ✗ | `" & payload.line & "` — an operator at each end ✓ |
| `payload.a & "x" & payload.b` | `payload.a & ` … ` & payload.b` ✓ | `x` is not code ✗ |

When exactly one reading holds, the parser takes it and gives back whichever
quote that reading says was the expression's own — the leading one, the
trailing one, or both. When neither holds — the `f"text {var}"` in a function
body, a sentence quoting a phrase — the value is left exactly as the repair
produced it. A guess that could go either way is not made.

The system prompt asks for single quotes in expression fields (`tot` / `vt` =
`jsonata`) for the same reason: a JSONata literal written `'C'` needs no JSON
escaping, which keeps most replies out of this path altogether.

One more thing the repair has to know, because a single broken value sends the
**whole** block through it: a string inside an **array** is a value, not a key.
The repair decided that by looking back for a `:`, and inside `["a", "b"]` there
is none — so each element was read as a key, whose end is a `:` rather than a
`,`, and the commas were swallowed into the string. One malformed expression
could therefore corrupt every `reposition` or group member list in the same
reply. The container the cursor is in is now tracked, and a string inside an
array is always a value.

- Regression tests: `test/json_repair.test.js` — an expression keeps the quotes
  of its own literals (both the case that loses two and the case that loses only
  the trailing one); a concatenation and a ternary that already read correctly
  are not re-quoted; the f-string inside a function body is still left alone.

## 15. A flow, a tab, and a group

Node-RED calls two different things a flow: a **tab**, and one **connected
sequence** of nodes. Users mean both, often in the same sentence, and the
ambiguity lands in the one place it does damage — "make me three flows in here"
was read as three tabs, or as one chain with three branches, when what was asked
for was three independent sequences side by side.

So the schema takes a side: `flow` on a node is **always the tab label**. A
tab holds any number of unconnected sequences, and the layout already gives each
its own band, so nothing had to change about the canvas. What was missing was an
instruction not to wire separate sequences into one chain just because they were
asked for together. **The prompt** now states the distinction, and tells the
model to build that many independent sequences, each with its own trigger and
its own end, when asked for several flows / sequences / pipelines. Without this
the model reached for the shape it knows best: one chain from one trigger.

### Group boxes are the user's

A group, the box the editor draws around a set of nodes, is **not part of the
schema**. An earlier version let the model declare, extend, nest and delete
boxes (`groups: { alias: { name, nodes } }`). That was withdrawn. A box is
something the user drew, and a reply that could redraw it breaks the rule that
what the reply does not name stays as it is (§0). Now:

- The context shows no box. `toIntermediate` drops groups, so node aliases are
  identical with or without them, and the numbering the importer reproduces
  (§6) cannot move.
- A `groups` key in a reply is ignored, and a groups-only reply is not a schema
  (`isVibeSchema`). No box is created, edited or deleted.
- The prompt says nothing about boxes. What happens to them is the code's
  business (§2).

The context export still carries groups (`includeCanvasExtras`), because it
carries junctions, and the converter drops the boxes.

### One box, one sequence

A box is assumed to hold exactly **one connected sequence**, meaning one
component of the wire graph. A wire through a junction counts. A link node's
virtual link, which the editor draws only on hover, does not, even though the
context shows it as a connection. Captions and nested boxes are not sequences.
An edit keeps a box that way (`keepBoxesAroundTheirSequences`):

- **A new node wired into a boxed sequence joins that box**, as long as every
  box among its neighbours is the same one. Left outside, the node was
  separated from the box it belongs to by the alignment pass.
- **A caption joins the box it heads.** The padding is one row, so a comment
  anchored to the first member lands exactly on the top edge and reads as a
  stray label rather than a heading. **Where a comment sits is the model's
  decision.** The context gives every comment the `above` it currently has, and
  any comment the reply gives an `above` (new or existing) is placed over that
  node and follows it: into the node's box, or out of its old box when the node
  has none. A comment the reply does not mention keeps its box.
- **Wiring two boxes together** is a change to the wires only. Both boxes stay
  where they are, with the members they had. The sequence now runs through two
  boxes, and each box still holds one part of it.
- **A box is never removed implicitly.** When all of its members are deleted,
  or the user drew it empty, the box stays, as it does in the editor. A deleted
  member is taken out of its group's `nodes` list, because `RED.nodes.remove`
  does no group bookkeeping (§12).

Membership is two-sided in the editor: `g` on the member, the id in the group's
`nodes` list. Only a node this edit placed in a box gets its `g` written. An
existing group's own bookkeeping is not an unrelated edit's business, and
"repairing" it would register as a change and send the whole apply down the
rebuild path.

### The box is computed here

Node-RED stores `x`/`y`/`w`/`h` on the group and recomputes them only when the
user drags a member, so a box whose members a layout pass moved would be left
where it was. `CanvasLayout.fitGroups` fits every box after the layout passes,
with the editor's own 25px padding ([layout.md](./layout.md#group-boxes)).
Every box is fitted tightly, including one the user made larger: a box bigger
than its contents cannot be lined up or spaced by what is in it.

- Regression tests: `test/group_schema.test.js`: a reply cannot create, edit or
  delete a box; the context shows no box and leaves node aliases alone; a node
  added to a box pushes the next sequence down, whole; rearranging a boxed
  sequence refits the box, and its caption follows the node it heads; a box
  stays when its members are deleted, and so does an empty one; a wire between
  two boxes keeps both where they are; a new node wired into a boxed sequence
  joins that box; a branch added inside a box lands clear of the others, in
  port order; a comment moves to the node the reply names, and into its box;
  and a new comment over a boxed node is drawn inside the box.
  `test/junction_preserve.test.js` covers the junction and link-node side.
