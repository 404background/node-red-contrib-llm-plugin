// Importer: parses LLM assistant messages and imports Node-RED flows.
// Supports both raw Node-RED JSON arrays and Vibe Schema (intermediate JSON).
//
// JSON parsing, token normalization, schema extraction, and flow lookup are
// implemented in src/core/llm_json_parser.js and accessed via LLMPlugin.LLMJsonParser.
(function(){
    var Importer = {};

    // ================================================================== //
    //  Layout Constants                                                   //
    // ================================================================== //
    // Single source of truth for all spacing / gap values used by the
    // layout functions below.  Changing a value here updates every path
    // (overwrite, merge, and orphan placement) at once.
    var LAYOUT = {
        startX:       200,   // canvas origin X (px)
        startY:       200,   // canvas origin Y (px)
        spacingX:     180,   // horizontal gap between node centres (3 grid squares between edges)
        spacingY:      80,   // vertical gap between node centres within a component
        componentGap:  80,   // gap between disconnected flow components (center-to-center)
                             // 80 px = 40 px visible gap + ~40 px node height  - 2 grid squares
        maxColumns:     5    // wrap long chains after this many columns
    };

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

    function safeGetCurrentFlow(workspaceId) {
        if (!window.LLMPlugin || !LLMPlugin.UI) return null;
        if (workspaceId && LLMPlugin.UI.getFlowsByIds) {
            return LLMPlugin.UI.getFlowsByIds([workspaceId]);
        }
        return LLMPlugin.UI.getCurrentFlow ? LLMPlugin.UI.getCurrentFlow() : null;
    }

    /**
     * Scan RED workspaces for a tab matching the given label (or ID).
     * Returns the workspace ID or null if no unique match exists.
     */
    function resolveFlowLabelToWorkspace(label) {
        if (!label || typeof label !== 'string') return null;
        if (!window.RED || !RED.nodes) return null;
        var target = label.trim();
        if (!target) return null;
        var byLabel = [];
          var byFuzzy = [];
          var byId = null;
          
          var fuzzyTarget = target.replace(/[\s\u3000]+/g, '').toLowerCase();

          if (typeof RED.nodes.eachWorkspace === 'function') {
              RED.nodes.eachWorkspace(function(ws) {
                  if (!ws || !ws.id || ws.type !== 'tab') return;
                  if (ws.id === target) byId = ws.id;
                  var lbl = String(ws.label || '').trim();
                  if (lbl === target) {
                      byLabel.push(ws.id);
                  } else {
                      var fuzzyLbl = lbl.replace(/[\s\u3000]+/g, '').toLowerCase();
                      if (fuzzyLbl === fuzzyTarget) byFuzzy.push(ws.id);
                  }
              });
          }
          if (byId) return byId;
          if (byLabel.length === 1) return byLabel[0];
          if (byLabel.length === 0 && byFuzzy.length === 1) return byFuzzy[0];
        return null;
    }

    /** Merge multiple wire ID arrays into one, deduplicating. */
    function mergeWireIds(/* ...arrays */) {
        var seen = {};
        var out = [];
        for (var i = 0; i < arguments.length; i++) {
            var arr = arguments[i];
            if (!Array.isArray(arr)) continue;
            for (var j = 0; j < arr.length; j++) {
                var id = String(arr[j] || '').trim();
                if (id && !seen[id]) { seen[id] = true; out.push(id); }
            }
        }
        return out;
    }

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
    //  Runtime Node-Type Helpers (uses RED.nodes.getType when available) //
    // ------------------------------------------------------------------ //

    /**
     * Check whether a node type can accept incoming wires (has input ports).
     * Delegates to FlowConverterCore which handles both runtime detection
     * (via setRuntimeGetType) and static fallback.
     */
    function nodeCanAcceptInput(type) {
        if (!type || typeof type !== 'string') return true;
        var cfg = getConfigurator();
        if (cfg && typeof cfg.isNoInputType === 'function') return !cfg.isNoInputType(type);
        return true;
    }

    /**
     * Check whether a node type is a config node (lives outside the canvas).
     * Delegates to FlowConverterCore which handles both runtime detection
     * (via setRuntimeGetType) and static fallback.
     */
    function isConfigNodeType(type) {
        if (!type || typeof type !== 'string') return false;
        var cfg = getConfigurator();
        if (cfg && typeof cfg.isConfigType === 'function') return cfg.isConfigType(type);
        return false;
    }

    /**
     * Check whether a node object is a config node using both type-based
     * and structural detection.  Falls back to type-only check if the
     * core function is unavailable.
     */
    function isConfigNodeObj(node) {
        if (!node || typeof node !== 'object') return false;
        var cfg = getConfigurator();
        if (cfg && typeof cfg.isConfigNode === 'function') return cfg.isConfigNode(node);
        return isConfigNodeType(node.type);
    }

    /**
     * Remove wires targeting nodes that cannot accept input.
     * Iterates all nodes and prunes invalid wire entries.
     */
    function pruneInvalidInputWires(flowNodes) {
        if (!Array.isArray(flowNodes)) return;
        var noInputIds = {};
        flowNodes.forEach(function(n) {
            if (n && n.id && !nodeCanAcceptInput(n.type)) noInputIds[n.id] = true;
        });
        if (Object.keys(noInputIds).length === 0) return;
        flowNodes.forEach(function(n) {
            if (!n || !Array.isArray(n.wires)) return;
            n.wires = n.wires.map(function(port) {
                if (!Array.isArray(port)) return [];
                return port.filter(function(tid) { return !noInputIds[tid]; });
            });
        });
    }

    /**
     * Strip canvas properties (x, y, wires, z) from nodes that are detected
     * as config nodes at runtime but were not caught by the static check.
     */
    function fixConfigNodeProperties(flowNodes) {
        if (!Array.isArray(flowNodes)) return;
        flowNodes.forEach(function(n) {
            if (!n || !n.type) return;
            if (!isConfigNodeType(n.type)) return;
            if (typeof n.x === 'number' || typeof n.y === 'number') {
                delete n.x;
                delete n.y;
                delete n.wires;
                delete n.z;
            }
        });
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
            // exactOnly: a hint's alias must match a real alias/name/ID
            // exactly. Fuzzy matching here is unsafe  - a new-node alias
            // like "inject_py_1" can prefix-match an existing "inject"
            // and silently reroute every connection to the wrong node.
            // New-to-new wires are already baked into node.wires by
            // toNodeRed, so we only need hints to land when they
            // reference something unambiguously.
            var fromId = lookup.resolve(h.from, { exactOnly: true });
            var toId = lookup.resolve(h.to, { exactOnly: true });
            if (!fromId || !toId || !lookup.byId[fromId] || !lookup.byId[toId]) return;
            // Skip connections targeting nodes that cannot accept input
            var targetNode = lookup.byId[toId];
            if (targetNode && !nodeCanAcceptInput(targetNode.type)) return;
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
            fromNode.wires[port] = mergeWireIds(fromNode.wires[port], desiredByFromPort[key]);
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
            // Auto-created config stubs must not overwrite existing config nodes
            if (n._autoStub && byId[n.id]) return;
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
            var rcLookup = buildFlowLookup(rebuilt, getConfigurator());

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
            delete n._llmAlias;
            delete n._autoStub;
            delete n._llmFlow;
        });

        // Prune wires targeting nodes that cannot accept input
        pruneInvalidInputWires(rebuilt);
        // Fix config nodes that were incorrectly given canvas properties
        fixConfigNodeProperties(rebuilt);

        if (mode === 'overwrite' || Object.keys(baseIds).length === 0) {
            // No existing nodes to preserve  - full re-layout
            reflowCanvasNodes(rebuilt, {
                startX: LAYOUT.startX, startY: LAYOUT.startY,
                spacingX: LAYOUT.spacingX, spacingY: LAYOUT.spacingY,
                maxColumns: LAYOUT.maxColumns
            });
        } else {
            // Preserve existing positions; only place new nodes near their neighbors
            placeAddedNodesNearNeighbors(rebuilt, baseIds, basePositions, {
                spacingX: LAYOUT.spacingX, spacingY: LAYOUT.spacingY,
                bandGap: LAYOUT.componentGap, maxColumns: LAYOUT.maxColumns
            });
        }

        return rebuilt;
    }

    // ================================================================== //
    //  Canvas Layout                                                      //
    // ================================================================== //

    /**
     * Reflow canvas nodes using FlowConverterCore's layoutNodes engine.
     * Builds adjacency from wires, delegates layout, applies coordinates.
     */
    function reflowCanvasNodes(nodes, opts) {
        var cfg = getConfigurator();
        if (!cfg || typeof cfg.layoutNodes !== 'function') return nodes;

        var options = opts || {};
        var startX = (typeof options.startX === 'number') ? options.startX : LAYOUT.startX;
        var startY = (typeof options.startY === 'number') ? options.startY : LAYOUT.startY;
        var spacingX = (typeof options.spacingX === 'number') ? options.spacingX : LAYOUT.spacingX;
        var spacingY = (typeof options.spacingY === 'number') ? options.spacingY : LAYOUT.spacingY;
        var maxColumns = (typeof options.maxColumns === 'number' && options.maxColumns >= 2)
            ? Math.floor(options.maxColumns) : LAYOUT.maxColumns;

        var canvasNodes = (nodes || []).filter(function(n) { return isCanvasNode(n); });
        if (canvasNodes.length < 2) return nodes;

        var byId = {};
        var ids = [];
        canvasNodes.forEach(function(n) {
            if (n && n.id) { byId[n.id] = n; ids.push(n.id); }
        });

        // Build bidirectional adjacency from wires
        var outgoing = {};
        var incoming = {};
        ids.forEach(function(id) { outgoing[id] = []; incoming[id] = []; });
        ids.forEach(function(id) {
            var n = byId[id];
            if (!Array.isArray(n.wires)) return;
            n.wires.forEach(function(port) {
                if (!Array.isArray(port)) return;
                port.forEach(function(toId) {
                    if (!byId[toId]) return;
                    outgoing[id].push(toId);
                    incoming[toId].push(id);
                });
            });
        });

        // Delegate to shared layout engine
        var positions = cfg.layoutNodes(ids, outgoing, incoming, maxColumns);

        // Apply col/row  - pixel coordinates with per-component stacking
        var compGapPx = LAYOUT.componentGap;
        var compInfo = {};
        ids.forEach(function(id) {
            var pos = positions[id] || { col: 0, row: 0 };
            var ci = pos.comp || 0;
            if (!compInfo[ci]) compInfo[ci] = { minRow: pos.row, maxRow: pos.row };
            if (pos.row < compInfo[ci].minRow) compInfo[ci].minRow = pos.row;
            if (pos.row > compInfo[ci].maxRow) compInfo[ci].maxRow = pos.row;
        });
        var compKeys = Object.keys(compInfo).map(Number).sort(function(a, b) { return a - b; });
        var compOffsets = {};
        var nextYR = startY;
        compKeys.forEach(function(ci) {
            var info = compInfo[ci];
            compOffsets[ci] = nextYR - info.minRow * spacingY;
            nextYR = nextYR + (info.maxRow - info.minRow) * spacingY + compGapPx;
        });
        ids.forEach(function(id) {
            var node = byId[id];
            var pos = positions[id] || { col: 0, row: 0 };
            var ci = pos.comp || 0;
            node.x = Math.round(startX + pos.col * spacingX);
            node.y = Math.round(pos.row * spacingY + (compOffsets[ci] || 0));
        });

        return nodes;
    }

    /**
     * Conservative layout: restore existing node positions from basePositions,
     * then place only new nodes near their connected neighbors.
     *
     * Placement rules for new nodes:
     *  - Has both predecessor(s) and successor(s) among positioned nodes  - midpoint
     *  - Has only predecessor(s)  - to the right of the furthest predecessor
     *  - Has only successor(s)    - to the left of the nearest successor
     *  - No positioned neighbors  - below all existing nodes (orphan fallback)
     *
     * Multi-node chains (new nodes connected only to other new nodes) are resolved
     * by iterating until all reachable nodes are placed.
     */
    function placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, opts) {
        var options = opts || {};
        var spacingX = (typeof options.spacingX === 'number') ? options.spacingX : LAYOUT.spacingX;
        var spacingY = (typeof options.spacingY === 'number') ? options.spacingY : LAYOUT.spacingY;
        var bandGap = (typeof options.bandGap === 'number') ? options.bandGap : LAYOUT.componentGap;
        var maxColumns = (typeof options.maxColumns === 'number' && options.maxColumns >= 2) ? options.maxColumns : LAYOUT.maxColumns;

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

        // Step 4: Orphan new nodes  - no path to any existing node  - place below
        //   Use the layout engine to respect connections among orphan nodes
        //   (e.g. 10 disconnected inject - venv - debug chains should stack vertically,
        //    not collapse into a flat grid).
        if (remaining.length > 0) {
            // Find the bottom-most Y among ALL positioned nodes (existing +
            // Step-3-placed) so orphans never overlap with anything above.
            var maxY = Number.NEGATIVE_INFINITY;
            var minX = Number.POSITIVE_INFINITY;
            canvasNodes.forEach(function(n) {
                if (!positioned[n.id] && !existingIdMap[n.id]) return;
                if ((n.y || 0) > maxY) maxY = n.y;
                if ((n.x || 0) < minX) minX = n.x;
            });
            if (!isFinite(maxY)) maxY = 200;
            if (!isFinite(minX)) minX = 200;
            var orphanStartY = maxY + bandGap;

            var cfg = getConfigurator();
            if (cfg && typeof cfg.layoutNodes === 'function') {
                // Build adjacency for orphan nodes only
                var orphanIds = [];
                var orphanOut = {};
                var orphanIn = {};
                remaining.forEach(function(n) {
                    orphanIds.push(n.id);
                    orphanOut[n.id] = [];
                    orphanIn[n.id] = [];
                });
                var orphanSet = {};
                remaining.forEach(function(n) { orphanSet[n.id] = true; });
                remaining.forEach(function(n) {
                    (outgoing[n.id] || []).forEach(function(toId) {
                        if (orphanSet[toId]) {
                            orphanOut[n.id].push(toId);
                            orphanIn[toId].push(n.id);
                        }
                    });
                });
                var orphanPositions = cfg.layoutNodes(orphanIds, orphanOut, orphanIn, maxColumns);
                // Per-component stacking with 40px gap
                var oCompInfo = {};
                remaining.forEach(function(n) {
                    var pos = orphanPositions[n.id] || { col: 0, row: 0 };
                    var ci = pos.comp || 0;
                    if (!oCompInfo[ci]) oCompInfo[ci] = { minRow: pos.row, maxRow: pos.row };
                    if (pos.row < oCompInfo[ci].minRow) oCompInfo[ci].minRow = pos.row;
                    if (pos.row > oCompInfo[ci].maxRow) oCompInfo[ci].maxRow = pos.row;
                });
                var oCompKeys = Object.keys(oCompInfo).map(Number).sort(function(a, b) { return a - b; });
                var oCompOff = {};
                var oNextY = orphanStartY;
                oCompKeys.forEach(function(ci) {
                    var info = oCompInfo[ci];
                    oCompOff[ci] = oNextY - info.minRow * spacingY;
                    oNextY = oNextY + (info.maxRow - info.minRow) * spacingY + LAYOUT.componentGap;
                });
                remaining.forEach(function(n) {
                    var pos = orphanPositions[n.id] || { col: 0, row: 0 };
                    var ci = pos.comp || 0;
                    n.x = Math.round(minX + pos.col * spacingX);
                    n.y = Math.round(pos.row * spacingY + (oCompOff[ci] || 0));
                });
            } else {
                // Fallback: simple grid
                remaining.forEach(function(n, idx) {
                    n.x = Math.round(minX + (idx % maxColumns) * spacingX);
                    n.y = Math.round(orphanStartY + Math.floor(idx / maxColumns) * spacingY);
                });
            }
        }

        return nodes;
    }

    // ================================================================== //
    //  Replace Workspace Flow                                             //
    // ================================================================== //

    function replaceWorkspaceFlow(nodes, targetWorkspaceId) {
        var workspaceId = (targetWorkspaceId && typeof targetWorkspaceId === 'string')
            ? targetWorkspaceId
            : getActiveWorkspaceId();
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

        var importIds = {};
        (nodes || []).forEach(function(n) { if (n && n.id) importIds[n.id] = true; });

        try {
            var allEntities = collectWorkspaceEntities();
            var nodesToDelete = allEntities.filter(function(n) { return !importIds[n.id]; });

            if (nodesToDelete.length > 0) {
                nodesToDelete.forEach(function(n) {
                    try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ }
                });
            }
        } catch (e) {
            return { ok: false, error: 'Failed to clear obsolete nodes: ' + (e.message || e) };
        }

        // Separate config nodes that already exist (update in-place) from
        // nodes that need to be imported fresh.
        // Drop tab definitions: generateIds would regenerate their ID and
        // RED.nodes.import would create a duplicate workspace with the same
        // label; canvas nodes should instead land on the active workspace.
        var configNodesToUpdate = [];
        var importNodes = (nodes || []).map(function(n) {
            var nn = JSON.parse(JSON.stringify(n));
            if (isCanvasNode(nn)) nn.z = workspaceId;
            return nn;
        }).filter(function(nn) {
            if (nn.type === 'tab') return false;
            if (!isCanvasNode(nn)) {
                var existing = RED.nodes.node(nn.id);
                if (existing) {
                    // Config node already exists  - collect for in-place update
                    configNodesToUpdate.push(nn);
                    return false;
                }
            }
            return true;
        });

        // Update existing config nodes in-place (properties only; no re-import)
        configNodesToUpdate.forEach(function(nn) {
            try {
                // Auto-created stubs have no real props  - skip to preserve existing settings
                if (nn._autoStub) return;
                var existing = RED.nodes.node(nn.id);
                if (!existing) return;
                Object.keys(nn).forEach(function(key) {
                    if (key === 'id' || key === 'type') return;
                    existing[key] = nn[key];
                });
                existing.dirty = true;
                existing.changed = true;
            } catch (e) {
                safeLog('[LLM Plugin] Failed to update config node:', nn.id, e);
            }
        });

        try {
            var importResult = RED.nodes.import(importNodes, { generateIds: false, reimport: true, addFlow: false });
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
            return { ok: true, count: importNodes.length, configUpdated: configNodesToUpdate.length };
        } catch (e) {
            return { ok: false, error: 'Failed to import restored flow: ' + (e.message || e) };
        }
    }

    // ================================================================== //
    //  Multi-flow Dispatch Helpers                                        //
    // ================================================================== //

    function getActiveWorkspaceLabel() {
        var id = getActiveWorkspaceId();
        if (!id || !window.RED || !RED.nodes) return null;
        if (typeof RED.nodes.workspace === 'function') {
            var ws = RED.nodes.workspace(id);
            if (ws && ws.label) return ws.label;
        }
        return id;
    }

    /**
     * Group the LLM's proposed canvas nodes by their `flow` label so each
     * group can target its own workspace. Untagged canvas nodes are folded
     * into the active flow when any other node is tagged (mixed response);
     * otherwise no groups are returned and the caller uses single-flow mode.
     */
    function collectFlowGroupsFromSchema(schema) {
        if (!schema || !schema.nodes || typeof schema.nodes !== 'object') return null;
        var groups = {};
        var untagged = [];
        Object.keys(schema.nodes).forEach(function(alias) {
            var spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;
            if (spec.config === true) return;
            if (spec.type === 'tab' || String(spec.type).toLowerCase() === 'tab') return;
            if (spec.type && isConfigNodeType(spec.type)) return;
            var flow = (typeof spec.flow === 'string') ? spec.flow.trim() : '';
            if (!flow) { untagged.push(alias); return; }
            if (!groups[flow]) groups[flow] = [];
            groups[flow].push(alias);
        });
        if (untagged.length > 0 && Object.keys(groups).length > 0) {
            var activeLabel = getActiveWorkspaceLabel();
            if (activeLabel) {
                if (!groups[activeLabel]) groups[activeLabel] = [];
                untagged.forEach(function(a) { groups[activeLabel].push(a); });
            }
        }
        return groups;
    }

    /**
     * Slice a schema down to a single flow: its tagged canvas nodes, any
     * untagged nodes (config / shared), and connections where both endpoints
     * belong to this flow. Cross-flow connections are dropped  - the prompt
     * discourages them unless the user asks explicitly.
     */
    function buildSubSchemaForFlow(schema, aliases) {
        var aliasSet = {};
        aliases.forEach(function(a) { aliasSet[a] = true; });
        var subNodes = {};

        aliases.forEach(function(alias) {
            if (Object.prototype.hasOwnProperty.call(schema.nodes || {}, alias)) {
                subNodes[alias] = schema.nodes[alias];
            }
        });
        Object.keys(schema.nodes || {}).forEach(function(alias) {
            if (aliasSet[alias]) return;
            var spec = schema.nodes[alias];
            if (spec === null) { subNodes[alias] = spec; return; }
            if (!spec || typeof spec !== 'object') return;
            var isUntagged = !spec.flow || typeof spec.flow !== 'string' || !spec.flow.trim();
            if (isUntagged) subNodes[alias] = spec;
        });

        var subConns = [];
        (schema.connections || []).forEach(function(c) {
            if (!c || typeof c !== 'object') return;
            if (c.remove && typeof c.remove === 'object') {
                var r = c.remove;
                if (aliasSet[r.from] && aliasSet[r.to]) subConns.push(c);
                return;
            }
            if (aliasSet[c.from] && aliasSet[c.to]) subConns.push(c);
        });

        var out = {
            nodes: subNodes,
            connections: subConns
        };
        if (typeof schema.description === 'string') out.description = schema.description;
        if (typeof schema.applyMode === 'string') out.applyMode = schema.applyMode;
        if (Array.isArray(schema.remove)) {
            out.remove = schema.remove.filter(function(t) { return aliasSet[t]; });
        }
        return out;
    }

    async function dispatchMultiFlowImport(messageContent, schema, flowGroups, options) {
        var applyMode = schema && typeof schema.applyMode === 'string' ? schema.applyMode : null;
        var results = [];
        var aggregatedAdded = 0;
        var aggregatedImported = 0;
        var unresolved = [];
        var flowLabels = Object.keys(flowGroups);

        for (var li = 0; li < flowLabels.length; li++) {
            var label = flowLabels[li];
            var wsId = resolveFlowLabelToWorkspace(label);
            if (!wsId) { unresolved.push(label); continue; }

            var subSchema = buildSubSchemaForFlow(schema, flowGroups[label]);
            var subMessage = '```json\n' + JSON.stringify(subSchema, null, 2) + '\n```';
            try {
                var res = await Importer.importFlowFromMessage(subMessage, Object.assign({}, options, {
                    targetWorkspaceId: wsId,
                    _isSubImport: true
                }));
                results.push(Object.assign({}, res, { flow: label, workspaceId: wsId }));
                if (res && res.ok) {
                    aggregatedAdded += (res.addedNodeCount || 0);
                    aggregatedImported += (res.importedCount || 0);
                }
            } catch (e) {
                results.push({ ok: false, error: String(e && e.message ? e.message : e), flow: label, workspaceId: wsId });
            }
        }

        if (unresolved.length > 0 && window.RED && RED.notify) {
            RED.notify('Skipped unknown flow(s): ' + unresolved.join(', '), 'warning');
        }

        var allOk = results.length > 0 && results.every(function(r) { return r && r.ok; });
        return {
            ok: allOk,
            multiFlow: true,
            results: results,
            importedCount: aggregatedImported,
            addedNodeCount: aggregatedAdded,
            applyMode: applyMode || 'auto'
        };
    }

    // ================================================================== //
    //  Main Import Entry Point                                            //
    // ================================================================== //

    Importer.importFlowFromMessage = async function(messageContent, options) {
        options = options || {};
        try {
            // --- Multi-flow dispatch ---
            // When the LLM response tags canvas nodes with "flow" fields,
            // proposals may span several workspaces. Split them per-flow so
            // each flow's existing nodes are only matched against proposals
            // intended for that flow  - prevents cross-flow overwrites.
            if (!options._isSubImport) {
                var dispatchSchema = extractLastVibeSchema(messageContent);
                var flowGroups = collectFlowGroupsFromSchema(dispatchSchema);
                var flowLabels = flowGroups ? Object.keys(flowGroups) : [];
                if (flowLabels.length > 1) {
                    return await dispatchMultiFlowImport(messageContent, dispatchSchema, flowGroups, options);
                }
                if (flowLabels.length === 1) {
                    var targetLabel = flowLabels[0];
                    var onlyWs = resolveFlowLabelToWorkspace(targetLabel);
                    if (onlyWs) {
                        options = Object.assign({}, options, { targetWorkspaceId: onlyWs });
                    } else {
                        if (window.RED && RED.notify) {
                            RED.notify('Target flow "' + targetLabel + '" not found. Import aborted to prevent modifying the current flow.', 'error');
                        }
                        return { ok: false, error: 'Target flow "' + targetLabel + '" not found.' };
                    }
                }
            }

            var targetWs = (options.targetWorkspaceId && typeof options.targetWorkspaceId === 'string')
                ? options.targetWorkspaceId
                : null;
            var beforeFlow = safeGetCurrentFlow(targetWs);

            var requestedApplyMode = normalizeApplyMode(options.applyMode) || 'auto';
            var llmApplyMode = extractApplyModeFromMessage(messageContent);
            var applyMode = requestedApplyMode === 'auto'
                ? (llmApplyMode || 'edit-only')
                : requestedApplyMode;
            var hasExistingFlow = Array.isArray(beforeFlow) && beforeFlow.length > 0;
            var parsedSchema = extractLastVibeSchema(messageContent);
            var rawConnectionHints = extractConnectionHints(messageContent);
            var rawFlowDirectives = extractFlowDirectives(messageContent);

            // Safety guard: auto + overwrite without explicit deletes  - prefer merge
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

            // Strip tab nodes early so they don't trigger false-positive patch-only updates
            if (Array.isArray(nodes)) {
                nodes = nodes.filter(function(n) { return n && n.type && String(n.type).toLowerCase() !== 'tab'; });
            }

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

            var currentWorkspace = targetWs || getActiveWorkspaceId();

            // Build unified lookup from current flow
            var cfg = getConfigurator();
            var lookup = canModifyExisting && hasExistingFlow
                ? buildFlowLookup(beforeFlow, cfg)
                : buildFlowLookup([], null);

            // Remap connection hints and directives using lookup.
            // exactOnly prevents a new-node alias (e.g. "inject_py_1")
            // from fuzzy-matching an unrelated existing node ("inject")
            // and silently hijacking connections or deletions.
            connectionHints = (connectionHints || []).map(function(h) {
                return {
                    from: lookup.resolve(h.from, { exactOnly: true }) || h.from,
                    to: lookup.resolve(h.to, { exactOnly: true }) || h.to,
                    fromPort: h.fromPort
                };
            });
            if (flowDirectives && Array.isArray(flowDirectives.removeTokens)) {
                flowDirectives.removeTokens = flowDirectives.removeTokens.map(function(t) {
                    return lookup.resolve(t, { exactOnly: true }) || t;
                });
            }
            if (flowDirectives && Array.isArray(flowDirectives.removeConnections)) {
                flowDirectives.removeConnections = flowDirectives.removeConnections.map(function(rc) {
                    return {
                        from: lookup.resolve(rc.from, { exactOnly: true }) || rc.from,
                        to: lookup.resolve(rc.to, { exactOnly: true }) || rc.to,
                        fromPort: rc.fromPort
                    };
                });
            }

            // Track existing IDs for downstream edit-only/patch-only checks.
            // Checkpoints are saved at chat-send time by ChatManager.savePreSendCheckpoint,
            // not here  - the import path no longer produces its own checkpoints.
            var beforeIdSet = new Set();
            (beforeFlow || []).forEach(function(n) {
                if (n && n.id) beforeIdSet.add(n.id);
            });

            // Build type+name lookup from live editor state
            var existingIds = new Set();
            var existingByTypeName = {};
            var existingByTypeNameToken = {};
            var existingByTypeNameTokenLoose = {};
            var existingConfigByType = {};
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
                        RED.nodes.eachConfig(function(n) {
                            registerNodeInLookups(n);
                            // Build type-only lookup for singleton config-node matching
                            if (n && n.id && n.type) {
                                var ct = String(n.type).trim().toLowerCase();
                                if (!existingConfigByType[ct]) existingConfigByType[ct] = [];
                                existingConfigByType[ct].push(n);
                            }
                        });
                    }
                }
            }

            // ---- Pre-pass: exact-alias claims ----
            // Run exact-only resolution for every proposed node first, so that
            // strong matches reserve their existing IDs before any fuzzy/loose
            // match in the main pass can steal them. This prevents a new node
            // with alias "inject_trigger_1" from loose-matching an existing
            // "inject_trigger" when the LLM also (intentionally) references
            // "inject_trigger" as an edit target.
            var preResolvedAlias = {};
            if (canModifyExisting) {
                nodes.forEach(function(n, idx) {
                    if (!n || !n._llmAlias) return;
                    var exactId = lookup.resolve(n._llmAlias, { exactOnly: true });
                    if (!exactId || claimedExistingIds[exactId]) return;
                    var existing = RED.nodes.node(exactId);
                    if (!existing) return;
                    if (!currentWorkspace || existing.z === currentWorkspace || !existing.z) {
                        preResolvedAlias[idx] = exactId;
                        claimedExistingIds[exactId] = true;
                    }
                });
            }

            // ---- Map each proposed node to existing or new ----
            var newNodes = nodes.map(function(n, idx) {
                var nn = JSON.parse(JSON.stringify(n));
                nn.type = String(nn.type || '').trim();

                var replacedExisting = null;

                // 1. Alias-based matching (primary  - uses _llmAlias from Vibe Schema conversion)
                if (canModifyExisting && nn._llmAlias) {
                    var aliasId = preResolvedAlias[idx] || null;
                    // Fallback to fuzzy/loose only when this node had no exact
                    // match; skip any existing IDs already claimed by the
                    // pre-pass or a prior proposal.
                    if (!aliasId) {
                        // New-node signal: alias has a trailing digit run
                        // (with or without underscore) and stripping it yields
                        // an existing exact alias  - e.g. "inject_py1" vs
                        // existing "inject_py", or "inject_trigger_2" vs
                        // existing "inject_trigger". Treat as NEW so loose
                        // fuzzy can't hijack an existing node.
                        var stripped = nn._llmAlias
                            .replace(/_?\d+$/, '')
                            .replace(/_+$/, '');
                        var isNewNodeSignal = (stripped !== nn._llmAlias) &&
                            lookup.aliasToId && !!lookup.aliasToId[stripped];
                        // Fuzzy matching is useful in edit-only mode where the
                        // LLM may typo an alias it wants to modify. In merge
                        // mode the LLM has every existing alias in its context
                        // and the prompt forbids reusing them for new nodes  -                         // fuzzy here only causes accidental overwrites of
                        // same-type existing nodes.
                        if (!isNewNodeSignal && applyMode === 'edit-only') {
                            var fuzzyId = lookup.resolve(nn._llmAlias, { minLen: 4 });
                            if (fuzzyId && !claimedExistingIds[fuzzyId]) aliasId = fuzzyId;
                        }
                    }
                    if (aliasId) {
                        var byAlias = RED.nodes.node(aliasId);
                        // Allow matching for: same workspace nodes, OR config nodes
                        // (config nodes have no z / empty z  - they live outside workspaces)
                        if (byAlias && (!currentWorkspace || byAlias.z === currentWorkspace || !byAlias.z)) {
                            replacedExisting = byAlias;
                        }
                    }
                }

                // 2. Type+name matching (fallback).
                // Only applies in edit-only mode: in merge mode the LLM picks
                // fresh aliases for new nodes and may legitimately reuse a
                // display name (e.g. adding another "run 1" inject alongside
                // an existing one). Matching on name would silently overwrite
                // the existing node instead of creating a new sibling.
                if (!replacedExisting && canModifyExisting && nn.name && nn.type && applyMode === 'edit-only') {
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

                // 4. Config node singleton matching: if a config node has no match
                //    by alias or name, but exactly one existing config node of the
                //    same type exists, reuse it rather than creating a duplicate.
                if (!replacedExisting && canModifyExisting && isConfigNodeObj(nn)) {
                    var configTypeKey = String(nn.type).trim().toLowerCase();
                    var sameTypeCandidates = existingConfigByType[configTypeKey] || [];
                    var unclaimedCandidates = sameTypeCandidates.filter(function(c) {
                        return !claimedExistingIds[c.id];
                    });
                    if (unclaimedCandidates.length === 1) {
                        replacedExisting = unclaimedCandidates[0];
                    }
                }

                if (replacedExisting) {
                    var originalId = nn.id;
                    claimedExistingIds[replacedExisting.id] = true;
                    nn.id = replacedExisting.id;
                    if (originalId && originalId !== nn.id) {
                        remappedIds[originalId] = nn.id;
                    }

                    // Auto-created config stubs (empty props) should not
                    // overwrite the existing config node's real settings.
                    // Keep the ID remap so canvas nodes point to the right
                    // config, but drop the stub itself.
                    if (nn._autoStub) {
                        existingIds.add(nn.id);
                        return null;
                    }

                    if (replacedExisting.z) nn.z = replacedExisting.z;
                    if (replacedExisting.x !== undefined) nn.x = replacedExisting.x;
                    if (replacedExisting.y !== undefined) nn.y = replacedExisting.y;
                    if ((!Array.isArray(nn.wires) || nn.wires.length === 0) && Array.isArray(replacedExisting.wires)) {
                        nn.wires = JSON.parse(JSON.stringify(replacedExisting.wires));
                    } else if (Array.isArray(nn.wires) && Array.isArray(replacedExisting.wires)) {
                        var maxPorts = Math.max(nn.wires.length, replacedExisting.wires.length);
                        var mergedWires = [];
                        for (var p = 0; p < maxPorts; p++) {
                            mergedWires[p] = mergeWireIds(replacedExisting.wires[p], nn.wires[p]);
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
            // every reference  - not just wires.
            if (Object.keys(remappedIds).length > 0) {
                newNodes.forEach(function(n) {
                    if (!n) return;
                    // Update wires: remap IDs and deduplicate
                    if (Array.isArray(n.wires)) {
                        n.wires = n.wires.map(function(port) {
                            if (!Array.isArray(port)) return [];
                            return mergeWireIds(port.map(function(tid) { return remappedIds[tid] || tid; }));
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
                        applyMode: applyMode, droppedPatchCandidates: droppedPatchCandidates
                    });
                    if (window.RED && RED.notify) {
                        RED.notify('Patch update applied safely: no reliable node match found, skipped adding new nodes', 'warning');
                    }
                    return { ok: false, error: 'No reliable existing-node match for patch-only update', applyMode: applyMode };
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

            var hasDirectives = (flowDirectives.removeTokens || []).length > 0 ||
                                (flowDirectives.removeConnections || []).length > 0 ||
                                (connectionHints || []).length > 0;
            if (!newNodes.length && !hasDirectives) {
                try {
                    if (window && window.RED && RED.notify)
                        RED.notify('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning');
                } catch(e) {}
                return { ok: false, error: 'No valid nodes after sanitization' };
            }

            var bad = newNodes.find(function(n) { return typeof n.type !== 'string' || n.type.length === 0; });
            if (bad) {
                if (RED && RED.notify) RED.notify('Import aborted: invalid node shape', 'error');
                safeLog('bad node', bad);
                return { ok: false, error: 'Invalid node shape' };
            }

            var rebuiltFlow = rebuildWorkspaceFromSnapshot(beforeFlow, newNodes, currentWorkspace, connectionHints, flowDirectives, applyMode);
            var rebuiltResult = replaceWorkspaceFlow(rebuiltFlow, currentWorkspace);
            if (!rebuiltResult || !rebuiltResult.ok) {
                return {
                    ok: false,
                    error: (rebuiltResult && rebuiltResult.error) || 'Failed to rebuild flow from snapshot'
                };
            }

            if (RED && RED.notify) RED.notify('Flow reloaded successfully', 'success');

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
})();



