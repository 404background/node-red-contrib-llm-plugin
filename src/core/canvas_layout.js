// Canvas Layout - standalone layout engine for Node-RED node arrays.
// Public API: layoutNodes, reflowCanvasNodes, placeAddedNodesNearNeighbors,
// fitGroups, getNodeWidth, and the two passes the converter shares
// (computeComponentYOffsets, computeLeftEdges). See docs/{en,jp}/layout.md.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        window.LLMPlugin.CanvasLayout = factory();
    }
})(function() {
    'use strict';

    // `spacingY`, `componentGap` and `edgeGap` are EDGE-TO-EDGE clearances
    // (visible whitespace), not centre-to-centre distances; the pitch is
    // `nodeHeight + gap`. See docs/{en,jp}/layout.md for the spacing rule.
    let LAYOUT_DEFAULTS = {
        startX:        60,
        startY:        60,
        spacingY:      40,    // 2 grid squares between stacked node edges (within a flow)
        componentGap:  80,    // 4 grid squares between disconnected flow components
        edgeGap:       40,    // 2 grid squares between adjacent node edges (horizontal)
        minNodeWidth: 100,
        nodeHeight:    30,    // Node-RED's standard rendered node height
        gridSize:      20,
        maxColumns:     5,
        topMargin:     20,    // min clearance between canvas top (y=0) and the topmost node edge
        leftMargin:    20,    // the same on the left edge (x=0)
        groupPadding:  25,    // the editor's own clearance between a group's box and its members
        groupGap:      40     // 2 grid squares between a group's box and whatever is outside it
    };

    // Default predicate when caller doesn't supply `options.isCanvasNode`.
    function defaultIsCanvasNode(node) {
        if (!node || typeof node !== 'object') return false;
        let type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        return true;
    }

    // --- Pure topological layout (docs/{en,jp}/layout.md §1) ---
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

    // `spacingY` and `gap` are EDGE-TO-EDGE clearances, so each pitch is
    // `nodeHeight + `the clearance. See docs/{en,jp}/layout.md — Defaults.
    function computeComponentYOffsets(ids, positions, startY, spacingY, gap, nodeHeight) {
        if (typeof nodeHeight !== 'number') nodeHeight = LAYOUT_DEFAULTS.nodeHeight;
        let rowPitch = nodeHeight + spacingY;
        let compStep = nodeHeight + gap;
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
            offsets[ci] = nextY - c.minRow * rowPitch;
            nextY = nextY + (c.maxRow - c.minRow) * rowPitch + compStep;
        });
        return offsets;
    }

    // Per-predecessor left edges, NOT shared column widths: each key sits
    // `edgeGap` right of `max(pred.rightEdge)`, roots at `startX`. Column 0
    // and branch siblings still align, but a wide label in one chain no
    // longer drags a parallel chain right.
    //
    // Keyed by whatever the caller uses — node ids here, aliases in the
    // converter, which has no ids yet. Both have to produce the same
    // coordinates, so they run the same pass rather than two copies of it.
    // See docs/{en,jp}/layout.md — Width-aware spacing.
    function computeLeftEdges(keys, positions, incoming, widthOf, startX, edgeGap) {
        let leftEdges = {};
        let buckets = {};
        keys.forEach(function(key) {
            let ci = (positions[key] || {}).comp || 0;
            (buckets[ci] = buckets[ci] || []).push(key);
        });
        Object.keys(buckets).forEach(function(ci) {
            let ordered = buckets[ci].slice().sort(function(a, b) {
                let pa = positions[a] || { col: 0, row: 0 };
                let pb = positions[b] || { col: 0, row: 0 };
                return (pa.col - pb.col) || (pa.row - pb.row);
            });
            ordered.forEach(function(key) {
                let preds = (incoming[key] || []).filter(function(p) {
                    return leftEdges[p] !== undefined;
                });
                if (preds.length === 0) {
                    leftEdges[key] = startX;
                    return;
                }
                let maxRight = -Infinity;
                preds.forEach(function(p) {
                    let r = leftEdges[p] + widthOf(p);
                    if (r > maxRight) maxRight = r;
                });
                leftEdges[key] = maxRight + edgeGap;
            });
        });
        return leftEdges;
    }

    function resolveCanvasFilter(opts) {
        return (opts && typeof opts.isCanvasNode === 'function') ? opts.isCanvasNode : defaultIsCanvasNode;
    }

    function pickOption(opts, key, fallback) {
        return (opts && typeof opts[key] === 'number') ? opts[key] : fallback;
    }

    // True if the label contains any non-ASCII char (Japanese, Chinese,
    // accented Latin, etc.). Used to switch to a wider per-char estimate.
    function hasWideChar(label) {
        for (let i = 0; i < label.length; i++) {
            if (label.charCodeAt(i) > 127) return true;
        }
        return false;
    }

    // The editor's own width formula:
    //   w = max(minWidth, grid * ceil((labelWidth + chrome) / grid))
    // See docs/{en,jp}/layout.md — Width-aware spacing.
    function estimateNodeWidth(node, opts) {
        let minW = pickOption(opts, 'minNodeWidth', LAYOUT_DEFAULTS.minNodeWidth);
        let grid = pickOption(opts, 'gridSize',     LAYOUT_DEFAULTS.gridSize);
        if (!node || typeof node !== 'object') return minW;
        let label = (typeof node.name === 'string' && node.name.trim()) ? node.name : (node.type || '');
        let perChar = hasWideChar(label) ? 14 : 7.5;
        let chrome = (node.type === 'comment') ? 24 : 57;
        let w = Math.max(minW, label.length * perChar + chrome);
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

    // Width-aware centre-to-centre distance (docs/{en,jp}/layout.md §"Width-aware…").
    function pairSpacing(a, b, opts) {
        let gap = pickOption(opts, 'edgeGap', LAYOUT_DEFAULTS.edgeGap);
        return (getNodeWidth(a, opts) + getNodeWidth(b, opts)) / 2 + gap;
    }

    // Place each comment directly above the canvas node it heads, stacking
    // upward when several share a target and landing on top of any comments
    // already there. Target = `_llmAboveId`, else the next canvas node in
    // `_llmOrder`. See docs/{en,jp}/layout.md#comment-placement.
    function repositionCommentsByLlmOrder(canvasNodes, opts, shouldReposition) {
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        let gridSize   = pickOption(opts, 'gridSize',   LAYOUT_DEFAULTS.gridSize);
        // Stack comments at grid-aligned intervals: snap nodeHeight UP to
        // the next grid multiple so each comment's y stays on the grid.
        let stackStep = (gridSize > 0)
            ? Math.ceil(nodeHeight / gridSize) * gridSize
            : nodeHeight;

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

        // Where the bottommost NEW comment lands: above any existing stack,
        // else touching the target. Detected by LEFT EDGE proximity — a
        // caption and its target share a left edge, not a centre.
        function findStackBottomY(target, group) {
            let targetLeft = (target.x || 0) - getNodeWidth(target, opts) / 2;
            let targetY = target.y || 0;
            let groupIds = {};
            group.forEach(function(c) { groupIds[c.id] = true; });

            let candidates = [];
            canvasNodes.forEach(function(n) {
                if (!n || n.type !== 'comment') return;
                if (groupIds[n.id]) return;
                if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
                let nLeft = n.x - getNodeWidth(n, opts) / 2;
                if (Math.abs(nLeft - targetLeft) > gridSize) return;
                if (n.y >= targetY) return;
                candidates.push(n);
            });
            candidates.sort(function(a, b) { return b.y - a.y; }); // closest-to-target first

            let yTol = stackStep / 2;
            let nextSlotY = targetY - stackStep;
            for (let i = 0; i < candidates.length; i++) {
                if (Math.abs(candidates[i].y - nextSlotY) <= yTol) {
                    nextSlotY = candidates[i].y - stackStep;
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
            // LEFT EDGES, not centres: a caption and its target share a
            // column. See docs/{en,jp}/layout.md — Comment placement.
            let targetLeft = (target.x || 0) - getNodeWidth(target, opts) / 2;
            group.forEach(function(c, i) {
                c.x = targetLeft + getNodeWidth(c, opts) / 2;
                c.y = bottomY - (group.length - 1 - i) * stackStep;
            });
        });
    }

    // Each caption's offset to the node it is attached to, found by hopping
    // down through whatever it TOUCHES. The tolerance is tight on purpose: a
    // standalone annotation gets no anchor and is left where the user put it.
    function captureCommentAnchors(canvasNodes, opts) {
        let gridSize   = pickOption(opts, 'gridSize',   LAYOUT_DEFAULTS.gridSize);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        let stackStep  = (gridSize > 0)
            ? Math.ceil(nodeHeight / gridSize) * gridSize
            : nodeHeight;
        let touchingTol = stackStep + gridSize;
        let xMargin = gridSize;

        let positioned = (canvasNodes || []).filter(function(n) {
            return n && n.id && typeof n.x === 'number' && typeof n.y === 'number';
        });

        function touchingBelow(from, visited) {
            let best = null;
            let bestDy = Infinity;
            // LEFT EDGES again: a wide caption over a narrow node has a
            // centre well outside that node's box.
            let fromLeft = (from.x || 0) - getNodeWidth(from, opts) / 2;
            for (let i = 0; i < positioned.length; i++) {
                let n = positioned[i];
                if (visited[n.id]) continue;
                let nLeft = (n.x || 0) - getNodeWidth(n, opts) / 2;
                if (Math.abs(nLeft - fromLeft) > xMargin) continue;
                let dy = n.y - from.y;
                if (dy <= 0 || dy > touchingTol) continue;
                if (dy < bestDy) { bestDy = dy; best = n; }
            }
            return best;
        }

        let anchors = {};
        positioned.forEach(function(c) {
            if (c.type !== 'comment') return;
            let visited = {};
            visited[c.id] = true;
            let current = c;
            let hops = 10;
            while (hops-- > 0) {
                let next = touchingBelow(current, visited);
                if (!next) break;
                visited[next.id] = true;
                if (next.type !== 'comment') {
                    anchors[c.id] = {
                        targetId: next.id,
                        dx: c.x - next.x,
                        dy: c.y - next.y
                    };
                    break;
                }
                current = next;
            }
        });
        return anchors;
    }

    // Re-apply each captured anchor: the caption keeps its vertical offset and
    // takes its target's LEFT EDGE. The captured `dx` is a centre offset, and
    // replaying it kept a caption aligned only while both widths stayed the
    // same — rename the node it heads and the column it shared with it was
    // gone. Skips entries whose target was deleted from the rebuilt flow (the
    // comment stays at its last position rather than vanishing).
    function applyCommentAnchors(canvasNodes, anchors, opts) {
        if (!anchors) return;
        let byId = {};
        (canvasNodes || []).forEach(function(n) { if (n && n.id) byId[n.id] = n; });
        (canvasNodes || []).forEach(function(c) {
            if (!c || c.type !== 'comment') return;
            let info = anchors[c.id];
            if (!info) return;
            let target = byId[info.targetId];
            if (!target || typeof target.x !== 'number' || typeof target.y !== 'number') return;
            c.x = (target.x - getNodeWidth(target, opts) / 2) + getNodeWidth(c, opts) / 2;
            c.y = target.y + info.dy;
        });
    }

    // A node's `x` is its CENTRE, so a rename moves BOTH its edges: the node
    // slid out of the column it was aligned to, and took the caption above it
    // and its group's box with it — a long enough name pushed the left edge
    // off the canvas. The column is what this engine aligns, so a width change
    // must not move it. `widthsBefore` is keyed by id; a node that is not in
    // it (a new one) is left to the layout passes. Returns the ids it moved,
    // because a node that grew also has to stop overlapping what follows it —
    // pass them to `placeAddedNodesNearNeighbors` as `reflowIds`.
    function keepLeftEdges(nodes, widthsBefore, options) {
        let changed = [];
        if (!widthsBefore) return changed;
        let opts = options || {};
        (nodes || []).forEach(function(n) {
            if (!n || !n.id || n.type === 'group' || typeof n.x !== 'number') return;
            let was = widthsBefore[n.id];
            if (typeof was !== 'number' || !(was > 0)) return;
            let now = getNodeWidth(n, opts);
            if (!(now > 0) || now === was) return;
            n.x = n.x - was / 2 + now / 2;
            changed.push(n.id);
        });
        return changed;
    }

    // Last resort for overlaps the directional pushes could not reach. With
    // `compOf` each component moves as a RIGID BODY, so a flow the user did
    // not edit keeps its shape. See docs/{en,jp}/layout.md — Pass details.
    function resolveOverlaps(canvasNodes, opts, compOf) {
        let gridSize   = pickOption(opts, 'gridSize',   LAYOUT_DEFAULTS.gridSize);
        let spacingY   = pickOption(opts, 'spacingY',   LAYOUT_DEFAULTS.spacingY);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);

        let nodes = (canvasNodes || []).filter(function(n) {
            return n && n.type !== 'comment' && typeof n.x === 'number' && typeof n.y === 'number';
        });
        if (nodes.length < 2) return;

        // Group non-comment nodes by component so a push can move the whole
        // body at once (rigid). Only built when compOf is provided.
        let members = null;
        if (compOf) {
            members = {};
            nodes.forEach(function(n) {
                let c = compOf[n.id];
                if (c === undefined) return;
                (members[c] = members[c] || []).push(n);
            });
        }

        // spacingY is edge-to-edge; the actual row pitch (centre delta) is
        // nodeHeight + spacingY. Floor stepY at a single grid square so
        // tightly-packed nodes always advance at least one snap unit.
        let stepY = nodeHeight + Math.max(spacingY, gridSize);
        let maxPasses = nodes.length * 2 + 5;
        let changed = true;
        while (changed && maxPasses-- > 0) {
            changed = false;
            nodes.sort(function(a, b) {
                return (a.y - b.y) || (a.x - b.x);
            });
            for (let i = 0; i < nodes.length; i++) {
                let a = nodes[i];
                let aw = getNodeWidth(a, opts);
                for (let j = i + 1; j < nodes.length; j++) {
                    let b = nodes[j];
                    let bw = getNodeWidth(b, opts);
                    if (Math.abs(a.x - b.x) < (aw + bw) / 2 && (b.y - a.y) < nodeHeight) {
                        let ca = compOf ? compOf[a.id] : undefined;
                        let cb = compOf ? compOf[b.id] : undefined;
                        // Leave a component's own internal layout alone.
                        if (compOf && ca !== undefined && ca === cb) continue;
                        // Push by exact `stepY` (= nodeHeight + max(spacingY,
                        // gridSize)); snapping would break the consistent
                        // per-row pitch that the rest of the layout enforces.
                        let delta = (a.y + stepY) - b.y;
                        if (delta <= 0) continue;
                        if (members && cb !== undefined) {
                            // Rigid: translate b's whole flow down together.
                            members[cb].forEach(function(n) { n.y = n.y + delta; });
                        } else {
                            b.y = a.y + stepY;
                        }
                        changed = true;
                    }
                }
            }
        }
    }

    // Comment stacks grow upward, so a caption above a node near the top of
    // the canvas can land at y <= 0. Slide every node down by one shared
    // delta, preserving relative geometry. Pinned component reflows opt out
    // (`skipTopMargin`) — their caller guards the canvas as a whole.
    function ensureTopMargin(canvasNodes, opts) {
        if (opts && opts.skipTopMargin) return;
        let gridSize   = pickOption(opts, 'gridSize',   LAYOUT_DEFAULTS.gridSize);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        let topMargin  = pickOption(opts, 'topMargin',  LAYOUT_DEFAULTS.topMargin);

        let minTop = Infinity;
        (canvasNodes || []).forEach(function(n) {
            if (!n || typeof n.y !== 'number') return;
            let top = n.y - nodeHeight / 2;
            if (top < minTop) minTop = top;
        });
        if (!isFinite(minTop) || minTop >= topMargin) return;

        let dy = topMargin - minTop;
        if (gridSize > 0) dy = Math.ceil(dy / gridSize) * gridSize;
        canvasNodes.forEach(function(n) {
            if (n && typeof n.y === 'number') n.y += dy;
        });
    }

    // --- Canvas-level layout (docs/{en,jp}/layout.md §§ 2 and 3) ---

    function reflowCanvasNodes(nodes, options) {
        let opts = options || {};
        let isCanvas    = resolveCanvasFilter(opts);
        let startX       = pickOption(opts, 'startX',       LAYOUT_DEFAULTS.startX);
        let startY       = pickOption(opts, 'startY',       LAYOUT_DEFAULTS.startY);
        let spacingY     = pickOption(opts, 'spacingY',     LAYOUT_DEFAULTS.spacingY);
        let componentGap = pickOption(opts, 'componentGap', LAYOUT_DEFAULTS.componentGap);
        let edgeGap      = pickOption(opts, 'edgeGap',      LAYOUT_DEFAULTS.edgeGap);
        let nodeHeight   = pickOption(opts, 'nodeHeight',   LAYOUT_DEFAULTS.nodeHeight);
        let rawMaxCols   = pickOption(opts, 'maxColumns',   LAYOUT_DEFAULTS.maxColumns);
        let maxColumns   = (rawMaxCols >= 2) ? Math.floor(rawMaxCols) : LAYOUT_DEFAULTS.maxColumns;
        let rowPitch     = nodeHeight + spacingY;

        let canvasNodes = (nodes || []).filter(isCanvas);
        if (canvasNodes.length < 2) return nodes;

        // Before the grid layout rewrites coordinates: attached captions
        // follow their target, standalone ones are left alone.
        let commentAnchors = captureCommentAnchors(canvasNodes, opts);

        let byId = {};
        let ids = [];
        canvasNodes.forEach(function(n) {
            if (n && n.id && n.type !== 'comment') {
                byId[n.id] = n;
                ids.push(n.id);
            }
        });
        if (ids.length === 0) return nodes;

        let adj = buildWireAdjacency(canvasNodes.filter(function(n) { return n.type !== 'comment'; }), byId);
        let positions = layoutNodes(ids, adj.outgoing, adj.incoming, maxColumns);
        let incoming = adj.incoming;

        let leftEdgeById = computeLeftEdges(ids, positions, incoming, function(id) {
            return getNodeWidth(byId[id], opts);
        }, startX, edgeGap);

        let compOffsets = computeComponentYOffsets(ids, positions, startY, spacingY, componentGap, nodeHeight);

        // No grid snap on the derived centre: left edges are what align, so
        // each is kept exactly and the centre derived from it.
        // See docs/{en,jp}/layout.md — Width-aware spacing.
        ids.forEach(function(id) {
            let node = byId[id];
            let pos = positions[id] || { col: 0, row: 0 };
            let ci = pos.comp || 0;
            let left = (leftEdgeById[id] !== undefined) ? leftEdgeById[id] : startX;
            node.x = left + getNodeWidth(node, opts) / 2;
            node.y = pos.row * rowPitch + (compOffsets[ci] || 0);
        });

        resolveOverlaps(canvasNodes, opts);
        applyCommentAnchors(canvasNodes, commentAnchors, opts);
        repositionCommentsByLlmOrder(canvasNodes, opts);
        ensureTopMargin(canvasNodes, opts);
        return nodes;
    }

    // Reflow one component, pinned to its current top-left so neighbouring
    // components stay put. Used by Step 3.6.
    function reflowComponentInPlace(componentNodes, opts) {
        if (!Array.isArray(componentNodes) || componentNodes.length < 2) return;

        let nonComments = componentNodes.filter(function(n) {
            return n && n.type !== 'comment' &&
                   typeof n.x === 'number' && typeof n.y === 'number';
        });
        if (nonComments.length < 2) return;

        let minLeft = Infinity, minTop = Infinity;
        nonComments.forEach(function(n) {
            let w = getNodeWidth(n, opts);
            let left = n.x - w / 2;
            if (left < minLeft) minLeft = left;
            if (n.y < minTop) minTop = n.y;
        });
        if (!isFinite(minLeft)) minLeft = pickOption(opts, 'startX', LAYOUT_DEFAULTS.startX);
        if (!isFinite(minTop))  minTop  = pickOption(opts, 'startY', LAYOUT_DEFAULTS.startY);

        // Pin the reflow to the component's existing top-left. Disable
        // column folding — a mid-chain insertion should never trigger a
        // hard line break the user didn't ask for.
        let pinnedOpts = Object.assign({}, opts || {}, {
            startX: minLeft,
            startY: minTop,
            maxColumns: Infinity,
            skipTopMargin: true
        });
        reflowCanvasNodes(componentNodes, pinnedOpts);
    }

    function placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, options) {
        let opts = options || {};
        let isCanvas = resolveCanvasFilter(opts);
        let spacingY = pickOption(opts, 'spacingY', LAYOUT_DEFAULTS.spacingY);
        let edgeGap  = pickOption(opts, 'edgeGap',  LAYOUT_DEFAULTS.edgeGap);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        let bandGap = (typeof opts.bandGap === 'number')
            ? opts.bandGap
            : pickOption(opts, 'componentGap', LAYOUT_DEFAULTS.componentGap);
        let rawMaxCols = pickOption(opts, 'maxColumns', LAYOUT_DEFAULTS.maxColumns);
        // Floored like reflowCanvasNodes: a fractional fold width would put
        // `colMap[a] % maxColumns` on a non-integer boundary. Math.floor
        // leaves the Infinity that callers pass to disable folding intact.
        let maxColumns = (rawMaxCols >= 2) ? Math.floor(rawMaxCols) : LAYOUT_DEFAULTS.maxColumns;
        let rowPitch = nodeHeight + spacingY;

        existingIdMap = existingIdMap || {};
        basePositions = basePositions || {};

        // An id-less entry has no place in the adjacency maps, so keeping it
        // would make `incoming[n.id]` undefined and throw in tryPlace.
        let canvasNodes = (nodes || []).filter(function(n) {
            return isCanvas(n) && !!n.id;
        });
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

        // After step 1, not before: an LLM-mentioned node arrives with no
        // x/y, so capturing earlier would miss it and strand its caption.
        let commentAnchors = captureCommentAnchors(canvasNodes, opts);

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

            // No snap on derived X/Y -- keeps the exact `edgeGap` clearance
            // between the placed node and its neighbour, and keeps the new
            // node's left edge aligned with `predRightEdge + edgeGap` even
            // when the neighbour's centre is at an odd half-grid offset.
            let nHalf = getNodeWidth(n, opts) / 2;
            if (preds.length > 0 && succs.length > 0) {
                let maxPredRight = Math.max.apply(null, preds.map(function(id) { return nodeRightEdge(byId[id], opts); }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = maxPredRight + edgeGap + nHalf;
                n.y = (avgPredY + avgSuccY) / 2;
            } else if (preds.length > 0) {
                let maxPredRight = Math.max.apply(null, preds.map(function(id) { return nodeRightEdge(byId[id], opts); }));
                let avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                n.x = maxPredRight + edgeGap + nHalf;
                n.y = avgPredY;
            } else {
                let minSuccLeft = Math.min.apply(null, succs.map(function(id) { return nodeLeftEdge(byId[id], opts); }));
                let avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = minSuccLeft - edgeGap - nHalf;
                n.y = avgSuccY;
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

        // Step 3.4 (docs/{en,jp}/layout.md): shift downstream chains to clear inserted nodes.
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
                    // No snap -- the shift amount comes from edge-aware
                    // math (`needed = nRight + edgeGap - succLeft`); snap
                    // here would round the clearance off by up to a
                    // half-grid and break left-edge alignment further down
                    // the chain.
                    node.x = node.x + toShift[id];
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
        // siblings of one predecessor), push it down by one row pitch
        // (= nodeHeight + spacingY) until clear. Cross-component collisions
        // are handled by Step 3.5b so we deliberately skip them here.
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
                            Math.abs((cur.y || 0) - (other.y || 0)) < nodeHeight) {
                            cur.y = (other.y || 0) + rowPitch;
                            changed = true;
                        }
                    }
                }
            }
        }

        // Step 3.6: reflow the whole component around any insertion. The
        // per-edge pushes in 3.4 / 3.5a clear the overlap but leave the
        // surrounding nodes pinned, so the chain ends up with uneven gaps
        // whenever the inserted node's width differs from the cadence.
        // Orphan-band nodes are excluded — Step 4 lays them out fresh.
        let componentsNeedingReflow = {};
        newlyPlaced.forEach(function(n) {
            let cidN = compOf[n.id];
            if (cidN !== undefined) componentsNeedingReflow[cidN] = true;
        });
        // A node that changed WIDTH is an insertion as far as the chain is
        // concerned: it reaches further right than it did, so what follows it
        // has to move over. See `keepLeftEdges`.
        (Array.isArray(opts.reflowIds) ? opts.reflowIds : []).forEach(function(id) {
            let cidN = compOf[id];
            if (cidN !== undefined) componentsNeedingReflow[cidN] = true;
        });
        let reflowedComponents = {};
        Object.keys(componentsNeedingReflow).forEach(function(cidStr) {
            let cid = Number(cidStr);
            let compNodes = canvasNodes.filter(function(n) { return compOf[n.id] === cid; });
            if (compNodes.length < 2) return;
            reflowComponentInPlace(compNodes, opts);
            reflowedComponents[cid] = true;
        });

        // Step 3.5b: shift a colliding component down as a WHOLE, so the
        // untouched flow keeps its shape. "Modified" = holds a new node or
        // one Step 3.4 shifted; a pushed component then propagates in turn.
        // Components that started above a modifier are never pushed.
        (function pushCollidingComponentsDown() {
            let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);

            // Re-glue captions first so bboxes use truthful coordinates
            // (earlier steps may have moved a target since anchors were
            // captured).
            applyCommentAnchors(canvasNodes, commentAnchors, opts);

            // Comments are wireless → singleton components. An ANCHORED
            // caption counts as part of its target's component here (it
            // moves with it, and its bbox must make the component
            // pushable); standalone captions never move in this pass and
            // are left out so they don't inflate the shift distance.
            let nodesByComp = {};
            allPositioned.forEach(function(n) {
                let c = compOf[n.id];
                if (n.type === 'comment') {
                    let info = commentAnchors[n.id];
                    c = (info && info.targetId !== undefined) ? compOf[info.targetId] : undefined;
                }
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
                    // One dy for every colliding component, sized for the
                    // topmost. Per-component dy makes a caption (higher minY)
                    // jump further than the inject it sits above, landing on
                    // it; a uniform shift keeps the existing gaps.
                    let candidates = [];
                    let topMinY = Infinity;
                    let othIds = Object.keys(nodesByComp);
                    for (let oi = 0; oi < othIds.length; oi++) {
                        let oid = othIds[oi];
                        if (oid === mid) continue;
                        if (modifiedComps[oid]) continue;
                        let oBox = compBoxes[oid];
                        if (oBox.minY < mBox.minY) continue;
                        if (oBox.maxX < mBox.minX || oBox.minX > mBox.maxX) continue;
                        if (oBox.maxY < mBox.minY || oBox.minY > mBox.maxY) continue;
                        candidates.push(oid);
                        if (oBox.minY < topMinY) topMinY = oBox.minY;
                    }
                    if (candidates.length === 0) continue;
                    // `dy` is the exact amount needed to leave `bandGap` of
                    // edge-to-edge clearance between the modifier's bottom
                    // and the topmost candidate's top. We apply it as-is
                    // (no snap) so the clearance is exactly `bandGap`
                    // regardless of where modifier's bbox falls relative
                    // to the grid.
                    let dy = (mBox.maxY + bandGap) - topMinY;
                    if (dy <= 0) continue;
                    let dyR = dy;
                    candidates.forEach(function(oid) {
                        nodesByComp[oid].forEach(function(n) {
                            // Anchored captions shift with their component
                            // (bbox stays truthful); standalone captions
                            // are in no component list, so they stay put.
                            if (typeof n.y === 'number') n.y = n.y + dyR;
                        });
                        compBoxes[oid] = bbox(nodesByComp[oid]);
                        modifiedComps[oid] = true;
                    });
                    didShift = true;
                }
            }
        })();

        // Excuse EVERY comment from the orphan layout -- comments are
        // captions, not graph nodes. A comment with x/y (existing or
        // raw-JSON import) keeps that position. New LLM comments from
        // the Vibe Schema get placed onto their target by the final
        // repositionCommentsByLlmOrder pass below.
        remaining = remaining.filter(function(n) {
            if (n && n.type === 'comment') {
                if (typeof n.x === 'number' && typeof n.y === 'number') {
                    positioned[n.id] = true;
                }
                return false;
            }
            return true;
        });

        // Step 4: orphan band — an entirely new chain lands `bandGap` below
        // the deepest existing node, left-aligned to the leftmost left edge.
        // Same edge maths as Step 3.5b, so both routes give the same gap.
        if (remaining.length > 0) {
            let maxBottomEdge = Number.NEGATIVE_INFINITY;
            let minLeftEdge   = Number.POSITIVE_INFINITY;
            canvasNodes.forEach(function(n) {
                if (!positioned[n.id] && !existingIdMap[n.id]) return;
                if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
                // Comments are kept out of the Y bound — captions are
                // anchored to their target separately, and a sidebar
                // annotation should not push the next flow further down.
                if (n.type !== 'comment') {
                    let bottom = n.y + nodeHeight / 2;
                    if (bottom > maxBottomEdge) maxBottomEdge = bottom;
                }
                let left = n.x - getNodeWidth(n, opts) / 2;
                if (left < minLeftEdge) minLeftEdge = left;
            });
            if (!isFinite(maxBottomEdge)) maxBottomEdge = LAYOUT_DEFAULTS.startY + nodeHeight / 2;
            if (!isFinite(minLeftEdge))   minLeftEdge   = LAYOUT_DEFAULTS.startX;
            // First orphan row's CENTRE = (deepest bottom edge) + bandGap +
            // half a node height = exactly `bandGap` of visible whitespace
            // between the previous bottom edge and the orphan's top edge.
            let orphanStartY = maxBottomEdge + bandGap + nodeHeight / 2;

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
            let orphanOffsets = computeComponentYOffsets(
                orphanIds, orphanPositions, orphanStartY, spacingY, bandGap, nodeHeight
            );

            // Per-predecessor left-edge placement (same idea as
            // reflowCanvasNodes). Each orphan component's column-0 nodes
            // sit at `minLeftEdge` so the first node of every new flow
            // lines up with the canvas's leftmost edge; everything
            // downstream advances by THIS chain's widths only.
            let orphanById = {};
            remaining.forEach(function(n) { orphanById[n.id] = n; });
            let orphanLeftEdgeById = {};
            let orphanCompBuckets = {};
            orphanIds.forEach(function(id) {
                let ci = (orphanPositions[id] || {}).comp || 0;
                (orphanCompBuckets[ci] = orphanCompBuckets[ci] || []).push(id);
            });
            Object.keys(orphanCompBuckets).forEach(function(ci) {
                let compIds = orphanCompBuckets[ci].slice().sort(function(a, b) {
                    let pa = orphanPositions[a] || { col: 0, row: 0 };
                    let pb = orphanPositions[b] || { col: 0, row: 0 };
                    return (pa.col - pb.col) || (pa.row - pb.row);
                });
                compIds.forEach(function(id) {
                    let preds = (orphanIn[id] || []).filter(function(p) {
                        return orphanLeftEdgeById[p] !== undefined;
                    });
                    let leftEdge;
                    if (preds.length === 0) {
                        leftEdge = minLeftEdge;
                    } else {
                        let maxRight = -Infinity;
                        preds.forEach(function(p) {
                            let r = orphanLeftEdgeById[p] + getNodeWidth(orphanById[p], opts);
                            if (r > maxRight) maxRight = r;
                        });
                        leftEdge = maxRight + edgeGap;
                    }
                    orphanLeftEdgeById[id] = leftEdge;
                });
            });

            remaining.forEach(function(n) {
                let pos = orphanPositions[n.id] || { col: 0, row: 0 };
                let ci = pos.comp || 0;
                let left = (orphanLeftEdgeById[n.id] !== undefined) ? orphanLeftEdgeById[n.id] : minLeftEdge;
                // No snap -- see the matching block in reflowCanvasNodes
                // for why centre-snapping breaks left-edge alignment.
                n.x = left + getNodeWidth(n, opts) / 2;
                n.y = pos.row * rowPitch + (orphanOffsets[ci] || 0);
            });
        }

        // Safety net: resolve any residual node-on-node overlap that the
        // directional pushes above couldn't reach. Must run before the
        // final comment pass so comments re-align to targets at their
        // final Y. Passing `compOf` makes it component-rigid: an untouched
        // flow can only be translated as a whole here, never sheared.
        resolveOverlaps(canvasNodes, opts, compOf);

        // Carry existing comments along with their (possibly moved)
        // anchor target. Runs before the new-comment pass so that pass
        // can stack new comments above the re-aligned existing ones.
        applyCommentAnchors(canvasNodes, commentAnchors, opts);

        // Place new schema comments above their resolved target. Runs
        // here, after every canvas target (including orphan-band ones)
        // has its final coordinates, so the comment lands on the right
        // spot in one go.
        repositionCommentsByLlmOrder(canvasNodes, opts, function(c) {
            return !existingIdMap[c.id];
        });

        // Top-edge guard: a new caption stacked above a target near the
        // canvas top must slide the whole flow down, not sit at y <= 0.
        ensureTopMargin(canvasNodes, opts);

        return nodes;
    }

    // ------------------------------------------------------------------ //
    //  Group boxes                                                        //
    // ------------------------------------------------------------------ //

    // A group's box is STORED on the group (x / y / w / h) and the editor only
    // recomputes it when the user drags a member, so whoever moves the members
    // owns the box. See docs/{en,jp}/layout.md — Group boxes.

    // Edges of one member: a node is centred on x / y, a nested group's x / y
    // is its top-left corner. Null when it has no usable position.
    function memberEdges(member, opts, nodeHeight) {
        if (!member || typeof member.x !== 'number' || typeof member.y !== 'number') return null;
        if (member.type === 'group') {
            let w = (typeof member.w === 'number' && member.w > 0) ? member.w : 0;
            let h = (typeof member.h === 'number' && member.h > 0) ? member.h : 0;
            if (w === 0 || h === 0) return null;   // not fitted yet
            return { minX: member.x, minY: member.y, maxX: member.x + w, maxY: member.y + h };
        }
        let w = getNodeWidth(member, opts);
        let h = (typeof member.h === 'number' && member.h > 0) ? member.h : nodeHeight;
        return {
            minX: member.x - w / 2, minY: member.y - h / 2,
            maxX: member.x + w / 2, maxY: member.y + h / 2
        };
    }

    function membersBBox(group, byId, opts, nodeHeight) {
        let ids = Array.isArray(group.nodes) ? group.nodes : [];
        let box = null;
        ids.forEach(function(id) {
            let edges = memberEdges(byId[id], opts, nodeHeight);
            if (!edges) return;
            if (!box) { box = edges; return; }
            box.minX = Math.min(box.minX, edges.minX);
            box.minY = Math.min(box.minY, edges.minY);
            box.maxX = Math.max(box.maxX, edges.maxX);
            box.maxY = Math.max(box.maxY, edges.maxY);
        });
        return box;
    }

    // How deep a group sits inside other groups, so the inner boxes are fitted
    // before the outer one that has to contain them.
    function groupDepth(group, byId) {
        let depth = 0;
        let parent = byId[group.g];
        while (parent && parent.type === 'group' && depth < 32) {
            depth++;
            parent = byId[parent.g];
        }
        return depth;
    }

    // Refit every group box that no longer holds its members — a new group has
    // no box at all, and a layout pass moves members out of the box they had.
    // A box the user made LARGER than it needs to be is left alone: it still
    // contains everything, and its size is their decision.
    function fitGroups(nodes, options) {
        let opts = options || {};
        let pad = pickOption(opts, 'groupPadding', LAYOUT_DEFAULTS.groupPadding);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);
        // Boxes whose members THIS edit moved: refitted even when the old box
        // still contains them. "Larger than it needs to be" is the user's
        // decision only until the layout rearranges what is inside it — after
        // a reposition the stale box is what leaves the boxes out of line.
        let refit = {};
        (Array.isArray(opts.refitIds) ? opts.refitIds : []).forEach(function(id) {
            if (id) refit[id] = true;
        });

        let byId = {};
        let groups = [];
        (nodes || []).forEach(function(n) {
            if (!n || !n.id) return;
            byId[n.id] = n;
            if (n.type === 'group') groups.push(n);
        });
        if (groups.length === 0) return nodes;

        groups.sort(function(a, b) { return groupDepth(b, byId) - groupDepth(a, byId); });
        groups.forEach(function(g) {
            let box = membersBBox(g, byId, opts, nodeHeight);
            if (!box) return;
            let fitted = typeof g.x === 'number' && typeof g.y === 'number' &&
                         typeof g.w === 'number' && g.w > 0 &&
                         typeof g.h === 'number' && g.h > 0;
            if (!refit[g.id] && fitted &&
                g.x <= box.minX && g.y <= box.minY &&
                g.x + g.w >= box.maxX && g.y + g.h >= box.maxY) return;
            g.x = box.minX - pad;
            g.y = box.minY - pad;
            g.w = (box.maxX - box.minX) + pad * 2;
            g.h = (box.maxY - box.minY) + pad * 2;
        });
        return nodes;
    }

    // A box is drawn `groupPadding` outside its members, so the clearance the
    // node layout left between two sequences is that clearance MINUS both
    // paddings — and a caption that joined a group grows its box further into
    // it. Stacked sequences that read as separate therefore come out with
    // boxes that touch, or overlap outright.
    //
    // This pass is the guard: whatever moved the members, no box ends up
    // closer than `groupGap` to anything outside it. Blocks move whole —
    // members, boxes, captions and everything wired to them — so separating
    // two sequences cannot shear either one. See docs/{en,jp}/layout.md.
    function separateGroups(nodes, options) {
        let opts = options || {};
        let gap        = pickOption(opts, 'groupGap',   LAYOUT_DEFAULTS.groupGap);
        let leftMargin = pickOption(opts, 'leftMargin', LAYOUT_DEFAULTS.leftMargin);
        let nodeHeight = pickOption(opts, 'nodeHeight', LAYOUT_DEFAULTS.nodeHeight);

        let all = (nodes || []).filter(function(n) {
            return n && n.id && typeof n.x === 'number' && typeof n.y === 'number';
        });
        let groups = all.filter(function(n) { return n.type === 'group'; });
        if (groups.length === 0) return nodes;

        let byId = {};
        all.forEach(function(n) { byId[n.id] = n; });

        // --- Blocks: what has to move together ---
        let parent = {};
        function find(id) {
            while (parent[id] !== undefined && parent[id] !== id) id = parent[id];
            return id;
        }
        function union(a, b) {
            if (parent[a] === undefined) parent[a] = a;
            if (parent[b] === undefined) parent[b] = b;
            let ra = find(a), rb = find(b);
            if (ra !== rb) parent[ra] = rb;
        }
        all.forEach(function(n) { parent[n.id] = n.id; });
        all.forEach(function(n) {
            if (Array.isArray(n.wires)) {
                n.wires.forEach(function(port) {
                    if (!Array.isArray(port)) return;
                    port.forEach(function(toId) { if (byId[toId]) union(n.id, toId); });
                });
            }
            // Both halves of group membership, so a member listed on only one
            // side still travels with its box.
            if (n.g && byId[n.g]) union(n.id, n.g);
            if (n.type === 'group' && Array.isArray(n.nodes)) {
                n.nodes.forEach(function(id) { if (byId[id]) union(n.id, id); });
            }
        });
        // A caption is tied to the node it heads, which is the only thing
        // saying where it belongs when it is not a group member.
        let anchors = captureCommentAnchors(all, opts);
        Object.keys(anchors).forEach(function(id) {
            if (byId[id] && byId[anchors[id].targetId]) union(id, anchors[id].targetId);
        });

        let blocks = {};
        all.forEach(function(n) {
            let root = find(n.id);
            let b = blocks[root] || (blocks[root] = {
                nodes: [], hasGroup: false, boxLeft: Infinity,
                top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity
            });
            b.nodes.push(n);
            let top, bottom, left, right;
            if (n.type === 'group') {
                b.hasGroup = true;
                top = n.y; bottom = n.y + (n.h || 0);
                left = n.x; right = n.x + (n.w || 0);
                if (left < b.boxLeft) b.boxLeft = left;
            } else {
                let w = getNodeWidth(n, opts);
                top = n.y - nodeHeight / 2; bottom = n.y + nodeHeight / 2;
                left = n.x - w / 2; right = n.x + w / 2;
            }
            if (top < b.top) b.top = top;
            if (bottom > b.bottom) b.bottom = bottom;
            if (left < b.left) b.left = left;
            if (right > b.right) b.right = right;
        });

        // --- Push down whatever a box does not clear ---
        // Top-down: each block is separated from the ones already placed
        // above it, so one pass settles the stack.
        let ordered = Object.keys(blocks).map(function(k) { return blocks[k]; })
            .sort(function(a, b) { return (a.top - b.top) || (a.left - b.left); });

        // --- Line the boxes up ---
        // Stacked sequences read as a column, so their boxes share a left
        // edge rather than stepping in and out by whatever their first node
        // happens to be. A box moves with everything it contains, PER BOX —
        // aligning whole blocks would leave two boxes wired to each other
        // stepped, which is the case a reposition produces most often.
        //
        // A box is not aligned when something outside every box sits to its
        // left in the same block: a box drawn around the middle of a chain
        // has the nodes feeding it over there, and dragging those sideways is
        // not an alignment. Boxes themselves never block each other.
        (function alignBoxes() {
            let blockOf = {};
            ordered.forEach(function(b, i) {
                b.nodes.forEach(function(n) { blockOf[n.id] = i; });
            });
            let looseLeft = {};       // block -> leftmost thing in no box at all
            all.forEach(function(n) {
                if (n.type === 'group' || n.g) return;
                let bi = blockOf[n.id];
                if (bi === undefined) return;
                let left = n.x - getNodeWidth(n, opts) / 2;
                if (looseLeft[bi] === undefined || left < looseLeft[bi]) looseLeft[bi] = left;
            });

            // Everything a box takes with it: its members, their members in
            // turn, and the captions that head them.
            let captionOf = {};
            Object.keys(anchors).forEach(function(id) {
                let t = anchors[id].targetId;
                if (byId[id]) (captionOf[t] = captionOf[t] || []).push(byId[id]);
            });
            function unitOf(group) {
                let seen = {};
                let unit = [];
                (function walk(g) {
                    if (!g || seen[g.id]) return;
                    seen[g.id] = true;
                    unit.push(g);
                    (Array.isArray(g.nodes) ? g.nodes : []).forEach(function(id) {
                        let m = byId[id];
                        if (!m || seen[m.id]) return;
                        if (m.type === 'group') { walk(m); return; }
                        seen[m.id] = true;
                        unit.push(m);
                        (captionOf[m.id] || []).forEach(function(c) {
                            if (seen[c.id]) return;
                            seen[c.id] = true;
                            unit.push(c);
                        });
                    });
                })(group);
                return unit;
            }

            let movable = groups.filter(function(g) {
                if (g.g) return false;                       // a nested box follows its parent
                let bi = blockOf[g.id];
                if (bi === undefined) return false;
                let loose = looseLeft[bi];
                return loose === undefined || g.x <= loose + 0.5;
            });
            if (movable.length < 2) return;

            // Never towards the edge of the canvas: the leftmost box sets the
            // column, but a box already hanging off it would otherwise drag
            // every other sequence out there with it.
            let target = movable.reduce(function(min, g) { return Math.min(min, g.x); }, Infinity);
            if (target < leftMargin) target = leftMargin;
            movable.forEach(function(g) {
                let dx = target - g.x;
                if (!dx) return;
                unitOf(g).forEach(function(n) { n.x = n.x + dx; });
            });

            // The blocks' own bounds moved with them.
            ordered.forEach(function(b) {
                b.left = Infinity; b.right = -Infinity; b.boxLeft = Infinity;
                b.nodes.forEach(function(n) {
                    let left, right;
                    if (n.type === 'group') {
                        left = n.x; right = n.x + (n.w || 0);
                        if (left < b.boxLeft) b.boxLeft = left;
                    } else {
                        let w = getNodeWidth(n, opts);
                        left = n.x - w / 2; right = n.x + w / 2;
                    }
                    if (left < b.left) b.left = left;
                    if (right > b.right) b.right = right;
                });
            });
        })();

        for (let j = 1; j < ordered.length; j++) {
            let cur = ordered[j];
            let delta = 0;
            for (let i = 0; i < j; i++) {
                let above = ordered[i];
                // Only a box needs this clearance; two plain flows are the
                // node layout's business, and it already spaced them.
                if (!above.hasGroup && !cur.hasGroup) continue;
                if (above.right <= cur.left || cur.right <= above.left) continue;
                let needed = (above.bottom + gap) - (cur.top + delta);
                if (needed > 0) delta += needed;
            }
            if (delta <= 0) continue;
            cur.nodes.forEach(function(n) { n.y = n.y + delta; });
            cur.top += delta;
            cur.bottom += delta;
        }
        return nodes;
    }

    // The left-edge twin of `ensureTopMargin`, and it covers BOXES as well as
    // nodes: a group's box is drawn `groupPadding` outside its members, so a
    // flow that starts at the canvas edge has a box hanging off it. Everything
    // slides right by one shared delta, so relative geometry is untouched.
    function ensureLeftMargin(nodes, options) {
        let opts = options || {};
        let leftMargin = pickOption(opts, 'leftMargin', LAYOUT_DEFAULTS.leftMargin);

        let positioned = (nodes || []).filter(function(n) {
            return n && typeof n.x === 'number';
        });
        let minLeft = Infinity;
        positioned.forEach(function(n) {
            let left = (n.type === 'group') ? n.x : n.x - getNodeWidth(n, opts) / 2;
            if (left < minLeft) minLeft = left;
        });
        if (!isFinite(minLeft) || minLeft >= leftMargin) return nodes;

        let dx = leftMargin - minLeft;
        positioned.forEach(function(n) { n.x = n.x + dx; });
        return nodes;
    }

    return {
        LAYOUT_DEFAULTS:              LAYOUT_DEFAULTS,
        estimateNodeWidth:            estimateNodeWidth,
        getNodeWidth:                 getNodeWidth,
        layoutNodes:                  layoutNodes,
        computeComponentYOffsets:     computeComponentYOffsets,
        computeLeftEdges:             computeLeftEdges,
        reflowCanvasNodes:            reflowCanvasNodes,
        placeAddedNodesNearNeighbors: placeAddedNodesNearNeighbors,
        captureCommentAnchors:        captureCommentAnchors,
        applyCommentAnchors:          applyCommentAnchors,
        fitGroups:                    fitGroups,
        separateGroups:               separateGroups,
        keepLeftEdges:                keepLeftEdges,
        ensureLeftMargin:             ensureLeftMargin
    };
});
