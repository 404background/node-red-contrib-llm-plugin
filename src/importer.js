// Importer: parses LLM assistant messages and imports Node-RED flows.
// Supports both raw Node-RED JSON arrays and Vibe Schema (intermediate JSON).
//
// JSON parsing, token normalization, schema extraction, and flow lookup are
// implemented in src/core/llm_json_parser.js and accessed via LLMPlugin.LLMJsonParser.
(function(){
    var Importer = {};
    var LAST_SANITIZED = null;

    // ================================================================== //
    //  Module References                                                  //
    // ================================================================== //

    function getConfigurator() {
        return (window.LLMPlugin && window.LLMPlugin.Configurator) || null;
    }

    function getParser() {
        return (window.LLMPlugin && window.LLMPlugin.LLMJsonParser) || null;
    }

    // ================================================================== //
    //  Basic Utilities                                                    //
    // ================================================================== //

    function genId() { return 'id_' + Math.random().toString(36).substr(2,9); }

    function safeLog() {
        try {
            if (window && window.console && window.console.log)
                window.console.log.apply(window.console, arguments);
        } catch(e) {}
    }

    function postTerminalLog(level, event, message, meta) {
        try {
            if (typeof fetch !== 'function') return;
            fetch('llm-plugin/client-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    level: level || 'info',
                    event: event || 'importer',
                    message: String(message || ''),
                    meta: (meta && typeof meta === 'object') ? meta : {}
                })
            }).catch(function() {});
        } catch (e) {}
    }

    // ------------------------------------------------------------------ //
    //  Forwarders to LLMJsonParser (implementations in src/core)         //
    // ------------------------------------------------------------------ //

    function normalizeToken(v) {
        var p = getParser(); return p ? p.normalizeToken(v) : '';
    }
    function normalizeTokenLoose(v) {
        var p = getParser(); return p ? p.normalizeTokenLoose(v) : '';
    }
    function putUniqueToken(mapObj, token, id) {
        var p = getParser(); if (p) p.putUniqueToken(mapObj, token, id);
    }
    function resolveUniqueApprox(mapObj, token, minLen) {
        var p = getParser(); return p ? p.resolveUniqueApprox(mapObj, token, minLen) : null;
    }
    function buildFlowLookup(flowNodes, cfg) {
        var p = getParser();
        return p ? p.buildFlowLookup(flowNodes, cfg)
                 : { aliasToId: {}, idToAlias: {}, nameToId: {}, byId: {}, inter: null, resolve: function() { return null; } };
    }
    function extractLastVibeSchema(messageContent) {
        var p = getParser(); var cfg = getConfigurator();
        return (p && cfg) ? p.extractVibeSchema(messageContent, cfg) : null;
    }
    function extractConnectionHints(messageContent) {
        var p = getParser(); var cfg = getConfigurator();
        return (p && cfg) ? p.extractConnectionHints(messageContent, cfg) : [];
    }
    function extractFlowDirectives(messageContent) {
        var p = getParser(); var cfg = getConfigurator();
        return (p && cfg) ? p.extractFlowDirectives(messageContent, cfg) : { removeTokens: [], removeConnections: [] };
    }
    function extractFlowNodes(messageContent, options) {
        var p = getParser(); var cfg = getConfigurator();
        return (p && cfg) ? p.extractFlowNodes(messageContent, options, cfg) : null;
    }

    // ================================================================== //
    //  Apply Mode                                                         //
    // ================================================================== //

    function normalizeApplyMode(v) {
        var m = String(v || '').trim().toLowerCase();
        if (m === 'editonly') m = 'edit-only';
        if (m === 'deleteonly') m = 'delete-only';
        if (m === 'add-edit' || m === 'add_edit') m = 'merge';
        if (m === 'replace' || m === 'full-replace' || m === 'full_replace') m = 'overwrite';
        return (m === 'auto' || m === 'edit-only' || m === 'merge' || m === 'overwrite' || m === 'delete-only') ? m : null;
    }

    function extractApplyModeFromMessage(messageContent) {
        var parsed = extractLastVibeSchema(messageContent);
        if (parsed && typeof parsed === 'object') {
            var fromSchema = normalizeApplyMode(parsed.applyMode || parsed.mode || parsed.strategy);
            if (fromSchema) return fromSchema;
        }
        var text = String(messageContent || '');
        var marker = text.match(/APPLY[_\s-]*MODE\s*[:=]\s*(edit-only|merge|overwrite|delete-only|auto)/i);
        if (marker && marker[1]) {
            var fromMarker = normalizeApplyMode(marker[1]);
            if (fromMarker) return fromMarker;
        }
        return null;
    }

    // ================================================================== //
    //  Apply Connection Hints                                             //
    // ================================================================== //

    function applyConnectionHints(flowNodes, hints) {
        if (!Array.isArray(flowNodes) || !Array.isArray(hints) || hints.length === 0) return flowNodes;

        var cfg = getConfigurator();
        var lookup = buildFlowLookup(flowNodes, cfg);

        var desiredByFromPort = {};
        hints.forEach(function(h) {
            var fromId = lookup.resolve(h.from);
            var toId = lookup.resolve(h.to);
            if (!fromId || !toId || !lookup.byId[fromId] || !lookup.byId[toId]) return;
            var port = (typeof h.fromPort === 'number' && h.fromPort >= 0) ? h.fromPort : 0;
            var key = fromId + '::' + port;
            if (!desiredByFromPort[key]) desiredByFromPort[key] = [];
            if (desiredByFromPort[key].indexOf(toId) === -1) desiredByFromPort[key].push(toId);
        });

        Object.keys(desiredByFromPort).forEach(function(key) {
            var sep = key.lastIndexOf('::');
            var fromId = key.substring(0, sep);
            var port = parseInt(key.substring(sep + 2), 10);
            var fromNode = lookup.byId[fromId];
            if (!fromNode) return;
            if (!Array.isArray(fromNode.wires)) fromNode.wires = [];
            while (fromNode.wires.length <= port) fromNode.wires.push([]);
            // Merge: keep existing connections and add new ones (deduplicated)
            var existing = fromNode.wires[port];
            var seen = {};
            var merged = [];
            existing.concat(desiredByFromPort[key]).forEach(function(tid) {
                var id = String(tid || '').trim();
                if (!id || seen[id]) return;
                seen[id] = true;
                merged.push(id);
            });
            fromNode.wires[port] = merged;
        });

        return flowNodes;
    }

    // ================================================================== //
    //  Canvas Utilities                                                   //
    // ================================================================== //

    function getActiveWorkspaceId() {
        var currentWorkspace = null;
        try {
            if (RED && RED.workspaces && typeof RED.workspaces.active === 'function') {
                currentWorkspace = RED.workspaces.active();
            }
        } catch(e) { /* ignore */ }
        if (currentWorkspace && typeof currentWorkspace === 'object' && currentWorkspace.id) {
            currentWorkspace = currentWorkspace.id;
        }
        return (currentWorkspace && typeof currentWorkspace === 'string') ? currentWorkspace : null;
    }

    function saveCheckpoint(chatId, label, flow, meta) {
        if (!Array.isArray(flow)) flow = [];
        return fetch('llm-plugin/checkpoint/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: chatId || null,
                label: label || 'checkpoint',
                flow: flow,
                meta: meta || {}
            })
        })
        .then(function(res) { return res.ok ? res.json() : null; })
        .then(function(data) { return data && data.checkpointId ? data.checkpointId : null; })
        .catch(function() { return null; });
    }

    function isCanvasNode(node) {
        if (!node || typeof node !== 'object') return false;
        if (typeof node.type !== 'string' || !node.type.trim()) return false;
        if (node.type === 'tab' || String(node.type).indexOf('subflow:') === 0) return false;
        return (
            (typeof node.z === 'string' && node.z.length > 0) ||
            typeof node.x === 'number' ||
            typeof node.y === 'number' ||
            Array.isArray(node.wires) ||
            (typeof node.g === 'string' && node.g.length > 0)
        );
    }

    // ================================================================== //
    //  Rebuild Workspace Flow                                             //
    // ================================================================== //

    function rebuildWorkspaceFromSnapshot(beforeFlow, updateNodes, workspaceId, connectionHints, flowDirectives, applyMode) {
        var base = Array.isArray(beforeFlow)
            ? JSON.parse(JSON.stringify(beforeFlow))
            : [];
        var updates = Array.isArray(updateNodes)
            ? JSON.parse(JSON.stringify(updateNodes))
            : [];

        // Capture original positions before any mutations so we can restore them later
        var basePositions = {};
        base.forEach(function(n) {
            if (n && n.id && typeof n.x === 'number' && typeof n.y === 'number') {
                basePositions[n.id] = { x: n.x, y: n.y };
            }
        });
        var directives = flowDirectives || { removeTokens: [], removeConnections: [] };
        var mode = normalizeApplyMode(applyMode) || 'edit-only';

        if (mode === 'overwrite') base = [];
        if (mode === 'delete-only') { updates = []; connectionHints = []; }

        function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

        function hasAnyOutgoing(wires) {
            if (!Array.isArray(wires)) return false;
            for (var i = 0; i < wires.length; i++) {
                if (Array.isArray(wires[i]) && wires[i].length > 0) return true;
            }
            return false;
        }

        var hintedSourceKeys = {};
        (connectionHints || []).forEach(function(h) {
            if (!h || typeof h.from !== 'string') return;
            var k = normalizeToken(h.from);
            if (k) hintedSourceKeys[k] = true;
        });

        function isHintedSource(node) {
            if (!node) return false;
            var keys = [normalizeToken(node.id), normalizeToken(node.name), normalizeToken(node._llmAlias)];
            for (var i = 0; i < keys.length; i++) {
                if (keys[i] && hintedSourceKeys[keys[i]]) return true;
            }
            return false;
        }

        // Delete nodes by token using shared lookup
        function removeNodesByTokens(nodes, removeTokens) {
            if (!Array.isArray(removeTokens) || removeTokens.length === 0) return nodes;
            var cfg = getConfigurator();
            var lookup = buildFlowLookup(nodes, cfg);
            var removeIdSet = {};

            removeTokens.forEach(function(tok) {
                var t = String(tok || '').trim();
                if (!t) return;
                var id = lookup.resolve(t, { minLen: 8 });
                if (id) removeIdSet[id] = true;
                // Also try direct ID match
                nodes.forEach(function(n) {
                    if (n && n.id === t) removeIdSet[n.id] = true;
                });
            });

            if (Object.keys(removeIdSet).length === 0) return nodes;

            nodes = nodes.filter(function(n) {
                return !!(n && n.id) && !removeIdSet[n.id];
            });
            nodes.forEach(function(n) {
                if (!Array.isArray(n.wires)) return;
                n.wires = n.wires.map(function(port) {
                    if (!Array.isArray(port)) return [];
                    return port.filter(function(tid) { return !removeIdSet[tid]; });
                });
            });
            return nodes;
        }

        // --- Deletion-first pass ---
        base = removeNodesByTokens(base, directives.removeTokens);

        var baseIds = {};
        base.forEach(function(n) { if (n && n.id) baseIds[n.id] = true; });

        var byId = {};
        base.forEach(function(n) { if (n && n.id) byId[n.id] = n; });

        updates.forEach(function(n) {
            if (!n || !n.id) return;
            var existing = byId[n.id];
            if (existing && !isHintedSource(n) && !hasAnyOutgoing(n.wires) && hasAnyOutgoing(existing.wires)) {
                n.wires = deepClone(existing.wires);
            }
            byId[n.id] = n;
        });

        var rebuilt = Object.keys(byId).map(function(id) { return byId[id]; });

        // Second pass deletion (catches nodes added by updates that should also be removed)
        rebuilt = removeNodesByTokens(rebuilt, directives.removeTokens);

        // Remove specific connections
        if (Array.isArray(directives.removeConnections) && directives.removeConnections.length > 0) {
            var cfg2 = getConfigurator();
            var rcLookup = buildFlowLookup(rebuilt, cfg2);

            directives.removeConnections.forEach(function(rc) {
                var fromId = rcLookup.resolve(rc.from);
                var toId = rcLookup.resolve(rc.to);
                if (!fromId || !toId || !rcLookup.byId[fromId]) return;
                var port = (typeof rc.fromPort === 'number' && rc.fromPort >= 0) ? rc.fromPort : 0;
                var fromNode = rcLookup.byId[fromId];
                if (!Array.isArray(fromNode.wires) || !Array.isArray(fromNode.wires[port])) return;
                fromNode.wires[port] = fromNode.wires[port].filter(function(tid) { return tid !== toId; });
            });
        }

        if (workspaceId && typeof workspaceId === 'string') {
            rebuilt.forEach(function(n) {
                if (isCanvasNode(n)) n.z = workspaceId;
            });
        }

        // Prune wires pointing to removed nodes
        var validIds = {};
        rebuilt.forEach(function(n) { if (n && n.id) validIds[n.id] = true; });
        rebuilt.forEach(function(n) {
            if (!n || !Array.isArray(n.wires)) return;
            n.wires = n.wires.map(function(port) {
                if (!Array.isArray(port)) return [];
                return port.filter(function(tid) { return !!validIds[tid]; });
            });
        });

        applyConnectionHints(rebuilt, connectionHints || []);

        rebuilt.forEach(function(n) {
            if (!n) return;
            delete n._llmPreservePosition;
            delete n._llmAlias;
        });

        if (mode === 'overwrite' || Object.keys(baseIds).length === 0) {
            // No existing nodes to preserve — full re-layout
            reflowCanvasNodes(rebuilt, {
                startX: 200, startY: 200, spacingX: 200, spacingY: 80, maxColumns: 5
            });
        } else {
            // Preserve existing positions; only place new nodes near their neighbors
            placeAddedNodesNearNeighbors(rebuilt, baseIds, basePositions, {
                spacingX: 200, spacingY: 80, bandGap: 140
            });
        }

        return rebuilt;
    }

    // ================================================================== //
    //  Canvas Layout                                                      //
    // ================================================================== //

    function reflowCanvasNodes(nodes, opts) {
        var options = opts || {};
        var startX = (typeof options.startX === 'number') ? options.startX : 60;
        var startY = (typeof options.startY === 'number') ? options.startY : 60;
        var spacingX = (typeof options.spacingX === 'number') ? options.spacingX : 200;
        var spacingY = (typeof options.spacingY === 'number') ? options.spacingY : 80;
        var maxColumns = (typeof options.maxColumns === 'number' && options.maxColumns >= 2)
            ? Math.floor(options.maxColumns) : 5;
        var canvasNodes = (nodes || []).filter(function(n) { return isCanvasNode(n); });
        if (canvasNodes.length < 2) return nodes;

        var byId = {};
        canvasNodes.forEach(function(n) { if (n && n.id) byId[n.id] = n; });

        var outgoing = {};
        var incomingCount = {};
        Object.keys(byId).forEach(function(id) { outgoing[id] = []; incomingCount[id] = 0; });

        Object.keys(byId).forEach(function(id) {
            var n = byId[id];
            if (!Array.isArray(n.wires)) return;
            n.wires.forEach(function(port) {
                if (!Array.isArray(port)) return;
                port.forEach(function(toId) {
                    if (!byId[toId]) return;
                    outgoing[id].push(toId);
                    incomingCount[toId] += 1;
                });
            });
        });

        function sortByOriginalPos(aId, bId) {
            var a = byId[aId] || {};
            var b = byId[bId] || {};
            var ax = (typeof a.x === 'number') ? a.x : 0;
            var bx = (typeof b.x === 'number') ? b.x : 0;
            if (ax !== bx) return ax - bx;
            var ay = (typeof a.y === 'number') ? a.y : 0;
            var by = (typeof b.y === 'number') ? b.y : 0;
            if (ay !== by) return ay - by;
            return String(aId).localeCompare(String(bId));
        }

        var queue = Object.keys(incomingCount)
            .filter(function(id) { return incomingCount[id] === 0; })
            .sort(sortByOriginalPos);

        var layerById = {};
        var visitedCount = 0;
        while (queue.length > 0) {
            var current = queue.shift();
            visitedCount += 1;
            if (typeof layerById[current] !== 'number') layerById[current] = 0;
            (outgoing[current] || []).forEach(function(nextId) {
                var nextLayer = layerById[current] + 1;
                if (typeof layerById[nextId] !== 'number' || layerById[nextId] < nextLayer) {
                    layerById[nextId] = nextLayer;
                }
                incomingCount[nextId] -= 1;
                if (incomingCount[nextId] === 0) queue.push(nextId);
            });
            queue.sort(sortByOriginalPos);
        }

        if (visitedCount < canvasNodes.length) {
            var unresolved = Object.keys(byId).filter(function(id) {
                return typeof layerById[id] !== 'number';
            }).sort(sortByOriginalPos);
            unresolved.forEach(function(id, idx) { layerById[id] = idx; });
        }

        var layers = {};
        Object.keys(layerById).forEach(function(id) {
            var l = layerById[id];
            if (!layers[l]) layers[l] = [];
            layers[l].push(id);
        });

        var rowById = {};
        var rowInLayerById = {};
        var layerRowCount = {};
        var layerKeys = Object.keys(layers)
            .map(function(v) { return parseInt(v, 10); })
            .sort(function(a, b) { return a - b; });

        layerKeys.forEach(function(layer) {
            var ids = layers[layer].slice();
            if (layer === layerKeys[0]) {
                ids.sort(sortByOriginalPos);
            } else {
                ids.sort(function(aId, bId) {
                    function avgParentRow(nodeId) {
                        var parentRows = [];
                        Object.keys(outgoing).forEach(function(fromId) {
                            if ((outgoing[fromId] || []).indexOf(nodeId) >= 0 && typeof rowById[fromId] === 'number') {
                                parentRows.push(rowById[fromId]);
                            }
                        });
                        if (parentRows.length === 0) return Number.POSITIVE_INFINITY;
                        var sum = 0;
                        parentRows.forEach(function(r) { sum += r; });
                        return sum / parentRows.length;
                    }
                    var aAvg = avgParentRow(aId);
                    var bAvg = avgParentRow(bId);
                    if (aAvg !== bAvg) return aAvg - bAvg;
                    return sortByOriginalPos(aId, bId);
                });
            }
            ids.forEach(function(id, rowIdx) {
                rowById[id] = rowIdx;
                rowInLayerById[id] = rowIdx;
            });
            layerRowCount[layer] = ids.length;
        });

        var foldBandMaxRows = {};
        layerKeys.forEach(function(layer) {
            var fold = Math.floor(layer / maxColumns);
            var rows = layerRowCount[layer] || 0;
            if (!foldBandMaxRows[fold] || foldBandMaxRows[fold] < rows) {
                foldBandMaxRows[fold] = rows;
            }
        });

        var foldBandRowOffset = {};
        var maxFold = layerKeys.length > 0
            ? Math.floor(layerKeys[layerKeys.length - 1] / maxColumns) : 0;
        var runningOffset = 0;
        for (var f = 0; f <= maxFold; f++) {
            foldBandRowOffset[f] = runningOffset;
            var bandRows = foldBandMaxRows[f] || 0;
            runningOffset += bandRows + 1;
        }

        Object.keys(layerById).forEach(function(id) {
            var layer = layerById[id];
            var fold = Math.floor(layer / maxColumns);
            var colInFold = layer % maxColumns;
            var localRow = rowInLayerById[id] || 0;
            var globalRow = (foldBandRowOffset[fold] || 0) + localRow;
            var node = byId[id];
            if (!node) return;
            node.x = Math.round(startX + (colInFold * spacingX));
            node.y = Math.round(startY + (globalRow * spacingY));
        });

        return nodes;
    }

    /**
     * Conservative layout: restore existing node positions from basePositions,
     * then place only new nodes near their connected neighbors.
     *
     * Placement rules for new nodes:
     *  - Has both predecessor(s) and successor(s) among positioned nodes → midpoint
     *  - Has only predecessor(s) → to the right of the furthest predecessor
     *  - Has only successor(s)   → to the left of the nearest successor
     *  - No positioned neighbors → below all existing nodes (orphan fallback)
     *
     * Multi-node chains (new nodes connected only to other new nodes) are resolved
     * by iterating until all reachable nodes are placed.
     */
    function placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, opts) {
        var options = opts || {};
        var spacingX = (typeof options.spacingX === 'number') ? options.spacingX : 200;
        var spacingY = (typeof options.spacingY === 'number') ? options.spacingY : 80;
        var bandGap = (typeof options.bandGap === 'number') ? options.bandGap : 140;

        var canvasNodes = (nodes || []).filter(function(n) { return isCanvasNode(n); });
        if (canvasNodes.length < 1) return nodes;

        var byId = {};
        canvasNodes.forEach(function(n) { byId[n.id] = n; });

        // Step 1: Restore original positions for all existing nodes
        canvasNodes.forEach(function(n) {
            if (existingIdMap[n.id] && basePositions[n.id]) {
                n.x = basePositions[n.id].x;
                n.y = basePositions[n.id].y;
            }
        });

        // Step 2: Build wire adjacency
        var outgoing = {};
        var incoming = {};
        canvasNodes.forEach(function(n) { outgoing[n.id] = []; incoming[n.id] = []; });
        canvasNodes.forEach(function(n) {
            (n.wires || []).forEach(function(port) {
                (port || []).forEach(function(toId) {
                    if (byId[toId]) {
                        outgoing[n.id].push(toId);
                        incoming[toId].push(n.id);
                    }
                });
            });
        });

        // Step 3: Iteratively place new nodes using any already-positioned neighbor
        var positioned = {};
        canvasNodes.forEach(function(n) {
            if (existingIdMap[n.id]) positioned[n.id] = true;
        });

        function tryPlace(n) {
            var preds = incoming[n.id].filter(function(id) { return positioned[id]; });
            var succs = outgoing[n.id].filter(function(id) { return positioned[id]; });
            if (preds.length === 0 && succs.length === 0) return false;

            if (preds.length > 0 && succs.length > 0) {
                var refs = preds.concat(succs);
                n.x = Math.round(refs.reduce(function(s, id) { return s + (byId[id].x || 0); }, 0) / refs.length);
                n.y = Math.round(refs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / refs.length);
            } else if (preds.length > 0) {
                var maxPredX = Math.max.apply(null, preds.map(function(id) { return byId[id].x || 0; }));
                var avgPredY = preds.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / preds.length;
                n.x = Math.round(maxPredX + spacingX);
                n.y = Math.round(avgPredY);
            } else {
                var minSuccX = Math.min.apply(null, succs.map(function(id) { return byId[id].x || 0; }));
                var avgSuccY = succs.reduce(function(s, id) { return s + (byId[id].y || 0); }, 0) / succs.length;
                n.x = Math.round(minSuccX - spacingX);
                n.y = Math.round(avgSuccY);
            }
            positioned[n.id] = true;
            return true;
        }

        var remaining = canvasNodes.filter(function(n) { return !existingIdMap[n.id]; });
        var progress = true;
        while (progress && remaining.length > 0) {
            progress = false;
            var next = [];
            remaining.forEach(function(n) {
                if (tryPlace(n)) { progress = true; } else { next.push(n); }
            });
            remaining = next;
        }

        // Step 3.5: Resolve overlapping positions among all canvas nodes
        //   Check newly placed nodes against ALL positioned nodes (existing + new).
        var allPositioned = canvasNodes.filter(function(n) { return positioned[n.id]; });
        var newlyPlaced = canvasNodes.filter(function(n) {
            return !existingIdMap[n.id] && positioned[n.id];
        });
        if (newlyPlaced.length > 0) {
            newlyPlaced.sort(function(a, b) {
                var dx = (a.x || 0) - (b.x || 0);
                return dx !== 0 ? dx : ((a.y || 0) - (b.y || 0));
            });
            var changed = true;
            var maxPasses = newlyPlaced.length * 2;
            while (changed && maxPasses-- > 0) {
                changed = false;
                for (var ni = 0; ni < newlyPlaced.length; ni++) {
                    var cur = newlyPlaced[ni];
                    for (var oi = 0; oi < allPositioned.length; oi++) {
                        var other = allPositioned[oi];
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

        // Step 4: Orphan new nodes — no path to any existing node — place below
        if (remaining.length > 0) {
            var maxY = Number.NEGATIVE_INFINITY;
            var minX = Number.POSITIVE_INFINITY;
            canvasNodes.forEach(function(n) {
                if (!existingIdMap[n.id]) return;
                if ((n.y || 0) > maxY) maxY = n.y;
                if ((n.x || 0) < minX) minX = n.x;
            });
            if (!isFinite(maxY)) maxY = 200;
            if (!isFinite(minX)) minX = 200;
            var startY = maxY + bandGap;
            remaining.forEach(function(n, idx) {
                n.x = Math.round(minX + (idx % 5) * spacingX);
                n.y = Math.round(startY + Math.floor(idx / 5) * spacingY);
            });
        }

        return nodes;
    }

    // ================================================================== //
    //  Replace Workspace Flow                                             //
    // ================================================================== //

    function replaceWorkspaceFlow(nodes) {
        var workspaceId = getActiveWorkspaceId();
        if (!workspaceId) return { ok: false, error: 'Active workspace not found' };

        function collectWorkspaceEntities() {
            var list = RED.nodes.filterNodes({ z: workspaceId }) || [];
            if (RED.nodes.filterGroups) list = list.concat(RED.nodes.filterGroups({ z: workspaceId }) || []);
            if (RED.nodes.filterJunctions) list = list.concat(RED.nodes.filterJunctions({ z: workspaceId }) || []);
            return list;
        }

        function stabilizeView() {
            try {
                if (RED.actions && typeof RED.actions.invoke === 'function') {
                    RED.actions.invoke('core:select-none');
                }
            } catch (e) { /* ignore */ }
            try {
                if (RED.nodes && typeof RED.nodes.dirty === 'function') RED.nodes.dirty(true);
                if (RED.view && typeof RED.view.redraw === 'function') {
                    RED.view.redraw(true);
                    setTimeout(function() {
                        try { RED.view.redraw(true); } catch (e2) { /* ignore */ }
                    }, 0);
                }
            } catch (e) { /* ignore */ }
        }

        try {
            var nodesToDelete = collectWorkspaceEntities();
            if (nodesToDelete.length > 0) {
                if (RED.view && typeof RED.view.select === 'function') {
                    RED.view.select({ nodes: nodesToDelete });
                    if (RED.actions && typeof RED.actions.invoke === 'function') {
                        RED.actions.invoke('core:delete-selection');
                    }
                } else {
                    nodesToDelete.forEach(function(n) {
                        try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ }
                    });
                }
            }
            var remaining = collectWorkspaceEntities();
            if (remaining.length > 0) {
                remaining.forEach(function(n) {
                    try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ }
                });
            }
            stabilizeView();
        } catch (e) {
            return { ok: false, error: 'Failed to clear current workspace: ' + (e.message || e) };
        }

        var importNodes = (nodes || []).map(function(n) {
            var nn = JSON.parse(JSON.stringify(n));
            if (isCanvasNode(nn)) nn.z = workspaceId;
            return nn;
        }).filter(function(nn) {
            // Config nodes that already exist in the editor should not be
            // re-imported (generateIds would create duplicates).
            // Only import truly new config nodes.
            if (!isCanvasNode(nn) && nn.type !== 'tab') {
                return !RED.nodes.node(nn.id);
            }
            return true;
        });

        try {
            var importResult = RED.nodes.import(importNodes, { generateIds: true, addFlow: false });
            if (importResult && RED.history) {
                var newIds = (importResult.nodes || []).map(function(n) { return n.id; });
                if (newIds.length > 0) {
                    RED.history.push({
                        t: "add",
                        nodes: newIds,
                        links: importResult.links || [],
                        workspaces: importResult.workspaces || [],
                        subflows: importResult.subflows || [],
                        groups: importResult.groups || []
                    });
                }
            }
            stabilizeView();
            return { ok: true, count: importNodes.length };
        } catch (e) {
            return { ok: false, error: 'Failed to import restored flow: ' + (e.message || e) };
        }
    }

    // ================================================================== //
    //  Main Import Entry Point                                            //
    // ================================================================== //

    Importer.importFlowFromMessage = async function(messageContent, options) {
        options = options || {};
        try {
            var beforeFlow = (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.getCurrentFlow)
                ? LLMPlugin.UI.getCurrentFlow()
                : null;

            var requestedApplyMode = normalizeApplyMode(options.applyMode) || 'auto';
            var llmApplyMode = extractApplyModeFromMessage(messageContent);
            var applyMode = requestedApplyMode === 'auto'
                ? (llmApplyMode || 'edit-only')
                : requestedApplyMode;
            var hasExistingFlow = Array.isArray(beforeFlow) && beforeFlow.length > 0;
            var parsedSchema = extractLastVibeSchema(messageContent);
            var rawConnectionHints = extractConnectionHints(messageContent);
            var rawFlowDirectives = extractFlowDirectives(messageContent);

            // Safety guard: auto + overwrite without explicit deletes → prefer merge
            if (requestedApplyMode === 'auto' && applyMode === 'overwrite' && hasExistingFlow) {
                var hasDeleteDirectives = (rawFlowDirectives.removeTokens || []).length > 0 ||
                    (rawFlowDirectives.removeConnections || []).length > 0;
                if (!hasDeleteDirectives) {
                    applyMode = 'merge';
                    try {
                        if (window.RED && RED.notify) {
                            RED.notify('Auto mode: switched overwrite to merge to preserve existing flow', 'warning');
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            var canModifyExisting = applyMode !== 'overwrite';
            var connectionHints = canModifyExisting ? rawConnectionHints : [];
            var flowDirectives = canModifyExisting ? rawFlowDirectives : { removeTokens: [], removeConnections: [] };

            var isPatchOnlyUpdate = (
                (applyMode === 'merge' || applyMode === 'edit-only') &&
                hasExistingFlow &&
                parsedSchema &&
                typeof parsedSchema === 'object' &&
                Object.keys(parsedSchema.nodes || {}).length > 0 &&
                Array.isArray(parsedSchema.connections) &&
                parsedSchema.connections.length === 0 &&
                (rawFlowDirectives.removeTokens || []).length === 0 &&
                (rawFlowDirectives.removeConnections || []).length === 0
            );

            var nodes = extractFlowNodes(messageContent, {
                mode: options.mode,
                currentFlow: beforeFlow
            });

            if (!nodes || nodes.length === 0) {
                if (canModifyExisting && (
                    connectionHints.length > 0 ||
                    (flowDirectives.removeTokens || []).length > 0 ||
                    (flowDirectives.removeConnections || []).length > 0
                )) {
                    nodes = [];
                } else {
                    if (window.RED && RED.notify) RED.notify('No JSON flow found in message', 'warning');
                    return { ok: false, error: 'No JSON flow found in message' };
                }
            }

            if (applyMode === 'delete-only' &&
                (flowDirectives.removeTokens || []).length === 0 &&
                (flowDirectives.removeConnections || []).length === 0) {
                if (window.RED && RED.notify) RED.notify('Delete Only mode requires delete directives in JSON', 'warning');
                return { ok: false, error: 'Delete Only mode requires delete directives', checkpointId: null };
            }

            var currentWorkspace = getActiveWorkspaceId();

            // Build unified lookup from current flow
            var cfg = getConfigurator();
            var lookup = canModifyExisting && hasExistingFlow
                ? buildFlowLookup(beforeFlow, cfg)
                : buildFlowLookup([], null);

            // Remap connection hints and directives using lookup
            connectionHints = (connectionHints || []).map(function(h) {
                return {
                    from: lookup.resolve(h.from) || h.from,
                    to: lookup.resolve(h.to) || h.to,
                    fromPort: h.fromPort
                };
            });
            if (flowDirectives && Array.isArray(flowDirectives.removeTokens)) {
                flowDirectives.removeTokens = flowDirectives.removeTokens.map(function(t) {
                    return lookup.resolve(t) || t;
                });
            }
            if (flowDirectives && Array.isArray(flowDirectives.removeConnections)) {
                flowDirectives.removeConnections = flowDirectives.removeConnections.map(function(rc) {
                    return {
                        from: lookup.resolve(rc.from) || rc.from,
                        to: lookup.resolve(rc.to) || rc.to,
                        fromPort: rc.fromPort
                    };
                });
            }

            // Save pre-import checkpoint
            var checkpointId = null;
            var beforeIdSet = new Set();
            (beforeFlow || []).forEach(function(n) {
                if (n && n.id) beforeIdSet.add(n.id);
            });
            checkpointId = await saveCheckpoint(
                options.chatId || null,
                options.checkpointLabel || 'pre-import',
                beforeFlow,
                { source: 'plugin-import' }
            );

            // Build type+name lookup from live editor state
            var existingIds = new Set();
            var existingByTypeName = {};
            var existingByTypeNameToken = {};
            var existingByTypeNameTokenLoose = {};
            var claimedExistingIds = {};
            var remappedIds = {};
            var droppedPatchCandidates = 0;

            if (window.RED && RED.nodes) {
                RED.nodes.eachNode(function(n) { existingIds.add(n.id); });
                if (RED.nodes.eachConfig) {
                    RED.nodes.eachConfig(function(n) { existingIds.add(n.id); });
                }

                // Helper to register a node in type+name lookup tables
                function registerNodeInLookups(n) {
                    if (!n || !n.name || !String(n.name).trim()) return;
                    var typeKey = String(n.type || '').trim().toLowerCase();
                    var k = typeKey + '::' + String(n.name || '').trim().toLowerCase();
                    if (k === '::') return;
                    if (!existingByTypeName[k]) existingByTypeName[k] = [];
                    existingByTypeName[k].push(n);

                    var nk = normalizeToken(n.name || '');
                    var lk = normalizeTokenLoose(n.name || '');
                    if (!existingByTypeNameToken[typeKey]) existingByTypeNameToken[typeKey] = {};
                    if (!existingByTypeNameTokenLoose[typeKey]) existingByTypeNameTokenLoose[typeKey] = {};
                    putUniqueToken(existingByTypeNameToken[typeKey], nk, n.id);
                    putUniqueToken(existingByTypeNameTokenLoose[typeKey], lk, n.id);
                }

                if (canModifyExisting && currentWorkspace) {
                    // Register workspace canvas nodes
                    var wsNodes = RED.nodes.filterNodes({ z: currentWorkspace }) || [];
                    wsNodes.forEach(registerNodeInLookups);

                    // Register config nodes (they live outside workspaces)
                    if (RED.nodes.eachConfig) {
                        RED.nodes.eachConfig(registerNodeInLookups);
                    }
                }
            }

            // ---- Map each proposed node to existing or new ----
            var newNodes = nodes.map(function(n) {
                var nn = JSON.parse(JSON.stringify(n));
                nn.type = String(nn.type || '').trim();

                var replacedExisting = null;

                // 1. Alias-based matching (primary — uses _llmAlias from Vibe Schema conversion)
                if (canModifyExisting && nn._llmAlias) {
                    var aliasId = lookup.resolve(nn._llmAlias, { minLen: 4 });
                    if (aliasId && !claimedExistingIds[aliasId]) {
                        var byAlias = RED.nodes.node(aliasId);
                        // Allow matching for: same workspace nodes, OR config nodes
                        // (config nodes have no z / empty z — they live outside workspaces)
                        if (byAlias && (!currentWorkspace || byAlias.z === currentWorkspace || !byAlias.z)) {
                            replacedExisting = byAlias;
                        }
                    }
                }

                // 2. Type+name matching (fallback)
                if (!replacedExisting && canModifyExisting && nn.name && nn.type) {
                    var key = String(nn.type).trim().toLowerCase() + '::' + String(nn.name).trim().toLowerCase();
                    var candidates = existingByTypeName[key] || [];
                    if (candidates.length === 1 && !claimedExistingIds[candidates[0].id]) {
                        replacedExisting = candidates[0];
                    }
                }

                // 3. Patch-only: type + name token matching (last resort for property updates)
                if (!replacedExisting && isPatchOnlyUpdate && canModifyExisting && nn._llmAlias && nn.type) {
                    var tkey = String(nn.type || '').trim().toLowerCase();
                    var tokenMap = existingByTypeNameToken[tkey] || {};
                    var tokenMapLoose = existingByTypeNameTokenLoose[tkey] || {};
                    var ank = normalizeToken(nn._llmAlias);
                    if (ank) {
                        var byTokenId = tokenMap[ank] || null;
                        if (!byTokenId) byTokenId = resolveUniqueApprox(tokenMap, ank, 6);
                        if (!byTokenId) {
                            var alk = normalizeTokenLoose(nn._llmAlias);
                            if (alk && tokenMapLoose[alk]) byTokenId = tokenMapLoose[alk];
                            if (!byTokenId && alk) byTokenId = resolveUniqueApprox(tokenMapLoose, alk, 6);
                        }
                        if (byTokenId && !claimedExistingIds[byTokenId]) {
                            var byToken = RED.nodes.node(byTokenId);
                            if (byToken && (!currentWorkspace || byToken.z === currentWorkspace)) {
                                replacedExisting = byToken;
                            }
                        }
                    }
                }

                if (replacedExisting) {
                    var originalId = nn.id;
                    claimedExistingIds[replacedExisting.id] = true;
                    nn.id = replacedExisting.id;
                    if (originalId && originalId !== nn.id) {
                        remappedIds[originalId] = nn.id;
                    }
                    if (replacedExisting.z) nn.z = replacedExisting.z;
                    if (replacedExisting.x !== undefined) nn.x = replacedExisting.x;
                    if (replacedExisting.y !== undefined) nn.y = replacedExisting.y;
                    if ((!Array.isArray(nn.wires) || nn.wires.length === 0) && Array.isArray(replacedExisting.wires)) {
                        nn.wires = JSON.parse(JSON.stringify(replacedExisting.wires));
                    } else if (Array.isArray(nn.wires) && Array.isArray(replacedExisting.wires)) {
                        var mergedWires = [];
                        var maxPorts = Math.max(nn.wires.length, replacedExisting.wires.length);
                        for (var p = 0; p < maxPorts; p++) {
                            var existingPort = Array.isArray(replacedExisting.wires[p]) ? replacedExisting.wires[p] : [];
                            var proposedPort = Array.isArray(nn.wires[p]) ? nn.wires[p] : [];
                            var seen = {};
                            mergedWires[p] = [];
                            existingPort.concat(proposedPort).forEach(function(tid) {
                                var id = String(tid || '').trim();
                                if (!id || seen[id]) return;
                                seen[id] = true;
                                mergedWires[p].push(id);
                            });
                        }
                        nn.wires = mergedWires;
                    }
                } else {
                    if (isPatchOnlyUpdate) {
                        droppedPatchCandidates += 1;
                        return null;
                    }
                    if (!nn.id) nn.id = genId();
                    while (existingIds.has(nn.id)) {
                        nn.id = genId();
                    }
                }
                existingIds.add(nn.id);
                if (!Array.isArray(nn.wires)) nn.wires = [];
                return nn;
            });

            // Re-point wires AND string properties that reference pre-remap IDs.
            // Config nodes (ui-group, ui-tab, ui-base, mqtt-broker, etc.) are
            // referenced by canvas nodes via plain string properties such as
            // "group", "tab", "server", "broker", etc.  When a config node's
            // generated ID is remapped to an existing node's ID we must update
            // every reference — not just wires.
            if (Object.keys(remappedIds).length > 0) {
                newNodes.forEach(function(n) {
                    if (!n) return;
                    // Update wires
                    if (Array.isArray(n.wires)) {
                        n.wires = n.wires.map(function(port) {
                            if (!Array.isArray(port)) return [];
                            var seen = {};
                            var out = [];
                            port.forEach(function(tid) {
                                var nextId = remappedIds[tid] || tid;
                                if (!nextId || seen[nextId]) return;
                                seen[nextId] = true;
                                out.push(nextId);
                            });
                            return out;
                        });
                    }
                    // Update string properties that reference remapped IDs
                    Object.keys(n).forEach(function(key) {
                        if (key === 'id' || key === 'type' || key === 'wires' || key === 'z' || key === 'name') return;
                        if (typeof n[key] === 'string' && remappedIds[n[key]]) {
                            n[key] = remappedIds[n[key]];
                        }
                    });
                });
            }

            // Remove tab nodes
            newNodes = newNodes.filter(function(n) { return n && n.type && n.type.toLowerCase() !== 'tab'; });

            if (isPatchOnlyUpdate) {
                if (droppedPatchCandidates > 0 && window.RED && RED.notify) {
                    RED.notify('Patch update: skipped ' + droppedPatchCandidates + ' unmatched node proposal(s)', 'warning');
                }
                var matchedCount = newNodes.filter(function(n) {
                    return !!(n && n.id) && beforeIdSet.has(n.id);
                }).length;
                if (matchedCount === 0) {
                    postTerminalLog('error', 'patch-only-no-match', 'No reliable existing-node match for patch-only update', {
                        applyMode: applyMode, checkpointId: checkpointId, droppedPatchCandidates: droppedPatchCandidates
                    });
                    if (window.RED && RED.notify) {
                        RED.notify('Patch update applied safely: no reliable node match found, skipped adding new nodes', 'warning');
                    }
                    return { ok: false, error: 'No reliable existing-node match for patch-only update', checkpointId: checkpointId, applyMode: applyMode };
                }
            }

            // edit-only: block new nodes but don't fail entirely
            var blockedNewNodes = [];
            if (applyMode === 'edit-only') {
                blockedNewNodes = newNodes.filter(function(n) {
                    return !!(n && n.id) && !beforeIdSet.has(n.id);
                });
                if (blockedNewNodes.length > 0) {
                    newNodes = newNodes.filter(function(n) {
                        return !!(n && n.id) && beforeIdSet.has(n.id);
                    });
                    try {
                        if (window.RED && RED.notify) {
                            RED.notify('Edit Only mode: blocked ' + blockedNewNodes.length + ' new node(s)', 'warning');
                        }
                    } catch (e) { /* ignore */ }
                }
            }

            // Assign workspace
            if (currentWorkspace && typeof currentWorkspace === 'string') {
                newNodes.forEach(function(n) {
                    if (isCanvasNode(n)) n.z = currentWorkspace;
                });
            } else {
                try {
                    if (window && window.RED && RED.notify)
                        RED.notify('Warning: could not determine active workspace; imported nodes may not be in the deployed flow', 'warning');
                } catch(e) {}
            }

            try { LAST_SANITIZED = JSON.parse(JSON.stringify(newNodes)); } catch(e) { LAST_SANITIZED = null; }

            var hasDirectives = (flowDirectives.removeTokens || []).length > 0 ||
                                (flowDirectives.removeConnections || []).length > 0 ||
                                (connectionHints || []).length > 0;
            if (!newNodes.length && !hasDirectives) {
                try {
                    if (window && window.RED && RED.notify)
                        RED.notify('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning');
                } catch(e) {}
                return { ok: false, error: 'No valid nodes after sanitization', checkpointId: checkpointId };
            }

            var bad = newNodes.find(function(n) { return typeof n.type !== 'string' || n.type.length === 0; });
            if (bad) {
                if (RED && RED.notify) RED.notify('Import aborted: invalid node shape', 'error');
                safeLog('bad node', bad);
                return { ok: false, error: 'Invalid node shape', checkpointId: checkpointId };
            }

            var rebuiltFlow = rebuildWorkspaceFromSnapshot(beforeFlow, newNodes, currentWorkspace, connectionHints, flowDirectives, applyMode);
            var rebuiltResult = replaceWorkspaceFlow(rebuiltFlow);
            if (!rebuiltResult || !rebuiltResult.ok) {
                return {
                    ok: false,
                    error: (rebuiltResult && rebuiltResult.error) || 'Failed to rebuild flow from snapshot',
                    checkpointId: checkpointId
                };
            }

            if (RED && RED.notify) RED.notify('Flow reloaded successfully', 'success');

            var afterFlow = (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.getCurrentFlow)
                ? LLMPlugin.UI.getCurrentFlow()
                : null;
            var postCheckpointId = await saveCheckpoint(
                options.chatId || null,
                options.postCheckpointLabel || ('post-import-' + new Date().toISOString()),
                afterFlow,
                { source: 'plugin-import-post' }
            );

            var addedNodes = rebuiltFlow.filter(function(n) {
                return !!(n && n.id) && !beforeIdSet.has(n.id);
            }).map(function(n) {
                return { id: n.id, type: n.type || '', name: n.name || '' };
            });

            if (applyMode !== 'overwrite' && addedNodes.length > 0) {
                try {
                    if (window.RED && RED.notify) {
                        RED.notify('Applied with ' + addedNodes.length + ' added node(s)', 'warning');
                    }
                } catch (e) { /* ignore */ }
            }

            return {
                ok: true,
                importedCount: rebuiltFlow.length,
                checkpointId: postCheckpointId || checkpointId,
                preCheckpointId: checkpointId,
                postCheckpointId: postCheckpointId,
                applyMode: applyMode,
                addedNodeCount: addedNodes.length,
                addedNodes: addedNodes,
                blockedNewNodeCount: blockedNewNodes.length
            };

        } catch(err) {
            console.error('Import error:', err);
            postTerminalLog('error', 'import-exception', 'Unhandled import exception', {
                message: err && err.message ? err.message : String(err)
            });
            if (RED && RED.notify) RED.notify('Failed to import flow: ' + (err && err.message ? err.message : String(err)), 'error');
            return { ok: false, error: err && err.message ? err.message : String(err) };
        }
    };

    // ================================================================== //
    //  Checkpoint Restore                                                 //
    // ================================================================== //

    Importer.restoreCheckpoint = function(checkpointId) {
        if (!checkpointId) return Promise.resolve({ ok: false, error: 'checkpointId is required' });
        return fetch('llm-plugin/checkpoint/' + encodeURIComponent(checkpointId))
            .then(function(res) {
                if (!res.ok) {
                    return res.json().catch(function() { return { error: 'Checkpoint load failed' }; })
                        .then(function(d) { throw new Error(d.error || 'Checkpoint load failed'); });
                }
                return res.json();
            })
            .then(function(data) {
                var cp = data && data.checkpoint;
                if (!cp || !Array.isArray(cp.flow)) {
                    return { ok: false, error: 'Invalid checkpoint data' };
                }
                return replaceWorkspaceFlow(cp.flow);
            })
            .catch(function(err) {
                return { ok: false, error: err && err.message ? err.message : String(err) };
            });
    };

    // ================================================================== //
    //  Exports                                                            //
    // ================================================================== //

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.Importer = Importer;
    Importer.extractFlowNodes = extractFlowNodes;
    Importer.hasFlowDirectives = function(messageContent) {
        var directives = extractFlowDirectives(messageContent);
        var hints = extractConnectionHints(messageContent);
        return (directives.removeTokens || []).length > 0 ||
               (directives.removeConnections || []).length > 0 ||
               hints.length > 0;
    };
    Importer.getLastSanitized = function() { return LAST_SANITIZED; };
})();
