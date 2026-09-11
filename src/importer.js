// Importer: parses LLM assistant messages and imports Node-RED flows.
// Supports both raw Node-RED JSON arrays and Vibe Schema (intermediate JSON).
//
// JSON parsing, token normalization, schema extraction, and flow lookup are
// implemented in src/core/llm_json_parser.js and accessed via LLMPlugin.LLMJsonParser.
(function(){
    let Importer = {};

    // Overrides passed to CanvasLayout. Every gap is an EDGE-TO-EDGE
    // clearance (visible whitespace), not a centre-to-centre distance.
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

    // client.js loads these before this file, so they are bound once here
    // instead of being re-read (and re-guarded) on every call.
    let Common    = window.LLMPlugin.Common;
    let Converter = window.LLMPlugin.FlowConverterCore;
    let Parser    = window.LLMPlugin.LLMJsonParser;

    // ================================================================== //
    //  Basic Utilities                                                    //
    // ================================================================== //

    let notify = Common.notify;

    function genId() { return Common.randomId('id_'); }

    function safeGetCurrentFlow(workspaceId) {
        // includeCanvasExtras: the rebuild base must carry the workspace's
        // junctions and groups so they survive the remove/reimport cycle and
        // wires that target a junction are not pruned as dangling.
        let opts = { includeCanvasExtras: true };
        return workspaceId
            ? LLMPlugin.UI.getFlowsByIds([workspaceId], opts)
            : LLMPlugin.UI.getCurrentFlow(undefined, opts);
    }

    // ------------------------------------------------------------------ //
    //  Workspace Scope                                                    //
    // ------------------------------------------------------------------ //
    // Every workspace decision below stays inside the flows sent to the LLM
    // as context. Auto-generated aliases are unique only WITHIN a flow, and
    // replaceWorkspaceFlow rebuilds its target destructively, so a global
    // scan can wipe a flow the conversation never saw. A null set means
    // unrestricted (no flow context was selected).

    function buildAllowedWorkspaceSet(ids) {
        if (!Array.isArray(ids) || ids.length === 0) return null;
        let set = {};
        let any = false;
        ids.forEach(function(id) {
            if (typeof id === 'string' && id) { set[id] = true; any = true; }
        });
        return any ? set : null;
    }

    function isWorkspaceAllowed(allowedSet, wsId) {
        return !allowedSet || (!!wsId && !!allowedSet[wsId]);
    }

    // Default target when the schema carries no usable `flow` tag: the
    // active tab, but only when it is in scope. Otherwise the first context
    // flow — the user may have switched tabs between Send and Import, and
    // the edit still belongs to the flow the LLM actually saw.
    function pickDefaultWorkspace(allowedSet) {
        let active = getActiveWorkspaceId();
        if (!allowedSet) return active;
        if (active && allowedSet[active]) return active;
        let ids = Object.keys(allowedSet);
        return ids.length > 0 ? ids[0] : null;
    }

    /**
     * Scan RED workspaces for a tab matching the given label (or ID).
     * Returns the workspace ID or null if no unique match exists.
     * `allowedSet` (optional) restricts the scan to the context flows, so a
     * label can never resolve onto an unrelated workspace.
     */
    function resolveFlowLabelToWorkspace(label, allowedSet) {
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
            if (!isWorkspaceAllowed(allowedSet, ws.id)) return;
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
        Common.apiFetch('llm-plugin/client-log', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    level: level || 'info',
                    event: event || 'importer',
                    message: String(message || ''),
                    meta: (meta && typeof meta === 'object') ? meta : {}
                })
        }).catch(function() { /* logging is best-effort */ });
    }

    // --- Runtime node-type helpers (thin wrappers over FlowConverterCore) ---

    function nodeCanAcceptInput(type) { return !Converter.isNoInputType(type); }
    function nodeCanEmitOutput(type)  { return !Converter.isNoOutputType(type); }
    function isConfigNodeType(type)   { return Converter.isConfigType(type); }
    function isConfigNodeObj(node)    { return Converter.isConfigNode(node); }

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

    function buildFlowLookup(flowNodes) {
        return Parser.buildFlowLookup(flowNodes, Converter);
    }
    function extractLastVibeSchema(messageContent) {
        return Parser.extractVibeSchema(messageContent, Converter);
    }
    function extractConnectionHints(messageContent) {
        return Parser.extractConnectionHints(messageContent, Converter);
    }
    function extractFlowDirectives(messageContent) {
        return Parser.extractFlowDirectives(messageContent, Converter);
    }
    function extractFlowNodes(messageContent, options) {
        return Parser.extractFlowNodes(messageContent, options, Converter);
    }

    // ================================================================== //
    //  Unified Alias Lookup                                               //
    // ================================================================== //

    // buildFlowLookup plus an index of the `_llmAlias` markers new nodes
    // carry. A new node's auto-alias is just its type ("function"), so
    // without this a connection to the LLM's "function_new" resolves the
    // source but loses the target.
    function buildUnifiedLookup(flowNodes) {
        let lookup = buildFlowLookup(flowNodes);
        if (Array.isArray(flowNodes)) {
            flowNodes.forEach(function(n) {
                if (!n || !n.id) return;
                if (typeof n._llmAlias !== 'string' || !n._llmAlias) return;
                // The _llmAlias is authoritative for new nodes; even if the
                // auto-alias map already had a different mapping for this
                // string, the schema's own alias wins.
                lookup.aliasToId[n._llmAlias] = n.id;
            });
        }
        return lookup;
    }

    // ================================================================== //
    //  Apply Connection Hints                                             //
    // ================================================================== //

    function applyConnectionHints(flowNodes, hints, precomputedLookup) {
        if (!Array.isArray(flowNodes) || !Array.isArray(hints) || hints.length === 0) return flowNodes;

        let lookup = precomputedLookup || buildUnifiedLookup(flowNodes);

        let desiredByFromPort = {};
        hints.forEach(function(h) {
            // exactOnly: fuzzy matching here would let a new-node alias
            // ("inject_py_1") prefix-match an existing "inject" and reroute
            // the connection to the wrong node. The unified lookup already
            // covers new nodes, so exact resolution is enough.
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
        return LLMPlugin.UI.getActiveWorkspaceId();
    }

    function isCanvasNode(node) { return Converter.isCanvasNode(node); }

    // Groups are canvas entities for z-assignment and re-import, but the
    // layout must never treat them as positionable nodes: a group's bounding
    // box always encloses its members, so feeding it to the collision passes
    // would make it fight its own contents. Junctions stay in — they are real
    // routing points with wires and belong in the adjacency graph.
    function isLayoutNode(node) {
        return isCanvasNode(node) && !(node && node.type === 'group');
    }

    // Collect canvas-level entities of a workspace, separated by type
    // because Node-RED's remove API is type-specific:
    //   nodes      -> RED.nodes.remove(id)
    //   groups     -> RED.nodes.removeGroup(groupObj)
    //   junctions  -> RED.nodes.removeJunction(juncObj)
    function collectWorkspaceEntities(wsId) {
        return {
            nodes:     RED.nodes.filterNodes({ z: wsId }) || [],
            groups:    RED.nodes.groups(wsId) || [],
            junctions: RED.nodes.junctions(wsId) || []
        };
    }

    // Node-RED's _redraw only repaints an entity whose `dirty` flag is set,
    // so after an import a plain redraw draws the wires and leaves the node
    // bodies blank. The second, rAF-deferred redraw covers new nodes whose
    // SVG <g> had not attached yet (checkpoint restore switching tabs).
    function refreshCanvasView(workspaceIds) {
        RED.actions.invoke('core:select-none');
        RED.nodes.dirty(true);

        function markAndRedraw() {
            (workspaceIds || []).forEach(function(wsId) {
                let ents = collectWorkspaceEntities(wsId);
                ents.nodes.forEach(function(n)     { n.dirty = true; });
                ents.groups.forEach(function(g)    { g.dirty = true; });
                ents.junctions.forEach(function(j) { j.dirty = true; });
            });
            RED.view.redraw(true, true);
        }

        markAndRedraw();
        window.requestAnimationFrame(markAndRedraw);
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

        // Returns { remainingNodes, removedIdSet } so Phase 2 can refuse to
        // re-introduce a just-deleted alias. Resolves removeTokens against
        // the provided nodes list (typically the original beforeFlow).
        function applyNodeDeletions(nodes, removeTokens) {
            let removedIdSet = {};
            if (!Array.isArray(removeTokens) || removeTokens.length === 0) {
                return { remainingNodes: nodes, removedIdSet: removedIdSet };
            }
            let lookup = buildFlowLookup(nodes);

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
                    removedIdSet[id] = true;
                }
                // Preserve the raw token too — Phase 2 also checks
                // _llmAlias against this set so a brand-new node carrying
                // the same alias as a delete directive cannot sneak in.
                removedIdSet[t] = true;
            });

            let removedRealIds = {};
            Object.keys(removedIdSet).forEach(function(k) {
                if (lookup.byId[k]) removedRealIds[k] = true;
            });
            if (Object.keys(removedRealIds).length === 0) {
                return { remainingNodes: nodes, removedIdSet: removedIdSet };
            }

            nodes = nodes.filter(function(n) {
                return !!(n && n.id) && !removedRealIds[n.id];
            });
            nodes.forEach(function(n) {
                if (!Array.isArray(n.wires)) return;
                n.wires = n.wires.map(function(port) {
                    if (!Array.isArray(port)) return [];
                    return port.filter(function(tid) { return !removedRealIds[tid]; });
                });
            });
            // A group's `nodes` is the other half of a member's `g`, and
            // deleting the member does not update it — RED.nodes.remove has
            // no group bookkeeping at all (verified in the 4.1 editor client;
            // the editor's own delete action calls RED.group.removeFromGroup
            // first). Left alone, the group keeps naming a node that no
            // longer exists, in the rebuilt flow and on the canvas after it.
            nodes.forEach(function(n) {
                if (!n || n.type !== 'group' || !Array.isArray(n.nodes)) return;
                n.nodes = n.nodes.filter(function(mid) { return !removedRealIds[mid]; });
            });
            return { remainingNodes: nodes, removedIdSet: removedIdSet };
        }

        // --- Phase 1: Delete ---
        // Edge deletions wait for Phase 3, which has the post-merge alias map
        // needed to resolve new-node endpoints.
        let deletion = applyNodeDeletions(base, directives.removeTokens);
        base = deletion.remainingNodes;
        let removedIdSet = deletion.removedIdSet;

        let baseIds = {};
        base.forEach(function(n) { if (n && n.id) baseIds[n.id] = true; });

        // Identity / placement / editor-state keys never carried over from
        // existing to proposed during the merge: each is supplied by something
        // else (`z` explicitly, `x`/`y` by the layout passes, `wires` by the
        // additive wire merge). `g` is NOT in this list and must not be —
        // nothing else restores group membership, and carrying it blindly is
        // safe because the schema can neither read nor write it.
        // See docs/{en,jp}/design.md §4.2 and §12.
        let MERGE_SKIP_KEYS = {
            id: 1, type: 1, z: 1, x: 1, y: 1, wires: 1,
            dirty: 1, changed: 1, selected: 1, valid: 1, h: 1, w: 1
        };

        // Restore every existing-node property the LLM did not explicitly
        // touch. "Explicitly touched" = key listed in n._llmSpecKeys (Vibe
        // Schema path), or key has a defined value on n (raw JSON path).
        // See docs/{en,jp}/architecture.md "importer.js" for the rationale.
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

        // --- Phase 2: Add / Update ---
        // Anything Phase 1 removed stays removed: the merge must not
        // re-introduce a node the same schema asked to delete.
        let byId = {};
        base.forEach(function(n) { if (n && n.id) byId[n.id] = n; });

        updates.forEach(function(n) {
            if (!n || !n.id) return;
            // Config Node Protection: the LLM may only reference existing
            // config nodes, never create new ones.
            if (!isCanvasNode(n) && n.type !== 'tab' && !byId[n.id]) {
                return;
            }
            if (n._autoStub && byId[n.id]) return;
            // Refuse to re-add a node the deletion phase just removed.
            if (removedIdSet[n.id]) return;
            if (typeof n._llmAlias === 'string' && removedIdSet[n._llmAlias]) return;

            let existing = byId[n.id];
            if (existing) {
                // Additive wire merge — existing connections are only ever
                // severed by `directives.removeConnections` in Phase 3.
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

        if (workspaceId && typeof workspaceId === 'string') {
            rebuilt.forEach(function(n) {
                if (isCanvasNode(n)) n.z = workspaceId;
            });
        }

        // --- Phase 3: Connect ---
        // Runs last so both endpoints resolve against the final node set.
        let validIds = {};
        rebuilt.forEach(function(n) { if (n && n.id) validIds[n.id] = true; });
        rebuilt.forEach(function(n) {
            if (!n || !Array.isArray(n.wires)) return;
            n.wires = n.wires.map(function(port) {
                if (!Array.isArray(port)) return [];
                return port.filter(function(tid) { return !!validIds[tid]; });
            });
        });

        let connLookup = buildUnifiedLookup(rebuilt);

        if (Array.isArray(directives.removeConnections) && directives.removeConnections.length > 0) {
            directives.removeConnections.forEach(function(rc) {
                let fromId = connLookup.resolve(rc.from);
                let toId = connLookup.resolve(rc.to);
                if (!fromId || !toId || !connLookup.byId[fromId]) return;
                let port = (typeof rc.fromPort === 'number' && rc.fromPort >= 0) ? rc.fromPort : 0;
                let fromNode = connLookup.byId[fromId];
                if (!Array.isArray(fromNode.wires) || !Array.isArray(fromNode.wires[port])) return;
                fromNode.wires[port] = fromNode.wires[port].filter(function(tid) { return tid !== toId; });
            });
        }

        applyConnectionHints(rebuilt, connectionHints || [], connLookup);

        // Resolve comment `above: <alias>` references to real node ids.
        // The alias may name a NEW node from the same schema (look up its
        // _llmAlias on rebuilt) or an EXISTING node from the live flow
        // (look up via toIntermediate's aliasToId / nameToId).
        (function resolveCommentAboveRefs() {
            let aboveCandidates = rebuilt.filter(function(n) {
                return n && n.type === 'comment' && typeof n._llmAbove === 'string' && n._llmAbove.length > 0;
            });
            if (aboveCandidates.length === 0) return;
            let newByAlias = {};
            rebuilt.forEach(function(n) {
                if (n && n.id && typeof n._llmAlias === 'string') newByAlias[n._llmAlias] = n.id;
            });
            let existingLookup = buildFlowLookup(rebuilt);
            aboveCandidates.forEach(function(c) {
                let want = c._llmAbove;
                let id = newByAlias[want]
                      || (existingLookup.aliasToId && existingLookup.aliasToId[want])
                      || existingLookup.resolve(want);
                if (id && id !== c.id) c._llmAboveId = id;
            });
        })();

        // Metadata sweep #1. Every `_`-prefixed property is plugin-internal
        // (see FlowConverterCore.isMetaProp) and must never reach the canvas.
        // `_llmOrder` / `_llmAboveId` are still consumed by the layout passes
        // below, so they are the only survivors; sweep #2 drops them once
        // layout is done.
        let LAYOUT_META_KEYS = { _llmOrder: 1, _llmAboveId: 1 };
        rebuilt.forEach(function(n) {
            if (!n) return;
            Object.keys(n).forEach(function(k) {
                if (k.charAt(0) === '_' && !LAYOUT_META_KEYS[k]) delete n[k];
            });
        });

        pruneInvalidInputWires(rebuilt);
        pruneInvalidOutputWires(rebuilt);
        fixConfigNodeProperties(rebuilt);

        let layout = LLMPlugin.CanvasLayout;
        // Prefer Node-RED's live `.w` (measured from the rendered SVG)
        // for existing nodes when the label is unchanged. If the LLM
        // renamed the node or changed its type the cached width no
        // longer matches the post-import label, so fall back to the
        // estimate which can grow the column to fit the new label.
        function liveNodeWidth(n) {
            if (!n || !n.id) return undefined;
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
            isCanvasNode: isLayoutNode,
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

        // Metadata sweep #2: the layout passes have consumed what they needed,
        // so drop the remainder. After this point no node carries a `_` key.
        rebuilt.forEach(function(n) {
            if (!n) return;
            Object.keys(n).forEach(function(k) { if (k.charAt(0) === '_') delete n[k]; });
        });

        return rebuilt;
    }

    // Reflow only the named nodes, keeping their IDs, then translate the
    // subset back to its previous top-left so the rest of the canvas does
    // not shift. Captions ride along via capture/apply.
    function repositionSubsetByAliases(allNodes, aliases, layoutOpts) {
        if (!Array.isArray(aliases) || aliases.length === 0) return;
        let layout = LLMPlugin.CanvasLayout;
        let commentAnchors = layout.captureCommentAnchors(allNodes, layoutOpts);

        let lookup = buildFlowLookup(allNodes);

        let subsetIdSet = {};
        aliases.forEach(function(a) {
            let id = lookup.resolve(a, { exactOnly: true }) || lookup.resolve(a);
            if (!id) return;
            let n = lookup.byId[id];
            if (n && isLayoutNode(n)) subsetIdSet[id] = true;
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
            isCanvasNode: isLayoutNode
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
        layout.applyCommentAnchors(allNodes, commentAnchors);
    }

    // ================================================================== //
    //  Replace Workspace Flow                                             //
    // ================================================================== //

    // Serialise live editor entities into their import-ready export shape.
    // `createExportableNodeSet` is mandatory for groups and junctions: a live
    // group's `nodes` array holds node OBJECTS, so the obvious fallback — a
    // plain JSON clone — writes whole nodes where the import format expects
    // ids. A fallback that produces a corrupt backup is worse than none.
    function exportEntities(entities) {
        let list = (entities || []).filter(Boolean);
        return list.length > 0 ? RED.nodes.createExportableNodeSet(list) : [];
    }

    function replaceWorkspaceFlow(nodes, targetWorkspaceId) {
        let workspaceId = (targetWorkspaceId && typeof targetWorkspaceId === 'string')
            ? targetWorkspaceId
            : getActiveWorkspaceId();
        if (!workspaceId) return { ok: false, error: 'Active workspace not found' };

        let backupEntitiesJSON = [];
        try {
            let ents = collectWorkspaceEntities(workspaceId);
            let canvasNodes = ents.nodes.filter(isCanvasNode);
            // Junctions and groups are removed below too, so they belong in
            // the rollback snapshot. A node-only backup used to restore the
            // canvas without them — silently deleting them on the very error
            // path that is supposed to leave the flow untouched.
            backupEntitiesJSON = exportEntities(
                canvasNodes.concat(ents.junctions || [], ents.groups || [])
            );
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
        //
        // No `_autoStub` guard here: by this point rebuildWorkspaceFromSnapshot
        // has already dropped every stub that stood in for a real config node,
        // and its metadata sweep has removed every `_`-prefixed key from what
        // is left. A test for one would never fire — Config Node Protection
        // lives in the merge, not here.
        configNodesToUpdate.forEach(function(nn) {
            try {
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
    //  Incremental Workspace Apply                                        //
    // ================================================================== //
    //
    // `rebuildWorkspaceFromSnapshot` already produces the COMPLETE desired end
    // state; this applies it as a DIFF, so only what was added, removed, moved
    // or actually changed is touched. Wires are why that is not simply
    // "import the changed nodes": links are separate objects in the editor's
    // own registry and `node.wires` is derived from them, so a changed
    // connection goes through addLink / removeLink against the live nodes.
    // Anything the diff cannot express safely hands back `fallback: true` and
    // the caller runs the destructive path, so correctness never depends on
    // this covering every case. See docs/{en,jp}/design.md §12.

    // Handled by other means, so they take no part in the property compare:
    // `wires` becomes link surgery, `x`/`y` a move, and id/type/z identify the
    // entity. A group's `w`/`h` are derived from its members.
    function comparableKeys(before, after) {
        let skip = { id: 1, type: 1, z: 1, wires: 1, x: 1, y: 1 };
        // A group's `w`/`h` follow its members, and so does `nodes`: the
        // authoritative half of membership is each node's `g`, which IS
        // compared, and the list is kept in step through RED.group rather
        // than by assigning to it. Comparing it here would report every
        // membership change twice — once on the node, once on the group —
        // and the second report has no safe way to be applied.
        if (after && after.type === 'group') { skip.w = 1; skip.h = 1; skip.nodes = 1; }
        let keys = {};
        Object.keys(before || {}).forEach(function(k) { if (!skip[k]) keys[k] = true; });
        Object.keys(after || {}).forEach(function(k) { if (!skip[k]) keys[k] = true; });
        return Object.keys(keys);
    }

    // The property keys that actually differ. Empty means Node-RED would not
    // consider this node changed either (its own diff ignores x/y/wires too).
    function changedPropertyKeys(before, after) {
        return comparableKeys(before, after).filter(function(k) {
            return JSON.stringify(before[k]) !== JSON.stringify(after[k]);
        });
    }

    // `port::targetId` keys, so wiring is compared as a set — the order Node-RED
    // happens to list a port's targets in is not a change.
    function wireKeySet(node) {
        let out = {};
        ((node && node.wires) || []).forEach(function(port, i) {
            (Array.isArray(port) ? port : []).forEach(function(targetId) {
                if (typeof targetId === 'string' && targetId) out[i + '::' + targetId] = true;
            });
        });
        return out;
    }

    function sameWiring(before, after) {
        let a = wireKeySet(before), b = wireKeySet(after);
        let ak = Object.keys(a), bk = Object.keys(b);
        return ak.length === bk.length && ak.every(function(k) { return b[k]; });
    }

    // A live entity by id, whichever registry it lives in. Junctions are NOT
    // in RED.nodes.node()'s lookup — they have their own — and a wire may
    // perfectly well end at one.
    function liveEntity(id) {
        let n = RED.nodes.node(id);
        if (n) return n;
        if (typeof RED.nodes.junction === 'function') {
            try { return RED.nodes.junction(id) || null; } catch (e) { /* ignore */ }
        }
        return null;
    }

    // Bring one node's outgoing links in line with its desired `wires`.
    // removeLink matches by object identity, so the links to drop must come
    // from getNodeLinks — a reconstructed `{source, sourcePort, target}` would
    // silently match nothing.
    function applyWireDiff(liveNode, desiredWires) {
        let want = wireKeySet({ wires: desiredWires });
        let existing = [];
        if (typeof RED.nodes.getNodeLinks === 'function') {
            existing = RED.nodes.getNodeLinks(liveNode.id, 0) || [];
        }
        existing.forEach(function(l) {
            if (!l || !l.target) return;
            let key = (l.sourcePort || 0) + '::' + l.target.id;
            if (want[key]) { delete want[key]; return; } // already correct - leave it
            RED.nodes.removeLink(l);
        });
        Object.keys(want).forEach(function(key) {
            let sep = key.indexOf('::');
            let port = parseInt(key.substring(0, sep), 10);
            let target = liveEntity(key.substring(sep + 2));
            // A dangling target is not an error here: rebuildWorkspaceFromSnapshot
            // already pruned wires to deleted nodes, and a wire leaving the
            // workspace is not this applier's to make.
            if (!target) return;
            RED.nodes.addLink({ source: liveNode, sourcePort: port, target: target });
        });
    }

    // Write changed properties onto the live node the way the edit dialog
    // does. Repointing a config reference has to be de-registered against the
    // OLD value first, or the config node's `users` list keeps a node that no
    // longer uses it (and its "N nodes use this" count drifts forever).
    function applyPropertyUpdate(liveNode, after, changedKeys) {
        let tracksConfig = typeof RED.nodes.updateConfigNodeUsers === 'function';
        if (tracksConfig) {
            try { RED.nodes.updateConfigNodeUsers(liveNode, { action: 'remove' }); } catch (e) { /* ignore */ }
        }
        changedKeys.forEach(function(key) {
            if (Object.prototype.hasOwnProperty.call(after, key)) {
                liveNode[key] = after[key];
            } else {
                // The key is gone, not blanked — `d: false` is written by
                // dropping `d`, and an assignment of undefined would export
                // as a key the runtime then sees as a change.
                try { delete liveNode[key]; } catch (e) { liveNode[key] = undefined; }
            }
        });
        if (tracksConfig) {
            try { RED.nodes.updateConfigNodeUsers(liveNode, { action: 'add' }); } catch (e) { /* ignore */ }
        }
        liveNode.changed = true;
        liveNode.dirty = true;
    }

    // Can group membership be maintained on the live canvas?
    //
    // `RED.group.removeFromGroup` is the only correct way: a group holds its
    // members as node OBJECTS, so the list cannot be edited through the
    // exported id form, and the editor's own delete action calls this before
    // removing anything. It is a silent no-op on a locked workspace, which is
    // exactly the case that must NOT proceed — a node removed while the group
    // still lists it leaves the group naming something that no longer exists.
    function canMaintainGroups() {
        return !!(RED.group && typeof RED.group.removeFromGroup === 'function' &&
                  typeof RED.nodes.group === 'function' &&
                  !(RED.workspaces && typeof RED.workspaces.isLocked === 'function' &&
                    RED.workspaces.isLocked()));
    }

    // Take a node out of its group, so removing it next does not leave the
    // group holding a member that is gone. Reports whether membership is
    // actually consistent afterwards; the caller treats false as a failure
    // rather than carrying on, because the alternative is a dangling member.
    function detachFromGroup(liveNode) {
        if (!liveNode || !liveNode.g) return true;
        let group = RED.nodes.group(liveNode.g);
        if (!group) {
            // The group is already gone; the node's own `g` is all that is
            // left to clean up.
            try { delete liveNode.g; } catch (e) { liveNode.g = undefined; }
            return true;
        }
        RED.group.removeFromGroup(group, liveNode, false);
        return !liveNode.g &&
               (!Array.isArray(group.nodes) || group.nodes.indexOf(liveNode) === -1);
    }

    function applyMove(liveNode, after) {
        if (typeof after.x === 'number') liveNode.x = after.x;
        if (typeof after.y === 'number') liveNode.y = after.y;
        liveNode.moved = true;
        liveNode.dirty = true;
    }

    // Clear the tab and re-import an export of it. Only the rollback path uses
    // this now — the destructive rebuild it mirrors is what the diff exists to
    // avoid, but on a half-applied failure it is the only way back to a known
    // state.
    function restoreWorkspaceFromExport(exportedFlow, wsId) {
        let ents = collectWorkspaceEntities(wsId);
        ents.nodes.forEach(function(n) { try { RED.nodes.remove(n.id); } catch (e) { /* ignore */ } });
        (ents.junctions || []).forEach(function(j) { try { RED.nodes.removeJunction(j); } catch (e) { /* ignore */ } });
        (ents.groups || []).forEach(function(g) { try { RED.nodes.removeGroup(g); } catch (e) { /* ignore */ } });
        try { RED.view.redraw(true, true); } catch (e) { /* ignore */ }
        let restore = (exportedFlow || []).filter(function(n) {
            return n && n.type !== 'tab' && n.z === wsId;
        });
        if (restore.length > 0) {
            RED.nodes.import(restore, { generateIds: false, reimport: true, addFlow: false });
        }
        try { RED.workspaces.refresh(); } catch (e) { /* ignore */ }
        refreshCanvasView([wsId]);
    }

    // Split the desired end state into the entities that belong on this
    // canvas and the config nodes that ride along with it.
    function partitionDesired(desired, wsId) {
        let canvas = [];
        let configs = [];
        (desired || []).forEach(function(n) {
            if (!n || !n.type || n.type === 'tab') return;
            let copy = JSON.parse(JSON.stringify(n));
            if (isCanvasNode(copy)) copy.z = wsId;
            // `z` rather than isCanvasNode: a subflow INSTANCE sits on the
            // canvas but is not a canvas node by that test, and treating it as
            // a config node would leave it out of the diff entirely.
            if (copy.z === wsId) canvas.push(copy);
            else configs.push(copy);
        });
        return { canvas: canvas, configs: configs };
    }

    // Update existing config nodes in place; hand back the ones that are new
    // so they can be imported with the rest.
    //
    // `undo` collects what it takes to put each touched config node back:
    // config nodes live OUTSIDE the workspace, so restoreWorkspaceFromExport
    // (which only re-imports entities whose `z` is the tab) cannot reach
    // them. Without this a failed apply left the flow restored but the
    // brokers and credentials it had already rewritten still rewritten.
    function applyConfigNodeUpdates(configs, undo) {
        let toImport = [];
        (configs || []).forEach(function(nn) {
            let existing = RED.nodes.node(nn.id);
            if (!existing) {
                // Not live yet, so undoing means removing it again. Recorded
                // before the import so a throw DURING the import still has it.
                if (undo) undo.push({ action: 'remove', id: nn.id });
                toImport.push(nn);
                return;
            }
            let changed = false;
            let before = {};
            Object.keys(nn).forEach(function(key) {
                if (key === 'id' || key === 'type') return;
                if (JSON.stringify(existing[key]) === JSON.stringify(nn[key])) return;
                if (!changed) {
                    before.dirty = existing.dirty;
                    before.changed = existing.changed;
                }
                // `hasOwnProperty`, not a truth test: recording `undefined`
                // for a key that was genuinely absent is what lets the undo
                // delete it rather than write undefined back.
                before[key] = Object.prototype.hasOwnProperty.call(existing, key)
                    ? JSON.parse(JSON.stringify(existing[key]))
                    : undefined;
                existing[key] = nn[key];
                changed = true;
            });
            if (changed) {
                existing.dirty = true;
                existing.changed = true;
                if (undo) undo.push({ action: 'restore', id: nn.id, before: before });
            }
        });
        return toImport;
    }

    // Put the config nodes back the way applyConfigNodeUpdates found them.
    // Runs newest-first so a node that was created and then edited is removed
    // rather than half-restored. Best-effort by design: it runs on an error
    // path that has already failed once.
    function undoConfigNodeUpdates(undo) {
        (undo || []).slice().reverse().forEach(function(entry) {
            try {
                if (entry.action === 'remove') {
                    if (RED.nodes.node(entry.id)) RED.nodes.remove(entry.id);
                    return;
                }
                let live = RED.nodes.node(entry.id);
                if (!live) return;
                Object.keys(entry.before).forEach(function(key) {
                    if (entry.before[key] === undefined) {
                        try { delete live[key]; } catch (e) { live[key] = undefined; }
                    } else {
                        live[key] = entry.before[key];
                    }
                });
                live.dirty = true;
            } catch (e) { /* best effort */ }
        });
    }

    // The end state, applied as a diff. Returns { ok } on success,
    // { ok: false, fallback: true } when the caller should use the
    // destructive path instead, or { ok: false, error } on a real failure
    // (the workspace is rolled back first).
    function applyWorkspaceDiff(desired, targetWorkspaceId) {
        let wsId = (targetWorkspaceId && typeof targetWorkspaceId === 'string')
            ? targetWorkspaceId
            : getActiveWorkspaceId();
        if (!wsId) return { ok: false, error: 'Active workspace not found' };

        let ents = collectWorkspaceEntities(wsId);
        let liveEntities = ents.nodes.concat(ents.junctions || [], ents.groups || []);

        // One export serves as BOTH the comparison baseline and the rollback
        // snapshot, so the two can never disagree about what "before" was.
        let beforeExport;
        try {
            beforeExport = exportEntities(liveEntities);
        } catch (e) {
            return { ok: false, fallback: true, error: 'could not snapshot the workspace' };
        }

        let beforeById = {};
        beforeExport.forEach(function(n) { if (n && n.id) beforeById[n.id] = n; });

        let liveById = {};
        let liveKind = {};
        ents.nodes.forEach(function(n) { if (n && n.id) { liveById[n.id] = n; liveKind[n.id] = 'node'; } });
        (ents.junctions || []).forEach(function(j) { if (j && j.id) { liveById[j.id] = j; liveKind[j.id] = 'junction'; } });
        (ents.groups || []).forEach(function(g) { if (g && g.id) { liveById[g.id] = g; liveKind[g.id] = 'group'; } });

        // An entity that does not round-trip through an export cannot be
        // compared. Guessing is how a rebuild loses things.
        let unexportable = Object.keys(liveById).some(function(id) { return !beforeById[id]; });
        if (unexportable) {
            return { ok: false, fallback: true, error: 'workspace holds entities that do not export' };
        }

        let split = partitionDesired(desired, wsId);
        let afterById = {};
        split.canvas.forEach(function(n) { if (n && n.id) afterById[n.id] = n; });

        // --- Classify -------------------------------------------------- //
        let removed = [];   // live ids no longer wanted
        let added = [];     // desired entities with no live counterpart
        let updates = [];   // { id, keys } - a real property change
        let moves = [];     // ids whose x/y moved
        let rewires = [];   // ids whose outgoing links changed

        Object.keys(liveById).forEach(function(id) {
            if (!afterById[id]) removed.push(id);
        });
        split.canvas.forEach(function(n) {
            if (!liveById[n.id]) { added.push(n); return; }
            let before = beforeById[n.id];
            let keys = changedPropertyKeys(before, n);
            if (keys.length > 0) updates.push({ id: n.id, keys: keys });
            // A group's position follows its members; assigning to it would
            // fight the bounds the editor derives on redraw.
            if (n.type !== 'group' && (before.x !== n.x || before.y !== n.y)) moves.push(n.id);
            if (!sameWiring(before, n)) rewires.push(n.id);
        });

        // --- Refuse what the diff cannot express ----------------------- //
        // Groups own their members as live OBJECTS and a node's `g` is only
        // half of that relationship, so any change to either has to go through
        // RED.group's own add/remove. None of this is reachable from the
        // schema (it has no notion of groups), so falling back costs nothing
        // and keeps the group bookkeeping in one place.
        let bail = null;
        updates.forEach(function(u) {
            let before = beforeById[u.id], after = afterById[u.id];
            if (before.type !== after.type) bail = bail || 'a node changed type';
            if (liveKind[u.id] === 'group') bail = bail || 'a group changed';
            if (u.keys.indexOf('g') !== -1) bail = bail || 'group membership changed';
        });
        removed.forEach(function(id) {
            if (liveKind[id] === 'group') bail = bail || 'a group was removed';
            else if (beforeById[id] && beforeById[id].g && !canMaintainGroups()) {
                bail = bail || 'a grouped node was removed and the group API is unavailable';
            }
        });
        added.forEach(function(n) {
            if (n.type === 'group') bail = bail || 'a group was added';
            else if (n.g) bail = bail || 'a node was added into a group';
        });
        if (bail) return { ok: false, fallback: true, error: bail };

        let touched = removed.length + added.length + updates.length +
                      moves.length + rewires.length;

        // Config nodes are not part of `beforeExport` (they have no `z`),
        // so they need their own undo log to be rollback-able.
        let configUndo = [];

        // --- Apply ----------------------------------------------------- //
        try {
            removed.forEach(function(id) {
                let obj = liveById[id];
                if (liveKind[id] === 'junction') RED.nodes.removeJunction(obj);
                else if (liveKind[id] === 'group') RED.nodes.removeGroup(obj);
                else {
                    // Out of the group first: RED.nodes.remove has no group
                    // bookkeeping, so the order is what keeps the two halves
                    // of membership in step.
                    if (!detachFromGroup(obj)) {
                        throw new Error('could not remove ' + id + ' from its group');
                    }
                    RED.nodes.remove(id);   // takes its links with it
                }
            });

            updates.forEach(function(u) {
                applyPropertyUpdate(liveById[u.id], afterById[u.id], u.keys);
            });
            moves.forEach(function(id) { applyMove(liveById[id], afterById[id]); });

            // Added nodes go in BEFORE the wire pass: a new link needs both
            // ends to exist. Their own `wires` are turned into links by the
            // import; wires pointing AT them from untouched nodes are not, and
            // that is what the rewire pass below is for.
            let configImports = applyConfigNodeUpdates(split.configs, configUndo);
            let importSet = added.concat(configImports);
            if (importSet.length > 0) {
                // Bypass RED.history - rewind via the plugin's checkpoints.
                RED.nodes.import(importSet, { generateIds: false, reimport: true, addFlow: false });
            }

            rewires.forEach(function(id) {
                let live = liveById[id] || liveEntity(id);
                if (live) applyWireDiff(live, afterById[id].wires);
            });

            try { RED.workspaces.refresh(); } catch (e) { /* ignore */ }
            refreshCanvasView([wsId]);
            return {
                ok: true,
                touched: touched,
                added: added.length,
                removed: removed.length,
                updated: updates.length,
                rewired: rewires.length,
                moved: moves.length
            };
        } catch (e) {
            postTerminalLog('error', 'incremental-apply-error',
                'Incremental apply threw; rolling the workspace back', {
                    error: e && e.message ? e.message : String(e)
                });
            // Canvas first, then configs: restoreWorkspaceFromExport removes
            // the workspace's nodes, and that de-registers them from the
            // config nodes' `users` lists — so a config node this undo is
            // about to delete is no longer claimed by a node that is going
            // away anyway.
            try { restoreWorkspaceFromExport(beforeExport, wsId); } catch (e2) { /* ignore */ }
            try { undoConfigNodeUpdates(configUndo); } catch (e3) { /* ignore */ }
            return { ok: false, error: 'Failed to apply flow changes: ' + (e.message || e) };
        }
    }

    // ================================================================== //
    //  Multi-flow Dispatch Helpers                                        //
    // ================================================================== //

    // Label of the flow untagged nodes belong to: the active tab, or — when
    // that tab is outside the conversation's scope — the context flow the
    // import will actually target. Returning the active label here would
    // route untagged nodes to a workspace the dispatch is not allowed to
    // write to, and they would be silently dropped as "unknown flow".
    function getDefaultWorkspaceLabel(allowedSet) {
        let id = pickDefaultWorkspace(allowedSet);
        if (!id || !window.RED || !RED.nodes) return null;
        let ws = RED.nodes.workspace(id);
        if (ws && ws.label) return ws.label;
        return id;
    }

    // Group canvas nodes by their Vibe Schema `flow` label so each group
    // can target its own workspace. Untagged canvas nodes fall into the
    // default (in-scope) flow when any other node is tagged.
    function collectFlowGroupsFromSchema(schema, allowedSet) {
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
            let defaultLabel = getDefaultWorkspaceLabel(allowedSet);
            if (defaultLabel) {
                if (!groups[defaultLabel]) groups[defaultLabel] = [];
                untagged.forEach(function(a) { groups[defaultLabel].push(a); });
            }
        }
        return groups;
    }

    // Slice a schema down to one flow: its tagged canvas nodes, the untagged
    // (config / shared) ones, and the connections internal to it.
    // `ownedDeletes` is this flow's share of the delete directives, decided
    // by routeDeleteTokens.
    function buildSubSchemaForFlow(schema, aliases, ownedDeletes) {
        let aliasSet = {};
        aliases.forEach(function(a) { aliasSet[a] = true; });
        let subNodes = {};

        // Deletions are never broadcast: an alias collision (`debug` on both
        // tabs) would delete from a flow the schema never mentioned.
        function deletionBelongsHere(token) {
            return !!aliasSet[token] || !!(ownedDeletes && ownedDeletes[token]);
        }

        aliases.forEach(function(alias) {
            if (Object.prototype.hasOwnProperty.call(schema.nodes || {}, alias)) {
                subNodes[alias] = schema.nodes[alias];
            }
        });
        Object.keys(schema.nodes || {}).forEach(function(alias) {
            if (aliasSet[alias]) return;
            let spec = schema.nodes[alias];
            if (spec === null) {
                if (deletionBelongsHere(alias)) subNodes[alias] = spec;
                return;
            }
            if (!spec || typeof spec !== 'object') return;
            let isUntagged = !spec.flow || typeof spec.flow !== 'string' || !spec.flow.trim();
            if (isUntagged) subNodes[alias] = spec;
        });

        // A connection is forwarded here when at least one endpoint belongs
        // to this sub-schema and neither is tagged to a different flow —
        // Node-RED has no cross-flow wires. An endpoint absent from
        // schema.nodes is an existing canvas node, resolved by the
        // sub-import's own lookup.
        function endpointBelongsToAnotherFlow(endpoint) {
            if (aliasSet[endpoint]) return false;
            let spec = schema.nodes && schema.nodes[endpoint];
            if (!spec || typeof spec !== 'object') return false;
            let flow = (typeof spec.flow === 'string') ? spec.flow.trim() : '';
            return flow.length > 0;
        }

        let subConns = [];
        (schema.connections || []).forEach(function(c) {
            if (!c || typeof c !== 'object') return;
            if (c.remove && typeof c.remove === 'object') {
                let r = c.remove;
                if (!r || typeof r.from !== 'string' || typeof r.to !== 'string') return;
                if (!aliasSet[r.from] && !aliasSet[r.to]) return;
                if (endpointBelongsToAnotherFlow(r.from)) return;
                if (endpointBelongsToAnotherFlow(r.to)) return;
                subConns.push(c);
                return;
            }
            if (typeof c.from !== 'string' || typeof c.to !== 'string') return;
            if (!aliasSet[c.from] && !aliasSet[c.to]) return;
            if (endpointBelongsToAnotherFlow(c.from)) return;
            if (endpointBelongsToAnotherFlow(c.to)) return;
            subConns.push(c);
        });

        let out = {
            nodes: subNodes,
            connections: subConns
        };
        if (typeof schema.description === 'string') out.description = schema.description;
        if (Array.isArray(schema.remove)) {
            out.remove = schema.remove.filter(deletionBelongsHere);
        }
        return out;
    }

    // ------------------------------------------------------------------ //
    //  Routing deletions across a fan-out                                 //
    // ------------------------------------------------------------------ //

    // Every deletion a schema can express: the top-level `remove` array and
    // the `nodes: { alias: null }` form.
    function collectDeleteTokens(schema) {
        let tokens = [];
        let seen = {};
        function add(t) {
            if (typeof t !== 'string') return;
            let s = t.trim();
            if (!s || seen[s]) return;
            seen[s] = true;
            tokens.push(s);
        }
        if (schema && Array.isArray(schema.remove)) schema.remove.forEach(add);
        if (schema && schema.nodes && typeof schema.nodes === 'object') {
            Object.keys(schema.nodes).forEach(function(alias) {
                if (schema.nodes[alias] === null) add(alias);
            });
        }
        return tokens;
    }

    // A deletion carries no `flow` tag and its node is normally not
    // redeclared under `nodes`, so the only evidence is which canvas holds
    // it. Routed only when exactly ONE in-scope flow resolves the token;
    // ambiguous or unresolvable ones are reported, not applied, because a
    // deletion cannot be undone from the import itself.
    // → { byLabel: { <flow label>: { <token>: true } }, unrouted: [] }
    function routeDeleteTokens(tokens, labelToWorkspaceId) {
        let byLabel = {};
        let unrouted = [];
        let labels = Object.keys(labelToWorkspaceId || {});
        if (tokens.length === 0 || labels.length === 0) {
            return { byLabel: byLabel, unrouted: tokens.slice() };
        }

        let lookups = {};
        labels.forEach(function(label) {
            lookups[label] = buildFlowLookup(RED.nodes.filterNodes({ z: labelToWorkspaceId[label] }) || []);
        });

        tokens.forEach(function(token) {
            let owners = labels.filter(function(l) {
                return !!lookups[l].resolve(token, { exactOnly: true });
            });
            if (owners.length !== 1) {
                // Looser tiers only when the exact pass was inconclusive: the
                // alias numbering the model sees spans every context flow
                // (`debug_2`), while these lookups are per-flow (`debug`).
                owners = labels.filter(function(l) {
                    return !!lookups[l].resolve(token);
                });
            }
            if (owners.length === 1) {
                (byLabel[owners[0]] = byLabel[owners[0]] || {})[token] = true;
            } else {
                unrouted.push(token);
            }
        });
        return { byLabel: byLabel, unrouted: unrouted };
    }

    // ================================================================== //
    //  Implicit Flow Tagging                                              //
    // ================================================================== //

    // LLMs routinely omit `flow` tags even when a message spans workspaces,
    // leaving the dispatch unfired and cross-tab connections unresolved.
    // Recover the tags from the context canvases and propagate them along
    // connections; the schema is cloned. The `allowedSet` scope is
    // load-bearing — the map is first-workspace-wins, so a global scan would
    // tag `inject` with whichever unrelated tab sits earlier in the tab bar.
    function inferImplicitFlowTagging(schema, allowedSet) {
        if (!schema || !schema.nodes || typeof schema.nodes !== 'object') return schema;

        let aliasToWorkspaceLabel = {};
        try {
            RED.nodes.eachWorkspace(function(ws) {
                if (!ws || ws.type !== 'tab' || !ws.id) return;
                if (!isWorkspaceAllowed(allowedSet, ws.id)) return;
                let label = (typeof ws.label === 'string' && ws.label.trim()) ? ws.label : ws.id;
                let nodes = RED.nodes.filterNodes({ z: ws.id }) || [];
                if (nodes.length === 0) return;
                let inter = Converter.toIntermediate(nodes, { includeIdMap: true });
                let interNodes = (inter && inter.nodes) ? inter.nodes : {};
                Object.keys(interNodes).forEach(function(alias) {
                    if (!aliasToWorkspaceLabel[alias]) {
                        aliasToWorkspaceLabel[alias] = label;
                    }
                });
            });
        } catch (e) { return schema; }

        if (Object.keys(aliasToWorkspaceLabel).length === 0) return schema;

        // Seed inferred flow per schema-node alias.
        let inferred = {};
        Object.keys(schema.nodes).forEach(function(alias) {
            let spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;
            if (spec.config === true) return;
            if (typeof spec.flow === 'string' && spec.flow.trim()) {
                inferred[alias] = spec.flow.trim();
                return;
            }
            if (aliasToWorkspaceLabel[alias]) {
                inferred[alias] = aliasToWorkspaceLabel[alias];
            }
        });

        // Propagate labels along connections. A connection's endpoint is
        // either: a schema-node alias (in `inferred` once set), or an
        // existing canvas alias (always in `aliasToWorkspaceLabel`). When
        // one endpoint is known and the schema-node endpoint isn't, the
        // unknown side inherits the known side's label.
        let connections = Array.isArray(schema.connections) ? schema.connections : [];
        let changed = true;
        let safety = 64;
        while (changed && safety-- > 0) {
            changed = false;
            connections.forEach(function(c) {
                if (!c || typeof c !== 'object' || c.remove) return;
                let from = c.from, to = c.to;
                if (typeof from !== 'string' || typeof to !== 'string') return;
                let fromFlow = inferred[from] || aliasToWorkspaceLabel[from];
                let toFlow   = inferred[to]   || aliasToWorkspaceLabel[to];
                if (fromFlow && schema.nodes[to] && !inferred[to]) {
                    let toSpec = schema.nodes[to];
                    if (toSpec && typeof toSpec === 'object' && toSpec.config !== true) {
                        inferred[to] = fromFlow;
                        changed = true;
                    }
                }
                if (toFlow && schema.nodes[from] && !inferred[from]) {
                    let fromSpec = schema.nodes[from];
                    if (fromSpec && typeof fromSpec === 'object' && fromSpec.config !== true) {
                        inferred[from] = toFlow;
                        changed = true;
                    }
                }
            });
        }

        let touched = false;
        Object.keys(inferred).forEach(function(alias) {
            let spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;
            if (typeof spec.flow === 'string' && spec.flow.trim()) return;
            touched = true;
        });
        if (!touched) return schema;

        let cloned = JSON.parse(JSON.stringify(schema));
        Object.keys(cloned.nodes).forEach(function(alias) {
            let spec = cloned.nodes[alias];
            if (!spec || typeof spec !== 'object') return;
            if (spec.config === true) return;
            if (typeof spec.flow === 'string' && spec.flow.trim()) return;
            if (inferred[alias]) spec.flow = inferred[alias];
        });
        return cloned;
    }

    // Re-serialize a schema back into a fenced ```json``` block so an
    // outer-level import can hand its inferred-tagged version off to the
    // sub-import path (which re-parses the message via extractFlowNodes
    // / extractConnectionHints from the surrounding text).
    function serializeSchemaAsMessage(schema) {
        return '```json\n' + JSON.stringify(schema, null, 2) + '\n```';
    }

    async function dispatchMultiFlowImport(schema, flowGroups, options, allowedSet) {
        let results = [];
        let aggregatedAdded = 0;
        let aggregatedImported = 0;
        let unresolved = [];
        let flowLabels = Object.keys(flowGroups);

        // Resolve every target workspace up front: deletions have to be
        // routed against the whole set of candidate flows, not one at a time.
        // Out-of-scope labels resolve to null and are reported as skipped —
        // a fan-out must never reach a flow outside the conversation's
        // context.
        let labelToWs = {};
        flowLabels.forEach(function(label) {
            let wsId = resolveFlowLabelToWorkspace(label, allowedSet);
            if (wsId) labelToWs[label] = wsId;
            else unresolved.push(label);
        });

        let routedDeletes = routeDeleteTokens(collectDeleteTokens(schema), labelToWs);
        if (routedDeletes.unrouted.length > 0) {
            notify('Could not tell which flow these node(s) should be deleted from; left in place: ' +
                routedDeletes.unrouted.join(', '), 'warning');
        }

        for (let li = 0; li < flowLabels.length; li++) {
            let label = flowLabels[li];
            let wsId = labelToWs[label];
            if (!wsId) continue;

            let subSchema = buildSubSchemaForFlow(schema, flowGroups[label], routedDeletes.byLabel[label]);
            let subMessage = serializeSchemaAsMessage(subSchema);
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

        if (unresolved.length > 0) {
            notify('Skipped unknown flow(s): ' + unresolved.join(', '), 'warning');
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
            // Workspace scope for this import: the flows that were sent to
            // the LLM as context (`allowedWorkspaceIds`, supplied by the
            // caller). Null = unrestricted, i.e. no flow context was
            // selected, in which case the active tab is the only sensible
            // target anyway.
            let allowedSet = buildAllowedWorkspaceSet(options.allowedWorkspaceIds);

            // Split a `flow`-tagged schema per workspace before importing.
            // inferImplicitFlowTagging fills in tags the LLM omitted, so the
            // dispatch still fires without explicit markers.
            if (!options._isSubImport) {
                let rawSchema = extractLastVibeSchema(messageContent);
                let dispatchSchema = inferImplicitFlowTagging(rawSchema, allowedSet);
                let inferredContent = (dispatchSchema && dispatchSchema !== rawSchema)
                    ? serializeSchemaAsMessage(dispatchSchema)
                    : messageContent;
                let flowGroups = collectFlowGroupsFromSchema(dispatchSchema, allowedSet);
                let flowLabels = flowGroups ? Object.keys(flowGroups) : [];
                if (flowLabels.length > 1) {
                    return await dispatchMultiFlowImport(dispatchSchema, flowGroups, options, allowedSet);
                }
                if (flowLabels.length === 1) {
                    let targetLabel = flowLabels[0];
                    let onlyWs = resolveFlowLabelToWorkspace(targetLabel, allowedSet);
                    if (onlyWs) {
                        options = Object.assign({}, options, { targetWorkspaceId: onlyWs });
                        // Use the inferred-tagged message so downstream
                        // parsing sees the same flow tags that drove the
                        // workspace decision.
                        if (inferredContent !== messageContent) {
                            messageContent = inferredContent;
                        }
                    } else {
                        notify('Target flow "' + targetLabel + '" is not one of the flows this chat is working on. Using the context flow instead.', 'warning');
                    }
                }
            }

            let targetWs = (options.targetWorkspaceId && typeof options.targetWorkspaceId === 'string')
                ? options.targetWorkspaceId
                : null;
            // A target that escaped the scope (e.g. a sub-import handed a
            // stale id) is discarded rather than honoured.
            if (targetWs && !isWorkspaceAllowed(allowedSet, targetWs)) targetWs = null;

            // Resolve the destination BEFORE snapshotting: `beforeFlow` is the
            // rebuild base and must come from the very workspace the result is
            // written back to, or the merge would splice one flow's nodes into
            // another.
            let currentWorkspace = targetWs || pickDefaultWorkspace(allowedSet);
            let beforeFlow = safeGetCurrentFlow(currentWorkspace);

            let hasExistingFlow = Array.isArray(beforeFlow) && beforeFlow.length > 0;
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
                    let diag = Parser.diagnoseJsonExtractionFailure(messageContent);
                    if (diag) {
                        let where = (diag.line && diag.column)
                            ? ' (line ' + diag.line + ', col ' + diag.column + ')'
                            : '';
                        let near = diag.snippet ? ' Near: …' + diag.snippet + '…' : '';
                        let detail = 'JSON parse failed' + where + ': ' + diag.error + '.' + near;
                        notify(detail, { type: 'warning', timeout: 12000 });
                        try { console.warn('[LLM Plugin] JSON parse failed:', diag); } catch (e) {}
                        postTerminalLog('warn', 'json-parse-failed',
                            'LLM response contained a fenced code block that failed to parse',
                            { line: diag.line, column: diag.column, error: diag.error });
                        return { ok: false, error: detail };
                    }
                    notify('No JSON flow found in message', 'warning');
                    return { ok: false, error: 'No JSON flow found in message' };
                }
            }

            // Build unified lookup from current flow
            let lookup = buildFlowLookup(hasExistingFlow ? beforeFlow : []);

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
                notify('Warning: could not determine active workspace; imported nodes may not be in the deployed flow', 'warning');
            }

            let hasDirectives = (flowDirectives.removeTokens || []).length > 0 ||
                                (flowDirectives.removeConnections || []).length > 0 ||
                                (flowDirectives.repositionTokens || []).length > 0 ||
                                (connectionHints || []).length > 0;
            if (!newNodes.length && !hasDirectives) {
                notify('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning');
                return { ok: false, error: 'No valid nodes after sanitization' };
            }

            let bad = newNodes.find(function(n) { return typeof n.type !== 'string' || n.type.length === 0; });
            if (bad) {
                notify('Import aborted: invalid node shape', 'error');
                console.warn('[LLM Plugin] bad node', bad);
                return { ok: false, error: 'Invalid node shape' };
            }

            // Last line of defence before the destructive rebuild: whatever
            // path decided `currentWorkspace`, it must be a flow this chat
            // was actually given. replaceWorkspaceFlow clears its target's
            // canvas, so an out-of-scope id here would destroy an unrelated
            // flow — abort instead.
            if (!isWorkspaceAllowed(allowedSet, currentWorkspace)) {
                let scopeErr = 'Import aborted: target flow is outside this chat\'s flow context';
                notify(scopeErr, 'error');
                postTerminalLog('warn', 'import-scope-violation',
                    'Refused to write outside the conversation flow context',
                    { target: currentWorkspace || null, allowed: Object.keys(allowedSet || {}) });
                return { ok: false, error: scopeErr };
            }

            let rebuiltFlow = rebuildWorkspaceFromSnapshot(beforeFlow, newNodes, currentWorkspace, connectionHints, flowDirectives);
            // Apply the end state as a diff, touching only what the edit
            // actually changes. `fallback` means the diff found something it
            // cannot express (group membership, a type change) — the
            // destructive rebuild still applies the same end state, just
            // wholesale, so it stays as the backstop rather than as the norm.
            let rebuiltResult = applyWorkspaceDiff(rebuiltFlow, currentWorkspace);
            if (rebuiltResult && rebuiltResult.fallback) {
                postTerminalLog('warn', 'incremental-apply-fallback',
                    'Incremental apply declined; rebuilding the workspace instead',
                    { workspace: currentWorkspace, reason: rebuiltResult.error || null });
                rebuiltResult = replaceWorkspaceFlow(rebuiltFlow, currentWorkspace);
            }
            if (!rebuiltResult || !rebuiltResult.ok) {
                let errMsg = (rebuiltResult && rebuiltResult.error) || 'Failed to rebuild flow from snapshot';
                notify('Import failed: ' + errMsg, 'error');
                return {
                    ok: false,
                    error: errMsg
                };
            }

            let addedNodes = rebuiltFlow.filter(function(n) {
                return !!(n && n.id) && !beforeIdSet.has(n.id);
            }).map(function(n) {
                return { id: n.id, type: n.type || '', name: n.name || '' };
            });

            // One toast per import: two in a row (and a 'warning' severity for
            // what is really a success detail) just buried the result.
            notify(addedNodes.length > 0
                ? 'Flow updated (' + addedNodes.length + ' node(s) added)'
                : 'Flow updated', 'success');

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
            notify('Failed to import flow: ' + (err && err.message ? err.message : String(err)), 'error');
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
        return Common.apiFetch('llm-plugin/checkpoint/' + encodeURIComponent(checkpointId))
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



