# Canvas Layout

Standalone layout engine for Node-RED node arrays. Lives in
`canvas_layout.js`; usable independently of the rest of the plugin.

## Why a separate module?

Node-RED's canvas requires every node to carry pixel `x` / `y` coordinates.
Generating these by hand for LLM-produced flows is error prone (overlapping
nodes, broken chains, off-screen placements), so the plugin owns the
layout. The logic was split out into this module so the same engine can be
used by any tooling that produces or rearranges Node-RED node arrays.

## Public API

```js
// Browser: window.LLMPlugin.CanvasLayout
// Node:    const Layout = require('./canvas_layout.js');
```

| Function | Purpose |
|----------|---------|
| `layoutNodes(aliases, outgoing, incoming, maxColumns)` | Pure topological layout. Returns `{ alias: { col, row, comp } }` logical positions. |
| `buildWireAdjacency(nodes, byId)` | Helper: directed `outgoing` / `incoming` maps from each node's `wires` array. |
| `computeComponentYOffsets(ids, positions, startY, spacingY, gap)` | Helper: y-offset per component for vertical stacking. |
| `estimateNodeWidth(node, options?)` | Approximate the rendered pixel width of a Node-RED node from its label. Snapped to `gridSize`. |
| `getNodeWidth(node, options?)` | `options.getNodeWidth(node)` if provided, else `estimateNodeWidth(node)`. |
| `pairSpacing(a, b, options?)` | Centre-to-centre distance ensuring `edgeGap` pixels of clearance between the two nodes' edges. |
| `reflowCanvasNodes(nodes, options)` | Full canvas re-layout. Mutates each canvas node's `x` / `y`. |
| `placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options)` | Conservative incremental layout: preserves existing coordinates, places only new nodes, then shifts the downstream chain. |
| `LAYOUT_DEFAULTS` | Default constants (see below). |

## Width-aware horizontal spacing

The layout is **width-aware**: the centre-to-centre distance between two
horizontally adjacent nodes is

```
distance = (width(a) + width(b)) / 2 + edgeGap
```

This guarantees `edgeGap` pixels (default `40` = 2 Node-RED grid squares)
of visible clearance between the right edge of `a` and the left edge of
`b`, regardless of label length. A wide-named function node is pushed out
more than a short one, and tight chains pack closer than before.

Node widths are estimated from label length and snapped to the grid
(`gridSize = 20` by default). Pass `options.getNodeWidth(node) -> number`
to use a more accurate measurement (e.g. via DOM in the browser).

## Default constants

```js
LAYOUT_DEFAULTS = {
    startX:         60,
    startY:         60,
    spacingY:       80,    // row height (fixed)
    componentGap:   80,    // vertical pixels between disconnected components
    edgeGap:        40,    // visible gap between adjacent node edges
    minNodeWidth:  100,    // Node-RED MIN_NODE_WIDTH; fallback for empty labels
    gridSize:       20,    // Node-RED canvas grid
    maxColumns:      5
};
```

All three layout functions accept an `options` object that overrides any
of these per call. `placeAddedNodesNearNeighbors` also accepts `bandGap`
(defaults to `componentGap`) for the orphan band offset.

## The `isCanvasNode` predicate

`reflowCanvasNodes` and `placeAddedNodesNearNeighbors` need to know which
entries in the node array belong on the canvas vs. which should be ignored
(tabs, subflow definitions, config nodes). The module ships a permissive
default predicate that excludes only tabs and `subflow:*` definitions; pass
`options.isCanvasNode` if you also need to skip config nodes:

```js
Layout.reflowCanvasNodes(nodes, {
    isCanvasNode: node => node && node.type !== 'tab'
                       && !node.type.startsWith('subflow:')
                       && !isConfigNode(node)   // your own check
});
```

The plugin's importer injects `FlowConverterCore.isCanvasNode` for that
exact reason.

## 1. `layoutNodes` — logical positions

Topological layout with parallel-branch support and line wrapping.

1. **Discover components** — undirected BFS over `outgoing ∪ incoming`.
2. **Assign columns** — directed BFS from each component's roots:
   `col[next] = col[cur] + 1`.
3. **Assign rows** — first column: sequential rows from the current global
   offset. Later columns: target row = mean of parents' rows; conflicts are
   resolved by incrementing until an unused row is found. This keeps
   straight chains visually horizontal even when other branches diverge.
4. **Wrap long chains** — if any column ≥ `maxColumns`, wrap into
   `(rowsPerFold + 1)` row strips so the chain stays on-screen.
5. **Stack components** — each component's rows are packed back-to-back via
   `globalRowOffset`; pixel gap is added by the caller using
   `computeComponentYOffsets`.

Returns `{ alias: { col: int, row: int, comp: int } }`. No pixels.

## 2. `reflowCanvasNodes` — full layout

Use when the entire canvas is being replaced (e.g. `overwrite` mode) and
there's no existing layout to preserve.

```
reflowCanvasNodes(nodes, options)
```

Pipeline:

1. Filter nodes through `options.isCanvasNode` (or the default predicate).
2. `buildWireAdjacency` builds directed `outgoing` / `incoming` from each
   node's `wires` array.
3. `layoutNodes` produces logical `{ col, row, comp }`.
4. **Width-aware column placement** — for each column, take the max width
   of every node in that column. The centre x of column `c+1` is
   `(right edge of column c) + edgeGap + (width of column c+1) / 2`,
   so adjacent columns clear each other by exactly `edgeGap`.
5. `computeComponentYOffsets` stacks components vertically with
   `componentGap` between them.
6. For each canvas node:
   - `node.x = colX[col]` (the per-column centre computed in step 4)
   - `node.y = row * spacingY + componentYOffset[comp]`

The same `nodes` array is returned (for chaining); non-canvas entries are
left untouched.

## 3. `placeAddedNodesNearNeighbors` — incremental

Use when applying edits to a user-curated flow so manual placements
survive (`merge` mode).

```
placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options)
```

- `existingIdMap` — `{ id: true }` for nodes whose position must be preserved.
- `basePositions` — `{ id: { x, y } }` source for the preserved coordinates.

The pass sequence:

### Step 1 — Restore existing positions

```
for each n in canvas nodes:
    if existingIdMap[n.id] and basePositions[n.id]:
        n.x = basePositions[n.id].x
        n.y = basePositions[n.id].y
```

New nodes (not in the map) keep whatever coordinates the caller supplied
(typically 0/0).

### Step 2 — Build adjacency

Same as `reflowCanvasNodes`: directed `outgoing` / `incoming` from each
node's `wires`. Wires pointing outside the canvas-node set are ignored.

### Step 3 — Iteratively place new nodes

For each new node, examine the *already-positioned* neighbors. The
formulas below use `rightEdge(p) = p.x + width(p)/2` and similarly
`leftEdge(s) = s.x - width(s)/2`.

| Situation | New node placement |
|-----------|--------------------|
| Both preds and succs positioned | `x = max(rightEdge(pred)) + edgeGap + width(N)/2`, `y = mid( avg(pred.y), avg(succ.y) )` |
| Preds only positioned (appended) | `x = max(rightEdge(pred)) + edgeGap + width(N)/2`, `y = avg(pred.y)` |
| Succs only positioned (prepended) | `x = min(leftEdge(succ)) - edgeGap - width(N)/2`, `y = avg(succ.y)` |
| Neither (orphan) | Deferred to Step 4 |

Chains of new nodes resolve over multiple iterations as their neighbors
become positioned.

### Step 3.4 — Downstream horizontal shift

Even after Step 3, the new node's right edge may sit too close to an
existing successor's left edge. For each `(new node N, existing succ S)`
pair, compute

```
needed = rightEdge(N) + edgeGap − leftEdge(S)
```

If `needed > 0`, BFS forward through `outgoing` from S and shift every
reachable node's `x` by `needed`. The maximum shift wins when multiple
paths converge.

This is the pass that makes inserting a node between two connected
existing nodes visually "open up" the chain instead of overlapping or
sending the new node down.

#### Example — single insertion `A → N → B` (all default-width nodes, 100 px)

Before: `A(100, 100) → B(240, 100)` (one width-aware step apart).

| After | A | N | B |
|-------|---|---|---|
| Step 3 (no shift) | (100, 100) | (240, 100) | (240, 100) ← overlap |
| Step 3.4 | (100, 100) | (240, 100) | (380, 100) ← shifted +140 |

Width-aware step = `(100+100)/2 + 40 = 140`.

#### Example — wide new node `A → N(wide) → B`

If N's name is "Compute aggregated rolling average" (260 px estimated):

| After | A (100) | N (260) | B (100) |
|-------|---------|---------|---------|
| Step 3 | (100, 100) | (320, 100) | (240, 100) ← overlap |
| Step 3.4 | (100, 100) | (320, 100) | (540, 100) ← shifted +300 |

Distance A→N = `(100+260)/2 + 40 = 220`. Distance N→B = `(260+100)/2 + 40 = 220`.

### Step 3.5 — Vertical overlap resolution

Any remaining overlap — a new node whose horizontal centres are within
`(width(cur) + width(other))/2 + edgeGap * 0.5` of another positioned
node **and** whose rows are within `spacingY * 0.8` of each other — is
resolved by pushing the *new* node down by `spacingY`. Re-runs until
stable, capped at `newlyPlaced.length * 2` passes.

This handles cases where the LLM proposes two new nodes that would end up
in the same slot (e.g. both attached to the same predecessor).

### Step 4 — Orphan placement

New nodes whose entire reachable chain consists of other new nodes get no
position from Step 3. They are laid out as a self-contained graph using
`layoutNodes`, placed below all positioned nodes at `maxY + bandGap` and
left-aligned to `minX`.

## Standalone usage example

```js
const Layout = require('./canvas_layout.js');

// 1. Full reflow of a freshly generated flow:
const flow = [
    { id: 'a', type: 'inject',   wires: [['b']] },
    { id: 'b', type: 'function', wires: [['c']] },
    { id: 'c', type: 'debug',    wires: [] }
];
Layout.reflowCanvasNodes(flow, { startX: 100, startY: 100 });
// flow now has x/y set on every entry.

// 2. Inserting one node into an existing chain:
const merged = [
    { id: 'a', type: 'inject',   x: 100, y: 100, wires: [['n']] },
    { id: 'n', type: 'function', wires: [['b']] },                 // new
    { id: 'b', type: 'debug',    x: 280, y: 100, wires: [] }
];
Layout.placeAddedNodesNearNeighbors(
    merged,
    { a: true, b: true },
    { a: { x: 100, y: 100 }, b: { x: 280, y: 100 } },
    { edgeGap: 40, spacingY: 80 }
);
// a stays at 100, n placed at 240, b shifted to 380 (140 px steps for 100 px nodes).

// 3. Bare topological layout (no pixels):
const positions = Layout.layoutNodes(
    ['a', 'b', 'c'],
    { a: ['b'], b: ['c'], c: [] },
    { a: [], b: ['a'], c: ['b'] },
    5
);
// positions = { a:{col:0,row:0,comp:0}, b:{col:1,row:0,comp:0}, ... }
```
