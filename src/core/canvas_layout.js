// Canvas Layout - standalone layout engine for Node-RED node arrays.
// Public API: layoutNodes, reflowCanvasNodes, placeAddedNodesNearNeighbors,
// estimateNodeWidth, getNodeWidth, pairSpacing. See ./LAYOUT.md.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        window.LLMPlugin.CanvasLayout = factory();
    }
})(function() {
    'use strict';

    // See ./LAYOUT.md for the meaning of each constant and the width-aware
    // spacing rule (`distance = (widthA + widthB)/2 + edgeGap`).
    let LAYOUT_DEFAULTS = {
        startX:        60,
        startY:        60,
        spacingY:      80,
        componentGap:  80,
        edgeGap:       60,    // 3 Node-RED grid squares between adjacent node edges
        minNodeWidth: 100,
        nodeHeight:    30,    // Node-RED's standard rendered node height
        gridSize:      20,
        maxColumns:     5
    };

    // Default predicate when caller doesn't supply `options.isCanvasNode`.
    function defaultIsCanvasNode(node) {
        if (!node || typeof node !== 'object') return false;
        let type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        return true;
    }

    // --- Pure topological layout (./LAYOUT.md §1) ---
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

    // --- Helpers ---

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

    // Approximate Node-RED's label-based width when no DOM measurement is
    // available. The editor renders nodes as
    //   max(MIN_NODE_WIDTH, textWidth + iconStrip + labelPadding) + portStubs
    // where the default 14 px sans-serif font averages ~7.5 px/char, the
    // icon strip is 30 px, label padding is ~14 px, and the port stubs add
    // ~7 px on each side (14 px total). 7.5*chars + 64 chrome puts the
    // estimate close enough to the rendered width that an `edgeGap` of N
    // grid squares actually shows ~N grid squares between rendered nodes.
    function estimateNodeWidth(node, opts) {
        let minW = pickOption(opts, 'minNodeWidth', LAYOUT_DEFAULTS.minNodeWidth);
        let grid = pickOption(opts, 'gridSize',     LAYOUT_DEFAULTS.gridSize);
        if (!node || typeof node !== 'object') return minW;
        let label = (typeof node.name === 'string' && node.name.trim()) ? node.name : (node.type || '');
        let estimated = label.length * 7.5 + 64;
        let w = Math.max(minW, estimated);
        return Math.ceil(w / grid) * grid;
    }

    function getNodeWidth(node, opts) {
        if (opts && typeof opts.getNodeWidth === 'function') {
            let w = opts.getNodeWidth(node);
            if (typeof w === 'number' && w > 0) return w;
        }
        return estimateNodeWidth(node, opts);
    }

    function nodeRightEdge(node, opts) { return (node.x || 0) + getNodeWidth(node, opts) / 2; }
    function nodeLeftEdge (node, opts) { return (node.x || 0) - getNodeWidth(node, opts) / 2; }

    // Width-aware centre-to-centre distance (./LAYOUT.md §"Width-aware…").
    function pairSpacing(a, b, opts) {
        let gap = pickOption(opts, 'edgeGap', LAYOUT_DEFAULTS.edgeGap);
        return (getNodeWidth(a, opts) + getNodeWidth(b, opts)) / 2 + gap;
    }

    // Place leading-position comments directly above the canvas node they
    // head, touching that node's top edge (zero-grid gap). Multiple
    // comments targeting the same canvas node stack upward, each touching
    // the comment beneath it.
    //
    // Target selection (per comment):
    //   1. Explicit `_llmAbove(Id)` — the schema named a target node.
    //   2. Fallback: the next canvas node in declaration order, via
    //      `_llmOrder` (legacy behaviour for schemas that omit `above`).
    //
    // toNodeRed has already filtered out trailing comments without a
    // forward neighbour, so the fallback path always has a valid target.
    //
    // Existing-comment stacking: if the target already has comments
    // touching above it (e.g. user-authored or carried over from a
    // previous run), the new group lands on TOP of that existing stack
    // instead of colliding with it.
    function repositionCommentsByLlmOrder(canvasNodes, opts, shouldReposition) {
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        let gridSize   = pickOption(opts, 'gridSize',   LAYOUT_DEFAULTS.gridSize);

        let byId = {};
        canvasNodes.forEach(function(n) { if (n && n.id) byId[n.id] = n; });

        let comments = [];
        let ordered = [];
        canvasNodes.forEach(function(n) {
            if (!n || typeof n._llmOrder !== 'number') return;
            if (n.type === 'comment') comments.push(n);
            else ordered.push(n);
        });
        // Comments may also reposition relative to existing canvas nodes
        // referenced via _llmAboveId, even when no ordered new node exists.
        if (comments.length === 0) return;
        ordered.sort(function(a, b) { return a._llmOrder - b._llmOrder; });

        function findFallbackTarget(c) {
            for (let i = 0; i < ordered.length; i++) {
                if (ordered[i]._llmOrder > c._llmOrder) return ordered[i];
            }
            return null;
        }

        let groupsByTargetId = {};
        comments.forEach(function(c) {
            if (typeof shouldReposition === 'function' && !shouldReposition(c)) return;
            let target = null;
            if (typeof c._llmAboveId === 'string' && byId[c._llmAboveId]) {
                target = byId[c._llmAboveId];
            } else {
                target = findFallbackTarget(c);
            }
            if (!target) return;
            (groupsByTargetId[target.id] = groupsByTargetId[target.id] || []).push(c);
        });

        // Walk the existing contiguous comment stack above `target` and
        // return the y where the bottommost NEW comment should land
        // (i.e. just above the topmost existing comment, or directly
        // touching the target if no existing stack is present).
        function findStackBottomY(target, group) {
            let targetX = target.x || 0;
            let targetY = target.y || 0;
            let groupIds = {};
            group.forEach(function(c) { groupIds[c.id] = true; });

            let candidates = [];
            canvasNodes.forEach(function(n) {
                if (!n || n.type !== 'comment') return;
                if (groupIds[n.id]) return;
                if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
                if (Math.abs(n.x - targetX) > gridSize) return;
                if (n.y >= targetY) return;
                candidates.push(n);
            });
            candidates.sort(function(a, b) { return b.y - a.y; }); // closest-to-target first

            let yTol = nodeHeight / 2;
            let nextSlotY = targetY - nodeHeight;
            for (let i = 0; i < candidates.length; i++) {
                if (Math.abs(candidates[i].y - nextSlotY) <= yTol) {
                    nextSlotY = candidates[i].y - nodeHeight;
                } else {
                    break;
                }
            }
            return nextSlotY;
        }

        Object.keys(groupsByTargetId).forEach(function(targetId) {
            let group = groupsByTargetId[targetId];
            group.sort(function(a, b) { return a._llmOrder - b._llmOrder; });
            let target = byId[targetId];
            if (!target) return;
            // Bottommost-new-comment slot: above any existing contiguous
            // stack, or touching the target's top edge if none. Earlier
            // declaration order = higher in the stack (further from target).
            let bottomY = findStackBottomY(target, group);
            group.forEach(function(c, i) {
                c.x = Math.round(target.x || 0);
                c.y = Math.round(bottomY - (group.length - 1 - i) * nodeHeight);
            });
        });
    }

    // --- Canvas-level layout (./LAYOUT.md §§ 2 and 3) ---

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

        let colMaxWidth = {};
        ids.forEach(function(id) {
            let col = (positions[id] || {}).col || 0;
            let w = getNodeWidth(byId[id], opts);
            if (!colMaxWidth[col] || colMaxWidth[col] < w) colMaxWidth[col] = w;
        });
        let colKeys = Object.keys(colMaxWidth).map(Number).sort(function(a, b) { return a - b; });
        let colX = {};
        let cursorRight = startX;
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

        repositionCommentsByLlmOrder(canvasNodes, opts);
        return nodes;
    }

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

        // Step 3.4 (./LAYOUT.md): shift downstream chains to clear inserted nodes.
        let shiftedIds = {};
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
                    shiftedIds[id] = true;
                }
            });
        }

        // Compute connected components over the live wire adjacency.
        // Used by Step 3.5a (within-component sibling nudge) and Step 3.5b
        // (cross-component push-down).
        let compOf = {};
        (function discoverComponents() {
            let visited = {};
            let cid = 0;
            canvasNodes.forEach(function(n) {
                if (visited[n.id]) return;
                let queue = [n.id];
                visited[n.id] = true;
                while (queue.length > 0) {
                    let cur = queue.shift();
                    compOf[cur] = cid;
                    let neighbors = (outgoing[cur] || []).concat(incoming[cur] || []);
                    for (let i = 0; i < neighbors.length; i++) {
                        if (!visited[neighbors[i]]) {
                            visited[neighbors[i]] = true;
                            queue.push(neighbors[i]);
                        }
                    }
                }
                cid++;
            });
        })();

        // Step 3.5a: within-component sibling nudge — when a newly-placed
        // node ends up at the same row as a same-component node (e.g. two
        // siblings of one predecessor), push it down by spacingY until
        // clear. Cross-component collisions are handled by Step 3.5b so
        // we deliberately skip them here.
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
                    let curComp = compOf[cur.id];
                    for (let oi = 0; oi < allPositioned.length; oi++) {
                        let other = allPositioned[oi];
                        if (other.id === cur.id) continue;
                        if (compOf[other.id] !== curComp) continue;
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

        // Step 3.5b: cross-component push — when an unrelated component
        // sits where the modified component now extends, shift the WHOLE
        // unrelated component down so the shape of the other flow is
        // preserved. "Modified" = contains a new node or a Step 3.4
        // horizontally-shifted node. Cascade: a pushed component itself
        // becomes a propagator for the next pass.
        // Components that started ABOVE a modified component are never
        // pushed (we only ever move things down).
        (function pushCollidingComponentsDown() {
            let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
            let nodesByComp = {};
            allPositioned.forEach(function(n) {
                let c = compOf[n.id];
                if (c === undefined) return;
                (nodesByComp[c] = nodesByComp[c] || []).push(n);
            });

            function bbox(nodes) {
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (let i = 0; i < nodes.length; i++) {
                    let n = nodes[i];
                    let w = getNodeWidth(n, opts);
                    let x = n.x || 0;
                    let y = n.y || 0;
                    if (x - w / 2 < minX) minX = x - w / 2;
                    if (x + w / 2 > maxX) maxX = x + w / 2;
                    if (y - nodeHeight / 2 < minY) minY = y - nodeHeight / 2;
                    if (y + nodeHeight / 2 > maxY) maxY = y + nodeHeight / 2;
                }
                return { minX: minX, maxX: maxX, minY: minY, maxY: maxY };
            }

            let modifiedComps = {};
            newlyPlaced.forEach(function(n) {
                let c = compOf[n.id];
                if (c !== undefined) modifiedComps[c] = true;
            });
            Object.keys(shiftedIds).forEach(function(id) {
                let c = compOf[id];
                if (c !== undefined) modifiedComps[c] = true;
            });
            if (Object.keys(modifiedComps).length === 0) return;

            let compBoxes = {};
            Object.keys(nodesByComp).forEach(function(c) {
                compBoxes[c] = bbox(nodesByComp[c]);
            });

            let safety = Object.keys(nodesByComp).length + 5;
            let didShift = true;
            while (didShift && safety-- > 0) {
                didShift = false;
                let modIds = Object.keys(modifiedComps);
                for (let mi = 0; mi < modIds.length; mi++) {
                    let mid = modIds[mi];
                    let mBox = compBoxes[mid];
                    let othIds = Object.keys(nodesByComp);
                    for (let oi = 0; oi < othIds.length; oi++) {
                        let oid = othIds[oi];
                        if (oid === mid) continue;
                        if (modifiedComps[oid]) continue;
                        let oBox = compBoxes[oid];
                        // Skip components that started above the modified one.
                        if (oBox.minY < mBox.minY) continue;
                        // Require horizontal AND vertical bbox overlap.
                        if (oBox.maxX < mBox.minX || oBox.minX > mBox.maxX) continue;
                        if (oBox.maxY < mBox.minY || oBox.minY > mBox.maxY) continue;
                        let dy = (mBox.maxY + bandGap) - oBox.minY;
                        if (dy <= 0) continue;
                        let dyR = Math.round(dy);
                        nodesByComp[oid].forEach(function(n) {
                            if (typeof n.y === 'number') n.y = n.y + dyR;
                        });
                        compBoxes[oid] = bbox(nodesByComp[oid]);
                        modifiedComps[oid] = true;
                        didShift = true;
                    }
                }
            }
        })();

        // Step 3.6: position new comments by schema declaration order so
        // they don't fall into the orphan band below.
        repositionCommentsByLlmOrder(canvasNodes, opts, function(c) {
            return !existingIdMap[c.id];
        });
        remaining = remaining.filter(function(n) {
            if (n.type === 'comment' && typeof n._llmOrder === 'number'
                && typeof n.x === 'number' && typeof n.y === 'number') {
                positioned[n.id] = true;
                return false;
            }
            return true;
        });

        // Step 4: orphan band — entirely-new chains land below at maxY + bandGap.
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

        // Final comment pass: step 3.6 ran before the orphan band placed
        // any new canvas targets, so a comment whose target only got
        // coordinates in step 4 still points at the old (zero/stale)
        // position. Re-run now that every target is in its final spot.
        repositionCommentsByLlmOrder(canvasNodes, opts, function(c) {
            return !existingIdMap[c.id];
        });

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
