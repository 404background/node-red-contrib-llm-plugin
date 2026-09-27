// Importer: parses LLM assistant messages and imports Node-RED flows (raw
// Node-RED JSON or Vibe Schema). Parsing and lookup live in
// src/core/llm_json_parser.js. See docs/{en,jp}/design.md.
(function(){
    let Importer = {};

    // Overrides passed to CanvasLayout. Every gap is an EDGE-TO-EDGE
    // clearance (visible whitespace), not a centre-to-centre distance.
    let LAYOUT = {
        startX:       200,   // canvas origin X (px) - left edge of first column
        startY:       200,   // canvas origin Y (px) - top edge of first row
        spacingY:      40,   // 2 grid squares between stacked node edges (within a flow)
        componentGap:  60,   // 3 grid squares between disconnected flow components
        edgeGap:       40    // 2 grid squares between adjacent node edges (horizontal)
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
    // Every decision below stays inside the flows sent as context; a null set
    // means none was selected. See docs/{en,jp}/design.md §6.

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

    // The active tab when it is in scope, else the first context flow: the
    // user may have changed tabs between Send and Import.
    function pickDefaultWorkspace(allowedSet) {
        let active = getActiveWorkspaceId();
        if (!allowedSet) return active;
        if (active && allowedSet[active]) return active;
        let ids = Object.keys(allowedSet);
        return ids.length > 0 ? ids[0] : null;
    }

    // Tab label (or id) -> workspace id, null unless the match is unique.
    // `allowedSet` keeps the scan inside the context flows.
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

    // Alias -> live config node, over the flows the MODEL was shown. Config
    // references resolve here; node identity stays per-flow.
    // See docs/{en,jp}/design.md §5.
    function buildConfigAliasIndex(allowedWorkspaceIds) {
        let index = {};
        try {
            if (!window.RED || !RED.nodes) return index;
            let ids = (Array.isArray(allowedWorkspaceIds) && allowedWorkspaceIds.length > 0)
                ? allowedWorkspaceIds
                : null;
            // The same export the model was sent. Adding an entity the context
            // did not have would shift the very numbering this table exists
            // to reproduce.
            let ctxOpts = { includeCanvasExtras: true };
            let context = ids
                ? LLMPlugin.UI.getFlowsByIds(ids, ctxOpts)
                : LLMPlugin.UI.getCurrentFlow(undefined, ctxOpts);
            if (!Array.isArray(context) || context.length === 0) return index;
            let inter = Converter.toIntermediate(context, { includeIdMap: true });
            let idToAlias = (inter && inter._meta && inter._meta.idToAlias) || {};
            Object.keys(idToAlias).forEach(function(id) {
                let live = RED.nodes.node(id);
                if (live && isConfigNodeObj(live)) {
                    index[idToAlias[id]] = { id: id, type: live.type };
                }
            });
        } catch (e) { /* best effort: the stub strategies still run */ }
        return index;
    }

    // Is this string a config reference we can resolve? Alias-shaped, known in
    // the context, and pointing at a type OTHER than the referring node's own
    // — an mqtt-broker's 'broker' prop is its hostname, not a broker ref.
    function resolveConfigAlias(index, value, ownType) {
        if (typeof value !== 'string' || !value) return null;
        if (!/^[a-z][a-z0-9_]*$/i.test(value)) return null;
        let hit = index[value];
        if (!hit || hit.type === ownType) return null;
        return hit;
    }

    // Props that are never a config reference, in either direction.
    let NON_REF_KEYS = { id: 1, type: 1, wires: 1, z: 1, name: 1, x: 1, y: 1, g: 1 };

    // The importer's own bookkeeping (_llmAlias, _autoStub, ...), never a node
    // property and never a reference.
    function isMetaKey(key) {
        return typeof key === 'string' && key.charAt(0) === '_';
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

    // buildFlowLookup plus the `_llmAlias` markers new nodes carry, so a
    // connection can name a node this same schema is adding.
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
            // exactOnly: a fuzzy match would reroute the connection to a
            // node that merely shares a prefix. See design.md §4.3.
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

    // The context shows `A -> junction -> B`, and `A -> link out ... link in
    // -> B`, as `A -> B`, so a reply that restates the connection would add a
    // direct wire beside the routing, and B would get every message twice. A
    // wire this edit added is dropped when the same port already reaches that
    // node through routing; a wire that was there before is never touched.
    // See docs/{en,jp}/vibe-schema.md.
    function dropWiresBesideRouting(nodes, beforeFlow) {
        let g = readRouting(nodes);
        let before = {};
        (Array.isArray(beforeFlow) ? beforeFlow : []).forEach(function(n) { if (n && n.id) before[n.id] = n; });
        (nodes || []).forEach(function(n) {
            if (!n || !Array.isArray(n.wires) || Converter.isRoutingNode(n)) return;
            let was = before[n.id];
            n.wires = n.wires.map(function(port, i) {
                if (!Array.isArray(port)) return port;
                let via = {};
                port.forEach(function(id) { if (g.isRouting(id)) Object.assign(via, g.down(id)); });
                let had = (was && Array.isArray(was.wires) && Array.isArray(was.wires[i])) ? was.wires[i] : [];
                return port.filter(function(id) { return !via[id] || had.indexOf(id) !== -1; });
            });
        });
    }

    // The routing graph under the connections the model is shown. An edge is
    // a wire, or a link out's link to a link in. A source is a node's output
    // port (`id#port`); a link in fed from another tab, or called by a link
    // call, has a source that is never cut (`ext:` / `call:`), and a link to
    // another tab ends at an `ext:` target. `carried(edge)` is the set of
    // `source>target` connections the edge lies on.
    function readRouting(nodes) {
        let byId = {};
        (nodes || []).forEach(function(n) { if (n && n.id) byId[n.id] = n; });
        function isRouting(id) { return !!byId[id] && Converter.isRoutingNode(byId[id]); }
        let edges = [], out = {};
        function add(e) { edges.push(e); (out[e.src] = out[e.src] || []).push(e); }
        (nodes || []).forEach(function(n) {
            if (!n || !n.id) return;
            let routing = Converter.isRoutingNode(n);
            (Array.isArray(n.wires) ? n.wires : []).forEach(function(port, i) {
                (Array.isArray(port) ? port : []).forEach(function(to) {
                    if (!byId[to]) return;
                    add({ key: 'w|' + n.id + '|' + i + '|' + to, kind: 'wire', from: n.id, port: i, to: to,
                          src: routing ? n.id : n.id + '#' + i });
                });
            });
            let links = Array.isArray(n.links) ? n.links : [];
            if (n.type === 'link out' && n.mode !== 'return') {
                links.forEach(function(to) {
                    add({ key: 'l|' + n.id + '|' + to, kind: 'link', from: n.id, to: byId[to] ? to : 'ext:' + to, src: n.id });
                });
            } else if (n.type === 'link in') {
                links.forEach(function(from) {
                    if (!byId[from]) add({ key: 'x|' + from + '|' + n.id, kind: 'fixed', to: n.id, src: 'ext:' + from });
                });
            } else if (n.type === 'link call') {
                links.forEach(function(to) {
                    if (isRouting(to)) add({ key: 'c|' + n.id + '|' + to, kind: 'fixed', to: to, src: 'call:' + n.id });
                });
            }
        });

        let memo = {};
        function down(v, stack) {
            if (!isRouting(v)) { let one = {}; one[v] = true; return one; }
            if (memo[v]) return memo[v];
            stack = stack || {};
            if (stack[v]) return {};
            stack[v] = true;
            let set = {};
            (out[v] || []).forEach(function(e) { Object.assign(set, down(e.to, stack)); });
            delete stack[v];
            memo[v] = set;
            return set;
        }
        function logical(s) {
            let set = {};
            (out[s] || []).forEach(function(e) { Object.assign(set, down(e.to)); });
            return set;
        }
        // Which sources reach each routing node.
        let sourcesAt = {};
        Object.keys(out).forEach(function(s) {
            if (isRouting(s)) return;
            let seen = {}, queue = out[s].map(function(e) { return e.to; });
            while (queue.length > 0) {
                let v = queue.shift();
                if (!isRouting(v) || seen[v]) continue;
                seen[v] = true;
                (sourcesAt[v] = sourcesAt[v] || []).push(s);
                (out[v] || []).forEach(function(e) { queue.push(e.to); });
            }
        });
        function carried(e) {
            let set = {};
            let sources = isRouting(e.src) ? (sourcesAt[e.src] || []) : [e.src];
            let targets = Object.keys(down(e.to));
            sources.forEach(function(s) { targets.forEach(function(t) { set[s + '>' + t] = true; }); });
            return set;
        }
        return { byId: byId, edges: edges, isRouting: isRouting, down: down, logical: logical, carried: carried };
    }

    function cutRoutingEdge(byId, e) {
        let from = byId[e.from];
        if (!from) return;
        if (e.kind === 'wire') {
            if (Array.isArray(from.wires) && Array.isArray(from.wires[e.port])) {
                from.wires[e.port] = from.wires[e.port].filter(function(id) { return id !== e.to; });
            }
        } else if (e.kind === 'link') {
            let to = e.to.indexOf('ext:') === 0 ? e.to.substring(4) : e.to;
            from.links = (from.links || []).filter(function(id) { return id !== to; });
            let li = byId[to];
            if (li && Array.isArray(li.links)) li.links = li.links.filter(function(id) { return id !== from.id; });
        }
    }

    // `remove: { from, to }` names a connection the model was shown, which
    // may run through junctions and link nodes. The routing that carries only
    // what is being removed is cut; when the connection shares its path with
    // ones that stay, the source leaves that path and is wired back to what
    // it should still reach — through routing that leads nowhere else, or
    // directly. Every other connection reads the same afterwards.
    // See docs/{en,jp}/vibe-schema.md.
    function severConnections(nodes, removals) {
        let g = readRouting(nodes);
        let pairs = [], removedPair = {};
        (removals || []).forEach(function(rc) {
            let n = g.byId[rc.from];
            if (!n || !Array.isArray(n.wires) || !g.byId[rc.to]) return;
            n.wires.forEach(function(port, i) {
                if (rc.port !== null && i !== rc.port) return;
                let s = rc.from + '#' + i;
                if (!g.logical(s)[rc.to] || removedPair[s + '>' + rc.to]) return;
                removedPair[s + '>' + rc.to] = true;
                pairs.push({ s: s, from: rc.from, port: i, to: rc.to });
            });
        });
        if (pairs.length === 0) return;

        let want = {};
        pairs.forEach(function(p) {
            if (want[p.s]) return;
            let keep = g.logical(p.s);
            Object.keys(keep).forEach(function(t) { if (removedPair[p.s + '>' + t]) delete keep[t]; });
            want[p.s] = keep;
        });

        pairs.forEach(function(p) {
            let port = g.byId[p.from].wires[p.port];
            if (Array.isArray(port)) g.byId[p.from].wires[p.port] = port.filter(function(id) { return id !== p.to; });
        });

        // An edge on no remaining connection's path can go; cutting only
        // those can never break a connection that stays.
        g = readRouting(nodes);
        g.edges.forEach(function(e) {
            if (e.kind === 'fixed') return;
            let keys = Object.keys(g.carried(e));
            if (keys.some(function(k) { return removedPair[k]; }) &&
                keys.every(function(k) { return removedPair[k]; })) {
                cutRoutingEdge(g.byId, e);
            }
        });

        pairs.forEach(function(p) {
            g = readRouting(nodes);
            if (!g.logical(p.s)[p.to]) return;
            let n = g.byId[p.from];
            n.wires[p.port] = n.wires[p.port].filter(function(id) { return !(g.isRouting(id) && g.down(id)[p.to]); });
            let keep = want[p.s];
            for (;;) {
                g = readRouting(nodes);
                let have = g.logical(p.s);
                let lost = Object.keys(keep).filter(function(t) { return !have[t]; });
                if (lost.length === 0) return;
                // A wire can only go into a junction or a link out.
                let best = null, bestCover = 0;
                Object.keys(g.byId).forEach(function(id) {
                    let r = g.byId[id];
                    if (r.type !== 'junction' && r.type !== 'link out') return;
                    let reach = Object.keys(g.down(id));
                    if (reach.length === 0 || !reach.every(function(t) { return keep[t]; })) return;
                    let cover = lost.filter(function(t) { return reach.indexOf(t) !== -1; }).length;
                    if (cover > bestCover) { best = id; bestCover = cover; }
                });
                if (best) { n.wires[p.port].push(best); continue; }
                lost.forEach(function(t) { if (g.byId[t]) n.wires[p.port].push(t); });
                return;
            }
        });
    }

    // Routing this edit left with nothing to carry is taken down: an edge
    // that carried a connection before and carries none now is cut, then a
    // junction left with no wire at all, a link out left with no link, and a
    // link in left unreferenced or with nowhere to send go. Routing that was
    // already idle before the edit is the user's and stays as it is.
    // Returns the surviving nodes. See docs/{en,jp}/vibe-schema.md.
    function removeIdleRouting(nodes, beforeFlow) {
        if (!Array.isArray(beforeFlow) || beforeFlow.length === 0) return nodes;
        let gb = readRouting(beforeFlow);
        let busyBefore = {};
        gb.edges.forEach(function(e) {
            if (Object.keys(gb.carried(e)).length > 0) busyBefore[e.key] = true;
        });
        function ends(g, id) {
            let r = { in: 0, out: 0, links: 0, refs: 0 };
            g.edges.forEach(function(e) {
                if (e.to === id) { r.in++; if (e.kind !== 'wire') r.refs++; }
                if (e.from === id || e.src === id) { r.out++; if (e.kind === 'link') r.links++; }
            });
            return r;
        }
        function idle(g, n, wasActive) {
            if (!wasActive) return false;
            let r = ends(g, n.id);
            if (n.type === 'junction') return r.in === 0 && r.out === 0;
            if (n.type === 'link out') return n.mode !== 'return' && r.links === 0;
            if (n.type === 'link in') return r.refs === 0 || r.out === 0;
            return false;
        }
        let active = {};
        Object.keys(gb.byId).forEach(function(id) {
            let n = gb.byId[id];
            if (!Converter.isRoutingNode(n)) return;
            let r = ends(gb, id);
            if (n.type === 'junction') active[id] = r.in > 0 || r.out > 0;
            else if (n.type === 'link out') active[id] = n.mode !== 'return' && r.links > 0;
            else active[id] = r.refs > 0 && r.out > 0;
        });

        for (;;) {
            let changed = false;
            let g = readRouting(nodes);
            g.edges.forEach(function(e) {
                // A link to another tab is that tab's too: cross-flow isolation.
                if (e.kind === 'fixed' || !busyBefore[e.key] || e.to.indexOf('ext:') === 0) return;
                if (!g.isRouting(e.from) && !g.isRouting(e.to)) return;
                if (Object.keys(g.carried(e)).length > 0) return;
                cutRoutingEdge(g.byId, e);
                changed = true;
            });
            g = readRouting(nodes);
            let gone = {};
            nodes.forEach(function(n) {
                if (n && n.id && Converter.isRoutingNode(n) && idle(g, n, active[n.id])) gone[n.id] = true;
            });
            if (Object.keys(gone).length > 0) {
                changed = true;
                nodes = nodes.filter(function(n) { return !(n && gone[n.id]); });
                nodes.forEach(function(n) {
                    if (Array.isArray(n.wires)) {
                        n.wires = n.wires.map(function(port) {
                            return Array.isArray(port) ? port.filter(function(id) { return !gone[id]; }) : port;
                        });
                    }
                    if (Array.isArray(n.links) && /^link /.test(n.type)) {
                        n.links = n.links.filter(function(id) { return !gone[id]; });
                    }
                    if (n.type === 'group' && Array.isArray(n.nodes)) {
                        n.nodes = n.nodes.filter(function(id) { return !gone[id]; });
                    }
                });
            }
            if (!changed) return nodes;
        }
    }

    // ================================================================== //
    //  Canvas Utilities                                                   //
    // ================================================================== //

    function getActiveWorkspaceId() {
        return LLMPlugin.UI.getActiveWorkspaceId();
    }

    function isCanvasNode(node) { return Converter.isCanvasNode(node); }

    // A group's box encloses its members, so the layout must not move it as
    // a node. Junctions are real routing points and stay in.
    function isLayoutNode(node) {
        return isCanvasNode(node) && !(node && node.type === 'group');
    }

    // Separated by type because the remove API is:
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

    // _redraw only repaints entities marked dirty; the deferred second pass
    // catches nodes whose SVG had not attached yet.
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

    // The layout phase, run inside-out: correct the coordinates coming in,
    // place the members, rearrange a named subset, fit each box around what
    // it now holds, then arrange the boxes and the canvas edge. Each step
    // needs the one before it to have finished — see docs/{en,jp}/layout.md,
    // "Order of the passes".
    function layoutRebuiltFlow(rebuilt, ctx) {
        let beforeFlow = ctx.beforeFlow;
        let baseIds = ctx.baseIds;
        let basePositions = ctx.basePositions;
        let directives = ctx.directives || {};
        let layout = LLMPlugin.CanvasLayout;
        // The live `.w` is measured from the rendered SVG, so it is only
        // valid while the label is unchanged. See docs/{en,jp}/layout.md.
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
            isCanvasNode: isLayoutNode,
            getNodeWidth: liveNodeWidth
        };

        // A rename changes the node's width and `x` is its CENTRE, so the
        // left edge — the thing this layout aligns — would move. Corrected
        // before the placement passes, which reason in left edges.
        let widthsBefore = {};
        (Array.isArray(beforeFlow) ? beforeFlow : []).forEach(function(n) {
            if (n && n.id && isLayoutNode(n)) widthsBefore[n.id] = layout.getNodeWidth(n, layoutOpts);
        });
        let widened = layout.keepLeftEdges(rebuilt, widthsBefore, layoutOpts);
        // The incremental pass pins existing nodes to these, so the
        // correction has to reach them or it is restored away again.
        rebuilt.forEach(function(n) {
            if (n && n.id && basePositions[n.id] && typeof n.x === 'number') {
                basePositions[n.id].x = n.x;
            }
        });

        // Routing is the user's: the node passes lay a chain out through a
        // junction, then it goes back where it was, shifted by as much as
        // what it serves moved (not at all when that moved unevenly). A link
        // node outside a box is placed the same way; one inside a box is laid
        // out with its sequence. See docs/{en,jp}/layout.md.
        let placedAt = {}, routingAt = {};
        rebuilt.forEach(function(n) {
            if (!n || !n.id || typeof n.x !== 'number' || typeof n.y !== 'number') return;
            placedAt[n.id] = { x: n.x, y: n.y };
            if (baseIds[n.id] && (n.type === 'junction' || (Converter.isRoutingNode(n) && !n.g))) {
                routingAt[n.id] = placedAt[n.id];
            }
        });

        // Was anything ON the canvas before? The tab itself is in `baseIds`
        // too, so counting ids made an empty flow look like an edit to an
        // existing one — and the fresh-layout branch, the one that starts at
        // the canvas origin, almost never ran.
        let hadCanvasNodes = (rebuilt || []).some(function(n) {
            return n && n.id && baseIds[n.id] && isLayoutNode(n) &&
                typeof n.x === 'number' && typeof n.y === 'number';
        });
        if (!hadCanvasNodes) {
            layout.reflowCanvasNodes(rebuilt, layoutOpts);
        } else {
            // Incremental edit: the existing flow shape is preserved and new
            // nodes are placed beside their neighbours.
            let incrementalOpts = Object.assign({}, layoutOpts, {
                reflowIds: widened
            });
            layout.placeAddedNodesNearNeighbors(rebuilt, baseIds, basePositions, incrementalOpts);
        }

        // Selective reposition: relayout the named subset in place,
        // keeping their IDs and properties. Runs AFTER the general
        // layout pass so coordinates of unaffected nodes are stable.
        if (Array.isArray(directives.repositionTokens) && directives.repositionTokens.length > 0) {
            repositionSubsetByAliases(rebuilt, directives.repositionTokens, layoutOpts);
        }
        let servedBy = layout.routingAnchors(rebuilt);
        // A junction inside one sequence sits between what feeds it and what
        // it serves, so it moves only when both sides moved alike. One that
        // leads from one box into another belongs to the box it leads into.
        let feedsJunction = {};
        rebuilt.forEach(function(n) {
            (n && Array.isArray(n.wires) ? n.wires : []).forEach(function(port) {
                (Array.isArray(port) ? port : []).forEach(function(to) {
                    if (routingAt[to]) (feedsJunction[to] = feedsJunction[to] || []).push(n);
                });
            });
        });
        rebuilt.forEach(function(n) {
            let at = n && routingAt[n.id];
            if (!at) return;
            let d = null, even = true;
            let served = servedBy[n.id] || [];
            let feeders = (n.type === 'junction' ? (feedsJunction[n.id] || []) : []).filter(function(f) {
                return served.some(function(s) { return (s.g || '') === (f.g || ''); });
            });
            let around = served.concat(feeders);
            around.forEach(function(a) {
                let was = placedAt[a.id];
                if (!was) return;
                let dx = a.x - was.x, dy = a.y - was.y;
                if (!d) d = { x: dx, y: dy };
                else if (dx !== d.x || dy !== d.y) even = false;
            });
            if (!d || !even) d = { x: 0, y: 0 };
            n.x = at.x + d.x;
            n.y = at.y + d.y;
        });

        // Whoever moved the members owns the boxes: the editor recomputes a
        // group's box only when the user drags something into or inside it.
        layout.fitGroups(rebuilt, layoutOpts);

        // Boxes fitted, so now they can be lined up and kept apart: the node
        // layout spaced the members, which is not the same as spacing what is
        // drawn around them.
        layout.separateGroups(rebuilt, layoutOpts);

        // Every caption onto the node it heads, re-read from where the passes
        // above left them: one that would sit on its node is clamped to a
        // full row above it.
        let finalAnchors = layout.captureCommentAnchors(rebuilt, layoutOpts);
        layout.applyCommentAnchors(rebuilt, finalAnchors, layoutOpts);

        // What the layout placed or moved goes onto the grid; what the edit
        // left where it was stays there. The snap comes before collisions are
        // settled, so it cannot leave anything touching, and settling pushes
        // in whole squares; what a push moved off its old place is snapped in
        // turn, until nothing moves.
        function snapMoved() {
            let unmoved = {};
            rebuilt.forEach(function(n) {
                let b = n && n.id && baseIds[n.id] && basePositions[n.id];
                if (b && n.x === b.x && n.y === b.y) unmoved[n.id] = true;
            });
            layout.snapToGrid(rebuilt, Object.assign({}, layoutOpts, { keep: unmoved }));
        }

        // The invariant, checked on the result rather than trusted to the
        // passes above, and the last thing that moves anything apart: nothing
        // sits on a node, a caption or a box it does not belong to.
        function settle() {
            for (let round = 0; round < 8; round++) {
                snapMoved();
                if (layout.settleCollisions(rebuilt, layoutOpts).length === 0) break;
            }
        }
        settle();

        // Last: the canvas edges. A box hangs one padding further out than
        // its members, so this is the pass that sees it — on both edges, so
        // the gap above the flow is the gap beside it. One shared shift, in
        // whole squares, so nothing it moves can start overlapping; what it
        // moved off the grid goes onto it like everything else.
        let probe = rebuilt.find(function(n) { return n && typeof n.x === 'number' && typeof n.y === 'number'; });
        let probeAt = probe && { x: probe.x, y: probe.y };
        layout.ensureCanvasMargins(rebuilt, layoutOpts);
        if (probe && (probe.x !== probeAt.x || probe.y !== probeAt.y)) settle();
        return rebuilt;
    }

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
            // RED.nodes.remove has no group bookkeeping, so a deleted member
            // stays listed in its group. See docs/{en,jp}/design.md §12.
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

        // Never carried over from existing to proposed: something else
        // supplies each. `g` is deliberately absent — the group pass below
        // only writes the members a schema named, so every other node's
        // membership has to survive here. See docs/{en,jp}/design.md §4.2,
        // §12 and §15.
        let MERGE_SKIP_KEYS = {
            id: 1, type: 1, z: 1, x: 1, y: 1, wires: 1,
            dirty: 1, changed: 1, selected: 1, valid: 1, h: 1, w: 1
        };

        // Restore every property the LLM did not explicitly touch — listed in
        // _llmSpecKeys, or defined on n. See docs/{en,jp}/design.md §4.2.
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
            severConnections(rebuilt, directives.removeConnections.map(function(rc) {
                return {
                    from: connLookup.resolve(rc.from),
                    to: connLookup.resolve(rc.to),
                    port: (typeof rc.fromPort === 'number' && rc.fromPort >= 0) ? rc.fromPort : null
                };
            }).filter(function(rc) { return rc.from && rc.to; }));
        }

        applyConnectionHints(rebuilt, connectionHints || [], connLookup);
        dropWiresBesideRouting(rebuilt, beforeFlow);
        rebuilt = removeIdleRouting(rebuilt, beforeFlow);

        // `above: <alias>` -> node id. The alias may name a node this schema
        // is adding, or one already on the canvas.
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

        // A property listing nodes may name one this reply adds, whose id
        // exists only now; planByWorkspace restored every other reference.
        (function resolveNewNodeRefs() {
            let newByAlias = {}, known = {};
            rebuilt.forEach(function(n) {
                if (!n || !n.id) return;
                known[n.id] = true;
                if (typeof n._llmAlias === 'string') newByAlias[n._llmAlias] = n.id;
            });
            function walk(v) {
                if (Array.isArray(v)) {
                    let refs = v.length > 0 && v.every(function(x) { return typeof x === 'string' && (known[x] || newByAlias[x]); });
                    if (refs) return v.map(function(x) { return known[x] ? x : newByAlias[x]; });
                    return v.map(walk);
                }
                if (v && typeof v === 'object') {
                    Object.keys(v).forEach(function(k) { v[k] = walk(v[k]); });
                }
                return v;
            }
            rebuilt.forEach(function(n) {
                if (!n || typeof n._llmAlias !== 'string') return;
                Object.keys(n).forEach(function(k) {
                    if (isMetaKey(k) || k === 'wires' || k === 'links') return;
                    if (n[k] && typeof n[k] === 'object') n[k] = walk(n[k]);
                });
            });
        })();

        // Group boxes are the user's: the model neither sees nor declares one.
        // What an edit does is keep a box holding its one sequence — a new
        // node wired into a boxed sequence, and a comment placed over a boxed
        // node, go into that box. See docs/{en,jp}/design.md §15.
        (function keepBoxesAroundTheirSequences() {
            let groups = rebuilt.filter(function(n) { return n && n.type === 'group'; });
            if (groups.length === 0) return;
            let byId = {};
            rebuilt.forEach(function(n) { if (n && n.id) byId[n.id] = n; });
            // Either half of membership says it: `g` on the member, or the id
            // in the group's list.
            let listedIn = {};
            groups.forEach(function(g) {
                (Array.isArray(g.nodes) ? g.nodes : []).forEach(function(id) { listedIn[id] = g; });
            });
            function boxOf(n) {
                if (!n) return null;
                if (n.g && byId[n.g] && byId[n.g].type === 'group') return byId[n.g];
                return listedIn[n.id] || null;
            }
            function join(n, g) {
                let was = boxOf(n);
                if (was === g) return;
                if (was) was.nodes = (Array.isArray(was.nodes) ? was.nodes : []).filter(function(id) { return id !== n.id; });
                if (g) {
                    g.nodes = (Array.isArray(g.nodes) ? g.nodes : []).concat([n.id]);
                    n.g = g.id;
                } else {
                    delete n.g;
                }
            }

            // A new node wired into a boxed sequence joins that box, when
            // every box among its neighbours is the same one.
            let neighbours = {};
            rebuilt.forEach(function(n) {
                if (!n || !n.id || !Array.isArray(n.wires)) return;
                n.wires.forEach(function(port) {
                    (Array.isArray(port) ? port : []).forEach(function(to) {
                        if (!byId[to]) return;
                        (neighbours[n.id] = neighbours[n.id] || []).push(to);
                        (neighbours[to] = neighbours[to] || []).push(n.id);
                    });
                });
            });
            let joined = true;
            while (joined) {
                joined = false;
                rebuilt.forEach(function(n) {
                    if (!n || !n.id || baseIds[n.id] || n.g || !isLayoutNode(n) || n.type === 'comment') return;
                    let boxes = {};
                    (neighbours[n.id] || []).forEach(function(id) {
                        let g = boxOf(byId[id]);
                        if (g) boxes[g.id] = g;
                    });
                    let ids = Object.keys(boxes);
                    if (ids.length !== 1) return;
                    join(n, boxes[ids[0]]);
                    joined = true;
                });
            }

            // A caption heads the sequence it names, so it belongs in the box
            // of the node it heads: left out, it lands exactly on the top edge
            // (the padding is one row) and reads as a stray label. A comment
            // the reply gave an `above` follows its target — into that box, or
            // out of the one it was in when the target has none.
            rebuilt.forEach(function(c) {
                if (!c || c.type !== 'comment' || typeof c._llmAboveId !== 'string') return;
                let target = byId[c._llmAboveId];
                if (target) join(c, boxOf(target));
            });
        })();

        // Metadata sweep #1: no `_`-prefixed property may reach the canvas.
        // These two survive until the layout passes below are done.
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

        layoutRebuiltFlow(rebuilt, {
            beforeFlow: beforeFlow,
            baseIds: baseIds,
            basePositions: basePositions,
            directives: directives
        });

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
    // The subset is laid out on its own, so a node wired to it but left
    // unnamed would keep its place while the named ones are laid out over it.
    // Grows the subset along the wires, but not out of the box it is in.
    // See docs/{en,jp}/vibe-schema.md — Layout fix.
    function takeWiredSequence(allNodes, byId, subsetIdSet) {
        let neighbours = {};
        allNodes.forEach(function(n) {
            if (!n || !n.id || !Array.isArray(n.wires) || !isLayoutNode(n)) return;
            n.wires.forEach(function(port) {
                (Array.isArray(port) ? port : []).forEach(function(to) {
                    if (!byId[to] || !isLayoutNode(byId[to])) return;
                    (neighbours[n.id] = neighbours[n.id] || []).push(to);
                    (neighbours[to] = neighbours[to] || []).push(n.id);
                });
            });
        });
        let queue = Object.keys(subsetIdSet);
        while (queue.length > 0) {
            let n = byId[queue.shift()];
            (neighbours[n.id] || []).forEach(function(id) {
                let m = byId[id];
                if (subsetIdSet[id] || m.type === 'comment' || (m.g || null) !== (n.g || null)) return;
                subsetIdSet[id] = true;
                queue.push(id);
            });
        }
    }

    function repositionSubsetByAliases(allNodes, aliases, layoutOpts) {
        if (!Array.isArray(aliases) || aliases.length === 0) return;
        let layout = LLMPlugin.CanvasLayout;
        let commentAnchors = layout.captureCommentAnchors(allNodes, layoutOpts);

        let lookup = buildFlowLookup(allNodes);

        let subsetIdSet = {};
        // A caption is not a step in the chain: laying one out as a node gives
        // it a column of its own and leaves it beside what it heads. Named or
        // not, it follows its target below.
        function takeNode(n) {
            if (n && n.id && isLayoutNode(n) && n.type !== 'comment') subsetIdSet[n.id] = true;
        }
        aliases.forEach(function(a) {
            let id = lookup.resolve(a, { exactOnly: true }) || lookup.resolve(a);
            if (id) takeNode(lookup.byId[id]);
        });
        takeWiredSequence(allNodes, lookup.byId, subsetIdSet);

        let subsetNodes = allNodes.filter(function(n) {
            return n && n.id && subsetIdSet[n.id];
        });
        if (subsetNodes.length < 1) return;

        // Anchor the subset to its current top-left so unrelated nodes
        // around it don't visually shift. LEFT EDGES, like everything else
        // here: pinning centres moves the column whenever the reflow puts a
        // node of a different width first.
        function leftEdgeOf(n) {
            return n.x - layout.getNodeWidth(n, layoutOpts) / 2;
        }
        function topLeftOf(nodes) {
            let x = Infinity, y = Infinity;
            nodes.forEach(function(n) {
                if (typeof n.x !== 'number' || typeof n.y !== 'number') return;
                let left = leftEdgeOf(n);
                if (left < x) x = left;
                if (n.y < y) y = n.y;
            });
            return {
                x: isFinite(x) ? x : LAYOUT.startX,
                y: isFinite(y) ? y : LAYOUT.startY
            };
        }
        let origin = topLeftOf(subsetNodes);

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
            isCanvasNode: isLayoutNode
        });
        layout.reflowCanvasNodes(clones, opts);

        let placed = topLeftOf(clones);

        let dx = origin.x - placed.x;
        let dy = origin.y - placed.y;

        let cloneById = {};
        clones.forEach(function(c) { cloneById[c.id] = c; });
        subsetNodes.forEach(function(n) {
            let c = cloneById[n.id];
            if (!c) return;
            if (typeof c.x === 'number') n.x = c.x + dx;
            if (typeof c.y === 'number') n.y = c.y + dy;
        });

        // Re-align captions to follow their (now moved) anchor target, and put
        // them back on the standard slot while we are at it: a reposition is a
        // request to tidy up, so a caption carrying half a row of drift should
        // not come out of it still carrying that drift.
        layout.applyCommentAnchors(allNodes, commentAnchors,
            Object.assign({}, layoutOpts, { snapCaptions: true }));
    }

    // ================================================================== //
    //  Replace Workspace Flow                                             //
    // ================================================================== //

    // createExportableNodeSet is mandatory, not a convenience: a live group
    // holds node OBJECTS where the export format wants ids, so there is no
    // safe JSON-clone fallback. See docs/{en,jp}/design.md §7.
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
            // Junctions and groups are removed below, so the rollback
            // snapshot has to carry them too.
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

        // Properties only, no re-import. Stubs and `_`-prefixed keys are
        // already gone by here; Config Node Protection lives in the merge.
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
            importNodes.forEach(applyTypeDefaults);
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
    // rebuildWorkspaceFromSnapshot produces the complete desired end state;
    // this applies it as a diff. Anything the diff cannot express hands back
    // `fallback: true` and the caller rebuilds instead, so correctness never
    // depends on the diff covering every case. See docs/{en,jp}/design.md §12.

    // Handled by other means, so they take no part in the property compare:
    // `wires` becomes link surgery, `x`/`y` a move, and id/type/z identify the
    // entity. A group's `w`/`h` are derived from its members.
    function comparableKeys(before, after) {
        let skip = { id: 1, type: 1, z: 1, wires: 1, x: 1, y: 1 };
        // A group's box and its member list follow its members, so neither is
        // compared here: the authoritative half of membership is each node's
        // `g`, and `applyGroupMembership` writes the list and the box the
        // layout fitted. Comparing them would report every membership change
        // twice — once on the node, once on the group.
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

    // A live entity by id, whichever registry it lives in. Junctions and
    // groups are NOT in RED.nodes.node()'s lookup — each has its own — and a
    // wire may perfectly well end at a junction, while a group is what an
    // alias resolves to when the schema edits a box.
    function liveEntity(id) {
        let n = RED.nodes.node(id);
        if (n) return n;
        if (typeof RED.nodes.junction === 'function') {
            try {
                let j = RED.nodes.junction(id);
                if (j) return j;
            } catch (e) { /* ignore */ }
        }
        if (typeof RED.nodes.group === 'function') {
            try { return RED.nodes.group(id) || null; } catch (e) { /* ignore */ }
        }
        return null;
    }

    // removeLink matches by object identity, so the links to drop have to
    // come from getNodeLinks, not be reconstructed.
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

    // A property the reply left out gets its type's default, as a node dropped
    // from the palette does, instead of failing validation (a split with no
    // `property` shows the warning mark). Done here, not through an import
    // option, so it does not depend on the editor version. A config reference
    // with no default is "", which is what the edit dialog writes for "none":
    // left undefined, merely opening the node and closing it marks the flow
    // changed (http in's `swaggerDoc`).
    function applyTypeDefaults(n) {
        let def = (n && n.type && typeof RED.nodes.getType === 'function') ? RED.nodes.getType(n.type) : null;
        let defaults = def && def.defaults;
        if (!defaults) return;
        Object.keys(defaults).forEach(function(k) {
            if (k === 'inputs' || k === 'outputs' || n[k] !== undefined || !defaults[k]) return;
            if (defaults[k].value !== undefined) n[k] = JSON.parse(JSON.stringify(defaults[k].value));
            else if (defaults[k].type) n[k] = '';
        });
    }

    // As the edit dialog does it: a repointed config reference is
    // de-registered against the OLD value first, or `users` drifts.
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
        // The editor validates on import and on closing the edit dialog, not
        // on a property write, so without this the warning mark stays as it
        // was until the user opens the node.
        if (RED.editor && typeof RED.editor.validateNode === 'function') {
            try { RED.editor.validateNode(liveNode); } catch (e) { /* ignore */ }
        }
        liveNode.changed = true;
        liveNode.dirty = true;
    }

    // Can group membership be maintained on the live canvas? On a locked
    // workspace removeFromGroup is a silent no-op, which is the one case that
    // must not proceed. See docs/{en,jp}/design.md §12.
    function canMaintainGroups() {
        return !!(RED.group && typeof RED.group.removeFromGroup === 'function' &&
                  typeof RED.nodes.group === 'function' &&
                  !(RED.workspaces && typeof RED.workspaces.isLocked === 'function' &&
                    RED.workspaces.isLocked()));
    }

    // Detach before removing. Returns whether membership is actually
    // consistent afterwards; false has to abort, not carry on.
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

    // Both halves of group membership, reconciled against the desired state:
    // `g` on the member, the member OBJECT in the group's `nodes`. The editor
    // draws from both and repairs neither, and `RED.nodes.import` only links
    // members that were in the SAME import set — so a new node joining a box
    // that already existed, or a new box drawn around nodes already on the
    // canvas, is written here.
    //
    // Not `RED.group.addToGroup`: it recomputes the box from `n.w` / `n.h`,
    // which a node that has not been drawn yet does not have, and the layout
    // has already fitted these boxes.
    function applyGroupMembership(desiredCanvas, liveLookup) {
        function liveOf(id) {
            if (!id || typeof id !== 'string') return null;
            let fromApply = liveLookup ? liveLookup(id) : null;
            if (fromApply) return fromApply;
            return RED.nodes.node(id) ||
                (typeof RED.nodes.junction === 'function' ? RED.nodes.junction(id) : null) ||
                (typeof RED.nodes.group === 'function' ? RED.nodes.group(id) : null);
        }
        function memberId(m) {
            return (typeof m === 'string') ? m : (m && m.id) || null;
        }
        function detach(live) {
            if (!live || !live.g) return;
            let old = RED.nodes.group(live.g);
            if (old) RED.group.removeFromGroup(old, live, false);
            // The box is already gone; `g` is all that is left to clear.
            if (live.g) { try { delete live.g; } catch (e) { live.g = undefined; } }
            live.dirty = true;
        }

        // Members first: one that left its box, and one whose box was
        // deleted — `removeGroup` does not clear `g` for us.
        (desiredCanvas || []).forEach(function(want) {
            if (!want || want.type === 'group') return;
            let live = liveOf(want.id);
            if (!live || !live.g || live.g === want.g) return;
            detach(live);
        });

        (desiredCanvas || []).forEach(function(want) {
            if (!want || want.type !== 'group') return;
            let group = RED.nodes.group(want.id);
            if (!group) return;

            let wanted = (Array.isArray(want.nodes) ? want.nodes : [])
                .filter(function(id) { return typeof id === 'string'; });
            let keep = {};
            wanted.forEach(function(id) { keep[id] = true; });

            (Array.isArray(group.nodes) ? group.nodes.slice() : []).forEach(function(m) {
                let id = memberId(m);
                if (id && keep[id]) return;
                let live = liveOf(id);
                if (live) detach(live);
            });

            let members = [];
            wanted.forEach(function(id) {
                let live = liveOf(id);
                if (!live || live === group) return;
                live.g = group.id;
                live.dirty = true;
                members.push(live);
            });
            // Assigned, not spliced: this IS the membership, and an entry the
            // editor left behind as an id rather than an object is the shape
            // that draws an empty box.
            group.nodes = members;

            // The box with it. Node-RED recomputes a group's bounds only when
            // a user drags a member, so the box the layout fitted is the box
            // the user sees — and it is not compared as a property for that
            // reason (see comparableKeys).
            ['x', 'y', 'w', 'h'].forEach(function(k) {
                if (typeof want[k] === 'number') group[k] = want[k];
            });
            group.dirty = true;
            if (RED.group && typeof RED.group.markDirty === 'function') {
                try { RED.group.markDirty(group); } catch (e) { /* ignore */ }
            }
        });
    }

    function applyMove(liveNode, after) {
        if (typeof after.x === 'number') liveNode.x = after.x;
        if (typeof after.y === 'number') liveNode.y = after.y;
        liveNode.moved = true;
        liveNode.dirty = true;
    }

    // Clear the tab and re-import an export of it. Rollback only: on a
    // half-applied failure it is the only way back to a known state.
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

    // Update existing config nodes in place; hand back the new ones to be
    // imported with the rest. They live outside the workspace, so the canvas
    // rollback cannot reach them and `undo` records how to put them back.
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

    // Newest-first, so a node created and then edited is removed rather than
    // half-restored. Best effort: this path has already failed once.
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

    // { ok } | { ok: false, fallback: true } (use the destructive path)
    // | { ok: false, error } (real failure; the workspace is rolled back).
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
        // Groups it CAN express: the box is an entity like any other, and
        // `applyGroupMembership` writes both halves of membership after the
        // import. What it cannot survive is a workspace where the group API
        // is a silent no-op, because half-written membership is the failure
        // the editor never repairs. See docs/{en,jp}/design.md §12.
        let bail = null;
        updates.forEach(function(u) {
            let before = beforeById[u.id], after = afterById[u.id];
            if (before.type !== after.type) bail = bail || 'a node changed type';
        });
        // Any box on either side means the membership pass runs: a group's
        // box and member list are not compared as properties (see
        // comparableKeys), so "nothing changed" is not something the diff can
        // read off them. The pass writes the desired state as it is, which
        // for an untouched group is what it already had.
        let groupWork = split.canvas.some(function(n) { return n && n.type === 'group'; }) ||
            Object.keys(liveKind).some(function(id) { return liveKind[id] === 'group'; });
        if (groupWork && !canMaintainGroups()) {
            bail = bail || 'the group API is unavailable';
        }
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
                // `g` is membership, written in both halves below; a live
                // group's `nodes` holds node OBJECTS, not the ids an export
                // has, so neither is a property to assign here.
                let keys = u.keys.filter(function(k) {
                    return k !== 'g' && !(liveKind[u.id] === 'group' && k === 'nodes');
                });
                if (keys.length > 0) applyPropertyUpdate(liveById[u.id], afterById[u.id], keys);
            });
            moves.forEach(function(id) { applyMove(liveById[id], afterById[id]); });

            // Before the wire pass: a new link needs both ends to exist. The
            // import makes their own wires; wires pointing AT them are below.
            let configImports = applyConfigNodeUpdates(split.configs, configUndo);
            let importSet = added.concat(configImports);
            if (importSet.length > 0) {
                // Bypass RED.history - rewind via the plugin's checkpoints.
                importSet.forEach(applyTypeDefaults);
                RED.nodes.import(importSet, { generateIds: false, reimport: true, addFlow: false });
            }

            // After the import: a member added by this edit has to exist
            // before it can be put in a box.
            if (groupWork) applyGroupMembership(split.canvas, function(id) { return liveById[id]; });

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
            // Canvas first: removing its nodes de-registers them from the
            // config nodes the undo below may delete.
            try { restoreWorkspaceFromExport(beforeExport, wsId); } catch (e2) { /* ignore */ }
            try { undoConfigNodeUpdates(configUndo); } catch (e3) { /* ignore */ }
            return { ok: false, error: 'Failed to apply flow changes: ' + (e.message || e) };
        }
    }

    // ================================================================== //
    //  Multi-flow Dispatch                                                //
    // ================================================================== //

    // The aliases exactly as the model was shown them: one numbering over
    // every context flow, so each names one node. Each canvas node also
    // carries the alias its own tab gives it, which is what the per-workspace
    // import resolves. See docs/{en,jp}/design.md §6.
    function contextAliasTable(ids) {
        let opts = { includeCanvasExtras: true };
        let context = LLMPlugin.UI.getFlowsByIds(ids, opts) || [];
        let inter = Converter.toIntermediate(context, { includeIdMap: true });
        let idToAlias = (inter && inter._meta && inter._meta.idToAlias) || {};
        let byId = {};
        context.forEach(function(n) { if (n && n.id) byId[n.id] = n; });
        let local = {};
        ids.forEach(function(ws) { local[ws] = buildFlowLookup(LLMPlugin.UI.getFlowsByIds([ws], opts) || []); });
        let entries = {};
        Object.keys(idToAlias).forEach(function(id) {
            let n = byId[id];
            let ws = (n && n.z && ids.indexOf(n.z) !== -1) ? n.z : null;
            entries[idToAlias[id]] = { id: id, ws: ws, local: ws ? local[ws].idToAlias[id] : null };
        });
        return { entries: entries, local: local, byId: byId, idToAlias: idToAlias };
    }

    // A node reference inside a property — a catch node's `scope`, say — is
    // an alias on the way to the model (toIntermediate) and goes back to the
    // id here. A string array naming only nodes is references; any other
    // string is restored only where the node already held that reference, so
    // text that happens to read like an alias is left alone. Top-level
    // strings are config references, resolved later by their own rules.
    function restoreNodeRefs(value, was, t, isNewAlias, depth) {
        if (Array.isArray(value)) {
            let allRefs = value.length > 0 && value.every(function(v) {
                return typeof v === 'string' && (!!t.entries[v] || isNewAlias(v));
            });
            if (allRefs) return value.map(function(v) { return t.entries[v] ? t.entries[v].id : v; });
            return value.map(function(v, i) {
                return restoreNodeRefs(v, Array.isArray(was) ? was[i] : undefined, t, isNewAlias, depth + 1);
            });
        }
        if (value && typeof value === 'object') {
            let out = {};
            Object.keys(value).forEach(function(k) {
                out[k] = restoreNodeRefs(value[k], (was && typeof was === 'object') ? was[k] : undefined, t, isNewAlias, depth + 1);
            });
            return out;
        }
        if (depth > 0 && typeof value === 'string' && typeof was === 'string' && t.idToAlias[was] === value) return was;
        return value;
    }

    // Splits a reply into one sub-schema per context flow, in the aliases
    // that flow's own import resolves. An existing node is edited on the tab
    // it is on, whatever `flow` the reply gave it. A new node goes to its
    // `flow`, else to the flow of what it is wired to or captions, else to
    // the default flow. A wire between two tabs is not made; a removed one is
    // severAcrossFlows'. Returns { wsId: subSchema }.
    function planByWorkspace(schema, ids, allowedSet) {
        let t = contextAliasTable(ids);
        let nodes = (schema.nodes && typeof schema.nodes === 'object' && !Array.isArray(schema.nodes)) ? schema.nodes : {};
        function existing(tok) {
            let e = (typeof tok === 'string') ? t.entries[tok] : null;
            return (e && e.ws) ? e : null;
        }
        function isConfigSpec(k) {
            let spec = nodes[k];
            if (t.entries[k] && !t.entries[k].ws) return true;
            return !!spec && typeof spec === 'object' &&
                Converter.claimsConfig(spec);
        }
        function isNewCanvas(k) {
            let spec = nodes[k];
            return !!spec && typeof spec === 'object' && !existing(k) && !isConfigSpec(k);
        }

        let home = {};
        let refused = [];
        Object.keys(nodes).forEach(function(k) {
            let e = existing(k);
            if (e) { home[k] = e.ws; return; }
            if (!isNewCanvas(k)) return;
            let flow = (typeof nodes[k].flow === 'string') ? nodes[k].flow.trim() : '';
            if (!flow) return;
            let ws = resolveFlowLabelToWorkspace(flow, allowedSet);
            if (ws) home[k] = ws;
            else if (refused.indexOf(flow) === -1) refused.push(flow);
        });
        refused.forEach(function(flow) {
            Common.notice('Target flow "' + flow + '" is not one of the flows this chat is working on. Using the context flow instead.', 'warning');
        });

        let conns = Array.isArray(schema.connections) ? schema.connections : [];
        function wsOf(tok) { let e = existing(tok); return e ? e.ws : home[tok]; }
        let changed = true, guard = 64;
        while (changed && guard-- > 0) {
            changed = false;
            conns.forEach(function(c) {
                if (!c || c.remove || typeof c.from !== 'string' || typeof c.to !== 'string') return;
                let a = wsOf(c.from), b = wsOf(c.to);
                if (a && !b && isNewCanvas(c.to)) { home[c.to] = a; changed = true; }
                if (b && !a && isNewCanvas(c.from)) { home[c.from] = b; changed = true; }
            });
            Object.keys(nodes).forEach(function(k) {
                if (!isNewCanvas(k) || home[k] || typeof nodes[k].above !== 'string') return;
                let ws = wsOf(nodes[k].above);
                if (ws) { home[k] = ws; changed = true; }
            });
        }
        let defaultWs = pickDefaultWorkspace(allowedSet);
        Object.keys(nodes).forEach(function(k) { if (isNewCanvas(k) && !home[k]) home[k] = defaultWs; });

        // A new node whose alias its tab already gives another node would be
        // read as an edit to that node, so it is renamed.
        let renamed = {};
        Object.keys(nodes).forEach(function(k) {
            if (!isNewCanvas(k) || !home[k]) return;
            let taken = t.local[home[k]] ? t.local[home[k]].aliasToId : {};
            if (!taken[k]) return;
            let n = 2, name = k + '_new';
            while (taken[name] || nodes[name] || t.entries[name]) name = k + '_new' + (n++);
            renamed[k] = name;
        });
        function nameIn(tok) {
            let e = existing(tok);
            if (e) return e.local;
            return renamed[tok] || tok;
        }
        function isNewAlias(tok) { return isNewCanvas(tok); }

        let subs = {};
        function sub(ws) { return (subs[ws] = subs[ws] || { nodes: {}, connections: [] }); }

        // A deletion names an alias the model was shown; one that is not
        // exactly one is looked for on each flow, and applied only where
        // exactly one flow has it.
        let unrouted = [];
        function routeDelete(tok) {
            let e = existing(tok);
            if (e) return { ws: e.ws, name: e.local };
            let owners = ids.filter(function(ws) { return !!t.local[ws].resolve(tok, { exactOnly: true }); });
            if (owners.length !== 1) owners = ids.filter(function(ws) { return !!t.local[ws].resolve(tok); });
            if (owners.length === 1) return { ws: owners[0], name: tok };
            unrouted.push(tok);
            return null;
        }

        Object.keys(nodes).forEach(function(k) {
            let spec = nodes[k];
            if (spec === null) {
                let d = routeDelete(k);
                if (d) sub(d.ws).nodes[d.name] = null;
                return;
            }
            if (!isNewCanvas(k) && !existing(k)) return;
            let ws = home[k];
            if (!ws) return;
            let copy = JSON.parse(JSON.stringify(spec));
            delete copy.flow;
            if (typeof copy.above === 'string') {
                if (wsOf(copy.above) === ws) copy.above = nameIn(copy.above);
                else delete copy.above;
            }
            if (copy.props && typeof copy.props === 'object') {
                let e = existing(k);
                let was = e ? t.byId[e.id] : null;
                Object.keys(copy.props).forEach(function(p) {
                    copy.props[p] = restoreNodeRefs(copy.props[p], was ? was[p] : undefined, t, isNewAlias, 0);
                });
            }
            sub(ws).nodes[nameIn(k)] = copy;
        });

        conns.forEach(function(c) {
            if (!c || typeof c !== 'object') return;
            let r = c.remove && typeof c.remove === 'object' ? c.remove : c;
            if (typeof r.from !== 'string' || typeof r.to !== 'string') return;
            let a = wsOf(r.from), b = wsOf(r.to);
            if (a && b && a !== b) return;
            let ws = a || b || defaultWs;
            if (!ws) return;
            let out = { from: nameIn(r.from), to: nameIn(r.to) };
            if (typeof r.fromPort === 'number') out.fromPort = r.fromPort;
            sub(ws).connections.push(c.remove ? { remove: out } : out);
        });

        let repo = schema.reposition || schema.relayout || schema.reflow;
        if (Array.isArray(repo)) {
            [].concat.apply([], repo.map(function(x) { return Array.isArray(x) ? x : [x]; })).forEach(function(tok) {
                if (typeof tok !== 'string' || !tok.trim()) return;
                let ws = wsOf(tok) || defaultWs;
                if (!ws) return;
                let s = sub(ws);
                (s.reposition = s.reposition || []).push(nameIn(tok));
            });
        }

        let remove = schema.remove || schema.delete || schema.removeNodes || schema.deleted;
        if (Array.isArray(remove)) {
            remove.forEach(function(tok) {
                if (typeof tok !== 'string' || !tok.trim()) return;
                let d = routeDelete(tok.trim());
                if (!d) return;
                let s = sub(d.ws);
                (s.remove = s.remove || []).push(d.name);
            });
        }
        if (unrouted.length > 0) {
            Common.notice('Could not tell which flow these node(s) should be deleted from; left in place: ' +
                unrouted.join(', '), 'warning');
        }

        // Config nodes live outside every tab: each flow's import sees them.
        Object.keys(nodes).forEach(function(k) {
            if (!isConfigSpec(k) || !nodes[k] || typeof nodes[k] !== 'object') return;
            let targets = Object.keys(subs);
            if (targets.length === 0 && defaultWs) targets = [defaultWs];
            targets.forEach(function(ws) { sub(ws).nodes[k] = JSON.parse(JSON.stringify(nodes[k])); });
        });

        if (typeof schema.description === 'string') {
            Object.keys(subs).forEach(function(ws) { subs[ws].description = schema.description; });
        }
        return subs;
    }

    // Back into a fenced block: the per-workspace import re-parses a message,
    // not a schema object.
    function serializeSchemaAsMessage(schema) {
        return '```json\n' + JSON.stringify(schema, null, 2) + '\n```';
    }

    async function dispatchToWorkspaces(subs, options) {
        let results = [];
        let aggregatedAdded = 0;
        let aggregatedImported = 0;
        let wsIds = Object.keys(subs);
        for (let i = 0; i < wsIds.length; i++) {
            let wsId = wsIds[i];
            try {
                let res = await Importer.importFlowFromMessage(serializeSchemaAsMessage(subs[wsId]), Object.assign({}, options, {
                    targetWorkspaceId: wsId,
                    _isSubImport: true
                }));
                results.push(Object.assign({}, res, { workspaceId: wsId }));
                if (res && res.ok) {
                    aggregatedAdded += (res.addedNodeCount || 0);
                    aggregatedImported += (res.importedCount || 0);
                }
            } catch (e) {
                results.push({ ok: false, error: String(e && e.message ? e.message : e), workspaceId: wsId });
            }
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

    // A connection the model was shown across tabs — `A → link out` on one,
    // `link in → B` on another, both in the context — is cut here, over all
    // the context flows at once: every other step works one workspace at a
    // time and cannot see the far end. Tabs outside the context are never
    // touched. See docs/{en,jp}/vibe-schema.md.
    function severAcrossFlows(messageContent, allowedWorkspaceIds) {
        let ids = Array.isArray(allowedWorkspaceIds) ? allowedWorkspaceIds.filter(Boolean) : [];
        if (ids.length < 2) return;
        let removals = (extractFlowDirectives(messageContent).removeConnections || []);
        if (removals.length === 0) return;
        let context = LLMPlugin.UI.getFlowsByIds(ids, { includeCanvasExtras: true });
        if (!Array.isArray(context)) return;
        let before = context.filter(function(n) { return n && n.z && ids.indexOf(n.z) !== -1; });
        let inter = Converter.toIntermediate(context, { includeIdMap: true });
        let idToAlias = (inter && inter._meta && inter._meta.idToAlias) || {};
        let aliasToId = {};
        Object.keys(idToAlias).forEach(function(id) { aliasToId[idToAlias[id]] = id; });

        let all = readRouting(before);
        let cross = [];
        removals.forEach(function(rc) {
            let from = all.byId[aliasToId[rc.from]], to = all.byId[aliasToId[rc.to]];
            if (!from || !to || !Array.isArray(from.wires)) return;
            let port = (typeof rc.fromPort === 'number' && rc.fromPort >= 0) ? rc.fromPort : null;
            let ownTab = readRouting(before.filter(function(n) { return n.z === from.z; }));
            let reaches = from.wires.some(function(p, i) {
                if (port !== null && i !== port) return false;
                return all.logical(from.id + '#' + i)[to.id] && !ownTab.logical(from.id + '#' + i)[to.id];
            });
            if (reaches) cross.push({ from: from.id, to: to.id, port: port });
        });
        if (cross.length === 0) return;

        let after = JSON.parse(JSON.stringify(before));
        severConnections(after, cross);
        after = removeIdleRouting(after, before);

        ids.forEach(function(wsId) {
            let was = JSON.stringify(before.filter(function(n) { return n.z === wsId; }));
            let desired = after.filter(function(n) { return n.z === wsId; });
            if (JSON.stringify(desired) === was) return;
            let res = applyWorkspaceDiff(desired, wsId);
            if (res && res.fallback) res = replaceWorkspaceFlow(desired, wsId);
            if (!res || !res.ok) {
                Common.notice('Could not cut a connection across flows: ' + ((res && res.error) || 'unknown error'), 'error');
            }
        });
    }

    Importer.importFlowFromMessage = async function(messageContent, options) {
        options = options || {};
        try {
            // The flows sent as context. Null = none was selected, which
            // leaves the active tab as the only sensible target.
            let allowedSet = buildAllowedWorkspaceSet(options.allowedWorkspaceIds);

            // Read the reply against the aliases the model was shown, then
            // import each context flow's share of it on its own.
            if (!options._isSubImport && allowedSet) {
                let ids = Object.keys(allowedSet);
                severAcrossFlows(messageContent, ids);
                let rawSchema = extractLastVibeSchema(messageContent);
                if (rawSchema && Converter.isVibeSchema(rawSchema)) {
                    let subs = planByWorkspace(rawSchema, ids, allowedSet);
                    let wsIds = Object.keys(subs);
                    if (wsIds.length > 1) return await dispatchToWorkspaces(subs, options);
                    if (wsIds.length === 0) return { ok: true, importedCount: 0, addedNodeCount: 0, addedNodes: [] };
                    options = Object.assign({}, options, { targetWorkspaceId: wsIds[0] });
                    messageContent = serializeSchemaAsMessage(subs[wsIds[0]]);
                }
            }

            let targetWs = (options.targetWorkspaceId && typeof options.targetWorkspaceId === 'string')
                ? options.targetWorkspaceId
                : null;
            // A target that escaped the scope (e.g. a sub-import handed a
            // stale id) is discarded rather than honoured.
            if (targetWs && !isWorkspaceAllowed(allowedSet, targetWs)) targetWs = null;

            // Before snapshotting: the rebuild base must come from the very
            // workspace the result is written back to.
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
                        Common.notice(detail, 'warning');
                        try { console.warn('[LLM Plugin] JSON parse failed:', diag); } catch (e) {}
                        postTerminalLog('warn', 'json-parse-failed',
                            'LLM response contained a fenced code block that failed to parse',
                            { line: diag.line, column: diag.column, error: diag.error });
                        return { ok: false, error: detail };
                    }
                    Common.notice('No JSON flow found in message', 'warning');
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
            // Aliases as the model was shown them. Only config references are
            // resolved through this - see buildConfigAliasIndex.
            let configAliases = buildConfigAliasIndex(options.allowedWorkspaceIds);
            // Stub ids whose config node could not be found at all, so the
            // props pointing at them can be cleared rather than left dangling.
            let unresolvedStubs = {};

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
                // liveEntity, not RED.nodes.node: a group alias resolves to a
                // box, which lives in its own registry.
                let existing = liveEntity(exactId);
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

                // 1. Exact alias only: the model was given every existing
                // alias, so a new one means "add". See design.md §4.3.
                if (nn._llmAlias) {
                    let aliasId = preResolvedAlias[idx] || null;
                    if (aliasId) {
                        let byAlias = liveEntity(aliasId);
                        // Allow matching for: same workspace nodes, OR config nodes
                        // (config nodes have no z / empty z — they live outside workspaces)
                        if (byAlias && (!currentWorkspace || byAlias.z === currentWorkspace || !byAlias.z)) {
                            replacedExisting = byAlias;
                        }
                    }
                }

                // 1b. Config nodes only: the same alias against the wider
                // context table. See buildConfigAliasIndex.
                if (!replacedExisting && nn._llmAlias && isConfigNodeObj(nn)) {
                    let hit = resolveConfigAlias(configAliases, nn._llmAlias, null);
                    if (hit && !claimedExistingIds[hit.id]) {
                        let live = RED.nodes.node(hit.id);
                        // A stub's type is a guess from the property name, so
                        // only the alias is evidence. A declared config node
                        // states its own type, and that has to agree.
                        if (live && (nn._autoStub || live.type === nn.type)) {
                            replacedExisting = live;
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
                        // Nothing matches this stub and it must not be
                        // created, so the reference is cleared below.
                        unresolvedStubs[nn.id] = nn._llmAlias || nn.type;
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
                        if (NON_REF_KEYS[key]) return;
                        if (typeof n[key] === 'string' && remappedIds[n[key]]) {
                            n[key] = remappedIds[n[key]];
                        }
                    });
                });
            }

            // Config references under a key the converter never recognised -
            // an unfamiliar node type names its config property whatever it
            // likes. See docs/{en,jp}/design.md §5.
            newNodes.forEach(function(n) {
                if (!n) return;
                Object.keys(n).forEach(function(key) {
                    if (NON_REF_KEYS[key] || isMetaKey(key)) return;
                    let hit = resolveConfigAlias(configAliases, n[key], n.type);
                    if (hit) n[key] = hit.id;
                });
            });

            // References to a config node that exists nowhere: cleared, so
            // the node reads as unconfigured rather than broken, and named.
            if (Object.keys(unresolvedStubs).length > 0) {
                let missing = {};
                newNodes.forEach(function(n) {
                    if (!n) return;
                    Object.keys(n).forEach(function(key) {
                        if (NON_REF_KEYS[key] || isMetaKey(key)) return;
                        if (typeof n[key] !== 'string') return;
                        let alias = unresolvedStubs[n[key]];
                        if (!alias) return;
                        missing[alias] = true;
                        n[key] = '';
                    });
                });
                let names = Object.keys(missing);
                if (names.length > 0) {
                    Common.notice('Config node(s) not found: ' + names.join(', ') +
                        '. The node(s) referring to them were left unconfigured.', 'warning');
                    postTerminalLog('warn', 'config-ref-unresolved',
                        'A schema referenced config nodes that do not exist', { aliases: names });
                }
            }

            // Remove tab nodes
            newNodes = newNodes.filter(function(n) { return n && n.type && n.type.toLowerCase() !== 'tab'; });

            // Assign workspace
            if (currentWorkspace && typeof currentWorkspace === 'string') {
                newNodes.forEach(function(n) {
                    if (isCanvasNode(n)) n.z = currentWorkspace;
                });
            } else {
                Common.notice('Could not determine active workspace; imported nodes may not be in the deployed flow', 'warning');
            }

            let hasDirectives = (flowDirectives.removeTokens || []).length > 0 ||
                                (flowDirectives.removeConnections || []).length > 0 ||
                                (flowDirectives.repositionTokens || []).length > 0 ||
                                (connectionHints || []).length > 0;
            if (!newNodes.length && !hasDirectives) {
                Common.notice('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning');
                return { ok: false, error: 'No valid nodes after sanitization' };
            }

            let bad = newNodes.find(function(n) { return typeof n.type !== 'string' || n.type.length === 0; });
            if (bad) {
                Common.notice('Import aborted: invalid node shape', 'error');
                console.warn('[LLM Plugin] bad node', bad);
                return { ok: false, error: 'Invalid node shape' };
            }

            // Last line of defence: the fallback path clears its target's
            // canvas, so an out-of-scope id here would destroy a flow.
            if (!isWorkspaceAllowed(allowedSet, currentWorkspace)) {
                let scopeErr = 'Import aborted: target flow is outside this chat\'s flow context';
                Common.notice(scopeErr, 'error');
                postTerminalLog('warn', 'import-scope-violation',
                    'Refused to write outside the conversation flow context',
                    { target: currentWorkspace || null, allowed: Object.keys(allowedSet || {}) });
                return { ok: false, error: scopeErr };
            }

            let rebuiltFlow = rebuildWorkspaceFromSnapshot(beforeFlow, newNodes, currentWorkspace, connectionHints, flowDirectives);
            // `fallback` means the diff found something it cannot express;
            // the rebuild applies the same end state wholesale.
            let rebuiltResult = applyWorkspaceDiff(rebuiltFlow, currentWorkspace);
            if (rebuiltResult && rebuiltResult.fallback) {
                postTerminalLog('warn', 'incremental-apply-fallback',
                    'Incremental apply declined; rebuilding the workspace instead',
                    { workspace: currentWorkspace, reason: rebuiltResult.error || null });
                rebuiltResult = replaceWorkspaceFlow(rebuiltFlow, currentWorkspace);
            }
            if (!rebuiltResult || !rebuiltResult.ok) {
                let errMsg = (rebuiltResult && rebuiltResult.error) || 'Failed to rebuild flow from snapshot';
                Common.notice('Import failed: ' + errMsg, 'error');
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
            Common.notice('Failed to import flow: ' + (err && err.message ? err.message : String(err)), 'error');
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

                // Every non-tab canvas entity, through the type-specific
                // APIs. Config nodes (no `z`) are patched in place below.
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
        return Common.apiFetch('llm-plugin/checkpoints/' + encodeURIComponent(checkpointId))
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



