// Canvas Layout - standalone layout engine for Node-RED node arrays.
//
// Three primitives are exposed:
//
//   layoutNodes(aliases, outgoing, incoming, maxColumns)
//     Pure topological layout. Returns logical positions
//     { alias: { col, row, comp } }. No pixel coordinates.
//
//   reflowCanvasNodes(nodes, options)
//     Full canvas re-layout. Filters to canvas nodes (tab / subflow
//     dropped by default; pass `options.isCanvasNode` for stricter
//     filtering such as config-node exclusion), builds adjacency from
//     each node's `wires`, calls `layoutNodes`, then translates the
//     logical positions to pixels and mutates each node's x / y in place.
//
//   placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options)
//     Conservative incremental layout. Existing nodes keep their
//     coordinates from `basePositions`; only new nodes are positioned,
//     then the downstream chain is shifted right by `spacingX` to keep
//     inserted nodes from overlapping their existing successors.
//
// See ./LAYOUT.md for the full per-pass description and examples.
//
// This module has NO dependency on flow_converter_core.js so it can be
// used standalone wherever a Node-RED node array needs to be laid out.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        window.LLMPlugin.CanvasLayout = factory();
    }
})(function() {
    'use strict';

    // Default spacing constants. Override per-call via `options`.
    //
    // The layout is width-aware: the centre-to-centre distance between two
    // horizontally adjacent nodes is `(widthA + widthB)/2 + edgeGap`, so
    // wide-named nodes get pushed apart automatically while narrow ones
    // pack tighter. `edgeGap` is the visible pixel gap between their edges.
    let LAYOUT_DEFAULTS = {
        startX:        60,
        startY:        60,
        spacingY:      80,    // row height (centre-to-centre, fixed)
        componentGap:  80,    // pixels between disconnected components
        edgeGap:       40,    // pixels between right edge of A and left edge of B
                              // (== 2 Node-RED grid squares of 20 px each)
        minNodeWidth: 100,    // Node-RED's MIN_NODE_WIDTH; fallback for empty labels
        gridSize:      20,    // Node-RED canvas grid; widths snap to multiples of this
        maxColumns:     5
    };

    /**
     * Default canvas-node predicate: accepts anything with a non-empty type
     * that isn't a tab definition or subflow definition. Callers needing
     * config-node exclusion should pass their own predicate.
     */
    function defaultIsCanvasNode(node) {
        if (!node || typeof node !== 'object') return false;
        let type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        return true;
    }

    // ------------------------------------------------------------------ //
    //  Pure topological layout                                            //
    // ------------------------------------------------------------------ //

    /**
     * Topological layout engine with parallel-branch support and line wrapping.
     *  1. Discover connected components via undirected BFS.
     *  2. Lay out each component independently; nodes in a straight chain
     *     share the same row so branches stay visually horizontal.
     *  3. When a chain exceeds maxColumns, wrap to the next row set.
     *  4. Components are packed back-to-back row-wise; pixel gap is added
     *     by the caller.
     *
     * @param  {string[]} aliases
     * @param  {Object}   outgoing  alias -> [target aliases]
     * @param  {Object}   incoming  alias -> [source aliases]
     * @param  {number}   [maxColumns=5]
     * @return {Object}   alias -> { col, row, comp }
     */
    function layoutNodes(aliases, outgoing, incoming, maxColumns) {
        if (!maxColumns || maxColumns < 2) maxColumns = 5;
        let positions = {};
        let visited = {};

        // --- Step 1: discover connected components (undirected BFS) ---
        let components = [];
        function discoverComponent(start) {
            let comp = [];
            let q = [start];
            visited[start] = true;
            while (q.length > 0) {
                let a = q.shift();
                comp.push(a);
                let neighbors = (outgoing[a] || []).concat(incoming[a] || []);
                for (let i = 0; i < neighbors.length; i++) {
                    if (!visited[neighbors[i]]) {
                        visited[neighbors[i]] = true;
                        q.push(neighbors[i]);
                    }
                }
            }
            return comp;
        }
        aliases.forEach(function(a) {
            if (!visited[a]) components.push(discoverComponent(a));
        });

        // --- Step 2: layout each component, stacked vertically ---
        let globalRowOffset = 0;
        let componentIndex = 0;

        components.forEach(function(comp) {
            let compSet = {};
            comp.forEach(function(a) { compSet[a] = true; });

            // Root nodes: no incoming edges from within this component
            let roots = comp.filter(function(a) {
                return incoming[a].every(function(p) { return !compSet[p]; });
            });
            if (roots.length === 0) roots = [comp[0]];

            // BFS to assign column indices
            let colMap = {};
            let bfsVis = {};
            let queue = [];
            roots.forEach(function(r) {
                colMap[r] = 0;
                bfsVis[r] = true;
                queue.push(r);
            });
            while (queue.length > 0) {
                let cur = queue.shift();
                for (let i = 0; i < outgoing[cur].length; i++) {
                    let next = outgoing[cur][i];
                    if (!bfsVis[next] && compSet[next]) {
                        bfsVis[next] = true;
                        colMap[next] = (colMap[cur] || 0) + 1;
                        queue.push(next);
                    }
                }
            }
            comp.forEach(function(a) { if (colMap[a] === undefined) colMap[a] = 0; });

            // Group by column
            let columns = {};
            comp.forEach(function(a) {
                let c = colMap[a];
                if (!columns[c]) columns[c] = [];
                columns[c].push(a);
            });

            // Assign rows: inherit parent's row to keep chains horizontal
            let rowMap = {};
            let colKeys = Object.keys(columns).map(Number).sort(function(a, b) { return a - b; });

            colKeys.forEach(function(col) {
                let nodesInCol = columns[col];
                if (col === colKeys[0]) {
                    // First column: sequential rows from current offset
                    nodesInCol.forEach(function(a, idx) {
                        rowMap[a] = globalRowOffset + idx;
                    });
                } else {
                    // Later columns: inherit parent row
                    let assignments = nodesInCol.map(function(a) {
                        let parents = incoming[a].filter(function(p) {
                            return compSet[p] && rowMap[p] !== undefined;
                        });
                        let target;
                        if (parents.length > 0) {
                            target = Math.round(
                                parents.reduce(function(s, p) { return s + rowMap[p]; }, 0) / parents.length
                            );
                        } else {
                            target = globalRowOffset;
                        }
                        return { alias: a, target: target };
                    });
                    assignments.sort(function(a, b) { return a.target - b.target; });
                    let usedRows = {};
                    assignments.forEach(function(item) {
                        let row = item.target;
                        while (usedRows[row]) row++;
                        usedRows[row] = true;
                        rowMap[item.alias] = row;
                    });
                }
            });

            // --- Wrap long chains ---
            let compMaxCol = 0;
            comp.forEach(function(a) { if (colMap[a] > compMaxCol) compMaxCol = colMap[a]; });

            if (compMaxCol >= maxColumns) {
                let rowSet = {};
                comp.forEach(function(a) { rowSet[rowMap[a]] = true; });
                let rowsPerFold = Object.keys(rowSet).length;
                if (rowsPerFold < 1) rowsPerFold = 1;

                comp.forEach(function(a) {
                    let fold = Math.floor(colMap[a] / maxColumns);
                    if (fold > 0) {
                        colMap[a] = colMap[a] % maxColumns;
                        rowMap[a] = rowMap[a] + fold * (rowsPerFold + 1);
                    }
                });
            }

            let maxRow = globalRowOffset - 1;
            comp.forEach(function(a) {
                if (rowMap[a] !== undefined && rowMap[a] > maxRow) maxRow = rowMap[a];
            });
            comp.forEach(function(a) {
                positions[a] = {
                    col: colMap[a] || 0,
                    row: rowMap[a] !== undefined ? rowMap[a] : 0,
                    comp: componentIndex
                };
            });

            globalRowOffset = maxRow + 1;
            componentIndex++;
        });

        return positions;
    }

    // ------------------------------------------------------------------ //
    //  Helpers                                                            //
    // ------------------------------------------------------------------ //

    /**
     * Build directed adjacency from each node's `wires` array. Edges that
     * point to ids not in `byId` are ignored.
     */
    function buildWireAdjacency(nodes, byId) {
        let outgoing = {};
        let incoming = {};
        nodes.forEach(function(n) {
            if (!n || !n.id) return;
            outgoing[n.id] = [];
            incoming[n.id] = [];
        });
        nodes.forEach(function(n) {
            if (!n || !n.id || !Array.isArray(n.wires)) return;
            n.wires.forEach(function(port) {
                if (!Array.isArray(port)) return;
                port.forEach(function(toId) {
                    if (!byId[toId]) return;
                    outgoing[n.id].push(toId);
                    incoming[toId].push(n.id);
                });
            });
        });
        return { outgoing: outgoing, incoming: incoming };
    }

    /**
     * Stack disconnected components vertically. Returns
     *   { componentIndex: yOffsetPx }
     * such that `y = positions[id].row * spacingY + offsets[positions[id].comp]`
     * places each component starting at `startY` and packs the next
     * component `gap` pixels below the previous one's bottom row.
     */
    function computeComponentYOffsets(ids, positions, startY, spacingY, gap) {
        let info = {};
        ids.forEach(function(id) {
            let pos = positions[id] || { col: 0, row: 0 };
            let ci = pos.comp || 0;
            if (!info[ci]) info[ci] = { minRow: pos.row, maxRow: pos.row };
            if (pos.row < info[ci].minRow) info[ci].minRow = pos.row;
            if (pos.row > info[ci].maxRow) info[ci].maxRow = pos.row;
        });
        let keys = Object.keys(info).map(Number).sort(function(a, b) { return a - b; });
        let offsets = {};
        let nextY = startY;
        keys.forEach(function(ci) {
            let c = info[ci];
            offsets[ci] = nextY - c.minRow * spacingY;
            nextY = nextY + (c.maxRow - c.minRow) * spacingY + gap;
        });
        return offsets;
    }

    function resolveCanvasFilter(opts) {
        return (opts && typeof opts.isCanvasNode === 'function') ? opts.isCanvasNode : defaultIsCanvasNode;
    }

    function pickOption(opts, key, fallback) {
        return (opts && typeof opts[key] === 'number') ? opts[key] : fallback;
    }

    /**
     * Estimate the rendered pixel width of a Node-RED node based on its
     * label length. The Node-RED editor itself measures labels via a hidden
     * SVG <text> element, which is unavailable to a standalone module, so
     * this is a character-count approximation that matches the editor's
     * `Math.max(MIN_NODE_WIDTH, labelWidth + chrome)` rule, snapped to the
     * grid. Pass `options.getNodeWidth(node)` if you can supply an
     * accurate measurement (e.g. via DOM).
     */
    function estimateNodeWidth(node, opts) {
        let minW = pickOption(opts, 'minNodeWidth', LAYOUT_DEFAULTS.minNodeWidth);
        let grid = pickOption(opts, 'gridSize',     LAYOUT_DEFAULTS.gridSize);
        if (!node || typeof node !== 'object') return minW;
        let label = (typeof node.name === 'string' && node.name.trim()) ? node.name : (node.type || '');
        // 6.5 px / char is a fair approximation for the editor's default font.
        // 38 px chrome covers the type icon strip on the left plus inner padding.
        let estimated = label.length * 6.5 + 38;
        let w = Math.max(minW, estimated);
        return Math.ceil(w / grid) * grid;
    }

    /** Resolve a node's width, preferring the caller's `getNodeWidth` hook. */
    function getNodeWidth(node, opts) {
        if (opts && typeof opts.getNodeWidth === 'function') {
            let w = opts.getNodeWidth(node);
            if (typeof w === 'number' && w > 0) return w;
        }
        return estimateNodeWidth(node, opts);
    }

    function nodeRightEdge(node, opts) { return (node.x || 0) + getNodeWidth(node, opts) / 2; }
    function nodeLeftEdge (node, opts) { return (node.x || 0) - getNodeWidth(node, opts) / 2; }

    /**
     * Centre-to-centre distance ensuring `edgeGap` pixels between the right
     * edge of `a` and the left edge of `b`. Width-aware.
     */
    function pairSpacing(a, b, opts) {
        let gap = pickOption(opts, 'edgeGap', LAYOUT_DEFAULTS.edgeGap);
        return (getNodeWidth(a, opts) + getNodeWidth(b, opts)) / 2 + gap;
    }

    // ------------------------------------------------------------------ //
    //  Canvas-level layout                                                //
    // ------------------------------------------------------------------ //

    /**
     * Full canvas re-layout. Mutates `nodes` (sets x / y on each canvas
     * node). Non-canvas entries are left untouched.
     * @return The same nodes array (for chaining).
     */
    function reflowCanvasNodes(nodes, options) {
        let opts = options || {};
        let isCanvas    = resolveCanvasFilter(opts);
        let startX       = pickOption(opts, 'startX',       LAYOUT_DEFAULTS.startX);
        let startY       = pickOption(opts, 'startY',       LAYOUT_DEFAULTS.startY);
        let spacingY     = pickOption(opts, 'spacingY',     LAYOUT_DEFAULTS.spacingY);
        let componentGap = pickOption(opts, 'componentGap', LAYOUT_DEFAULTS.componentGap);
        let edgeGap      = pickOption(opts, 'edgeGap',      LAYOUT_DEFAULTS.edgeGap);
        let rawMaxCols   = pickOption(opts, 'maxColumns',   LAYOUT_DEFAULTS.maxColumns);
        let maxColumns   = (rawMaxCols >= 2) ? Math.floor(rawMaxCols) : LAYOUT_DEFAULTS.maxColumns;

        let canvasNodes = (nodes || []).filter(isCanvas);
        if (canvasNodes.length < 2) return nodes;

        let byId = {};
        let ids = [];
        canvasNodes.forEach(function(n) {
            if (n && n.id) { byId[n.id] = n; ids.push(n.id); }
        });

        let adj = buildWireAdjacency(canvasNodes, byId);
        let positions = layoutNodes(ids, adj.outgoing, adj.incoming, maxColumns);

        // Width-aware column placement: each column's centre is offset by
        // half of its max width plus the previous column's half plus edgeGap.
        let colMaxWidth = {};
        ids.forEach(function(id) {
            let col = (positions[id] || {}).col || 0;
            let w = getNodeWidth(byId[id], opts);
            if (!colMaxWidth[col] || colMaxWidth[col] < w) colMaxWidth[col] = w;
        });
        let colKeys = Object.keys(colMaxWidth).map(Number).sort(function(a, b) { return a - b; });
        let colX = {};
        let cursorRight = startX;     // x of the right edge of the most recent column
        colKeys.forEach(function(col, idx) {
            let w = colMaxWidth[col];
            let centre = (idx === 0)
                ? (cursorRight + w / 2)
                : (cursorRight + edgeGap + w / 2);
            colX[col] = centre;
            cursorRight = centre + w / 2;
        });

        let compOffsets = computeComponentYOffsets(ids, positions, startY, spacingY, componentGap);

        ids.forEach(function(id) {
            let node = byId[id];
            let pos = positions[id] || { col: 0, row: 0 };
            let ci = pos.comp || 0;
            node.x = Math.round(colX[pos.col] !== undefined ? colX[pos.col] : startX);
            node.y = Math.round(pos.row * spacingY + (compOffsets[ci] || 0));
        });
        return nodes;
    }

    /**
     * Conservative incremental layout. Existing-node coordinates are
     * sourced from `basePositions`; only nodes NOT in `existingIdMap` are
     * positioned. The downstream chain is then shifted right so inserted
     * nodes don't overlap. See ./LAYOUT.md for the full pass description.
     *
     * @param  {Array}  nodes           All canvas nodes (existing + new).
     * @param  {Object} existingIdMap   Set of ids whose position must be preserved.
     * @param  {Object} basePositions   { id: { x, y } } for preserved positions.
     * @param  {Object} [options]       Layout overrides.
     * @return The same nodes array (for chaining).
     */
    function placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options) {
        let opts = options || {};
        let isCanvas = resolveCanvasFilter(opts);
        let spacingY = pickOption(opts, 'spacingY', LAYOUT_DEFAULTS.spacingY);
        let edgeGap  = pickOption(opts, 'edgeGap',  LAYOUT_DEFAULTS.edgeGap);
        let bandGap = (typeof opts.bandGap === 'number')
            ? opts.bandGap
            : pickOption(opts, 'componentGap', LAYOUT_DEFAULTS.componentGap);
        let rawMaxCols = pickOption(opts, 'maxColumns', LAYOUT_DEFAULTS.maxColumns);
        let maxColumns = (rawMaxCols >= 2) ? rawMaxCols : LAYOUT_DEFAULTS.maxColumns;

        existingIdMap = existingIdMap || {};
        basePositions = basePositions || {};

        let canvasNodes = (nodes || []).filter(isCanvas);
        if (canvasNodes.length < 1) return nodes;

        let byId = {};
        canvasNodes.forEach(function(n) { byId[n.id] = n; });

        // Step 1: Restore original positions for preserved nodes
        canvasNodes.forEach(function(n) {
            if (existingIdMap[n.id] && basePositions[n.id]) {
                n.x = basePositions[n.id].x;
                n.y = basePositions[n.id].y;
            }
        });

        // Step 2: Wire adjacency
        let adj = buildWireAdjacency(canvasNodes, byId);
        let outgoing = adj.outgoing;
        let incoming = adj.incoming;

        // Step 3: Iteratively place new nodes (width-aware spacing)
        let positioned = {};
        canvasNodes.forEach(function(n) {
            if (existingIdMap[n.id]) positioned[n.id] = true;
        });

        function tryPlace(n) {
            let preds = incoming[n.id].filter(function(id) { return positioned[id]; });
            let succs = outgoing[n.id].filter(function(id) { return positioned[id]; });
            if (preds.length === 0 && succs.length === 0) return false;

            let nHalf = getNodeWidth(n, opts) / 2;
            if (preds.length > 0 && succs.length > 0) {
                let maxPredRight = Math.max.apply(null, preds.map(function(id) { return nodeRightEdge(byId[id], opts); }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = Math.round(maxPredRight + edgeGap + nHalf);
                n.y = Math.round((avgPredY + avgSuccY) / 2);
            } else if (preds.length > 0) {
                let maxPredRight = Math.max.apply(null, preds.map(function(id) { return nodeRightEdge(byId[id], opts); }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                n.x = Math.round(maxPredRight + edgeGap + nHalf);
                n.y = Math.round(avgPredY);
            } else {
                let minSuccLeft = Math.min.apply(null, succs.map(function(id) { return nodeLeftEdge(byId[id], opts); }));
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = Math.round(minSuccLeft - edgeGap - nHalf);
                n.y = Math.round(avgSuccY);
            }
            positioned[n.id] = true;
            return true;
        }

        let remaining = canvasNodes.filter(function(n) { return !existingIdMap[n.id]; });
        let progress = true;
        while (progress && remaining.length > 0) {
            progress = false;
            let next = [];
            remaining.forEach(function(n) {
                if (tryPlace(n)) { progress = true; } else { next.push(n); }
            });
            remaining = next;
        }

        // Step 3.4: Shift downstream chains so inserted nodes don't overlap
        // (width-aware: required gap = edgeGap between right(N) and left(S))
        let seedDeltas = {};
        canvasNodes.forEach(function(n) {
            if (!positioned[n.id] || existingIdMap[n.id]) return;
            let nRight = nodeRightEdge(n, opts);
            (outgoing[n.id] || []).forEach(function(succId) {
                let s = byId[succId];
                if (!s || typeof s.x !== 'number') return;
                let needed = (nRight + edgeGap) - nodeLeftEdge(s, opts);
                if (needed > 0) {
                    seedDeltas[succId] = Math.max(seedDeltas[succId] || 0, needed);
                }
            });
        });
        let seedIds = Object.keys(seedDeltas);
        if (seedIds.length > 0) {
            let toShift = {};
            let queue = [];
            seedIds.forEach(function(id) { toShift[id] = seedDeltas[id]; queue.push(id); });
            while (queue.length > 0) {
                let id = queue.shift();
                let dx = toShift[id];
                (outgoing[id] || []).forEach(function(nextId) {
                    if (toShift[nextId] === undefined || toShift[nextId] < dx) {
                        toShift[nextId] = dx;
                        queue.push(nextId);
                    }
                });
            }
            Object.keys(toShift).forEach(function(id) {
                let node = byId[id];
                if (node && typeof node.x === 'number') {
                    node.x = Math.round(node.x + toShift[id]);
                }
            });
        }

        // Step 3.5: Resolve remaining overlaps among new nodes (width-aware)
        let allPositioned = canvasNodes.filter(function(n) { return positioned[n.id]; });
        let newlyPlaced = canvasNodes.filter(function(n) {
            return !existingIdMap[n.id] && positioned[n.id];
        });
        if (newlyPlaced.length > 0) {
            newlyPlaced.sort(function(a, b) {
                let dx = (a.x || 0) - (b.x || 0);
                return dx !== 0 ? dx : ((a.y || 0) - (b.y || 0));
            });
            let changed = true;
            let maxPasses = newlyPlaced.length * 2;
            while (changed && maxPasses-- > 0) {
                changed = false;
                for (let ni = 0; ni < newlyPlaced.length; ni++) {
                    let cur = newlyPlaced[ni];
                    let curHalf = getNodeWidth(cur, opts) / 2;
                    for (let oi = 0; oi < allPositioned.length; oi++) {
                        let other = allPositioned[oi];
                        if (other.id === cur.id) continue;
                        // Treat as overlap when their horizontal centres are
                        // within half a node's worth of clearance AND their
                        // rows are within 0.8 * spacingY.
                        let otherHalf = getNodeWidth(other, opts) / 2;
                        let xThreshold = curHalf + otherHalf + edgeGap * 0.5;
                        if (Math.abs((cur.x || 0) - (other.x || 0)) < xThreshold &&
                            Math.abs((cur.y || 0) - (other.y || 0)) < spacingY * 0.8) {
                            cur.y = (other.y || 0) + spacingY;
                            changed = true;
                        }
                    }
                }
            }
        }

        // Step 4: Orphan placement (chain entirely new) below all positioned
        if (remaining.length > 0) {
            let maxY = Number.NEGATIVE_INFINITY;
            let minX = Number.POSITIVE_INFINITY;
            canvasNodes.forEach(function(n) {
                if (!positioned[n.id] && !existingIdMap[n.id]) return;
                if ((n.y || 0) > maxY) maxY = n.y;
                if ((n.x || 0) < minX) minX = n.x;
            });
            if (!isFinite(maxY)) maxY = LAYOUT_DEFAULTS.startY;
            if (!isFinite(minX)) minX = LAYOUT_DEFAULTS.startX;
            let orphanStartY = maxY + bandGap;

            let orphanIds = remaining.map(function(n) { return n.id; });
            let orphanSet = {};
            orphanIds.forEach(function(id) { orphanSet[id] = true; });
            let orphanOut = {};
            let orphanIn = {};
            orphanIds.forEach(function(id) { orphanOut[id] = []; orphanIn[id] = []; });
            remaining.forEach(function(n) {
                (outgoing[n.id] || []).forEach(function(toId) {
                    if (orphanSet[toId]) {
                        orphanOut[n.id].push(toId);
                        orphanIn[toId].push(n.id);
                    }
                });
            });
            let orphanPositions = layoutNodes(orphanIds, orphanOut, orphanIn, maxColumns);
            let orphanOffsets = computeComponentYOffsets(orphanIds, orphanPositions, orphanStartY, spacingY, bandGap);

            // Width-aware column placement for the orphan band, mirroring
            // reflowCanvasNodes: each column's x-centre is offset by half
            // its max width plus edgeGap from the previous column's right
            // edge. Band starts at `minX` (left edge of leftmost column).
            let orphanColMaxWidth = {};
            orphanIds.forEach(function(id) {
                let col = (orphanPositions[id] || {}).col || 0;
                let w = getNodeWidth(byId[id], opts);
                if (!orphanColMaxWidth[col] || orphanColMaxWidth[col] < w) orphanColMaxWidth[col] = w;
            });
            let orphanColKeys = Object.keys(orphanColMaxWidth).map(Number).sort(function(a, b) { return a - b; });
            let orphanColX = {};
            let orphanCursorRight = minX;
            orphanColKeys.forEach(function(col, idx) {
                let w = orphanColMaxWidth[col];
                let centre = (idx === 0) ? (orphanCursorRight + w / 2) : (orphanCursorRight + edgeGap + w / 2);
                orphanColX[col] = centre;
                orphanCursorRight = centre + w / 2;
            });

            remaining.forEach(function(n) {
                let pos = orphanPositions[n.id] || { col: 0, row: 0 };
                let ci = pos.comp || 0;
                n.x = Math.round(orphanColX[pos.col] !== undefined ? orphanColX[pos.col] : minX);
                n.y = Math.round(pos.row * spacingY + (orphanOffsets[ci] || 0));
            });
        }

        return nodes;
    }

    return {
        LAYOUT_DEFAULTS:              LAYOUT_DEFAULTS,
        estimateNodeWidth:            estimateNodeWidth,
        getNodeWidth:                 getNodeWidth,
        pairSpacing:                  pairSpacing,
        layoutNodes:                  layoutNodes,
        buildWireAdjacency:           buildWireAdjacency,
        computeComponentYOffsets:     computeComponentYOffsets,
        reflowCanvasNodes:            reflowCanvasNodes,
        placeAddedNodesNearNeighbors: placeAddedNodesNearNeighbors
    };
});
