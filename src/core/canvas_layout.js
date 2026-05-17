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
    let LAYOUT_DEFAULTS = {
        startX:       60,
        startY:       60,
        spacingX:     180,   // 3 grid squares (60 px) between node edges
        spacingY:      80,   // row height
        componentGap:  80,   // pixels between disconnected components (centre-to-centre)
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
        let spacingX     = pickOption(opts, 'spacingX',     LAYOUT_DEFAULTS.spacingX);
        let spacingY     = pickOption(opts, 'spacingY',     LAYOUT_DEFAULTS.spacingY);
        let componentGap = pickOption(opts, 'componentGap', LAYOUT_DEFAULTS.componentGap);
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
        let compOffsets = computeComponentYOffsets(ids, positions, startY, spacingY, componentGap);

        ids.forEach(function(id) {
            let node = byId[id];
            let pos = positions[id] || { col: 0, row: 0 };
            let ci = pos.comp || 0;
            node.x = Math.round(startX + pos.col * spacingX);
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
        let spacingX = pickOption(opts, 'spacingX', LAYOUT_DEFAULTS.spacingX);
        let spacingY = pickOption(opts, 'spacingY', LAYOUT_DEFAULTS.spacingY);
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

        // Step 3: Iteratively place new nodes
        let positioned = {};
        canvasNodes.forEach(function(n) {
            if (existingIdMap[n.id]) positioned[n.id] = true;
        });

        function tryPlace(n) {
            let preds = incoming[n.id].filter(function(id) { return positioned[id]; });
            let succs = outgoing[n.id].filter(function(id) { return positioned[id]; });
            if (preds.length === 0 && succs.length === 0) return false;

            if (preds.length > 0 && succs.length > 0) {
                let maxPredX = Math.max.apply(null, preds.map(function(id) { return byId[id].x || 0; }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = Math.round(maxPredX + spacingX);
                n.y = Math.round((avgPredY + avgSuccY) / 2);
            } else if (preds.length > 0) {
                let maxPredX = Math.max.apply(null, preds.map(function(id) { return byId[id].x || 0; }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                n.x = Math.round(maxPredX + spacingX);
                n.y = Math.round(avgPredY);
            } else {
                let minSuccX = Math.min.apply(null, succs.map(function(id) { return byId[id].x || 0; }));
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = Math.round(minSuccX - spacingX);
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
        let seedDeltas = {};
        canvasNodes.forEach(function(n) {
            if (!positioned[n.id] || existingIdMap[n.id]) return;
            (outgoing[n.id] || []).forEach(function(succId) {
                let s = byId[succId];
                if (!s || typeof s.x !== 'number') return;
                let needed = ((n.x || 0) + spacingX) - s.x;
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

        // Step 3.5: Resolve remaining overlaps among new nodes
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
                    for (let oi = 0; oi < allPositioned.length; oi++) {
                        let other = allPositioned[oi];
                        if (other.id === cur.id) continue;
                        if (Math.abs((cur.x || 0) - (other.x || 0)) < spacingX * 0.5 &&
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
            remaining.forEach(function(n) {
                let pos = orphanPositions[n.id] || { col: 0, row: 0 };
                let ci = pos.comp || 0;
                n.x = Math.round(minX + pos.col * spacingX);
                n.y = Math.round(pos.row * spacingY + (orphanOffsets[ci] || 0));
            });
        }

        return nodes;
    }

    return {
        LAYOUT_DEFAULTS:              LAYOUT_DEFAULTS,
        layoutNodes:                  layoutNodes,
        buildWireAdjacency:           buildWireAdjacency,
        computeComponentYOffsets:     computeComponentYOffsets,
        reflowCanvasNodes:            reflowCanvasNodes,
        placeAddedNodesNearNeighbors: placeAddedNodesNearNeighbors
    };
});
