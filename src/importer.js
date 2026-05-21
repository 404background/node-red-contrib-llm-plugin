// Importer: parses LLM assistant messages and imports Node-RED flows.
// Supports both raw Node-RED JSON arrays and Vibe Schema (intermediate JSON).
//
// JSON parsing, token normalization, schema extraction, and flow lookup are
// implemented in src/core/llm_json_parser.js and accessed via LLMPlugin.LLMJsonParser.
(function(){
    let Importer = {};

    // ================================================================== //
    //  Layout Constants                                                   //
    // ================================================================== //
    // Plugin-specific overrides passed to CanvasLayout. All gap values are
    // EDGE-TO-EDGE clearances (the visible whitespace), not centre-to-
    // centre distances — CanvasLayout adds the rendered node size
    // internally. See core/LAYOUT.md for the full spacing rule.
    let LAYOUT = {
        startX:       200,   // canvas origin X (px) - left edge of first column
        startY:       200,   // canvas origin Y (px) - top edge of first row
        spacingY:      40,   // 2 grid squares between stacked node edges (within a flow)
        componentGap:  80,   // 4 grid squares between disconnected flow components
        edgeGap:       40,   // 2 grid squares between adjacent node edges (horizontal)
        maxColumns:     5    // wrap long chains after this many columns
    };

    // ================================================================== //
    //  Module References                                                  //
    // ================================================================== //

    function getConfigurator() {
        return window.LLMPlugin ? window.LLMPlugin.Configurator : null;
    }

    function getParser() {
        return window.LLMPlugin ? window.LLMPlugin.LLMJsonParser : null;
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
        let target = label.trim();
        if (!target) return null;
        let byLabel = [];
        let byFuzzy = [];
        let byId = null;

        function normalizeForFuzzy(str) {
            let s = str.replace(/[\s\u3000_]+/g, '').toLowerCase();
            return (String.prototype.normalize) ? s.normalize('NFKC') : s;
        }

        let fuzzyTarget = normalizeForFuzzy(target);

        RED.nodes.eachWorkspace(function(ws) {
            if (!ws || !ws.id || ws.type !== 'tab') return;
            if (ws.id === target) byId = ws.id;
            let lbl = String(ws.label || '').trim();
            if (lbl === target) {
                byLabel.push(ws.id);
            } else {
                let fuzzyLbl = normalizeForFuzzy(lbl);
                if (fuzzyLbl === fuzzyTarget) byFuzzy.push(ws.id);
            }
        });

        if (byId) return byId;
        if (byLabel.length === 1) return byLabel[0];
        if (byLabel.length === 0 && byFuzzy.length === 1) return byFuzzy[0];
        return null;
    }

    /** Merge multiple wire ID arrays into one, deduplicating. */
    function mergeWireIds(/* ...arrays */) {
        let seen = {};
        let out = [];
        for (let i = 0; i < arguments.length; i++) {
            let arr = arguments[i];
            if (!Array.isArray(arr)) continue;
            for (let j = 0; j < arr.length; j++) {
                let id = String(arr[j] || '').trim();
                if (id && !seen[id]) { seen[id] = true; out.push(id); }
            }
        }
        return out;
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

    // --- Runtime node-type helpers (thin wrappers over FlowConverterCore) ---

    function nodeCanAcceptInput(type) {
        if (!type || typeof type !== 'string') return true;
        let cfg = getConfigurator();
        if (cfg && typeof cfg.isNoInputType === 'function') return !cfg.isNoInputType(type);
        return true;
    }

    function nodeCanEmitOutput(type) {
        if (!type || typeof type !== 'string') return true;
        let cfg = getConfigurator();
        if (cfg && typeof cfg.isNoOutputType === 'function') return !cfg.isNoOutputType(type);
        return true;
    }

    function isConfigNodeType(type) {
        if (!type || typeof type !== 'string') return false;
        let cfg = getConfigurator();
        if (cfg && typeof cfg.isConfigType === 'function') return cfg.isConfigType(type);
        return false;
    }

    function isConfigNodeObj(node) {
        if (!node || typeof node !== 'object') return false;
        let cfg = getConfigurator();
        if (cfg && typeof cfg.isConfigNode === 'function') return cfg.isConfigNode(node);
        return isConfigNodeType(node.type);
    }

    // Drop wires targeting nodes with no inputs (inject / comment / ...).
    function pruneInvalidInputWires(flowNodes) {
        if (!Array.isArray(flowNodes)) return;
        let noInputIds = {};
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

    // Strip stray wires from nodes with no outputs (comment).
    function pruneInvalidOutputWires(flowNodes) {
        if (!Array.isArray(flowNodes)) return;
        flowNodes.forEach(function(n) {
            if (!n || !n.type) return;
            if (!nodeCanEmitOutput(n.type)) {
                if (Array.isArray(n.wires) && n.wires.some(function(p) {
                    return Array.isArray(p) && p.length > 0;
                })) {
                    n.wires = [];
                }
            }
        });
    }

    // Remove x/y/wires/z from runtime-detected config nodes that the static
    // suffix check missed.
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

    function buildFlowLookup(flowNodes, cfg) {
        let p = getParser();
        return p ? p.buildFlowLookup(flowNodes, cfg)
                 : { aliasToId: {}, idToAlias: {}, nameToId: {}, byId: {}, inter: null, resolve: function() { return null; } };
    }
    function extractLastVibeSchema(messageContent) {
        let p = getParser(); let cfg = getConfigurator();
        return (p && cfg) ? p.extractVibeSchema(messageContent, cfg) : null;
    }
    function extractConnectionHints(messageContent) {
        let p = getParser(); let cfg = getConfigurator();
        return (p && cfg) ? p.extractConnectionHints(messageContent, cfg) : [];
    }
    function extractFlowDirectives(messageContent) {
        let p = getParser(); let cfg = getConfigurator();
        return (p && cfg) ? p.extractFlowDirectives(messageContent, cfg) : { removeTokens: [], removeConnections: [], repositionTokens: [] };
    }
    function extractFlowNodes(messageContent, options) {
        let p = getParser(); let cfg = getConfigurator();
        return (p && cfg) ? p.extractFlowNodes(messageContent, options, cfg) : null;
    }

    // ================================================================== //
    //  Apply Mode                                                         //
    // ================================================================== //

    // The legacy `applyMode` field is no longer honoured — every import is
    // a merge: listed nodes are added or updated, aliases mapped to `null`
    // are deleted, anything else stays. The field is silently ignored when
    // older schemas or model outputs still carry it.

    // ================================================================== //
    //  Apply Connection Hints                                             //
    // ================================================================== //

    function applyConnectionHints(flowNodes, hints) {
        if (!Array.isArray(flowNodes) || !Array.isArray(hints) || hints.length === 0) return flowNodes;

        let cfg = getConfigurator();
        let lookup = buildFlowLookup(flowNodes, cfg);

        let desiredByFromPort = {};
        hints.forEach(function(h) {
            // exactOnly: a hint's alias must match a real alias/name/ID
            // exactly. Fuzzy matching here is unsafe  - a new-node alias
            // like "inject_py_1" can prefix-match an existing "inject"
            // and silently reroute every connection to the wrong node.
            // New-to-new wires are already baked into node.wires by
            // toNodeRed, so we only need hints to land when they
            // reference something unambiguously.
            let fromId = lookup.resolve(h.from, { exactOnly: true });
            let toId = lookup.resolve(h.to, { exactOnly: true });
            if (!fromId || !toId || !lookup.byId[fromId] || !lookup.byId[toId]) return;
            // Skip connections targeting nodes that cannot accept input
            let targetNode = lookup.byId[toId];
            if (targetNode && !nodeCanAcceptInput(targetNode.type)) return;
            let port = (typeof h.fromPort === 'number' && h.fromPort >= 0) ? h.fromPort : 0;
            let key = fromId + '::' + port;
            if (!desiredByFromPort[key]) desiredByFromPort[key] = [];
            if (desiredByFromPort[key].indexOf(toId) === -1) desiredByFromPort[key].push(toId);
        });

        Object.keys(desiredByFromPort).forEach(function(key) {
            let sep = key.lastIndexOf('::');
            let fromId = key.substring(0, sep);
            let port = parseInt(key.substring(sep + 2), 10);
            let fromNode = lookup.byId[fromId];
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
        return LLMPlugin.UI ? LLMPlugin.UI.getActiveWorkspaceId() : null;
    }

    function isCanvasNode(node) {
        let cfg = getConfigurator();
        if (cfg && typeof cfg.isCanvasNode === 'function') return cfg.isCanvasNode(node);
        if (!node || typeof node !== 'object') return false;
        if (typeof node.type !== 'string' || !node.type.trim()) return false;
        if (node.type === 'tab' || String(node.type).indexOf('subflow:') === 0) return false;
        return !isConfigNodeObj(node);
    }

    // Collect canvas-level entities of a workspace, separated by type
    // because Node-RED's remove API is type-specific:
    //   nodes      -> RED.nodes.remove(id)
    //   groups     -> RED.nodes.removeGroup(groupObj)
    //   junctions  -> RED.nodes.removeJunction(juncObj)
    function collectWorkspaceEntities(wsId) {
        let out = { nodes: [], groups: [], junctions: [] };
        if (!RED || !RED.nodes) return out;
        if (typeof RED.nodes.filterNodes === 'function') out.nodes = RED.nodes.filterNodes({ z: wsId }) || [];
        if (typeof RED.nodes.groups === 'function')      out.groups = RED.nodes.groups(wsId) || [];
        if (typeof RED.nodes.junctions === 'function')   out.junctions = RED.nodes.junctions(wsId) || [];
        return out;
    }

    // Repaint the canvas after a destructive flow change. Node-RED's
    // _redraw only repaints a node / group / junction body when its
    // `dirty` flag is set, so without this step a plain redraw after
    // RED.nodes.import paints wires but leaves the bodies blank.
    // Marks every canvas-level entity in the touched workspaces, then
    // forces a sync redraw plus one rAF-deferred redraw (the latter
    // covers cases where the SVG <g> for new nodes hadn't attached
    // yet, e.g. when checkpoint restore switches tabs in the same tick).
    function refreshCanvasView(workspaceIds) {
        if (!RED || !RED.view) return;
        try { RED.actions.invoke('core:select-none'); } catch (e) { /* ignore */ }
        try { RED.nodes.dirty(true); } catch (e) { /* ignore */ }

        function markAndRedraw() {
            (workspaceIds || []).forEach(function(wsId) {
                let ents = collectWorkspaceEntities(wsId);
                ents.nodes.forEach(function(n)     { if (n) n.dirty = true; });
                ents.groups.forEach(function(g)    { if (g) g.dirty = true; });
                ents.junctions.forEach(function(j) { if (j) j.dirty = true; });
            });
            try { RED.view.redraw(true, true); } catch (e) { /* ignore */ }
        }

        markAndRedraw();
        let raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
            ? window.requestAnimationFrame.bind(window)
            : function(cb) { return setTimeout(cb, 16); };
        raf(markAndRedraw);
    }

    // ================================================================== //
    //  Rebuild Workspace Flow                                             //
    // ================================================================== //

    function rebuildWorkspaceFromSnapshot(beforeFlow, updateNodes, workspaceId, connectionHints, flowDirectives) {
        let base = Array.isArray(beforeFlow)
            ? JSON.parse(JSON.stringify(beforeFlow))
            : [];
        let updates = Array.isArray(updateNodes)
            ? JSON.parse(JSON.stringify(updateNodes))
            : [];

        // Snapshot existing positions so placeAddedNodesNearNeighbors can
        // restore them when only new nodes need placing.
        let basePositions = {};
        base.forEach(function(n) {
            if (n && n.id && typeof n.x === 'number' && typeof n.y === 'number') {
                basePositions[n.id] = { x: n.x, y: n.y };
            }
        });
        let directives = flowDirectives || { removeTokens: [], removeConnections: [], repositionTokens: [] };

        function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

        function removeNodesByTokens(nodes, removeTokens) {
            if (!Array.isArray(removeTokens) || removeTokens.length === 0) return nodes;
            let cfg = getConfigurator();
            let lookup = buildFlowLookup(nodes, cfg);
            let removeIdSet = {};

            removeTokens.forEach(function(tok) {
                let t = String(tok || '').trim();
                if (!t) return;
                let id = lookup.resolve(t, { minLen: 8 });
                if (id) {
                    let targetNode = lookup.byId[id];
                    // Config nodes are never deleted by the LLM.
                    if (targetNode && !isCanvasNode(targetNode) && targetNode.type !== 'tab') {
                        return;
                    }
                    removeIdSet[id] = true;
                }
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

        let baseIds = {};
        base.forEach(function(n) { if (n && n.id) baseIds[n.id] = true; });

        let byId = {};
        base.forEach(function(n) { if (n && n.id) byId[n.id] = n; });

        // Identity / placement / editor-state keys never carried over from
        // existing to proposed during the merge.
        let MERGE_SKIP_KEYS = {
            id: 1, type: 1, z: 1, x: 1, y: 1, wires: 1, g: 1,
            dirty: 1, changed: 1, selected: 1, valid: 1, h: 1, w: 1
        };

        // Restore every existing-node property the LLM did not explicitly
        // touch. "Explicitly touched" = key listed in n._llmSpecKeys (Vibe
        // Schema path), or key has a defined value on n (raw JSON path).
        // See src/README.md "importFlowFromMessage" for the rationale.
        function preserveUnmentionedProperties(n, existing) {
            if (!existing) return;
            let llmKeys = Array.isArray(n._llmSpecKeys) ? n._llmSpecKeys : null;
            Object.keys(existing).forEach(function(key) {
                if (MERGE_SKIP_KEYS[key]) return;
                if (key.charAt(0) === '_') return;     // editor / plugin internals
                let llmExplicitlySet = llmKeys
                    ? (llmKeys.indexOf(key) !== -1)
                    : (n[key] !== undefined);
                if (llmExplicitlySet) return;
                n[key] = deepClone(existing[key]);
            });
        }

        updates.forEach(function(n) {
            if (!n || !n.id) return;
            // Config Node Protection: the LLM may only reference existing
            // config nodes, never create new ones.
            if (!isCanvasNode(n) && n.type !== 'tab' && !byId[n.id]) {
                return;
            }
            if (n._autoStub && byId[n.id]) return;
            let existing = byId[n.id];
            if (existing) {
                // Additive wire merge — existing connections are only ever
                // severed by `directives.removeConnections` below.
                if (Array.isArray(existing.wires) && existing.wires.length > 0) {
                    let maxPorts = Math.max(
                        Array.isArray(n.wires) ? n.wires.length : 0,
                        existing.wires.length
                    );
                    let merged = [];
                    for (let p = 0; p < maxPorts; p++) {
                        let oldPort = Array.isArray(existing.wires[p]) ? existing.wires[p] : [];
                        let newPort = (Array.isArray(n.wires) && Array.isArray(n.wires[p])) ? n.wires[p] : [];
                        merged[p] = mergeWireIds(oldPort, newPort);
                    }
                    n.wires = merged;
                }
                preserveUnmentionedProperties(n, existing);
            }
            byId[n.id] = n;
        });

        let rebuilt = Object.keys(byId).map(function(id) { return byId[id]; });

        // Second deletion pass catches nodes that updates just added.
        rebuilt = removeNodesByTokens(rebuilt, directives.removeTokens);

        if (Array.isArray(directives.removeConnections) && directives.removeConnections.length > 0) {
            let rcLookup = buildFlowLookup(rebuilt, getConfigurator());

            directives.removeConnections.forEach(function(rc) {
                let fromId = rcLookup.resolve(rc.from);
                let toId = rcLookup.resolve(rc.to);
                if (!fromId || !toId || !rcLookup.byId[fromId]) return;
                let port = (typeof rc.fromPort === 'number' && rc.fromPort >= 0) ? rc.fromPort : 0;
                let fromNode = rcLookup.byId[fromId];
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
        let validIds = {};
        rebuilt.forEach(function(n) { if (n && n.id) validIds[n.id] = true; });
        rebuilt.forEach(function(n) {
            if (!n || !Array.isArray(n.wires)) return;
            n.wires = n.wires.map(function(port) {
                if (!Array.isArray(port)) return [];
                return port.filter(function(tid) { return !!validIds[tid]; });
            });
        });

        applyConnectionHints(rebuilt, connectionHints || []);

        // Resolve comment `above: <alias>` references to real node ids.
        // The alias may name a NEW node from the same schema (look up its
        // _llmAlias on rebuilt) or an EXISTING node from the live flow
        // (look up via toIntermediate's aliasToId / nameToId).
        (function resolveCommentAboveRefs() {
            let cfg = getConfigurator();
            let aboveCandidates = rebuilt.filter(function(n) {
                return n && n.type === 'comment' && typeof n._llmAbove === 'string' && n._llmAbove.length > 0;
            });
            if (aboveCandidates.length === 0) return;
            let newByAlias = {};
            rebuilt.forEach(function(n) {
                if (n && n.id && typeof n._llmAlias === 'string') newByAlias[n._llmAlias] = n.id;
            });
            let existingLookup = buildFlowLookup(rebuilt, cfg);
            aboveCandidates.forEach(function(c) {
                let want = c._llmAbove;
                let id = newByAlias[want]
                      || (existingLookup.aliasToId && existingLookup.aliasToId[want])
                      || existingLookup.resolve(want);
                if (id && id !== c.id) c._llmAboveId = id;
            });
        })();

        // _llmOrder is stripped after layout — the layout passes consume it.
        rebuilt.forEach(function(n) {
            if (!n) return;
            delete n._llmAlias;
            delete n._autoStub;
            delete n._llmFlow;
            delete n._llmSpecKeys;
            delete n._llmAbove;
        });

        pruneInvalidInputWires(rebuilt);
        pruneInvalidOutputWires(rebuilt);
        fixConfigNodeProperties(rebuilt);

        let layout = window.LLMPlugin && window.LLMPlugin.CanvasLayout;
        if (layout) {
            // Prefer Node-RED's live `.w` (measured from the rendered SVG)
            // for existing nodes when the label is unchanged. If the LLM
            // renamed the node or changed its type the cached width no
            // longer matches the post-import label, so fall back to the
            // estimate which can grow the column to fit the new label.
            function liveNodeWidth(n) {
                if (!n || !n.id) return undefined;
                if (typeof RED === 'undefined' || !RED.nodes || typeof RED.nodes.node !== 'function') return undefined;
                try {
                    let live = RED.nodes.node(n.id);
                    if (!live || typeof live.w !== 'number' || live.w <= 0) return undefined;
                    let liveLabel = (typeof live.name === 'string' && live.name.trim()) ? live.name : (live.type || '');
                    let newLabel  = (typeof n.name    === 'string' && n.name.trim())    ? n.name    : (n.type    || '');
                    if (liveLabel !== newLabel) return undefined;
                    return live.w;
                } catch (e) { /* ignore */ }
                return undefined;
            }
            let layoutOpts = {
                startX: LAYOUT.startX, startY: LAYOUT.startY,
                spacingY: LAYOUT.spacingY,
                edgeGap: LAYOUT.edgeGap,
                componentGap: LAYOUT.componentGap,
                bandGap: LAYOUT.componentGap,
                maxColumns: LAYOUT.maxColumns,
                isCanvasNode: isCanvasNode,
                getNodeWidth: liveNodeWidth
            };
            if (Object.keys(baseIds).length === 0) {
                // Fresh flow: honour maxColumns so long chains fold neatly.
                layout.reflowCanvasNodes(rebuilt, layoutOpts);
            } else {
                // Incremental edit: disable column folding so the existing
                // flow shape is preserved and new nodes just extend right.
                let incrementalOpts = Object.assign({}, layoutOpts, { maxColumns: Infinity });
                layout.placeAddedNodesNearNeighbors(rebuilt, baseIds, basePositions, incrementalOpts);
            }

            // Selective reposition: relayout the named subset in place,
            // keeping their IDs and properties. Runs AFTER the general
            // layout pass so coordinates of unaffected nodes are stable.
            if (Array.isArray(directives.repositionTokens) && directives.repositionTokens.length > 0) {
                repositionSubsetByAliases(rebuilt, directives.repositionTokens, layoutOpts);
            }
        }

        rebuilt.forEach(function(n) { if (n) delete n._llmOrder; });

        return rebuilt;
    }

    // Selective layout: reflow only the nodes named by `aliases` (and any
    // already-existing wires between them), keeping their IDs intact. The
    // subset is translated back to its previous top-left corner so the
    // rest of the canvas is undisturbed. Comment captions anchored above
    // any subset node are carried along by capture/apply so they don't
    // get left behind their target's old position.
    function repositionSubsetByAliases(allNodes, aliases, layoutOpts) {
        if (!Array.isArray(aliases) || aliases.length === 0) return;
        let layout = window.LLMPlugin && window.LLMPlugin.CanvasLayout;
        if (!layout || typeof layout.reflowCanvasNodes !== 'function') return;

        let commentAnchors = (typeof layout.captureCommentAnchors === 'function')
            ? layout.captureCommentAnchors(allNodes, layoutOpts)
            : null;

        let cfg = getConfigurator();
        let lookup = buildFlowLookup(allNodes, cfg);

        let subsetIdSet = {};
        aliases.forEach(function(a) {
            let id = lookup.resolve(a, { exactOnly: true }) || lookup.resolve(a);
            if (!id) return;
            let n = lookup.byId[id];
            if (n && isCanvasNode(n)) subsetIdSet[id] = true;
        });

        let subsetNodes = allNodes.filter(function(n) {
            return n && n.id && subsetIdSet[n.id];
        });
        if (subsetNodes.length < 1) return;

        // Anchor the subset to its current top-left so unrelated nodes
        // around it don't visually shift.
        let origMinX = Infinity, origMinY = Infinity;
        subsetNodes.forEach(function(n) {
            if (typeof n.x === 'number' && n.x < origMinX) origMinX = n.x;
            if (typeof n.y === 'number' && n.y < origMinY) origMinY = n.y;
        });
        if (!isFinite(origMinX)) origMinX = LAYOUT.startX;
        if (!isFinite(origMinY)) origMinY = LAYOUT.startY;

        // Clone with wires restricted to the subset so reflowCanvasNodes
        // only sees the internal adjacency.
        let clones = subsetNodes.map(function(n) {
            let c = JSON.parse(JSON.stringify(n));
            if (Array.isArray(c.wires)) {
                c.wires = c.wires.map(function(port) {
                    if (!Array.isArray(port)) return [];
                    return port.filter(function(tid) { return subsetIdSet[tid]; });
                });
            }
            return c;
        });

        let opts = Object.assign({}, layoutOpts || {}, {
            startX: LAYOUT.startX,
            startY: LAYOUT.startY,
            maxColumns: Infinity,
            isCanvasNode: isCanvasNode
        });
        layout.reflowCanvasNodes(clones, opts);

        let newMinX = Infinity, newMinY = Infinity;
        clones.forEach(function(c) {
            if (typeof c.x === 'number' && c.x < newMinX) newMinX = c.x;
            if (typeof c.y === 'number' && c.y < newMinY) newMinY = c.y;
        });
        if (!isFinite(newMinX) || !isFinite(newMinY)) return;

        let dx = origMinX - newMinX;
        let dy = origMinY - newMinY;

        let cloneById = {};
        clones.forEach(function(c) { cloneById[c.id] = c; });
        subsetNodes.forEach(function(n) {
            let c = cloneById[n.id];
            if (!c) return;
            if (typeof c.x === 'number') n.x = c.x + dx;
            if (typeof c.y === 'number') n.y = c.y + dy;
        });

        // Re-align captions to follow their (now moved) anchor target.
        if (commentAnchors && typeof layout.applyCommentAnchors === 'function') {
            layout.applyCommentAnchors(allNodes, commentAnchors);
        }
    }

    // ================================================================== //
    //  Replace Workspace Flow                                             //
    // ================================================================== //

    function replaceWorkspaceFlow(nodes, targetWorkspaceId) {
        let workspaceId = (targetWorkspaceId && typeof targetWorkspaceId === 'string')
            ? targetWorkspaceId
            : getActiveWorkspaceId();
        if (!workspaceId) return { ok: false, error: 'Active workspace not found' };

        let backupEntitiesJSON = [];
        try {
            let ents = collectWorkspaceEntities(workspaceId);
            let canvasNodes = ents.nodes.filter(isCanvasNode);
            backupEntitiesJSON = canvasNodes.map(function(n) { return JSON.parse(JSON.stringify(n)); });
            canvasNodes.forEach(function(n) {
                try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ }
            });
            ents.junctions.forEach(function(j) {
                try { RED.nodes.removeJunction(j); } catch (e) { /* ignore */ }
            });
            ents.groups.forEach(function(g) {
                try { RED.nodes.removeGroup(g); } catch (e) { /* ignore */ }
            });
            // Flush d3 exit() before re-importing so any same-id node from
            // the new flow gets a fresh <g> + enter() (computes w/h).
            try { RED.view.redraw(true, true); } catch (e) { /* ignore */ }
        } catch (e) {
            return { ok: false, error: 'Failed to clear current workspace nodes: ' + (e.message || e) };
        }

        // Tabs are dropped (RED.nodes.import would dup the workspace label);
        // canvas nodes are pinned to workspaceId; already-present config
        // nodes are diverted to an in-place update path.
        let configNodesToUpdate = [];
        let importNodes = (nodes || []).map(function(n) {
            let nn = JSON.parse(JSON.stringify(n));
            if (isCanvasNode(nn)) nn.z = workspaceId;
            return nn;
        }).filter(function(nn) {
            if (nn.type === 'tab') return false;
            if (!isCanvasNode(nn)) {
                let existing = RED.nodes.node(nn.id);
                if (existing) {
                    configNodesToUpdate.push(nn);
                    return false;
                }
            }
            return true;
        });

        // Update existing config nodes in-place (properties only; no re-import)
        configNodesToUpdate.forEach(function(nn) {
            try {
                // Auto-created stubs have no real props - skip to preserve existing settings
                if (nn._autoStub) return;
                let existing = RED.nodes.node(nn.id);
                if (!existing) return;

                let isDirty = false;
                Object.keys(nn).forEach(function(key) {
                    if (key === 'id' || key === 'type') return;
                    if (existing[key] !== nn[key] &&
                        JSON.stringify(existing[key]) !== JSON.stringify(nn[key])) {
                        existing[key] = nn[key];
                        isDirty = true;
                    }
                });

                if (isDirty) {
                    existing.dirty = true;
                    existing.changed = true;
                }
            } catch (e) {
                console.warn('[LLM Plugin] Failed to update config node:', nn.id, e);
            }
        });

        try {
            // Bypass RED.history — rewind via the plugin's checkpoints instead.
            RED.nodes.import(importNodes, { generateIds: false, reimport: true, addFlow: false });
            try { RED.workspaces.refresh(); } catch (e) { /* ignore */ }
            refreshCanvasView([workspaceId]);
            return { ok: true, count: importNodes.length, configUpdated: configNodesToUpdate.length };
        } catch (e) {
            postTerminalLog('error', 'import-nodes-error', 'RED.nodes.import threw an error', { error: e && e.message ? e.message : String(e) });
            try {
                if (backupEntitiesJSON.length > 0) {
                    RED.nodes.import(backupEntitiesJSON, { generateIds: false, reimport: true, addFlow: false });
                    try { RED.workspaces.refresh(); } catch (e3) { /* ignore */ }
                    refreshCanvasView([workspaceId]);
                }
            } catch (e2) { /* ignore */ }
            return { ok: false, error: 'Failed to import restored flow: ' + (e.message || e) };
        }
    }

    // ================================================================== //
    //  Multi-flow Dispatch Helpers                                        //
    // ================================================================== //

    function getActiveWorkspaceLabel() {
        let id = getActiveWorkspaceId();
        if (!id || !window.RED || !RED.nodes) return null;
        let ws = RED.nodes.workspace(id);
        if (ws && ws.label) return ws.label;
        return id;
    }

    // Group canvas nodes by their Vibe Schema `flow` label so each group
    // can target its own workspace. Untagged canvas nodes fall into the
    // active flow when any other node is tagged.
    function collectFlowGroupsFromSchema(schema) {
        if (!schema || !schema.nodes || typeof schema.nodes !== 'object') return null;
        let groups = {};
        let untagged = [];
        Object.keys(schema.nodes).forEach(function(alias) {
            let spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;
            if (spec.config === true) return;
            if (spec.type === 'tab' || String(spec.type).toLowerCase() === 'tab') return;
            if (spec.type && isConfigNodeType(spec.type)) return;
            let flow = (typeof spec.flow === 'string') ? spec.flow.trim() : '';
            if (!flow) { untagged.push(alias); return; }
            if (!groups[flow]) groups[flow] = [];
            groups[flow].push(alias);
        });
        if (untagged.length > 0 && Object.keys(groups).length > 0) {
            let activeLabel = getActiveWorkspaceLabel();
            if (activeLabel) {
                if (!groups[activeLabel]) groups[activeLabel] = [];
                untagged.forEach(function(a) { groups[activeLabel].push(a); });
            }
        }
        return groups;
    }

    // Slice a schema down to one flow: its tagged canvas nodes, all
    // untagged (config / shared) nodes, and connections internal to it.
    function buildSubSchemaForFlow(schema, aliases) {
        let aliasSet = {};
        aliases.forEach(function(a) { aliasSet[a] = true; });
        let subNodes = {};

        aliases.forEach(function(alias) {
            if (Object.prototype.hasOwnProperty.call(schema.nodes || {}, alias)) {
                subNodes[alias] = schema.nodes[alias];
            }
        });
        Object.keys(schema.nodes || {}).forEach(function(alias) {
            if (aliasSet[alias]) return;
            let spec = schema.nodes[alias];
            if (spec === null) { subNodes[alias] = spec; return; }
            if (!spec || typeof spec !== 'object') return;
            let isUntagged = !spec.flow || typeof spec.flow !== 'string' || !spec.flow.trim();
            if (isUntagged) subNodes[alias] = spec;
        });

        let subConns = [];
        (schema.connections || []).forEach(function(c) {
            if (!c || typeof c !== 'object') return;
            if (c.remove && typeof c.remove === 'object') {
                let r = c.remove;
                if (aliasSet[r.from] && aliasSet[r.to]) subConns.push(c);
                return;
            }
            if (aliasSet[c.from] && aliasSet[c.to]) subConns.push(c);
        });

        let out = {
            nodes: subNodes,
            connections: subConns
        };
        if (typeof schema.description === 'string') out.description = schema.description;
        if (Array.isArray(schema.remove)) {
            out.remove = schema.remove.filter(function(t) { return aliasSet[t]; });
        }
        return out;
    }

    async function dispatchMultiFlowImport(messageContent, schema, flowGroups, options) {
        let results = [];
        let aggregatedAdded = 0;
        let aggregatedImported = 0;
        let unresolved = [];
        let flowLabels = Object.keys(flowGroups);

        for (let li = 0; li < flowLabels.length; li++) {
            let label = flowLabels[li];
            let wsId = resolveFlowLabelToWorkspace(label);
            if (!wsId) { unresolved.push(label); continue; }

            let subSchema = buildSubSchemaForFlow(schema, flowGroups[label]);
            let subMessage = '```json\n' + JSON.stringify(subSchema, null, 2) + '\n```';
            try {
                let res = await Importer.importFlowFromMessage(subMessage, Object.assign({}, options, {
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

        let allOk = results.length > 0 && results.every(function(r) { return r && r.ok; });
        return {
            ok: allOk,
            multiFlow: true,
            results: results,
            importedCount: aggregatedImported,
            addedNodeCount: aggregatedAdded
        };
    }

    // ================================================================== //
    //  Main Import Entry Point                                            //
    // ================================================================== //

    Importer.importFlowFromMessage = async function(messageContent, options) {
        options = options || {};
        try {
            // Multi-flow dispatch: when the schema tags nodes with `flow`,
            // split the proposal per workspace before importing.
            if (!options._isSubImport) {
                let dispatchSchema = extractLastVibeSchema(messageContent);
                let flowGroups = collectFlowGroupsFromSchema(dispatchSchema);
                let flowLabels = flowGroups ? Object.keys(flowGroups) : [];
                if (flowLabels.length > 1) {
                    return await dispatchMultiFlowImport(messageContent, dispatchSchema, flowGroups, options);
                }
                if (flowLabels.length === 1) {
                    let targetLabel = flowLabels[0];
                    let onlyWs = resolveFlowLabelToWorkspace(targetLabel);
                    if (onlyWs) {
                        options = Object.assign({}, options, { targetWorkspaceId: onlyWs });
                    } else {
                        if (window.RED && RED.notify) {
                            RED.notify('Target flow "' + targetLabel + '" not found. Using current workspace instead.', 'warning');
                        }
                    }
                }
            }

            let targetWs = (options.targetWorkspaceId && typeof options.targetWorkspaceId === 'string')
                ? options.targetWorkspaceId
                : null;
            let beforeFlow = safeGetCurrentFlow(targetWs);

            let hasExistingFlow = Array.isArray(beforeFlow) && beforeFlow.length > 0;
            let parsedSchema = extractLastVibeSchema(messageContent);
            let connectionHints = extractConnectionHints(messageContent);
            let flowDirectives = extractFlowDirectives(messageContent);

            let nodes = extractFlowNodes(messageContent, {
                mode: options.mode,
                currentFlow: beforeFlow
            });

            // Strip tab nodes early — they're definitions, not canvas content.
            if (Array.isArray(nodes)) {
                nodes = nodes.filter(function(n) { return n && n.type && String(n.type).toLowerCase() !== 'tab'; });
            }

            if (!nodes || nodes.length === 0) {
                if (connectionHints.length > 0 ||
                    (flowDirectives.removeTokens || []).length > 0 ||
                    (flowDirectives.removeConnections || []).length > 0 ||
                    (flowDirectives.repositionTokens || []).length > 0) {
                    nodes = [];
                } else {
                    // Try to surface a real parse error so users can act on
                    // a malformed JSON block (e.g. an unescaped JSONata
                    // quote) instead of the generic "no JSON" message.
                    let parser = getParser();
                    let diag = (parser && typeof parser.diagnoseJsonExtractionFailure === 'function')
                        ? parser.diagnoseJsonExtractionFailure(messageContent)
                        : null;
                    if (diag) {
                        let where = (diag.line && diag.column)
                            ? ' (line ' + diag.line + ', col ' + diag.column + ')'
                            : '';
                        let near = diag.snippet ? ' Near: …' + diag.snippet + '…' : '';
                        let detail = 'JSON parse failed' + where + ': ' + diag.error + '.' + near;
                        if (window.RED && RED.notify) {
                            RED.notify(detail, { type: 'warning', timeout: 12000 });
                        }
                        try { console.warn('[LLM Plugin] JSON parse failed:', diag); } catch (e) {}
                        postTerminalLog('warn', 'json-parse-failed',
                            'LLM response contained a fenced code block that failed to parse',
                            { line: diag.line, column: diag.column, error: diag.error });
                        return { ok: false, error: detail };
                    }
                    if (window.RED && RED.notify) RED.notify('No JSON flow found in message', 'warning');
                    return { ok: false, error: 'No JSON flow found in message' };
                }
            }

            let currentWorkspace = targetWs || getActiveWorkspaceId();

            // Build unified lookup from current flow
            let cfg = getConfigurator();
            let lookup = hasExistingFlow
                ? buildFlowLookup(beforeFlow, cfg)
                : buildFlowLookup([], null);

            // Resolve hint/directive aliases to real IDs. exactOnly avoids
            // a fuzzy match from hijacking unrelated nodes.
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
            // Reposition tokens stay as aliases; they're resolved later
            // against the rebuilt flow so newly added nodes from the same
            // schema can also be included by alias.

            // Checkpoints come from ChatManager.saveImportCheckpoint, taken
            // by the UI immediately before this import runs.
            let beforeIdSet = new Set();
            (beforeFlow || []).forEach(function(n) {
                if (n && n.id) beforeIdSet.add(n.id);
            });

            // Live-editor state used during the import: every known node id
            // (so freshly generated ids never collide) and a per-type index of
            // config nodes (for singleton config-node reuse).
            let existingIds = new Set();
            let existingConfigByType = {};
            let claimedExistingIds = {};
            let remappedIds = {};

            if (window.RED && RED.nodes) {
                RED.nodes.eachNode(function(n) { existingIds.add(n.id); });
                if (RED.nodes.eachConfig) {
                    RED.nodes.eachConfig(function(n) {
                        existingIds.add(n.id);
                        if (n && n.id && n.type) {
                            let ct = String(n.type).trim().toLowerCase();
                            if (!existingConfigByType[ct]) existingConfigByType[ct] = [];
                            existingConfigByType[ct].push(n);
                        }
                    });
                }
            }

            // Pre-pass: every proposed node claims its exact-alias match
            // first, so later passes can't steal those IDs.
            let preResolvedAlias = {};
            nodes.forEach(function(n, idx) {
                if (!n || !n._llmAlias) return;
                let exactId = lookup.resolve(n._llmAlias, { exactOnly: true });
                if (!exactId || claimedExistingIds[exactId]) return;
                let existing = RED.nodes.node(exactId);
                if (!existing) return;
                if (!currentWorkspace || existing.z === currentWorkspace || !existing.z) {
                    preResolvedAlias[idx] = exactId;
                    claimedExistingIds[exactId] = true;
                }
            });

            // Map each proposed node to an existing match or mark it new.
            let newNodes = nodes.map(function(n, idx) {
                let nn = JSON.parse(JSON.stringify(n));
                nn.type = String(nn.type || '').trim();

                let replacedExisting = null;

                // 1. Alias-based matching (primary): exact-alias only.
                // The LLM gets every existing alias in its prompt context, so
                // a non-matching alias means "add as new" — never fuzzy-match,
                // which would silently overwrite an unrelated node.
                if (nn._llmAlias) {
                    let aliasId = preResolvedAlias[idx] || null;
                    if (aliasId) {
                        let byAlias = RED.nodes.node(aliasId);
                        // Allow matching for: same workspace nodes, OR config nodes
                        // (config nodes have no z / empty z — they live outside workspaces)
                        if (byAlias && (!currentWorkspace || byAlias.z === currentWorkspace || !byAlias.z)) {
                            replacedExisting = byAlias;
                        }
                    }
                }

                // 2. Singleton config node: reuse the lone existing match
                //    by type to avoid duplicating it.
                if (!replacedExisting && isConfigNodeObj(nn)) {
                    let configTypeKey = String(nn.type).trim().toLowerCase();
                    let sameTypeCandidates = existingConfigByType[configTypeKey] || [];
                    let unclaimedCandidates = sameTypeCandidates.filter(function(c) {
                        return !claimedExistingIds[c.id];
                    });
                    if (unclaimedCandidates.length === 1) {
                        replacedExisting = unclaimedCandidates[0];
                    }
                }

                if (replacedExisting) {
                    let originalId = nn.id;
                    claimedExistingIds[replacedExisting.id] = true;
                    nn.id = replacedExisting.id;
                    if (originalId && originalId !== nn.id) {
                        remappedIds[originalId] = nn.id;
                    }

                    // Stub-only payloads keep the ID remap (so refs are
                    // rewired) but never overwrite the real config node.
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
                        let maxPorts = Math.max(nn.wires.length, replacedExisting.wires.length);
                        let mergedWires = [];
                        for (let p = 0; p < maxPorts; p++) {
                            mergedWires[p] = mergeWireIds(replacedExisting.wires[p], nn.wires[p]);
                        }
                        nn.wires = mergedWires;
                    }
                } else {
                    if (nn._autoStub) {
                        existingIds.add(nn.id);
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

            // After ID remapping, update both `wires` and any string props
            // that referenced the pre-remap IDs (ui-group, mqtt-broker, …).
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

            let hasDirectives = (flowDirectives.removeTokens || []).length > 0 ||
                                (flowDirectives.removeConnections || []).length > 0 ||
                                (flowDirectives.repositionTokens || []).length > 0 ||
                                (connectionHints || []).length > 0;
            if (!newNodes.length && !hasDirectives) {
                try {
                    if (window && window.RED && RED.notify)
                        RED.notify('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning');
                } catch(e) {}
                return { ok: false, error: 'No valid nodes after sanitization' };
            }

            let bad = newNodes.find(function(n) { return typeof n.type !== 'string' || n.type.length === 0; });
            if (bad) {
                if (RED && RED.notify) RED.notify('Import aborted: invalid node shape', 'error');
                console.warn('[LLM Plugin] bad node', bad);
                return { ok: false, error: 'Invalid node shape' };
            }

            let rebuiltFlow = rebuildWorkspaceFromSnapshot(beforeFlow, newNodes, currentWorkspace, connectionHints, flowDirectives);
            let rebuiltResult = replaceWorkspaceFlow(rebuiltFlow, currentWorkspace);
            if (!rebuiltResult || !rebuiltResult.ok) {
                let errMsg = (rebuiltResult && rebuiltResult.error) || 'Failed to rebuild flow from snapshot';
                if (window && window.RED && RED.notify) RED.notify('Import failed: ' + errMsg, 'error');
                return {
                    ok: false,
                    error: errMsg
                };
            }

            if (RED && RED.notify) RED.notify('Flow reloaded successfully', 'success');

            let addedNodes = rebuiltFlow.filter(function(n) {
                return !!(n && n.id) && !beforeIdSet.has(n.id);
            }).map(function(n) {
                return { id: n.id, type: n.type || '', name: n.name || '' };
            });

            if (addedNodes.length > 0) {
                try {
                    if (window.RED && RED.notify) {
                        RED.notify('Applied with ' + addedNodes.length + ' added node(s)', 'warning');
                    }
                } catch (e) { /* ignore */ }
            }

            return {
                ok: true,
                importedCount: rebuiltFlow.length,
                addedNodeCount: addedNodes.length,
                addedNodes: addedNodes
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

    function restoreMultiFlowCheckpoint(nodes) {
        return new Promise(function(resolve, reject) {
            if (!window.RED || !RED.nodes || !RED.view) {
                return reject(new Error("Node-RED API not available"));
            }
            try {
                // Identify target workspaces from the snapshot, falling
                // back to the active one if no `tab` / `z` is present.
                let ids = LLMPlugin.UI
                    ? LLMPlugin.UI.extractWorkspaceIds(nodes)
                    : (function() {
                        let m = {};
                        (nodes || []).forEach(function(n) {
                            if (n && n.type === 'tab' && n.id) m[n.id] = true;
                            if (n && n.z) m[n.z] = true;
                        });
                        return Object.keys(m);
                    })();
                if (ids.length === 0) {
                    let active = getActiveWorkspaceId();
                    if (active) ids = [active];
                }

                // Clear every non-tab canvas entity (regular nodes +
                // subflow instances + junctions + groups) via type-
                // specific Node-RED APIs. Config nodes (no `z`) are
                // left alone and patched in place below.
                ids.forEach(function(wsId) {
                    let ents = collectWorkspaceEntities(wsId);
                    ents.nodes.forEach(function(n) {
                        if (n && n.type !== 'tab') {
                            try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ }
                        }
                    });
                    ents.junctions.forEach(function(j) {
                        try { RED.nodes.removeJunction(j); } catch (e) { /* ignore */ }
                    });
                    ents.groups.forEach(function(g) {
                        try { RED.nodes.removeGroup(g); } catch (e) { /* ignore */ }
                    });
                });
                // Flush d3 exit() so id-reused nodes get fresh <g>s on import.
                try { RED.view.redraw(true, true); } catch (e) { /* ignore */ }

                // Partition: skip tabs, patch existing config nodes in
                // place, import the rest (canvas + missing configs).
                let importNodes = [];
                (nodes || []).forEach(function(n) {
                    if (!n || n.type === 'tab') return;
                    if (!isCanvasNode(n)) {
                        let existing = RED.nodes.node(n.id);
                        if (existing) {
                            let changed = false;
                            Object.keys(n).forEach(function(key) {
                                if (key === 'id' || key === 'type') return;
                                if (JSON.stringify(existing[key]) === JSON.stringify(n[key])) return;
                                existing[key] = n[key];
                                changed = true;
                            });
                            if (changed) { existing.dirty = true; existing.changed = true; }
                            return;
                        }
                    }
                    importNodes.push(n);
                });

                RED.nodes.import(importNodes, { generateIds: false, reimport: true, addFlow: false });
                try { RED.workspaces.refresh(); } catch (e) { /* ignore */ }
                refreshCanvasView(ids);

                resolve({ ok: true, msg: 'Checkpoint restored' });
            } catch (e) {
                reject(e);
            }
        });
    }

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
                let cp = data && data.checkpoint;
                if (!cp || !Array.isArray(cp.flow)) {
                    return { ok: false, error: 'Invalid checkpoint data' };
                }
                return restoreMultiFlowCheckpoint(cp.flow);
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
        let directives = extractFlowDirectives(messageContent);
        let hints = extractConnectionHints(messageContent);
        return (directives.removeTokens || []).length > 0 ||
               (directives.removeConnections || []).length > 0 ||
               (directives.repositionTokens || []).length > 0 ||
               hints.length > 0;
    };
})();



