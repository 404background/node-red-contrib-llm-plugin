# Canvas Layout

Standalone layout engine for Node-RED node arrays. UMD module
(`window.LLMPlugin.CanvasLayout` / `require('./src/core/canvas_layout.js')`).
Width-aware: chains pack at `(widthA + widthB)/2 + edgeGap` so wide
labels push their neighbours out automatically.

## Examples

### 1. Full reflow

```js
const Layout = require('./src/core/canvas_layout.js');
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
                       │  (every schema comment)      │
                       └──────────────┬───────────────┘
                                      ▼
                             nodes mutated in place
```

### Order of the passes, and why it is that order

The importer runs them inside-out: place what is inside a box, fit the box to
it, then arrange the boxes against each other. Each step depends on the one
before having finished, so none of them can be reordered without contradicting
another.

| # | Pass | Depends on |
|---|------|------------|
| 1 | `keepLeftEdges` | Nothing — it corrects the *input* coordinates, so every pass below reasons about left edges that are already true. Its result also feeds step 2 as `reflowIds`. |
| 2 | `reflowCanvasNodes` / `placeAddedNodesNearNeighbors` | (1). Places the members: columns, rows, captions. |
| 3 | `repositionSubsetByAliases` | (2). Rearranges one named subset in place, so it must run after the general pass or the general pass would undo it. Then the **routing** that was already there is placed: chains are laid out through a junction, but the layout never places one itself. Each junction, and each link node outside a box, goes back where it was, shifted by as much as what it serves moved (see [Routing follows what it serves](#routing-follows-what-it-serves)). |
| 4 | `fitGroups` | (2) and (3). A box is fitted to where its members ended up, so it cannot run before they are placed. Every box is fitted tightly. |
| 5 | `separateGroups` | (4). Aligns each boxed sequence by its members' left edge, then settles collisions (below), which is what keeps the boxes `groupGap` apart. Both read box bounds, which only exist once the boxes are fitted. |
| 6 | `applyCommentAnchors` | (5). Every caption onto the node it heads, re-read from where the passes above left it: one that would sit on its node is clamped to a full row above it. |
| 7 | `settleCollisions` | (6). The invariant, checked on the result rather than trusted to the passes above: no node on a node, no box on a box (closer than `groupGap`), no node inside a box it is not a member of. Comments count too. Siblings are compared level by level, and every collision counts, whoever placed the things involved. The lower party goes under the upper one as a whole (a box with its contents, a wired chain with its captions), except inside one chain, where the lower node steps off alone with its captions. A comment that heads nothing is the one that moves. Routing outside a box moves with what it serves. A junction (measured at its real 10×10) is never moved on its own account: what lands on it steps off below, and one on a box edge is an ordinary route, left alone. A link node on what it serves steps off alone. A caption outside a box that heads a member from on top of the frame joins that box. Boxes are refitted after each move, and a push that lands on something else is resolved in turn. It is the last pass that moves anything apart, so captions are placed before it. |
| 8 | `ensureCanvasMargins` | (7). One uniform shift on each axis, so it cannot disturb any spacing the passes above established. |

A box left at its old size is the case this order exists to avoid: step 5 would
line up a stale rectangle instead of the sequence inside it.

## Public API

| Function | Purpose |
|----------|---------|
| `layoutNodes(aliases, outgoing, incoming)` | Pure topological layout. Returns `{ alias: { col, row, comp } }`. |
| `reflowCanvasNodes(nodes, options?)` | Full canvas re-layout (recomputes every position). |
| `placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options?)` | Incremental layout (keeps existing nodes pinned, places only the new ones). |
| `estimateNodeWidth(node, options?)` | Label-based width estimate, snapped to `gridSize`. |
| `getNodeWidth(node, options?)` | `options.getNodeWidth(node)` if provided, else `estimateNodeWidth`. |
| `computeComponentYOffsets(ids, positions, startY, spacingY, gap, nodeHeight?)` | Y-offset per component for vertical stacking. `spacingY` and `gap` are edge-to-edge; the row pitch is `nodeHeight + spacingY` and the component step is `nodeHeight + gap`. `nodeHeight` defaults to `LAYOUT_DEFAULTS.nodeHeight`. |
| `fitGroups(nodes, options?)` | Fit every group box to its members. See [Group boxes](#group-boxes). |
| `separateGroups(nodes, options?)` | Line the boxes up and push blocks apart until every group box clears what is outside it (`groupGap` from a box, one padding more from a plain node). Runs after `fitGroups`. |
| `keepLeftEdges(nodes, widthsBefore, options?)` | Re-centre nodes whose width changed so their LEFT edge is where it was. Returns the ids it moved. |
| `ensureCanvasMargins(nodes, options?)` | Slide everything by one shared delta per axis when the topmost or leftmost edge — a box included — is nearer the canvas edge than `topMargin` / `leftMargin`. |
| `settleCollisions(nodes, options?)` | Resolve every collision on the canvas: node or caption on node, box on box, node inside a foreign box. Returns the ids it moved. |
| `routingAnchors(nodes)` | For every junction / `link in` / `link out` outside a box, the nodes it serves. See [Routing follows what it serves](#routing-follows-what-it-serves). |
| `LAYOUT_DEFAULTS` | Default constants. |

## Defaults

```js
LAYOUT_DEFAULTS = {
    startX:         60,    // left edge of the first column
    startY:         60,    // TOP edge of the first row — an edge, like startX
    spacingY:       40,    // edge-to-edge clearance between stacked node rows
    componentGap:   80,    // edge-to-edge clearance between disconnected components
    edgeGap:        40,    // edge-to-edge clearance between adjacent node edges (horizontal)
    minNodeWidth:  100,    // Node-RED MIN_NODE_WIDTH
    nodeHeight:     30,    // Node-RED's standard rendered node height
    gridSize:       20,    // Node-RED canvas grid (used by width estimate + comment stacking)
    topMargin:      20,    // min clearance between the canvas top (y=0) and the topmost edge
    leftMargin:     20,    // the same on the left edge (x=0), boxes included
    groupPadding:   25,    // the editor's own clearance between a group's box and its members
    groupGap:       30     // box to box: componentGap between their members, less both paddings
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

### `ensureCanvasMargins` — the same gap above and beside

The only margin guard, on both edges at once and counting **boxes** as well as
nodes: a box is drawn `groupPadding` outside its members, so measuring nodes
alone leaves it nearer the edge than they are, or off the canvas entirely. A
caption stacked above a node near the top is caught here too. Everything slides
by one shared delta per axis, so relative geometry is untouched.

**Both origins are edges.** `startX` is the left edge of the first column and
`startY` is the top edge of the first row; the row's centre is half a node
further down. They used to mean different things (`startY` was the centre),
which put a flow 15px nearer the top of the canvas than its left side, and the
box around it nearer still. Equal origins now produce equal gaps — for a plain
flow and for a boxed one.

## Width changes keep the left edge

`node.x` is a **centre**, so a rename moves both of the node's edges — and left
edges are what this engine aligns. A renamed node therefore slid out of its
column, stranded the caption above it, and with a long enough name pushed its
own left edge (and any box around it) towards negative x.

`keepLeftEdges(nodes, widthsBefore, options)` corrects that before the placement
passes: for every node whose width changed it re-derives `x` from the left edge
it had. It returns those ids, and the importer hands them to
`placeAddedNodesNearNeighbors` as `options.reflowIds` — a node that grew reaches
further right than it did, so its component is reflowed exactly as it would be
around an insertion, and the chain after it moves over instead of being
overlapped.

The caption side matches: `applyCommentAnchors` gives a caption its target's
**left edge** rather than replaying the centre offset it was captured with.
Replaying that offset kept a caption aligned only while both widths stayed the
same.

Comment stacking uses a step of `ceil(nodeHeight / gridSize) * gridSize`
(= 40 px with the defaults) so a stack of comments rises at a regular
visual cadence even though `nodeHeight` (30) is not a grid multiple.
Comments are placed so their **left edge** matches the anchor target's
left edge (`commentX = target.leftEdge + commentWidth / 2`) — no extra
snap — so a wide caption visibly aligns under the column it heads
rather than drifting off-axis.

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

The pass that turns this into coordinates — `computeLeftEdges` — is shared.
The converter runs it keyed by alias (it has no node ids yet), the reflow
keyed by id, and both have to land on the same numbers: converting a schema
and then reflowing it must not move anything. It was written twice before,
with a comment on the second copy asking it to mirror the first.

Width comes from `getNodeWidth` (caller hook → `options.getNodeWidth` →
`estimateNodeWidth`). The hook lets callers feed in live measured widths
(e.g. `RED.nodes.node(id).w` from the live editor) — with exact widths
every adjacent pair ends up with exactly `edgeGap` (2 grid squares) of
visible clearance regardless of label length. The fallback estimate
mirrors the editor's own formula (view.js redraw, verified against
NR 4.1.7):

```
w = max(node_width, 20 * ceil((labelTextWidth + 50 + (inputs>0 ? 7 : 0)) / 20))
```

using per-character text-width estimates (Latin ~7.5 px, CJK /
fullwidth ~14 px) plus a node-type-dependent chrome:

- **Regular nodes** (inject, function, debug, etc.): chrome = 57 px
  (editor's 50 px chrome + 7 px input-port stub; ≤7 px high for
  no-input types, absorbed by the grid snap).
- **Comment nodes** (`type === 'comment'`): chrome = 24 px — matched
  empirically to the rendered comment (smaller icon, no port stubs);
  a larger chrome visibly pushes wide captions right of their
  target's left edge.

With the importer's default `edgeGap = 40` two default-named ~120 px
nodes sit ~160 px centre-to-centre, leaving 2 grid squares of visible
clearance between them — close to the spacing Node-RED itself produces
when you drag nodes onto the canvas one at a time.

## Group boxes

A group's box is **stored on the group** (`x` / `y` / `w` / `h`) and Node-RED
recomputes it only when the user drags a member into or inside it. So whoever
moves the members owns the box: a group imported with a `0 × 0` box is one the
user sees at `0 × 0`, and a member pushed down by a layout pass leaves the box
behind. `fitGroups` runs after the layout passes and settles it:

- The box is the members' bounding box grown by `groupPadding` (25) on all four
  sides — the same clearance `RED.group.addToGroup` applies, so a box the plugin
  fits and one the editor fits look the same.
- A node's edges come from its centre and `getNodeWidth` / `nodeHeight`; a
  **nested** group's `x` / `y` is already its top-left corner, so inner boxes
  are fitted first (deepest first) and the outer one then contains them.
- **Every** box is fitted tightly, including one the user made larger: a box
  bigger than its contents cannot be lined up or spaced by what is in it.
- Groups are not laid out as nodes (`isLayoutNode` excludes them), so they never
  displace anything — which also means nothing keeps two boxes apart. The node
  layout spaces MEMBERS: `componentGap` (80) minus two paddings leaves exactly
  `groupGap` (30px) between two boxed sequences, but a caption that joined a
  group grows its box 40px further up, so the boxes overlapped by 10px. `separateGroups` runs after
  `fitGroups` and is the guarantee that a box clears what is outside it.

### `separateGroups` — lining the boxes up, and keeping them apart

- Stacked sequences read as a column, so they **share a left edge**. What is
  aligned is the SEQUENCE: the members' own left edges. Alignment is per
  box, not per block: two sequences wired to each other are one block, and a
  `reposition` leaves exactly that pair stepped in and out.
- A box moves with everything it holds — members, their members, and the
  captions heading them. It is **not** moved when its block holds a node that
  is in no box at all, such as the chain feeding a box drawn around its middle,
  or a node hanging off its end. Only the box would move, and the wire between
  them would shear. Routing that serves only the box is not such a node: it
  moves with the box. Boxes never block each other.
- Only sequences that are STACKED are aligned. Two boxes whose rows overlap
  are side by side, or interlocked because a node in one is wired to a node in
  the other; pulling those into one column drops one sequence onto the other.
- Every stacked box is aligned, whoever drew it, to the **leftmost** sequence.
  The canvas margin is restored afterwards by `ensureCanvasMargins`, for
  everything at once.
- Every box ends up clear of anything outside it: `groupGap` (30) from another
  box and one padding more (55) from a plain node, so stacked sequences are
  `componentGap` (80, four grid squares) apart member to member whether they
  are boxed or not — removing a box does not leave a wider gap behind. Routing
  serving a box keeps only `groupGap`. That is `settleCollisions`' job: it moves each box with everything it holds, so two
  boxes interlocked by a wire are still pulled apart.
- Pushes only ever go **down**, so the pass is idempotent: a canvas that
  already clears settles with nothing moved, and running it again does not
  drift.
- Only blocks that overlap horizontally are compared. Two sequences side by side
  do not push each other down.

## Routing follows what it serves

Junctions and link nodes are the user's routing, and the layout does not place
them. But a routing point the user put between two boxes belongs to the flow it
leads into: when a node added to the box above pushes the one below down, a
junction left where it was ends up inside the grown box, and a `link in` beside
the lower box is left behind.

So routing outside a box **travels with what it serves**
(`routingAnchors`): a junction or a `link in` with the nodes it leads to, a
`link out` with the nodes feeding it, followed through further routing. A
junction with nothing downstream follows what feeds it.

- After the node passes, each routing node that was already on the canvas goes
  back to where it was, **shifted by as much as what it serves moved**. When
  those moved by different amounts there is no one place it belongs, and it
  stays where it was.
- `settleCollisions` and the box alignment move routing along with the box or
  chain it serves, when everything it serves is moving. In a collision it counts
  as part of that thing, so it is never pushed apart from it on its own.
- A junction is still never moved on its own account, and routing inside a box
  moves with the box as a member.

## Comment placement

A caption is found by what it TOUCHES, and the tolerance is deliberately
tight: a standalone annotation gets no anchor and is left where the user put
it. **Sharing a box overrides that.** When a caption and the node below it are
members of the same group, any horizontal overlap is enough — the schema put
them in one box and the editor draws one border round them, which is a stronger
statement about belonging together than a column they may have drifted out of.
Without it a caption was orphaned the moment its node moved, and a reposition
left it behind. The box itself counts its caption members like any other
member, so `fitGroups` fits around them too.

Two rules follow from that, and both are about the boundary:

- **The search never crosses it.** A caption in a box only ever heads a node in
  the same box. The caption at the bottom of one sequence sits within touching
  distance of the top of the next, and anchoring across tied the two groups
  into one block — a block cannot be pushed apart from itself, so the boxes
  overlapped by the height of the caption that bridged them.
- **A caption in a box that touches nothing is re-stacked** above that box's
  first member, in reading order. It is the sequence's heading; a layout pass
  that moves the members without it can leave it below the row it names, where
  nothing touches it and no later pass would find it again.

Each comment is placed directly above its target canvas node:

- **Vertically**: touching the target's top edge with **zero grid gap**
  (centre-to-centre delta = `nodeHeight` = 30 px).
- **Horizontally**: the comment's **left edge** matches the target's
  left edge (`commentX = target.leftEdge + commentWidth / 2`), so a
  wide caption sits in the same column as the node it heads instead
  of being centred on the target's narrow centre.

Target selection per comment:

1. **Explicit** — schema sets `above: <alias>`. The importer resolves
   the alias to a real node id and stores it on `node._llmAboveId`;
   `repositionCommentsByLlmOrder` uses it directly. The target may be a
   new node in this schema or an existing node on the live canvas.
2. **Fallback** — for comments without `above`, the layout
   uses `node._llmOrder` (set by `FlowConverterCore.toNodeRed`) to find
   the next canvas node in declaration order.

Multiple comments sharing the same target stack upward (each touching
the comment beneath it). The stack also accounts for any **existing**
comment nodes already directly above the target on the canvas — new
comments land above the existing stack rather than overlapping it.

**Trailing comments without an explicit `above` are dropped.**
`FlowConverterCore.toNodeRed` strips any comment that has no `above`
AND no canvas node later in declaration order, so by the time a comment
reaches the layout engine it is guaranteed to have a resolvable target.
Comments that DO set `above` are kept regardless of where they appear
in the `nodes` map.

## Pass details

### `layoutNodes` — topological positions

1. **Components** — undirected BFS over `outgoing ∪ incoming`.
2. **Columns** — directed BFS from each component's roots:
   `col[next] = col[cur] + 1`.
3. **Rows** — first column: sequential rows from `globalRowOffset`.
   Later columns: target row = mean of parents' rows; conflicts are
   resolved by incrementing until an unused row is found.
4. **Stack** — components are packed back-to-back via `globalRowOffset`;
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
   - Downstream nodes in a chain advance by THIS chain's widths only, so
     a wide label in a parallel flow does not drag this chain right.
   - Then, last column first, each node moves right until it sits
     `edgeGap` before the nearest node it feeds (never left). Two inputs of
     different widths into one node thus both end `edgeGap` before it: the
     narrower one is right-aligned, and column-0 nodes no longer share
     `startX` in that case. Every wire is `edgeGap` long.
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
| 3.6 | **Insertion reflow** — for every component containing a node from `newlyPlaced` (i.e. a NEW node that `tryPlace` successfully wired to a positioned neighbour), call `reflowComponentInPlace`: `reflowCanvasNodes` pinned to the component's current top-left. The pre-existing user-placed nodes in that component move too, which is the only way to give the inserted node a uniform width-aware cadence. Orphan-band new nodes (no positioned neighbour) are excluded — they get a fresh layout from Step 4 and have no chain to honour. The "always reflow on connection" trigger is the user-specified contract; the cheaper directional pushes in 3.4 / 3.5a still run first so 3.6 always operates on a sane starting point. |
| 3.5b | **Cross-component push-down** — group nodes by connected component over the live wire adjacency. A component is "modified" if it contains a new node or a Step 3.4-shifted node. For each modifier `M`, collect every unmodified component `O` whose bbox overlaps `M` in both axes and whose `O.minY ≥ M.minY`. Compute one **uniform** `dy = (M.maxY + bandGap) − min(O.minY across the collected set)` (bboxes use edges, so `bandGap` is delivered exactly edge-to-edge) and shift every collected `O` by that same `dy`. **Comments are never moved by this pass** — they ride along with their target via the comment-anchor mechanism, or stay put if they are standalone. Pushed components become propagators for the next pass (cascade). Components that started entirely above `M` are never pushed — we only ever move things down. |
| 4 | Orphans (new nodes with no positioned neighbour): a fresh `layoutNodes` lays them out as their own graph below all positioned nodes. The first orphan row's centre is `maxBottomEdge + bandGap + nodeHeight/2`, so there is exactly `bandGap` of edge-to-edge clearance between the previous flow's bottom and the orphan's top — matching the formula Step 3.5b uses. Horizontally, orphan column 0 starts at the **leftmost left edge** of the positioned set (not the leftmost centre). **Comments are always excluded** from the orphan band — captions keep whatever x/y they came in with, or are placed onto their schema-named target by the final comment pass. |
| 5 | `applyCommentAnchors`: re-glue each comment that was *directly touching* a canvas node (or another comment in such a stack) to that node's new position, preserving the original offset. Standalone comments — anything beyond `stackStep + gridSize` below the nearest target, or outside its rendered bbox + one grid square — are NOT anchored and stay where the user put them. |
| 6 | Final `repositionCommentsByLlmOrder`: position every new schema comment, and every existing one the reply gave an `above`, over its resolved target (now that all targets, including orphan-band ones, have final coordinates). |

#### Guarantee: unmodified flows translate only

A connected component that contains **no** added node (and no Step 3.4
horizontally-shifted node) is never reflowed and never sheared — it can only
be **translated as a rigid whole**. Only the edited component is reflowed
(Step 3.6); every other flow is moved down as a unit by the cross-component
push (Step 3.5b) or, for any residual overlap, by `settleCollisions` at the
end of the import, which also moves a chain whole. This keeps a user's carefully arranged flow intact when an edit
to a neighbouring flow happens to overlap it — the neighbour just slides down.

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
