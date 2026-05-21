# Canvas Layout

Standalone layout engine for Node-RED node arrays. UMD module
(`window.LLMPlugin.CanvasLayout` / `require('./canvas_layout.js')`).
Width-aware: chains pack at `(widthA + widthB)/2 + edgeGap` so wide
labels push their neighbours out automatically.

## Examples

### 1. Full reflow

```js
const Layout = require('./canvas_layout.js');
const flow = [
    { id: 'a', type: 'inject',   wires: [['b']] },
    { id: 'b', type: 'function', wires: [['c']] },
    { id: 'c', type: 'debug',    wires: [] }
];
Layout.reflowCanvasNodes(flow, { startX: 100, startY: 100 });
// inject=120, function=140, debug=120 (grid-snapped from estimate)
// leftEdges:    a=100,         b=260 (=100+120+40),  c=440 (=260+140+40)
// x (centres):  a=160,         b=330,                c=500
// y all 100 (single row, single component)
```

### 2. Inserting a node between two existing ones

```js
const merged = [
    { id: 'a', type: 'inject',   x: 100, y: 100, wires: [['n']] },
    { id: 'n', type: 'function', wires: [['b']] },                  // new (140-px wide)
    { id: 'b', type: 'debug',    x: 280, y: 100, wires: [] }
];
Layout.placeAddedNodesNearNeighbors(
    merged,
    { a: true, b: true },
    { a: { x: 100, y: 100 }, b: { x: 280, y: 100 } }
);
// a stays at 100, n placed centre 270 (left edge 200 = 100+60+40), then
// Step 3.4 shifts b right so its left edge sits at n.right+40=380 (b.x=440).
```

### 3. Bare topological positions (no pixels)

```js
const positions = Layout.layoutNodes(
    ['a', 'b', 'c'],
    { a: ['b'], b: ['c'], c: [] },
    { a: [], b: ['a'], c: ['b'] }
);
// { a:{col:0,row:0,comp:0}, b:{col:1,row:0,comp:0}, c:{col:2,row:0,comp:0} }
```

## Pipeline

```
                       ┌──────────────────────────────┐
                       │         layoutNodes          │
                       │  col / row / comp (no pixels)│
                       └─────┬──────────────────┬─────┘
                             │                  │
                ┌────────────┘                  └────────────┐
                ▼                                            ▼
   ┌─────────────────────────┐              ┌──────────────────────────────────┐
   │   reflowCanvasNodes     │              │ placeAddedNodesNearNeighbors     │
   │ (full re-layout)        │              │ (incremental: keep existing)     │
   └────────────┬────────────┘              └─────────────────┬────────────────┘
                │                                             │
                └─────────────────────┬───────────────────────┘
                                      ▼
                       ┌──────────────────────────────┐
                       │ repositionCommentsByLlmOrder │
                       │  (leading comments only)     │
                       └──────────────┬───────────────┘
                                      ▼
                             nodes mutated in place
```

## Public API

| Function | Purpose |
|----------|---------|
| `layoutNodes(aliases, outgoing, incoming, maxColumns?)` | Pure topological layout. Returns `{ alias: { col, row, comp } }`. |
| `reflowCanvasNodes(nodes, options?)` | Full canvas re-layout (recomputes every position). |
| `placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options?)` | Incremental layout (keeps existing nodes pinned, places only the new ones). |
| `estimateNodeWidth(node, options?)` | Label-based width estimate, snapped to `gridSize`. |
| `getNodeWidth(node, options?)` | `options.getNodeWidth(node)` if provided, else `estimateNodeWidth`. |
| `pairSpacing(a, b, options?)` | Width-aware centre-to-centre distance. |
| `buildWireAdjacency(nodes, byId)` | `outgoing` / `incoming` maps from each node's `wires`. |
| `computeComponentYOffsets(ids, positions, startY, spacingY, gap, nodeHeight?)` | Y-offset per component for vertical stacking. `spacingY` and `gap` are edge-to-edge; the row pitch is `nodeHeight + spacingY` and the component step is `nodeHeight + gap`. `nodeHeight` defaults to `LAYOUT_DEFAULTS.nodeHeight`. |
| `LAYOUT_DEFAULTS` | Default constants. |

## Defaults

```js
LAYOUT_DEFAULTS = {
    startX:         60,
    startY:         60,
    spacingY:       40,    // edge-to-edge clearance between stacked node rows
    componentGap:   80,    // edge-to-edge clearance between disconnected components
    edgeGap:        40,    // edge-to-edge clearance between adjacent node edges (horizontal)
    minNodeWidth:  100,    // Node-RED MIN_NODE_WIDTH
    nodeHeight:     30,    // Node-RED's standard rendered node height
    gridSize:       20,    // Node-RED canvas grid (used by width estimate + comment stacking)
    maxColumns:      5
};
```

`spacingY`, `componentGap`, and `edgeGap` all describe **edge-to-edge**
clearance (the visible whitespace), not centre-to-centre distance. The
layout engine adds `nodeHeight` internally whenever a centre coordinate
is needed, so setting `spacingY = 40` produces exactly two grid squares
of vertical clearance between consecutive rows.

Derived `node.x` / `node.y` coordinates are NOT snapped to `gridSize`.
Snapping centres would distort visible alignment: nodes whose widths
are odd multiples of `gridSize` (e.g. 100 or 140 px wide) end up with
their left edges shifted by half a grid square relative to nodes whose
widths are even multiples (e.g. 120 px), even when both should share
the same column. Instead the engine snaps **left edges** (always grid
multiples by construction) and computes each centre as
`leftEdge + width(node) / 2`, so siblings in a column visibly share
the same left edge regardless of label width. The same logic gives a
uniform `rowPitch = nodeHeight + spacingY` for vertical spacing.

Comment stacking uses a step of `ceil(nodeHeight / gridSize) * gridSize`
(= 40 px with the defaults) so a stack of comments rises at a regular
visual cadence even though `nodeHeight` (30) is not a grid multiple.
Comments are placed at the exact x/y of their anchor target — no extra
snap — so they stay glued to their target's centre.

Every layout function accepts an `options` object overriding any of
these. `placeAddedNodesNearNeighbors` also accepts `bandGap` (defaults
to `componentGap`) for the orphan-band offset, and either function
takes `options.isCanvasNode` for a custom canvas-node predicate
(default keeps everything that is not a `tab` or `subflow:*`
definition).

## Width-aware spacing

```
distance(a, b) = (width(a) + width(b)) / 2 + edgeGap
```

Width comes from `getNodeWidth` (caller hook → `options.getNodeWidth` →
`estimateNodeWidth`). The hook lets callers feed in live measured widths
(e.g. `RED.nodes.node(id).w` from the live editor); the fallback
estimate approximates the editor's
`max(MIN_NODE_WIDTH, labelWidth + chrome)` rule by summing per-character
widths (Latin ~7.5 px, CJK / fullwidth ~14 px) plus 64 px of chrome
(30 icon strip + 14 label padding + 14 port stubs on each side). With
the importer's default `edgeGap = 40` two default-named ~120 px nodes
sit ~160 px centre-to-centre, leaving 2 grid squares of visible
clearance between them — close to the spacing Node-RED itself produces
when you drag nodes onto the canvas one at a time.

## Comment placement

Each comment is placed directly above its target canvas node, touching
that node's top edge with **zero grid gap** (centre-to-centre delta =
`nodeHeight` = 30 px).

Target selection per comment:

1. **Explicit** — schema sets `above: <alias>`. The importer resolves
   the alias to a real node id and stores it on `node._llmAboveId`;
   `repositionCommentsByLlmOrder` uses it directly. The target may be a
   new node in this schema or an existing node on the live canvas.
2. **Fallback (legacy)** — for comments without `above`, the layout
   uses `node._llmOrder` (set by `FlowConverterCore.toNodeRed`) to find
   the next canvas node in declaration order.

Multiple comments sharing the same target stack upward (each touching
the comment beneath it). The stack also accounts for any **existing**
comment nodes already directly above the target on the canvas — new
comments land above the existing stack rather than overlapping it.

**Trailing comments are dropped.** `FlowConverterCore.toNodeRed` strips
any comment with no `above` and no canvas node after it, so by the time
a comment reaches the layout engine it is guaranteed to have a target.

## Pass details

### `layoutNodes` — topological positions

1. **Components** — undirected BFS over `outgoing ∪ incoming`.
2. **Columns** — directed BFS from each component's roots:
   `col[next] = col[cur] + 1`.
3. **Rows** — first column: sequential rows from `globalRowOffset`.
   Later columns: target row = mean of parents' rows; conflicts are
   resolved by incrementing until an unused row is found.
4. **Wrap** — chains with `col >= maxColumns` fold into
   `(rowsPerFold + 1)` row strips.
5. **Stack** — components are packed back-to-back via `globalRowOffset`;
   pixel offsets are added later by `computeComponentYOffsets`.

### `reflowCanvasNodes` — full layout

1. Filter through `options.isCanvasNode`.
2. `buildWireAdjacency` from each node's `wires`.
3. `layoutNodes` → `{ col, row, comp }`.
4. **Per-predecessor left edges** — iterate each component in column order
   (preds first). For each node, `leftEdge = max(pred.rightEdge) + edgeGap`
   if it has placed predecessors, otherwise `leftEdge = startX`.
   - Column-0 nodes of EVERY component share `startX`, so the first node
     of each flow lines up at the canvas's left margin.
   - Branch siblings that share a predecessor share that predecessor's
     `rightEdge + edgeGap`, so they line up too.
   - Downstream nodes in a chain advance by THIS chain's widths only — a
     wide label in a parallel flow no longer drags this chain right.
5. `computeComponentYOffsets` stacks components with `componentGap` of
   edge-to-edge clearance (component step = `nodeHeight + componentGap`).
6. `node.x = leftEdge + width(node) / 2`,
   `node.y = row * (nodeHeight + spacingY) + componentYOffset[comp]`.
7. `repositionCommentsByLlmOrder` for any leading comments.

#### Worked example: parallel flows of different widths

`edgeGap = 40`, `spacingY = 40`, `componentGap = 80`, `startX = 200`,
`startY = 200`. Flow A has a wide label; Flow B is narrow.

| Node | width | leftEdge | x (centre) | y |
|------|------:|---------:|----------:|--:|
| `a1` (inject, "Sensor")                | 120 | 200 | 260 | 200 |
| `a2` (function, "Compute aggregated…") | 320 | 360 | 520 | 200 |
| `a3` (debug)                           | 120 | 720 | 780 | 200 |
| `b1` (inject)                          | 120 | 200 | 260 | 310 |
| `b2` (function, "fn")                  | 100 | 360 | 410 | 310 |
| `b3` (debug)                           | 120 | 500 | 560 | 310 |

`b3` lands at leftEdge 500 (= 360 + 100 + 40), not at 720 — it follows
Flow B's own width, not Flow A's. `a1` and `b1` share leftEdge 200; `a2`
and `b2` share leftEdge 360 (both downstream of a default-width inject);
deeper columns diverge. Vertical gap between Flow A's bottom (215) and
Flow B's top (295) is exactly `componentGap = 80` px.

### `placeAddedNodesNearNeighbors` — incremental layout

`rightEdge(p) = p.x + width(p)/2`, `leftEdge(s) = s.x - width(s)/2`.

| Step | What it does |
|------|--------------|
| 1 | Restore `basePositions[id]` for every id in `existingIdMap`. |
| 2 | `buildWireAdjacency` over the canvas-node set. |
| 3 | Iteratively place each new node next to its positioned neighbours: both → `x = max(rightEdge(pred)) + edgeGap + width(N)/2`, `y = mid(avg(pred.y), avg(succ.y))`. Only preds → above, right of preds. Only succs → above, left of succs. |
| 3.4 | For each `(new node N, existing succ S)` pair, if `rightEdge(N) + edgeGap > leftEdge(S)`, BFS forward through `outgoing` from S and shift every reachable node's x by `needed`. Max shift wins on converging paths. IDs touched here are recorded as "shifted" and feed into Step 3.5b. |
| 3.5a | **Within-component nudge** — push any newly placed node down by one row pitch (`nodeHeight + spacingY`) if its horizontal centre is within `(width(cur)+width(other))/2 + edgeGap*0.5` of a **same-component** positioned node AND their Y centres are within `nodeHeight`. Re-runs until stable. Cross-component collisions are deliberately ignored here (handled by 3.5b). |
| 3.5b | **Cross-component push-down** — group nodes by connected component over the live wire adjacency. A component is "modified" if it contains a new node or a Step 3.4-shifted node. For each modifier `M`, collect every unmodified component `O` whose bbox overlaps `M` in both axes and whose `O.minY ≥ M.minY`. Compute one **uniform** `dy = (M.maxY + bandGap) − min(O.minY across the collected set)` (bboxes use edges, so `bandGap` is delivered exactly edge-to-edge) and shift every collected `O` by that same `dy`. **Comments are never moved by this pass** — they ride along with their target via the comment-anchor mechanism, or stay put if they are standalone. Pushed components become propagators for the next pass (cascade). Components that started entirely above `M` are never pushed — we only ever move things down. |
| 4 | Orphans (new nodes with no positioned neighbour): a fresh `layoutNodes` lays them out as their own graph below all positioned nodes. The first orphan row's centre is `maxBottomEdge + bandGap + nodeHeight/2`, so there is exactly `bandGap` of edge-to-edge clearance between the previous flow's bottom and the orphan's top — matching the formula Step 3.5b uses. Horizontally, orphan column 0 starts at the **leftmost left edge** of the positioned set (not the leftmost centre). **Comments are always excluded** from the orphan band — captions keep whatever x/y they came in with, or are placed onto their schema-named target by the final comment pass. |
| 5 | `resolveOverlaps` (safety net): scan all canvas-node pairs and push the lower one further down whenever their boxes overlap. Comments are skipped here too. |
| 6 | `applyCommentAnchors`: re-glue each comment that was *directly touching* a canvas node (or another comment in such a stack) to that node's new position, preserving the original offset. Standalone comments — anything beyond `stackStep + gridSize` below the nearest target, or outside its rendered bbox + one grid square — are NOT anchored and stay where the user put them. |
| 7 | Final `repositionCommentsByLlmOrder`: position newly-added schema comments above their resolved target (now that all targets, including orphan-band ones, have final coordinates). |

#### `maxColumns` in incremental layout

`placeAddedNodesNearNeighbors` accepts a `maxColumns` option, but in
incremental mode the caller typically passes `Infinity` so the existing
flow shape is preserved — newly inserted chains extend rightward
without being folded into new rows. Only the orphan-band sub-layout in
Step 4 honours `maxColumns`, because orphans form their own fresh
graph. The LLM importer (`src/importer.js`) follows this convention:
fresh flows go through `reflowCanvasNodes` with the default
`maxColumns: 5`; edits go through `placeAddedNodesNearNeighbors` with
`maxColumns: Infinity`.

#### Worked examples

Default-named nodes (inject=120, function=140, debug=120), `edgeGap = 40`:

| State | A (inject, 120) | N (function, 140) | B (debug, 120) |
|-------|---|---|---|
| Before | (100, 100) | — | (280, 100) |
| Step 3 | (100, 100) | (270, 100) ← leftEdge=200 | (280, 100) ← overlap |
| Step 3.4 | (100, 100) | (270, 100) | (440, 100) ← leftEdge=380 |

`A→N: leftEdge(N) = A.rightEdge + 40 = 160 + 40 = 200`, `x(N) = 200 + 70 = 270`.
`N→B (Step 3.4): leftEdge(B) = N.rightEdge + 40 = 340 + 40 = 380`, `x(B) = 380 + 60 = 440`.

Wide N (label "Compute aggregated rolling average" → 320 px):

| State | A (inject, 120) | N (320) | B (debug, 120) |
|-------|---------|---------|---------|
| Step 3 | (100, 100) | (360, 100) ← leftEdge=200 | (280, 100) |
| Step 3.4 | (100, 100) | (360, 100) | (620, 100) ← leftEdge=560 |

Cross-component push (Step 3.5b), `bandGap = 80`, `nodeHeight = 30`:

Flow 1 (component M, edited): `A(100,100) → B(280,100) → C-new(460,100)`.
Flow 2 (component O, untouched): `D(100,180) → E(280,180)`.

- `M.bbox = {x:[40, 520], y:[85, 115]}`, `O.bbox = {x:[40, 340], y:[165, 195]}`.
- Bboxes overlap horizontally; `O.minY (165) > M.minY (85)`; no vertical
  overlap → no shift required. `D`/`E` stay at `y=180`.

Now insert a tall stack so M grows downward to `y=200`:
- `M.bbox.maxY = 215`, `O.minY = 165` → `dy = 215 + 80 − 165 = 130`.
- `D`/`E` both shift by `+130` → `y=310`. O's shape (its internal
  horizontal layout) is preserved exactly.
