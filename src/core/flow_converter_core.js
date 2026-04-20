// Flow Converter Core: bi-directional converter between Node-RED JSON
// and Vibe Schema (intermediate JSON).
//
// This module is intentionally independent from plugin UI/server code so it
// can be reused by other projects.
//
// Vibe Schema:
//   {
//     "description": "...",
//     "nodes": { "alias": { "type": "...", "name": "...", "props": { ... } } },
//     "connections": [{ "from": "a", "to": "b", "fromPort": 0 }]
//   }
//
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        window.LLMPlugin.FlowConverterCore = factory();
        window.LLMPlugin.Configurator = window.LLMPlugin.FlowConverterCore;
    }
})(function() {
    'use strict';

    // Layout defaults — shared between toNodeRed() and callers that
    // override via options.  Importers should reference these values so
    // there is a single source of truth for spacing / gap constants.
    var LAYOUT_DEFAULTS = {
        startX:       60,
        startY:       60,
        spacingX:     180,   // 3 grid squares (60 px) between node edges
        spacingY:      80,   // row height
        componentGap:  80,   // gap between disconnected flow components (center-to-center)
                             // 80 px = ~40 px visible gap + ~40 px node height ≈ 2 grid squares
        maxColumns:     5
    };

    // Node-RED config node types end with "-config" and live outside the
    // canvas (no x, y, wires).  Detect them so we can handle them specially.
    var CONFIG_TYPE_SUFFIX = '-config';

    // Well-known node types that have 0 input ports (source-only / event nodes).
    // Connections targeting these types are invalid and should be dropped.
    var NO_INPUT_TYPES = {
        'inject': true,
        'catch': true,
        'status': true,
        'complete': true,
        'http in': true,
        'mqtt in': true,
        'websocket in': true,
        'tcp in': true,
        'udp in': true
    };

    /**
     * Optional runtime type-info callback.  When set (typically by the browser
     * environment), it is called with a node type string and should return the
     * node definition object (same shape as RED.nodes.getType) or null.
     * This allows non-core / community nodes to be detected correctly.
     */
    var _runtimeGetType = null;

    function setRuntimeGetType(fn) {
        _runtimeGetType = (typeof fn === 'function') ? fn : null;
    }

    function isConfigType(type) {
        if (typeof type !== 'string') return false;
        // Runtime detection first (covers every installed node — core,
        // community, custom — via RED.nodes.getType().category).
        if (_runtimeGetType) {
            var def = _runtimeGetType(type);
            if (def && def.category === 'config') return true;
        }
        // Static fallback: the "-config" suffix is the Node-RED convention
        // for config node types (e.g. venv-config, mongodb-config).
        if (type.length > CONFIG_TYPE_SUFFIX.length &&
            type.substring(type.length - CONFIG_TYPE_SUFFIX.length) === CONFIG_TYPE_SUFFIX) return true;
        return false;
    }

    /**
     * Determine whether a node object is a config node by combining
     * type-based detection (runtime + static) with structural detection.
     * In a valid Node-RED flow, config nodes lack x, y, and wires because
     * they live outside the canvas.  This structural check serves as a
     * reliable fallback when the runtime type registry is unavailable and
     * the type name does not match a known config-type pattern.
     */
    function isConfigNode(node) {
        if (!node || typeof node !== 'object') return false;
        var type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        // Type-based detection (runtime + static suffix/list)
        if (isConfigType(type)) return true;
        // Structural detection: config nodes have no canvas properties.
        // Exclude tab and subflow definitions which also lack x/y/wires.
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        var hasZ = false; // Ignore z (config nodes can be workspace scoped)
        var hasXY = typeof node.x === 'number' || typeof node.y === 'number';
        var hasWires = Array.isArray(node.wires);
        var hasGroup = typeof node.g === 'string' && node.g.length > 0;
        return !hasZ && !hasXY && !hasWires && !hasGroup;
    }

    /** Check whether a node type has zero input ports. */
    function isNoInputType(type) {
        if (typeof type !== 'string') return false;
        // Runtime detection first (covers all installed nodes)
        if (_runtimeGetType) {
            var def = _runtimeGetType(type);
            if (def && typeof def.inputs === 'number') {
                return def.inputs === 0;
            }
        }
        // Static fallback
        return NO_INPUT_TYPES[type] === true;
    }

    // Keys that belong to the Node-RED runtime/editor and should NOT be treated
    // as type-specific properties ("props") in the intermediate format.
    var META_KEYS = ['id', 'type', 'name', 'z', 'x', 'y', 'wires', 'g'];

    // ------------------------------------------------------------------ //
    //  Utilities                                                          //
    // ------------------------------------------------------------------ //

    /** Generate a short random ID compatible with Node-RED. */
    function genId() {
        return 'id_' + Math.random().toString(36).substr(2, 9);
    }

    /** Turn an arbitrary string into a safe, lower-case alias. */
    function sanitizeAlias(str) {
        return str
            .replace(/[^a-zA-Z0-9_]/g, '_')
            .replace(/_{2,}/g, '_')
            .replace(/^_|_$/g, '')
            .toLowerCase() || 'node';
    }

    /** Pick a unique alias for a node: {type}_{name} format, kept short. */
    function generateAlias(node, usedAliases) {
        var typePart = sanitizeAlias(node.type || 'node');
        var namePart = node.name && node.name.trim() ? sanitizeAlias(node.name) : '';
        // Combine type and name; skip name if it duplicates the type
        var base;
        if (namePart && namePart !== typePart) {
            base = typePart + '_' + namePart;
        } else {
            base = typePart;
        }
        var alias = base;
        var counter = 2;
        while (usedAliases[alias]) {
            alias = base + '_' + counter;
            counter++;
        }
        return alias;
    }

    // ------------------------------------------------------------------ //
    //  Node-RED JSON  →  Intermediate (Vibe Schema)                       //
    // ------------------------------------------------------------------ //

    /**
     * Convert an array of Node-RED nodes into Vibe Schema intermediate JSON.
     *
     * @param  {Array}  nodeRedJson  Exported Node-RED nodes (array of objects).
     * @return {Object} Vibe Schema { description, nodes, connections }.
     */
    function toIntermediate(nodeRedJson, options) {
        var opts = options || {};
        if (!Array.isArray(nodeRedJson) || nodeRedJson.length === 0) {
            return { description: '', nodes: {}, connections: [] };
        }

        // Filter out tab / subflow definition nodes
        var nodes = nodeRedJson.filter(function(n) {
            return n && n.type && n.type !== 'tab' && n.type.indexOf('subflow:') !== 0;
        });

        // --- Pass 1: assign aliases ---
        var usedAliases = {};
        var idToAlias = {};

        nodes.forEach(function(node) {
            var alias = generateAlias(node, usedAliases);
            usedAliases[alias] = true;
            idToAlias[node.id] = alias;
        });

        // --- Pass 2: build intermediate nodes & connections ---
        var intermediateNodes = {};
        var connections = [];

        nodes.forEach(function(node) {
            var alias = idToAlias[node.id];

            // Collect type-specific properties
            var props = {};
            Object.keys(node).forEach(function(key) {
                if (META_KEYS.indexOf(key) !== -1) return;
                if (key.charAt(0) === '_') return;              // editor-internal
                props[key] = node[key];
            });

            // Inject nodes have an internal "props" array that collides with
            // the Vibe Schema concept.  Strip it — toNodeRed will regenerate it.
            if (node.type === 'inject' && Array.isArray(props.props)) {
                delete props.props;
            }

            // Resolve config-node ID references in props → aliases.
            // Any string prop whose value is a known node ID is replaced
            // with that node's alias so the intermediate format stays
            // portable (IDs are instance-specific).
            Object.keys(props).forEach(function(key) {
                if (typeof props[key] === 'string' && idToAlias[props[key]]) {
                    props[key] = idToAlias[props[key]];
                }
            });

            var entry = { type: node.type };
            if (node.name) entry.name = node.name;
            // Mark config nodes so the LLM knows they live outside the canvas.
            if (isConfigNode(node)) {
                entry.config = true;
            }
            if (Object.keys(props).length > 0) entry.props = props;

            intermediateNodes[alias] = entry;

            // wires → connections
            if (Array.isArray(node.wires)) {
                node.wires.forEach(function(output, portIndex) {
                    if (!Array.isArray(output)) return;
                    output.forEach(function(targetId) {
                        var targetAlias = idToAlias[targetId];
                        if (!targetAlias) return;
                        var conn = { from: alias, to: targetAlias };
                        if (portIndex > 0) conn.fromPort = portIndex;
                        connections.push(conn);
                    });
                });
            }
        });

        // Auto-generate a human-readable description
        var typeCount = {};
        nodes.forEach(function(n) {
            typeCount[n.type] = (typeCount[n.type] || 0) + 1;
        });
        var desc = nodes.length + ' node(s): ' +
            Object.keys(typeCount).map(function(t) {
                return t + (typeCount[t] > 1 ? ' x' + typeCount[t] : '');
            }).join(', ');

        var result = {
            description: desc,
            nodes: intermediateNodes,
            connections: connections
        };

        if (opts.includeIdMap) {
            result._meta = { idToAlias: idToAlias };
        }

        return result;
    }

    // ------------------------------------------------------------------ //
    //  Intermediate (Vibe Schema)  →  Node-RED JSON                       //
    // ------------------------------------------------------------------ //

    /**
     * Topological layout engine with parallel-branch support and line wrapping.
     * 1. Discovers connected components (subgraphs).
     * 2. Lays out each component independently — nodes in a straight chain
     *    share the same row so branches stay visually horizontal.
     * 3. When a chain exceeds maxColumns, wraps to the next row set.
     * 4. Stacks components vertically with a 2-row gap.
     *
     * @param {string[]} aliases
     * @param {Object}   outgoing  alias → [target aliases]
     * @param {Object}   incoming  alias → [source aliases]
     * @param {number}   [maxColumns=5]  Wrap after this many columns.
     */
    function layoutNodes(aliases, outgoing, incoming, maxColumns) {
        if (!maxColumns || maxColumns < 2) maxColumns = 5;
        var positions = {};
        var visited = {};

        // --- Step 1: discover connected components (undirected BFS) ---
        var components = [];
        function discoverComponent(start) {
            var comp = [];
            var q = [start];
            visited[start] = true;
            while (q.length > 0) {
                var a = q.shift();
                comp.push(a);
                var neighbors = (outgoing[a] || []).concat(incoming[a] || []);
                for (var i = 0; i < neighbors.length; i++) {
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
        var globalRowOffset = 0;
        var componentIndex = 0;

        components.forEach(function(comp) {
            var compSet = {};
            comp.forEach(function(a) { compSet[a] = true; });

            // Root nodes: no incoming edges from within this component
            var roots = comp.filter(function(a) {
                return incoming[a].every(function(p) { return !compSet[p]; });
            });
            if (roots.length === 0) roots = [comp[0]];

            // BFS to assign column indices
            var colMap = {};
            var bfsVis = {};
            var queue = [];
            roots.forEach(function(r) {
                colMap[r] = 0;
                bfsVis[r] = true;
                queue.push(r);
            });
            while (queue.length > 0) {
                var cur = queue.shift();
                for (var i = 0; i < outgoing[cur].length; i++) {
                    var next = outgoing[cur][i];
                    if (!bfsVis[next] && compSet[next]) {
                        bfsVis[next] = true;
                        colMap[next] = (colMap[cur] || 0) + 1;
                        queue.push(next);
                    }
                }
            }
            comp.forEach(function(a) { if (colMap[a] === undefined) colMap[a] = 0; });

            // Group by column
            var columns = {};
            comp.forEach(function(a) {
                var c = colMap[a];
                if (!columns[c]) columns[c] = [];
                columns[c].push(a);
            });

            // Assign rows: inherit parent's row to keep chains horizontal
            var rowMap = {};
            var colKeys = Object.keys(columns).map(Number).sort(function(a, b) { return a - b; });

            colKeys.forEach(function(col) {
                var nodesInCol = columns[col];
                if (col === colKeys[0]) {
                    // First column: sequential rows from current offset
                    nodesInCol.forEach(function(a, idx) {
                        rowMap[a] = globalRowOffset + idx;
                    });
                } else {
                    // Later columns: inherit parent row
                    var assignments = nodesInCol.map(function(a) {
                        var parents = incoming[a].filter(function(p) {
                            return compSet[p] && rowMap[p] !== undefined;
                        });
                        var target;
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
                    var usedRows = {};
                    assignments.forEach(function(item) {
                        var row = item.target;
                        while (usedRows[row]) row++;
                        usedRows[row] = true;
                        rowMap[item.alias] = row;
                    });
                }
            });

            // --- Wrap long chains ---
            // Find the distinct row count within this component (before wrapping)
            var compMaxCol = 0;
            comp.forEach(function(a) { if (colMap[a] > compMaxCol) compMaxCol = colMap[a]; });

            if (compMaxCol >= maxColumns) {
                // Count the distinct rows used in the original layout
                var rowSet = {};
                comp.forEach(function(a) { rowSet[rowMap[a]] = true; });
                var rowsPerFold = Object.keys(rowSet).length;
                if (rowsPerFold < 1) rowsPerFold = 1;

                comp.forEach(function(a) {
                    var fold = Math.floor(colMap[a] / maxColumns);
                    if (fold > 0) {
                        colMap[a] = colMap[a] % maxColumns;
                        rowMap[a] = rowMap[a] + fold * (rowsPerFold + 1);
                    }
                });
            }

            // Compute max row for this component
            var maxRow = globalRowOffset - 1;
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

            globalRowOffset = maxRow + 1; // compact row packing; pixel gap added by caller
            componentIndex++;
        });

        return positions;
    }

    /**
     * Convert Vibe Schema intermediate JSON into an array of Node-RED nodes.
     *
     * @param  {Object} intermediate  Vibe Schema object.
     * @param  {Object} [options]     Optional overrides.
     * @param  {string} [options.workspace]  Tab ID to assign (z).
     * @param  {number} [options.startX]    Defaults to LAYOUT_DEFAULTS.startX.
     * @param  {number} [options.startY]    Defaults to LAYOUT_DEFAULTS.startY.
     * @param  {number} [options.spacingX]  Defaults to LAYOUT_DEFAULTS.spacingX.
     * @param  {number} [options.spacingY]  Defaults to LAYOUT_DEFAULTS.spacingY.
     * @param  {number} [options.maxColumns] Defaults to LAYOUT_DEFAULTS.maxColumns.
     * @return {Array}  Node-RED JSON nodes array.
     */
    function toNodeRed(intermediate, options) {
        if (!intermediate || !intermediate.nodes) return [];

        var opts = options || {};
        var workspace      = opts.workspace      || '';
        var startX         = opts.startX         || LAYOUT_DEFAULTS.startX;
        var startY         = opts.startY         || LAYOUT_DEFAULTS.startY;
        var spacingX       = opts.spacingX       || LAYOUT_DEFAULTS.spacingX;
        var spacingY       = opts.spacingY       || LAYOUT_DEFAULTS.spacingY;
        var maxColumns     = opts.maxColumns     || LAYOUT_DEFAULTS.maxColumns;
        var preserveAlias  = !!opts.preserveAlias;

        // --- Work on a shallow copy so we never mutate the caller's object ---
        var nodeSpecs = {};
        Object.keys(intermediate.nodes).forEach(function(k) {
            nodeSpecs[k] = intermediate.nodes[k];
        });

        // --- Auto-create missing config nodes ---
        // LLMs sometimes reference config nodes by alias in props without
        // defining them.  Detect such dangling references and create stubs.
        //
        // Detection strategies:
        //  1. Props keys ending in "config" (e.g. venvconfig → venv-config)
        //  2. Well-known reference keys that commonly point to config nodes
        var CONFIG_REF_KEYS = {
            'broker': 'mqtt-broker',
            'server': null,          // type varies — skip auto-create
            'group': 'ui-group',
            'tab': 'ui-tab',
            'base': 'ui-base',
            'serialport': 'serial-port'
        };
        Object.keys(nodeSpecs).forEach(function(alias) {
            var spec = nodeSpecs[alias];
            if (!spec || !spec.props) return;
            Object.keys(spec.props).forEach(function(key) {
                var refAlias = spec.props[key];
                if (typeof refAlias !== 'string') return;
                if (nodeSpecs[refAlias]) return;           // already defined
                if (!/^[a-z][a-z0-9_]*$/i.test(refAlias)) return; // not alias-shaped

                // Strategy 1: key ends in "config"
                if (/config$/i.test(key)) {
                    var typeName = key.replace(/config$/i, '-config');
                    nodeSpecs[refAlias] = { type: typeName, name: refAlias, config: true, _autoStub: true, props: {} };
                    return;
                }

                // Strategy 2: well-known reference key
                var lowerKey = key.toLowerCase();
                if (CONFIG_REF_KEYS.hasOwnProperty(lowerKey) && CONFIG_REF_KEYS[lowerKey]) {
                    nodeSpecs[refAlias] = { type: CONFIG_REF_KEYS[lowerKey], name: refAlias, config: true, _autoStub: true, props: {} };
                }
            });
        });

        var aliases = Object.keys(nodeSpecs);
        if (aliases.length === 0) return [];

        // --- Generate real IDs ---
        var aliasToId = {};
        aliases.forEach(function(alias) {
            aliasToId[alias] = genId();
        });

        // --- Separate config nodes from canvas nodes for layout ---
        var canvasAliases = aliases.filter(function(a) {
            var spec = nodeSpecs[a];
            return !(isConfigType(spec.type) || spec.config === true);
        });

        // --- Build adjacency lists (skip dangling references) ---
        var outgoing = {};
        var incoming = {};
        canvasAliases.forEach(function(a) { outgoing[a] = []; incoming[a] = []; });

        var connections = intermediate.connections || [];
        connections.forEach(function(conn) {
            if (outgoing[conn.from] && incoming[conn.to]) {
                // Skip connections targeting nodes that cannot accept input
                var targetSpec = nodeSpecs[conn.to];
                if (targetSpec && isNoInputType(targetSpec.type)) return;
                outgoing[conn.from].push(conn.to);
                incoming[conn.to].push(conn.from);
            }
        });

        // --- Layout (canvas nodes only; config nodes have no coordinates) ---
        var layout = layoutNodes(canvasAliases, outgoing, incoming, maxColumns);

        // --- Build wires map (guard against dangling aliases) ---
        var wiresMap = {};
        aliases.forEach(function(a) { wiresMap[a] = []; });

        connections.forEach(function(conn) {
            if (!wiresMap[conn.from] || !aliasToId[conn.to]) return;
            // Skip connections targeting nodes that cannot accept input
            var targetSpec = nodeSpecs[conn.to];
            if (targetSpec && isNoInputType(targetSpec.type)) return;
            var port = Math.max(0, Math.min(conn.fromPort || 0, 32));
            while (wiresMap[conn.from].length <= port) {
                wiresMap[conn.from].push([]);
            }
            wiresMap[conn.from][port].push(aliasToId[conn.to]);
        });

        // --- Node-type normalisers ---

        /**
         * Reformat single-line JS/Python code into readable multi-line.
         * Only activates when the code appears to be a single line (few or
         * no newlines relative to the number of statements).
         */
        function formatFunctionCode(code) {
            if (!code || typeof code !== 'string') return code;

            // Heuristic: if there are already a reasonable number of newlines,
            // the code is already formatted — leave it alone.
            var lines = code.split('\n');
            var semis = (code.match(/;/g) || []).length;
            if (lines.length > 3 || (lines.length > 1 && lines.length >= semis * 0.3)) {
                return code;
            }

            // Walk the code character-by-character, tracking:
            //  - nesting depth of () [] for skipping semicolons in for(;;) etc.
            //  - brace depth {} for indentation
            //  - string context (' " `)
            var result = [];
            var indent = 0;
            var i = 0;
            var len = code.length;
            var parenDepth = 0;    // () and []
            var inString = false;  // false, or the opening quote char
            var INDENT = '  ';

            function pushIndent() {
                result.push('\n');
                for (var k = 0; k < indent; k++) result.push(INDENT);
            }

            while (i < len) {
                var ch = code[i];

                // --- String tracking ---
                if (inString) {
                    result.push(ch);
                    if (ch === '\\' && i + 1 < len) {
                        result.push(code[i + 1]);
                        i += 2;
                        continue;
                    }
                    if (ch === inString) inString = false;
                    i++;
                    continue;
                }
                if (ch === "'" || ch === '"' || ch === '`') {
                    inString = ch;
                    result.push(ch);
                    i++;
                    continue;
                }

                // --- Parens / brackets ---
                if (ch === '(' || ch === '[') {
                    parenDepth++;
                    result.push(ch);
                    i++;
                    continue;
                }
                if (ch === ')' || ch === ']') {
                    parenDepth--;
                    if (parenDepth < 0) parenDepth = 0;
                    result.push(ch);
                    i++;
                    continue;
                }

                // --- Braces ---
                if (ch === '{') {
                    // Peek backwards: skip space and check  =>  or  ) or keyword
                    result.push(' {');
                    indent++;
                    pushIndent();
                    i++;
                    // Skip any whitespace after {
                    while (i < len && (code[i] === ' ' || code[i] === '\t')) i++;
                    continue;
                }
                if (ch === '}') {
                    indent--;
                    if (indent < 0) indent = 0;
                    pushIndent();
                    result.push('}');
                    i++;
                    // If next is ; or , consume it on the same line
                    if (i < len && (code[i] === ';' || code[i] === ',')) {
                        result.push(code[i]);
                        i++;
                    }
                    // If next non-space is ) or . keep it on the same line
                    // (method chains like }).on(...) and callback closes like }))
                    var peekJ = i;
                    while (peekJ < len && code[peekJ] === ' ') peekJ++;
                    if (peekJ < len && (code[peekJ] === ')' || code[peekJ] === '.')) {
                        // Stay on same line — don't add newline
                        while (i < len && code[i] === ' ') i++;
                    } else if (peekJ < len && code[peekJ] !== '}') {
                        pushIndent();
                        while (i < len && code[i] === ' ') i++;
                    } else {
                        // Next is } or end — let the next iteration handle it
                        while (i < len && code[i] === ' ') i++;
                    }
                    continue;
                }

                // --- Semicolons (statement boundary) ---
                if (ch === ';' && parenDepth === 0) {
                    result.push(';');
                    i++;
                    // Skip whitespace after ;
                    while (i < len && (code[i] === ' ' || code[i] === '\t')) i++;
                    // Don't newline if next char is } (closing brace handles it)
                    if (i < len && code[i] !== '}') {
                        pushIndent();
                    }
                    continue;
                }

                // --- Default ---
                result.push(ch);
                i++;
            }

            var formatted = result.join('');
            // Clean up: remove trailing whitespace on each line, collapse blank lines
            formatted = formatted.split('\n').map(function(l) { return l.replace(/\s+$/, ''); }).join('\n');
            formatted = formatted.replace(/\n{3,}/g, '\n\n');
            formatted = formatted.replace(/^\s*\n/, '');  // leading blank line
            formatted = formatted.replace(/\n\s*$/, '');  // trailing blank line
            return formatted;
        }

        // Function nodes: Node-RED sandboxes func code so `require()` is
        // unavailable.  External modules must be declared in the `libs`
        // array.  This normaliser scans for require() calls, moves them
        // into `libs`, and rewrites the code to use plain variable names.
        function normalizeFunctionNode(node) {
            if (!node.func || typeof node.func !== 'string') return;

            // Match require() patterns ANYWHERE in the code — not just at
            // the start of a line.  LLMs often emit the entire function
            // body on one line separated by semicolons.
            //
            // Matches:
            //   const net = require('net');
            //   var net = require("net");
            //   let  net = require( 'net' );
            //   const { Socket } = require('net');
            //   …also mid-line: "…[]; const net = require('net'); …"
            var requireRe = /\b(?:const|let|var)\s+(?:\{[^}]+\}|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
            var libs = Array.isArray(node.libs) ? node.libs.slice() : [];
            var existingModules = {};
            libs.forEach(function(l) { existingModules[l.module] = true; });

            var cleaned = node.func.replace(requireRe, function(match, varName, moduleName) {
                if (existingModules[moduleName]) return '';   // already declared
                // For destructured imports use the module name as the var name
                var v = varName || moduleName.replace(/[^a-zA-Z0-9_$]/g, '_');
                libs.push({ var: v, module: moduleName });
                existingModules[moduleName] = true;
                return '';  // remove the require statement
            });

            // Tidy up: remove leading/trailing whitespace left behind
            cleaned = cleaned.replace(/^\s+/, '');
            cleaned = cleaned.replace(/\s+$/, '');
            // Collapse double semicolons left by require removal
            cleaned = cleaned.replace(/;\s*;/g, ';');

            if (libs.length > 0) {
                node.libs = libs;
                node.func = cleaned;
            }

            // Reformat single-line code into readable multi-line
            node.func = formatFunctionCode(node.func);

            // Ensure outputs is set (defaults to 1)
            if (node.outputs === undefined) node.outputs = 1;
        }

        // Inject nodes require a special internal `props` array plus several
        // default fields.  Without them the editor shows "not properly configured".
        function normalizeInjectNode(node) {
            if (node.payload    === undefined) node.payload    = '';
            if (node.payloadType === undefined) node.payloadType = 'date';
            if (node.topic      === undefined) node.topic      = '';
            if (node.repeat     === undefined) node.repeat     = '';
            if (node.crontab    === undefined) node.crontab    = '';
            if (node.once       === undefined) node.once       = false;
            if (node.onceDelay  === undefined) node.onceDelay  = 0.1;

            // Build the internal props descriptor array expected by the editor.
            if (!Array.isArray(node.props)) {
                var injectProps = [{ p: 'payload' }];
                if (node.topic !== undefined) {
                    injectProps.push({ p: 'topic', vt: 'str' });
                }
                node.props = injectProps;
            }

            // LLMs often output objects instead of strings for JSON typed properties
            if (node.payloadType === 'json' && typeof node.payload !== 'string') {
                try { node.payload = JSON.stringify(node.payload); } catch (e) {}
            }
        }

        // Change nodes and switch nodes sometimes receive raw objects instead of 
        // JSON-stringified strings when the property type is 'json'.
        // Node-RED expects stringified JSON in the internal representation.
        function normalizeRuleNodes(node) {
            if (Array.isArray(node.rules)) {
                node.rules.forEach(function(rule) {
                    if (rule.tot === 'json' && typeof rule.to !== 'string') {
                        try {
                            rule.to = JSON.stringify(rule.to);
                        } catch (e) {}
                    }
                    if (rule.vt === 'json' && typeof rule.v !== 'string') {
                        try {
                            rule.v = JSON.stringify(rule.v);
                        } catch (e) {}
                    }
                });
            }
        }

        // Switch node output count must match its branches.
        // If outputs stays at 1, Node-RED can collapse branch wires on import.
        function normalizeSwitchNode(node) {
            if (node.type !== 'switch') return;
            var rulesLen = Array.isArray(node.rules) ? node.rules.length : 0;
            var wiresLen = Array.isArray(node.wires) ? node.wires.length : 0;
            var current = (typeof node.outputs === 'number' && node.outputs > 0) ? node.outputs : 0;
            node.outputs = Math.max(current, rulesLen, wiresLen, 1);
        }

        // Template nodes: LLMs often use "tmpl" or "content" instead of "template".
        // Also ensure default values for syntax/output/field settings.
        function normalizeTemplateNode(node) {
            // Map common LLM property name mistakes
            if (node.template === undefined) {
                if (node.tmpl !== undefined) {
                    node.template = node.tmpl;
                    delete node.tmpl;
                } else if (node.content !== undefined) {
                    node.template = node.content;
                    delete node.content;
                } else if (node.body !== undefined) {
                    node.template = node.body;
                    delete node.body;
                }
            }
            if (node.template === undefined) node.template = '';
            if (node.syntax === undefined) node.syntax = 'mustache';
            if (node.output === undefined) node.output = 'str';
            if (node.fieldType === undefined) node.fieldType = 'msg';
            if (node.field === undefined) node.field = 'payload';
        }

        // Compute per-component Y offsets so disconnected flows stack with
        // Gap between disconnected flows: 2 grid squares (40px) visible gap.
        // Node effective height ≈ 40px, so center-to-center = 40 + 40 = 80px.
        var componentGapPx = LAYOUT_DEFAULTS.componentGap;
        function buildComponentYOffsets(layoutMap, aliases) {
            var compInfo = {};  // comp → { minRow, maxRow }
            aliases.forEach(function(a) {
                var pos = layoutMap[a];
                if (!pos || pos.comp === undefined) return;
                var ci = pos.comp;
                if (!compInfo[ci]) compInfo[ci] = { minRow: pos.row, maxRow: pos.row };
                if (pos.row < compInfo[ci].minRow) compInfo[ci].minRow = pos.row;
                if (pos.row > compInfo[ci].maxRow) compInfo[ci].maxRow = pos.row;
            });
            var compKeys = Object.keys(compInfo).map(Number).sort(function(a, b) { return a - b; });
            var offsets = {};
            var nextY = startY;
            compKeys.forEach(function(ci) {
                var info = compInfo[ci];
                // Offset so this component's minRow maps to nextY
                offsets[ci] = nextY - info.minRow * spacingY;
                // Next component starts after this one's maxRow + gap
                nextY = nextY + (info.maxRow - info.minRow) * spacingY + componentGapPx;
            });
            return offsets;
        }

        var compYOffsets = buildComponentYOffsets(layout, canvasAliases);

        // --- Assemble Node-RED nodes ---
        var result = [];
        aliases.forEach(function(alias) {
            var spec = nodeSpecs[alias];
            var isConfig = isConfigType(spec.type) || spec.config === true;
            var pos  = layout[alias] || { col: 0, row: 0 };

            var node = {
                id:   aliasToId[alias],
                type: spec.type
            };
            if (preserveAlias) node._llmAlias = alias;
            // Preserve the Vibe Schema `flow` field as `_llmFlow` so the
            // importer can route this node to the correct workspace in
            // multi-flow edits. The field is stripped before nodes reach
            // the canvas (handled by the importer).
            if (typeof spec.flow === 'string' && spec.flow.length > 0) {
                node._llmFlow = spec.flow;
            }
            if (spec.name) node.name = spec.name;
            if (workspace && !isConfig) node.z = workspace;

            // Config nodes don't appear on the canvas — skip coordinates
            if (!isConfig) {
                node.x = startX + pos.col * spacingX;
                var yOff = (pos.comp !== undefined && compYOffsets[pos.comp] !== undefined)
                    ? compYOffsets[pos.comp] : 0;
                node.y = Math.round(pos.row * spacingY + yOff);
            }

            // Flatten type-specific props (from both spec.props and root spec)
            var mergedProps = {};
            if (typeof spec.props === 'object' && spec.props !== null && !Array.isArray(spec.props)) {
                Object.keys(spec.props).forEach(function(key) {
                    mergedProps[key] = spec.props[key];
                });
            } else if (Array.isArray(spec.props)) {
                // Handle case where LLM generates Node-RED array 'props' (e.g. for inject nodes) directly
                mergedProps.props = spec.props;
            }

            // Flatten spec root keys into mergedProps, skipping META_KEYS
            // and Vibe-Schema-only keys (props, _llmAlias, config, flow).
            var SPEC_SKIP_KEYS = META_KEYS.concat(['props', '_llmAlias', 'config', 'flow']);
            Object.keys(spec).forEach(function(key) {
                if (SPEC_SKIP_KEYS.indexOf(key) === -1) {
                    mergedProps[key] = spec[key];
                }
            });

            Object.keys(mergedProps).forEach(function(key) {
                node[key] = mergedProps[key];
            });

            // Resolve alias references in props → real IDs.
            // Only resolve type-specific properties (config-node references like
            // venvconfig: "my_venv" → "id_xxx"). Skip META_KEYS (id, type, name,
            // z, x, y, wires, g) and _llmAlias to avoid corrupting node identity
            // when an alias happens to match a type or name (e.g. alias "inject"
            // colliding with type "inject").
            Object.keys(node).forEach(function(key) {
                if (key.charAt(0) === '_') return;
                if (META_KEYS.indexOf(key) !== -1) return;
                if (typeof node[key] === 'string' && aliasToId[node[key]]) {
                    node[key] = aliasToId[node[key]];
                }
            });

            if (!isConfig) {
                node.wires = wiresMap[alias] || [];
            }

            // Apply type-specific normalisers
            if (node.type === 'inject') normalizeInjectNode(node);
            if (node.type === 'function') normalizeFunctionNode(node);
            if (node.type === 'change' || node.type === 'switch') normalizeRuleNodes(node);
            if (node.type === 'switch') normalizeSwitchNode(node);
            if (node.type === 'template') normalizeTemplateNode(node);

            result.push(node);
        });

        return result;
    }

    // ------------------------------------------------------------------ //
    //  Detection helper                                                   //
    // ------------------------------------------------------------------ //

    /**
     * Check whether the given parsed JSON object looks like Vibe Schema.
     * @param  {*} obj  Parsed JSON value.
     * @return {boolean}
     */
    function isVibeSchema(obj) {
        return obj !== null &&
               typeof obj === 'object' &&
               !Array.isArray(obj) &&
               typeof obj.nodes === 'object' &&
               !Array.isArray(obj.nodes) &&
               Array.isArray(obj.connections);
    }

    // ------------------------------------------------------------------ //
    //  Public API                                                         //
    // ------------------------------------------------------------------ //

    return {
        LAYOUT_DEFAULTS:     LAYOUT_DEFAULTS,
        toIntermediate:      toIntermediate,
        toNodeRed:           toNodeRed,
        isVibeSchema:        isVibeSchema,
        isConfigType:        isConfigType,
        isConfigNode:        isConfigNode,
        isNoInputType:       isNoInputType,
        setRuntimeGetType:   setRuntimeGetType,
        layoutNodes:         layoutNodes
    };
});
