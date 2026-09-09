# Design Notes — Processing Flow, Rules, Priorities, and Their Rationale

This document describes, for "user instruction → LLM response → applying it to the
flow", **in what order, by what rules, and with what priorities** the LLM Plugin
operates — and **why it is implemented that way**. It is meant as the shared basis
for discussing the implementation.

- Module-by-module "what does what" reference → [architecture.md](./architecture.md)
- The intermediate format (Vibe Schema) spec → [vibe-schema.md](./vibe-schema.md)
- Layout engine details → [layout.md](./layout.md)

This note does not duplicate those; it focuses on the **"why" behind the design
decisions and priorities**.

---

## 0. Design pillars (why this shape)

| Decision | Reason |
|----------|--------|
| **Deterministic work in code, meaning in the LLM** | This split is the premise every other pillar rests on. **Anything with exactly one right answer** — generating and de-colliding node IDs, coordinates, assembling `wires` arrays, alias numbering, preserving junctions/groups — is always the code's job: `flow_converter_core.js` / `canvas_layout.js` / `importer.js`. **The LLM is trusted with exactly two things: the logical connections between nodes, and the settings inside a node.** Give deterministic work to a probabilistic output and it fails as duplicate IDs, broken coordinates, and mis-targeted wires — failures that are also hard to verify. Conversely, "make this inject fire every 5 minutes and feed the debug" is a meaning the code cannot decide. |
| **Interpose an intermediate "Vibe Schema"** | The boundary that enforces the split structurally. Raw Node-RED JSON carries random IDs, coordinates, and type-specific internal arrays that an LLM cannot meaningfully generate/edit. Abstracting to human-readable `{type}_{name}` aliases without coordinates means the LLM *cannot* invent IDs and has no positions to worry about. `flow_converter_core.js` handles raw JSON ↔ Vibe Schema. |
| **`_`-prefixed properties are metadata, never shown to the LLM** | Code-side hand-offs — aliases, declaration order, a comment's anchor target — ride on nodes as `_llmAlias` / `_llmOrder` / `_llmAboveId` and friends. Both directions of the boundary hang off that naming convention (§0.1). |
| **Applying is always a "merge"** | The LLM does not return the whole flow every time (partial edits are the norm). Fixing the rule to "only add/update what is listed, delete what maps to `null`, leave the unmentioned as-is" keeps an incomplete LLM response from breaking the existing flow. There is no branch that lets the model choose how to apply — a misfire there falls on the side of destroying the existing flow. |
| **Applying happens on the editor (browser) side** | Writing back from the server via the Admin API cannot clear the open editor's unsaved state (dirty/highlights), so it diverges from what the user sees. `RED.nodes.import` is used to apply directly to the canvas inside the browser (both sidebar and Agent node). |
| **Always checkpoint before a destructive change** | An LLM apply rewrites the original flow in one click. A snapshot is saved immediately before applying, enabling per-message "undo". `RED.history` is not used; the plugin's own checkpoints rewind. |
| **The snapshot must be the "complete flow"** | The snapshot is both the merge base and the rollback state, and the fallback apply still clears the target workspace, so any canvas entity missing from it can still disappear. → junctions / groups must be included (§7). |

### 0.1 The metadata boundary (`_`-prefixed properties)

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
   │   ┌── LLM context: getCurrentFlow(targets) → toIntermediate(Vibe Schema)
   │   │   (junction/group NOT included = the alias numbering the model sees is unchanged)
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
| Apply trigger | User presses Import | Automatic once the response arrives |
| Use case | Want to review before applying | Iteration / automation |
| In common | Apply logic, checkpoints, merge rules are all identical | same |

- **The mode is only a difference of "when to apply".** Branching the apply body
  would be a source of bugs that break one side only, so `importFlowFromMessage`
  barely looks at mode (it only passes `mode==='agent'` to the parser's merge behavior).

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
- `MERGE_SKIP_KEYS` (id/type/z/x/y/wires/g/dirty/…) and `_`-prefixed metadata (§0.1) are excluded (identity, coordinates, editor state, and metadata are not carried over).
- **Reason**: Even when a normaliser fills in a default value (e.g. debug's `complete`), it must not overwrite a value the user set earlier. Guarantees "settings you didn't touch are preserved."

### 4.3 Node matching: exact-alias only, no fuzzy
- When assigning a proposed node to an existing node, decide by **exact alias only** (`exactOnly: true`).
- **Reason**: The LLM is given every existing alias in the prompt. A non-matching alias means "new". Allowing fuzzy here would let a new `inject_py_1` prefix-match an existing `inject` and silently overwrite an unrelated node. **"Add as new" is safer than "overwrite the wrong one".**

---

## 5. Config Node Protection

- The LLM can **neither create nor delete** config nodes (broker, venv-config, etc.). It may only reference existing ones by alias. Enforced both in the prompt (`prompt_system.txt`) and on the apply side (`applyNodeDeletions` / Phase 2).
- A singleton config reuses the single existing match by type (prevents duplicate creation).
- **Reason**: Config nodes are shared resources (credentials, endpoints) whose breakage has wide impact. Preventing the LLM from creating/deleting them avoids accidents that drag in other flows. All configs are put into the context as "free to reference, cannot create/delete".

---

## 6. Multi-flow / implicit flow tagging

- If schema nodes carry `flow: "<tab name>"`, apply per workspace (`dispatchMultiFlowImport`).
- **Implicit tagging** (`inferImplicitFlowTagging`): even if the LLM forgets the tags, when the schema's aliases/connections resolve against existing nodes across multiple workspaces, infer alias→tab name, and follow connections so new nodes inherit the tab of their existing neighbors.
- **Reason**: For instructions spanning multiple tabs like "MCU side / Server side", the LLM tends to drop the `flow` tag. Without tags, connections cannot cross the active-tab boundary, producing the "nothing connects to mqtt_out" symptom. Inference fills the gap.

### The scan is confined to the context flows (mandatory)

Inference, label resolution, and dispatch all scan **only the flows sent to the LLM as context** (`options.allowedWorkspaceIds` ← the message's `targetFlowIds`). Never every workspace.

- **Reason**: auto-generated aliases (`inject`, `debug_1`, `function_2`, …) are unique only *within* a flow and collide freely across tabs. The alias→tab map is first-wins, so a global scan lets an unrelated flow that merely sits earlier in the tab bar claim `inject` and take the whole edit with it. And an apply **deletes** whatever the merged end state does not contain (and the fallback path clears the target's canvas outright), so a misroute is destructive rather than additive. The checkpoint only covers the context flows, so Restore cannot undo it either.
- Scoping makes "flows written ⊆ flows checkpointed" hold, which is what keeps Restore meaningful.
- When the active tab is out of scope (the user switched tabs after Send), the target is a context flow, not the active tab. Only an empty scope (no flow selected) keeps the legacy active-tab behaviour.
- A final check right before the apply **aborts** the import if the target escaped the scope.
- Regression test: `test/cross_flow_isolation.test.js` (alias collision / tab switch / fan-out / out-of-scope `flow` tag / unscoped backwards compatibility).

---

## 7. Snapshot completeness — junction / group

### Premises (Node-RED editor internals)
- `RED.nodes.filterNodes({z})` **returns regular nodes only**. In the editor, junctions live in `junctionsByZ` and groups in `groupsByZ`, **separate registries**, reachable only via `RED.nodes.junctions(z)` / `RED.nodes.groups(z)` (verified in the Node-RED 4.1.7 editor-client).
- `restoreMultiFlowCheckpoint` (restore), and `replaceWorkspaceFlow` when the diff falls back to it, **remove all** junctions / groups of the target workspace before re-importing, so anything missing from the snapshot is gone. On top of that, Phase 3's wire prune drops wires "targeting an ID not in rebuilt", so a missing junction also gets its `node→junction` wires cut as dangling.

### Design (opt-in inclusion)
- Added **`opts.includeCanvasExtras`** to `getFlowsByIds(flowIds, opts)` / `getCurrentFlow(flowIds, opts)`. Only when enabled, junctions / groups are included in the snapshot (`createExportableNodeSet` emits junctions correctly, with their wires).
- **Only the two callers that rebuild the flow opt in**:
  - `importer.safeGetCurrentFlow` (the rebuild base for apply)
  - `chat_manager.snapshotCurrentFlow` (checkpoint save)
- **The LLM-context path (`vibe_ui.js`) and the annotation path (`ui_core.js`) do NOT opt in.**
  - **Reason**: These share `toIntermediate`'s alias numbering. Mixing junctions/groups in would change the order of aliases the model sees, altering generation behavior. Using the complete flow only on the apply side while keeping the generation side unchanged isolates the bug fix from generation quality.

### Excluding groups from layout
- A junction has x/y/wires, so `isCanvasNode` is true. It is a real routing point and may stay in the layout adjacency graph (its position is preserved from `basePositions` on the incremental path).
- A group also has x/y, so `isCanvasNode` is true too, but **a group's bounding box encloses its own members**. Feeding it to the collision-resolution passes makes it "collide with its own contents" and break.
- → Added `isLayoutNode()` (= `isCanvasNode && type!=='group'`), applied to all layout calls. **Groups are excluded from layout** (their positions are kept as-is).
- Regression test: `test/junction_preserve.test.js` (registered in `npm test`). Edits an `A→junction→B` flow and verifies the junction and both wire directions survive.

### The rollback snapshot is subject to the same rule
- Both appliers take their own backup before touching the workspace, so a failing `RED.nodes.import` can put the flow back. That backup used to hold **regular nodes only** — so the error path, the one case that is supposed to change nothing, deleted the workspace's junctions and groups for good.
- The backup now covers junctions and groups too, and is produced with `createExportableNodeSet` rather than a plain JSON clone: a *live* group's `nodes` array holds node **objects**, which a naive clone would serialise into the backup where the import format expects ids.
- Regression test: `test/import_safety.test.js` scenario B.

---

## 8. Layout priorities (details in layout.md)

- **When an existing flow is present, incremental** (`placeAddedNodesNearNeighbors`): restore existing node coordinates from `basePositions` and place only the new nodes to the right/left of neighbors. maxColumns disabled (preserve the existing shape).
- **Only for a brand-new flow, reflow** (`reflowCanvasNodes`): fold long chains via maxColumns.
- **Gaps are "edge-to-edge clearance"** (visible whitespace), not center-to-center distance. Node width uses the editor's measured value (`RED.nodes.node(id).w`) when possible, falling back to an estimate on rename.
- The `reposition` directive relayouts only the named subset and translates it back to its previous top-left so nothing else moves (re-arrange without changing IDs; avoids delete→recreate which changes IDs).

---

## 9. Checkpoint (rewind) semantics

- **Immediately before** applying, save a snapshot of the target flow (`saveImportCheckpoint`). Bind the ID to the message; the Restore button next to the message rewinds.
- **The Agent node checkpoints too** (`saveNodeApplyCheckpoint`). It used to be the one way to change a flow that could not be undone, which is worst exactly where it is most used: an unattended node with auto deploy puts the edit into the running runtime with nobody watching. It cannot reuse the sidebar's call — there is no chat — and borrowing whichever chat happens to be open would file the node's edit under an unrelated conversation and delete it with that chat. So `chatId` is null and `meta.source` is `node-apply`, alongside `meta.node` (which node) and `meta.targetFlowIds` (what it was allowed to write). A failed checkpoint does not cancel the edit; the notification says a restore point could not be saved.
- Those two sources are pruned against **separate budgets** (`MAX_CHECKPOINT_FILES` / `MAX_NODE_CHECKPOINT_FILES`). A node on a timer takes a checkpoint every time it fires, and a single oldest-first pass over the whole directory would let that stream evict the chat checkpoints the sidebar's Restore buttons point at — turning those buttons into 404s while the flow they would have restored is gone. Per-source budgets mean a busy node can only crowd out itself.
- A node checkpoint has no message to hang off, so `GET /llm-plugin/checkpoints` lists checkpoint headers (no flow bodies) newest-first, with `?source=node-apply` to narrow. A restore point nobody can find is not a restore point. The **Restore Points** dialog (the history button in the sidebar header) is the front end for it: a badge for which producer, what the checkpoint was taken before, when, how big the snapshot is, and which flows were in scope — resolved to flow *names*, since the ids mean nothing to someone deciding whether this is the point they want.
- Pruning happens **after** the write, not before. Pruning first left the directory at cap+1 once the new record landed, so the limit never meant what it said, and the memory-only branch (which inserts then trims) disagreed with the on-disk one about the same constant.
- Restore (`restoreMultiFlowCheckpoint`) removes all non-tab entities of the target workspace (regular nodes + subflow instances + junctions + groups) via type-specific APIs, then re-imports the snapshot.
- That the snapshot includes junctions/groups (§7) is the prerequisite for them not vanishing on restore.
- Restore marks the workspace dirty so it can be Deployed to commit.

---

## 10. Security / boundary defaults (assumptions)

- All HTTP endpoints are on `RED.httpAdmin`, and each data/action route carries `RED.auth.needsPermission` explicitly — Node-RED does not extend `adminAuth` to plugin-registered routes on its own. The client sends the editor bearer token via `Common.apiFetch`. Static asset routes are intentionally left open (tag-loaded, cannot send headers; plugin's own published code only).
- API keys are encrypted (`credentials.json`, AES-256-GCM, legacy CTR still readable). Logs, errors, and client logs are masked via `redactSecrets`. Credentials are also stripped from the flow context sent to the LLM.
- **Agent mode is an accepted-risk boundary**: the model's output is applied without confirmation and may contain `function` / `exec` nodes, so it is arbitrary code execution by design. No node-type allowlist — constraining it would defeat the mode. See architecture.md.

---

## 11. Points to discuss / known trade-offs

Main points to discuss on top of this document:

1. **Group type classification**: In `isConfigNode`'s structural fallback, a group is treated as config before export and as canvas after export (with x/y). Currently reconciled by "excluding it from layout only" — should `type==='group'`/`'junction'` be made explicit in the type check?
2. **Whether to show junctions to the LLM context**: Currently not shown (§7 reason). Are there future cases where "the LLM should be aware of junction routing"? If shown, how to keep alias numbering consistent?
3. **Misfire risk of implicit flow tagging**: When the same alias exists on multiple tabs, inference adopts the first tab hit. Should ambiguous cases be handled more strictly?
4. **Fuzzy matching scope**: Node matching is exact-only, while prose annotation and hint resolution use fuzzy (minLen 8). Is this boundary (how much approximate matching to allow) appropriate?
5. **adminAuth support**: Should authenticated environments be brought into the supported scope?
6. **Raw IDs still left inside props**: `toIntermediate`'s ID→alias substitution only inspects **top-level string values** of props. IDs nested in arrays or objects (e.g. a link in/out node's `links: [id, …]`) pass through to the model verbatim, which breaks the §0 premise that the LLM never sees IDs. Substituting recursively would require making `toNodeRed`'s alias→ID restoration symmetric to the same depth — miss that and the links break.

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
- a group changed, was added, or was removed
- a node's group membership (`g`) changed
- a grouped node was removed **and the group API is unavailable** (see below)
- an existing id changed `type`
- a live entity that does not round-trip through an export

**`g` has to survive the merge for any of this to mean anything.** It is not in
`MERGE_SKIP_KEYS`, and must not be: nothing else restores it, so skipping it made
every edited node come back without its group. That was a silent data loss on its
own (the node left the group while the group went on listing it), and it also made
the "group membership changed" test fire on every ordinary property edit — so on any
flow that uses groups, the diff declined every time and the destructive rebuild ran
instead. Carrying `g` blindly is safe because it is a `META_KEY` in the converter:
the schema can neither read nor write it, so the existing value is the only value
there can be.

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
would report every membership change twice, and the second report has no safe way to
be applied.

`removeFromGroup` is a silent no-op on a locked workspace, and a silent no-op is the
worst outcome available here — the node would go while the group went on naming it.
So the diff checks for a usable group API first and declines if it has none. The
destructive rebuild does not need the API (it re-imports the group wholesale) and
reaches the same consistent end state, just by the broader route.

Groups own their members as live **objects** and `g` is only half of that
relationship, so that bookkeeping belongs to `RED.group`'s own API. None of it is
reachable from the Vibe Schema (which has no notion of groups), so the fallback
costs nothing in practice — and correctness never depends on the diff covering
every case.

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

## 13. Ordering two producers against one canvas

### The collision
The sidebar's Import button and the Agent node both apply flow edits to the same
canvas, and the node's reply arrives whenever the model finishes — not at a moment
anyone chose. Nothing separated them.

The damage lands on the **first** edit, not the second. Applying is a merge against
the flow as it currently stands (§0, §3), so when the second apply takes its
snapshot, the first edit is already there: undeployed, unreviewed, and now part of
the base the second edit merges into. Both changes end up on the canvas, and the
second apply's checkpoint rewinds to a state that already contains the first — so
neither can be undone cleanly any more.

### The rule
A flow that has been **applied but not yet deployed is held**, and anything else
targeting that flow waits. Applies that touch different flows never wait for each
other, and among those that do wait, the earlier request goes first.

"Held until deployed" is the right boundary because it is the same boundary the
runtime uses. Until a deploy, the edit exists only in the editor: it is the user's
to review, undo, or restore, and a second edit merging into it takes that decision
away. After a deploy it is simply the flow, and the next edit merging into it is
what merging is for.

### Release
One signal covers both cases: the editor's `deploy` event, which Node-RED emits only
from the success path of a deploy. The Agent node's auto deploy goes through
`core:deploy-flows`, the same action as the Deploy button, so an unattended node
releases its own hold while a node without auto deploy waits for the user — which is
the behaviour asked for, without the queue needing to tell the two apart.

Two cases the deploy event does not cover, both surfaced in the sidebar's queue
panel rather than left to deadlock:
- **A failed apply holds nothing.** The importer rolls back, so nothing was
  committed; holding its flows would make the next request wait for a deploy that
  has no reason to happen.
- **An edit undone by hand, or a restored checkpoint**, ends the edit without a
  deploy. **Release** clears the hold manually. A waiting request can also be
  cancelled, and its caller is told rather than left hanging.

An apply with **no declared scope** (no flow context was selected) conflicts with
everything in both directions: it may read or write any flow, and guessing otherwise
is how an edit lands somewhere nobody looked.

### Scope — one editor, not one server
The queue is per editor session, and that is where the two producers actually
collide: the sidebar and the Agent node are both in the same browser. It does **not**
coordinate two people with the editor open. Each browser holds its own queue, and the
node's comms message is broadcast to every connected editor, so each applies it
locally.

Node-RED already guards that case, at the point where it matters: the flows POST
carries a revision, and a deploy against a stale one comes back `409` and raises the
editor's own merge-conflict dialog. The queue is about the window *before* the
deploy, which Node-RED has no view of.

- Regression test: `test/apply_queue.test.js` — different flows do not wait,
  the same flow waits for the deploy, arrival order is preserved, a failure holds
  nothing, an unknown scope holds everything, and cancel / release both work.
