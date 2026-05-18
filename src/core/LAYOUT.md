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
// a(150,100) → b(320,100) → c(490,100)  (160-px steps)
```

### 2. Inserting a node between two existing ones

```js
const merged = [
    { id: 'a', type: 'inject',   x: 100, y: 100, wires: [['n']] },
    { id: 'n', type: 'function', wires: [['b']] },                  // new (120-px wide)
    { id: 'b', type: 'debug',    x: 260, y: 100, wires: [] }
];
Layout.placeAddedNodesNearNeighbors(
    merged,
    { a: true, b: true },
    { a: { x: 100, y: 100 }, b: { x: 260, y: 100 } }
);
// a stays at 100, n placed at 270, b shifted to 440 (b moves over by the width-aware step).
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
   │   (overwrite: re-layout)│              │ (merge: keep existing, add new)  │
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
| `reflowCanvasNodes(nodes, options?)` | Full canvas re-layout (overwrite mode). |
| `placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options?)` | Incremental layout (merge mode). |
| `estimateNodeWidth(node, options?)` | Label-based width estimate, snapped to `gridSize`. |
| `getNodeWidth(node, options?)` | `options.getNodeWidth(node)` if provided, else `estimateNodeWidth`. |
| `pairSpacing(a, b, options?)` | Width-aware centre-to-centre distance. |
| `buildWireAdjacency(nodes, byId)` | `outgoing` / `incoming` maps from each node's `wires`. |
| `computeComponentYOffsets(ids, positions, startY, spacingY, gap)` | Y-offset per component for vertical stacking. |
| `LAYOUT_DEFAULTS` | Default constants. |

## Defaults

```js
LAYOUT_DEFAULTS = {
    startX:         60,
    startY:         60,
    spacingY:       80,    // row height
    componentGap:   80,    // gap between disconnected components
    edgeGap:        60,    // 3 grid squares between adjacent node edges
    minNodeWidth:  100,    // Node-RED MIN_NODE_WIDTH
    gridSize:       20,    // Node-RED canvas grid
    maxColumns:      5
};
```

Every layout function accepts an `options` object overriding any of these.
`placeAddedNodesNearNeighbors` also accepts `bandGap` (defaults to
`componentGap`) for the orphan-band offset, and either function takes
`options.isCanvasNode` for a custom canvas-node predicate (default keeps
everything that is not a `tab` or `subflow:*` definition).

## Width-aware spacing

```
distance(a, b) = (width(a) + width(b)) / 2 + edgeGap
```

Width comes from `getNodeWidth` (caller hook → `options.getNodeWidth` →
`estimateNodeWidth`), which approximates the editor's
`max(MIN_NODE_WIDTH, labelWidth + chrome)` rule. Default chrome is 50 px
(30 icon + 14 label padding + 6 ports), so a default-named 100 px node
plus a default-named 100 px node sits 160 px centre-to-centre, leaving
`edgeGap = 60 px` (3 grid squares) of visible clearance.

## Comment placement

Comments are repositioned **only when they appear as a leading summary**
for the next canvas node in schema declaration order (read off
`node._llmOrder` set by `FlowConverterCore.toNodeRed`). They are placed
directly above that canvas node at the same x, one `spacingY` higher.
Multiple consecutive leading comments stack upward (nearest-to-next at
`y - spacingY`, the one above it at `y - 2*spacingY`, and so on).

**Non-leading comments are not supported.** `FlowConverterCore.toNodeRed`
already drops Vibe Schema comments that appear mid-sequence or after the
last canvas node, so by the time a comment reaches the layout engine it
is guaranteed to have only a forward neighbour. Earlier versions handled
between- and trailing-comment placement too; that logic was removed
because those positions tended to land in awkward spots.

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
4. Per column, take the max `getNodeWidth`. Column x-centres cascade:
   `colX[c+1] = (right edge of column c) + edgeGap + width(c+1)/2`.
5. `computeComponentYOffsets` stacks components with `componentGap`.
6. `node.x = colX[col]`, `node.y = row * spacingY + componentYOffset[comp]`.
7. `repositionCommentsByLlmOrder` for any leading comments.

### `placeAddedNodesNearNeighbors` — incremental layout

`rightEdge(p) = p.x + width(p)/2`, `leftEdge(s) = s.x - width(s)/2`.

| Step | What it does |
|------|--------------|
| 1 | Restore `basePositions[id]` for every id in `existingIdMap`. |
| 2 | `buildWireAdjacency` over the canvas-node set. |
| 3 | Iteratively place each new node next to its positioned neighbours: both → `x = max(rightEdge(pred)) + edgeGap + width(N)/2`, `y = mid(avg(pred.y), avg(succ.y))`. Only preds → above, right of preds. Only succs → above, left of succs. |
| 3.4 | For each `(new node N, existing succ S)` pair, if `rightEdge(N) + edgeGap > leftEdge(S)`, BFS forward through `outgoing` from S and shift every reachable node's x by `needed`. Max shift wins on converging paths. |
| 3.5 | Push any newly placed node down by `spacingY` if its horizontal centre is within `(width(cur)+width(other))/2 + edgeGap*0.5` of another positioned node AND their rows are within `spacingY*0.8`. Re-runs until stable. |
| 3.6 | `repositionCommentsByLlmOrder` for new leading comments. |
| 4 | Orphans (new nodes with no positioned neighbour): a fresh `layoutNodes` lays them out as their own graph below all positioned nodes at `maxY + bandGap`, left-aligned to `minX`. |

#### Worked examples

Default 100-px nodes, `edgeGap = 60`:

| State | A | N | B |
|-------|---|---|---|
| Before | (100, 100) | — | (260, 100) |
| Step 3 | (100, 100) | (260, 100) | (260, 100) ← overlap |
| Step 3.4 | (100, 100) | (260, 100) | (420, 100) ← +160 |

Wide N (label "Compute aggregated rolling average" → 280 px):

| State | A (100) | N (280) | B (100) |
|-------|---------|---------|---------|
| Step 3 | (100, 100) | (350, 100) | (260, 100) |
| Step 3.4 | (100, 100) | (350, 100) | (600, 100) ← +340 |

`A→N = (100+280)/2 + 60 = 250`, `N→B = (280+100)/2 + 60 = 250`.
