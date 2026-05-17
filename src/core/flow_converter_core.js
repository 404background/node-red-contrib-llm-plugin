// Flow Converter Core: Node-RED JSON ↔ Vibe Schema converter + type
// detection helpers. See ./VIBE_SCHEMA.md.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./canvas_layout.js'));
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        // canvas_layout.js must be loaded first (see ../client.js).
        window.LLMPlugin.FlowConverterCore = factory(window.LLMPlugin.CanvasLayout);
        window.LLMPlugin.Configurator = window.LLMPlugin.FlowConverterCore;
    }
})(function(CanvasLayout) {
    'use strict';

    let layoutNodes              = CanvasLayout.layoutNodes;
    let computeComponentYOffsets = CanvasLayout.computeComponentYOffsets;
    let LAYOUT_DEFAULTS          = CanvasLayout.LAYOUT_DEFAULTS;

    let CONFIG_TYPE_SUFFIX = '-config';

    let NO_INPUT_TYPES = {
        'inject': true, 'catch': true, 'status': true, 'complete': true,
        'http in': true, 'mqtt in': true, 'websocket in': true,
        'tcp in': true, 'udp in': true,
        'comment': true   // canvas-only annotation, no I/O
    };
    let NO_OUTPUT_TYPES = { 'comment': true };

    // Optional `RED.nodes.getType` adapter. Injected by setRuntimeGetType
    // so the helpers below can see community / custom node defs.
    let _runtimeGetType = null;

    function setRuntimeGetType(fn) {
        _runtimeGetType = (typeof fn === 'function') ? fn : null;
    }

    function isConfigType(type) {
        if (typeof type !== 'string') return false;
        if (_runtimeGetType) {
            let def = _runtimeGetType(type);
            if (def && def.category === 'config') return true;
        }
        if (type.length > CONFIG_TYPE_SUFFIX.length &&
            type.substring(type.length - CONFIG_TYPE_SUFFIX.length) === CONFIG_TYPE_SUFFIX) return true;
        return false;
    }

    function isConfigNode(node) {
        if (!node || typeof node !== 'object') return false;
        let type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        if (isConfigType(type)) return true;
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        // Structural fallback: no canvas properties => looks like a config node.
        let hasXY = typeof node.x === 'number' || typeof node.y === 'number';
        let hasWires = Array.isArray(node.wires);
        let hasGroup = typeof node.g === 'string' && node.g.length > 0;
        return !hasXY && !hasWires && !hasGroup;
    }

    function isNoInputType(type) {
        if (typeof type !== 'string') return false;
        if (_runtimeGetType) {
            let def = _runtimeGetType(type);
            if (def && typeof def.inputs === 'number') return def.inputs === 0;
        }
        return NO_INPUT_TYPES[type] === true;
    }

    function isCanvasNode(node) {
        if (!node || typeof node !== 'object') return false;
        let type = node.type;
        if (typeof type !== 'string' || !type.trim()) return false;
        if (type === 'tab' || type.indexOf('subflow:') === 0) return false;
        return !isConfigNode(node);
    }

    function isNoOutputType(type) {
        if (typeof type !== 'string') return false;
        if (_runtimeGetType) {
            let def = _runtimeGetType(type);
            if (def && typeof def.outputs === 'number') return def.outputs === 0;
        }
        return NO_OUTPUT_TYPES[type] === true;
    }

    // Runtime keys never treated as type-specific `props`.
    let META_KEYS = ['id', 'type', 'name', 'z', 'x', 'y', 'wires', 'g'];

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
        let typePart = sanitizeAlias(node.type || 'node');
        let namePart = node.name && node.name.trim() ? sanitizeAlias(node.name) : '';
        // Combine type and name; skip name if it duplicates the type
        let base;
        if (namePart && namePart !== typePart) {
            base = typePart + '_' + namePart;
        } else {
            base = typePart;
        }
        let alias = base;
        let counter = 2;
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
        let opts = options || {};
        if (!Array.isArray(nodeRedJson) || nodeRedJson.length === 0) {
            return { description: '', nodes: {}, connections: [] };
        }

        // Filter out tab / subflow definition nodes
        let nodes = nodeRedJson.filter(function(n) {
            return n && n.type && n.type !== 'tab' && n.type.indexOf('subflow:') !== 0;
        });

        // --- Pass 1: assign aliases ---
        let usedAliases = {};
        let idToAlias = {};

        nodes.forEach(function(node) {
            let alias = generateAlias(node, usedAliases);
            usedAliases[alias] = true;
            idToAlias[node.id] = alias;
        });

        // --- Pass 2: build intermediate nodes & connections ---
        let intermediateNodes = {};
        let connections = [];

        nodes.forEach(function(node) {
            let alias = idToAlias[node.id];

            // Collect type-specific properties
            let props = {};
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

            let entry = { type: node.type };
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
                        let targetAlias = idToAlias[targetId];
                        if (!targetAlias) return;
                        let conn = { from: alias, to: targetAlias };
                        if (portIndex > 0) conn.fromPort = portIndex;
                        connections.push(conn);
                    });
                });
            }
        });

        // Auto-generate a human-readable description
        let typeCount = {};
        nodes.forEach(function(n) {
            typeCount[n.type] = (typeCount[n.type] || 0) + 1;
        });
        let desc = nodes.length + ' node(s): ' +
            Object.keys(typeCount).map(function(t) {
                return t + (typeCount[t] > 1 ? ' x' + typeCount[t] : '');
            }).join(', ');

        let result = {
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
     * Convert Vibe Schema intermediate JSON into an array of Node-RED nodes.
     *
     * @param  {Object} intermediate  Vibe Schema object.
     * @param  {Object} [options]     Optional overrides.
     * @param  {string} [options.workspace]  Tab ID to assign (z).
     * @param  {number} [options.startX]    Defaults to LAYOUT_DEFAULTS.startX.
     * @param  {number} [options.startY]    Defaults to LAYOUT_DEFAULTS.startY.
     * @param  {number} [options.spacingY]  Defaults to LAYOUT_DEFAULTS.spacingY.
     * @param  {number} [options.edgeGap]   Pixels between adjacent node edges.
     * @param  {number} [options.maxColumns] Defaults to LAYOUT_DEFAULTS.maxColumns.
     * @return {Array}  Node-RED JSON nodes array.
     */
    function toNodeRed(intermediate, options) {
        if (!intermediate || !intermediate.nodes) return [];

        let opts = options || {};
        let workspace      = opts.workspace || '';
        let startX         = (typeof opts.startX     === 'number') ? opts.startX     : LAYOUT_DEFAULTS.startX;
        let startY         = (typeof opts.startY     === 'number') ? opts.startY     : LAYOUT_DEFAULTS.startY;
        let spacingY       = (typeof opts.spacingY   === 'number') ? opts.spacingY   : LAYOUT_DEFAULTS.spacingY;
        let edgeGap        = (typeof opts.edgeGap    === 'number') ? opts.edgeGap    : LAYOUT_DEFAULTS.edgeGap;
        let maxColumns     = (typeof opts.maxColumns === 'number') ? opts.maxColumns : LAYOUT_DEFAULTS.maxColumns;
        let preserveAlias  = !!opts.preserveAlias;

        // --- Work on a shallow copy so we never mutate the caller's object ---
        let nodeSpecs = {};
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
        let CONFIG_REF_KEYS = {
            'broker': 'mqtt-broker',
            'server': null,          // type varies — skip auto-create
            'group': 'ui-group',
            'tab': 'ui-tab',
            'base': 'ui-base',
            'serialport': 'serial-port'
        };
        Object.keys(nodeSpecs).forEach(function(alias) {
            let spec = nodeSpecs[alias];
            if (!spec || !spec.props) return;
            Object.keys(spec.props).forEach(function(key) {
                let refAlias = spec.props[key];
                if (typeof refAlias !== 'string') return;
                if (nodeSpecs[refAlias]) return;           // already defined
                if (!/^[a-z][a-z0-9_]*$/i.test(refAlias)) return; // not alias-shaped

                // Strategy 1: key ends in "config"
                if (/config$/i.test(key)) {
                    let typeName = key.replace(/config$/i, '-config');
                    nodeSpecs[refAlias] = { type: typeName, name: refAlias, config: true, _autoStub: true, props: {} };
                    return;
                }

                // Strategy 2: well-known reference key
                let lowerKey = key.toLowerCase();
                if (CONFIG_REF_KEYS.hasOwnProperty(lowerKey) && CONFIG_REF_KEYS[lowerKey]) {
                    nodeSpecs[refAlias] = { type: CONFIG_REF_KEYS[lowerKey], name: refAlias, config: true, _autoStub: true, props: {} };
                }
            });
        });

        let aliases = Object.keys(nodeSpecs);
        if (aliases.length === 0) return [];

        // --- Generate real IDs ---
        let aliasToId = {};
        aliases.forEach(function(alias) {
            aliasToId[alias] = genId();
        });

        // --- Separate config nodes from canvas nodes for layout ---
        let canvasAliases = aliases.filter(function(a) {
            let spec = nodeSpecs[a];
            return !(isConfigType(spec.type) || spec.config === true);
        });

        // --- Build adjacency lists (skip dangling references) ---
        let outgoing = {};
        let incoming = {};
        canvasAliases.forEach(function(a) { outgoing[a] = []; incoming[a] = []; });

        let connections = intermediate.connections || [];
        connections.forEach(function(conn) {
            if (outgoing[conn.from] && incoming[conn.to]) {
                // Skip connections targeting nodes that cannot accept input
                let targetSpec = nodeSpecs[conn.to];
                if (targetSpec && isNoInputType(targetSpec.type)) return;
                // Skip connections originating from nodes with no outputs
                // (e.g. the comment annotation node).
                let sourceSpec = nodeSpecs[conn.from];
                if (sourceSpec && isNoOutputType(sourceSpec.type)) return;
                outgoing[conn.from].push(conn.to);
                incoming[conn.to].push(conn.from);
            }
        });

        // --- Layout (canvas nodes only; config nodes have no coordinates) ---
        let layout = layoutNodes(canvasAliases, outgoing, incoming, maxColumns);

        // --- Build wires map (guard against dangling aliases) ---
        let wiresMap = {};
        aliases.forEach(function(a) { wiresMap[a] = []; });

        connections.forEach(function(conn) {
            if (!wiresMap[conn.from] || !aliasToId[conn.to]) return;
            // Skip connections targeting nodes that cannot accept input
            let targetSpec = nodeSpecs[conn.to];
            if (targetSpec && isNoInputType(targetSpec.type)) return;
            // Skip connections originating from nodes with no outputs
            let sourceSpec = nodeSpecs[conn.from];
            if (sourceSpec && isNoOutputType(sourceSpec.type)) return;
            let port = Math.max(0, Math.min(conn.fromPort || 0, 32));
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
            let lines = code.split('\n');
            let semis = (code.match(/;/g) || []).length;
            if (lines.length > 3 || (lines.length > 1 && lines.length >= semis * 0.3)) {
                return code;
            }

            // Walk the code character-by-character, tracking:
            //  - nesting depth of () [] for skipping semicolons in for(;;) etc.
            //  - brace depth {} for indentation
            //  - string context (' " `)
            let result = [];
            let indent = 0;
            let i = 0;
            let len = code.length;
            let parenDepth = 0;    // () and []
            let inString = false;  // false, or the opening quote char
            let INDENT = '  ';

            function pushIndent() {
                result.push('\n');
                for (let k = 0; k < indent; k++) result.push(INDENT);
            }

            while (i < len) {
                let ch = code[i];

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
                    let peekJ = i;
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

            let formatted = result.join('');
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
            //   let net = require("net");
            //   let  net = require( 'net' );
            //   const { Socket } = require('net');
            //   …also mid-line: "…[]; const net = require('net'); …"
            let requireRe = /\b(?:const|let|var)\s+(?:\{[^}]+\}|([a-zA-Z_$][a-zA-Z0-9_$]*))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)\s*;?/g;
            let libs = Array.isArray(node.libs) ? node.libs.slice() : [];
            let existingModules = {};
            libs.forEach(function(l) { existingModules[l.module] = true; });

            let cleaned = node.func.replace(requireRe, function(match, varName, moduleName) {
                if (existingModules[moduleName]) return '';   // already declared
                // For destructured imports use the module name as the let name
                let v = varName || moduleName.replace(/[^a-zA-Z0-9_$]/g, '_');
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
                let injectProps = [{ p: 'payload' }];
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
            let rulesLen = Array.isArray(node.rules) ? node.rules.length : 0;
            let wiresLen = Array.isArray(node.wires) ? node.wires.length : 0;
            let current = (typeof node.outputs === 'number' && node.outputs > 0) ? node.outputs : 0;
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

        // Stack disconnected components vertically using the shared helper
        // (also used by reflowCanvasNodes / placeAddedNodesNearNeighbors).
        let compYOffsets = computeComponentYOffsets(
            canvasAliases, layout, startY, spacingY, LAYOUT_DEFAULTS.componentGap
        );

        // Width-aware column positioning: each column's x-centre is the
        // previous column's right edge plus edgeGap plus half this column's
        // max node width. Mirrors CanvasLayout.reflowCanvasNodes so a
        // toNodeRed call produces the same coordinates as an explicit
        // reflow over the resulting array.
        let colMaxWidth = {};
        canvasAliases.forEach(function(alias) {
            let spec = nodeSpecs[alias];
            let col = (layout[alias] || {}).col || 0;
            // Pass a node-shaped object (type + name) so estimateNodeWidth
            // measures the same label that Node-RED would render.
            let probe = { type: spec.type, name: spec.name || '' };
            let w = CanvasLayout.getNodeWidth(probe, opts);
            if (!colMaxWidth[col] || colMaxWidth[col] < w) colMaxWidth[col] = w;
        });
        let _colKeys = Object.keys(colMaxWidth).map(Number).sort(function(a, b) { return a - b; });
        let colX = {};
        let _cursorRight = startX;
        _colKeys.forEach(function(col, idx) {
            let w = colMaxWidth[col];
            let centre = (idx === 0) ? (_cursorRight + w / 2) : (_cursorRight + edgeGap + w / 2);
            colX[col] = centre;
            _cursorRight = centre + w / 2;
        });

        // --- Assemble Node-RED nodes ---
        let result = [];
        aliases.forEach(function(alias, schemaIndex) {
            let spec = nodeSpecs[alias];
            let isConfig = isConfigType(spec.type) || spec.config === true;
            let pos  = layout[alias] || { col: 0, row: 0 };

            let node = {
                id:   aliasToId[alias],
                type: spec.type
            };
            // Record the LLM's schema declaration order so downstream
            // layout passes can place ordering-sensitive nodes (notably
            // `comment` nodes that have no wires) near the canvas nodes
            // the LLM listed them next to.
            node._llmOrder = schemaIndex;
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
                node.x = Math.round(colX[pos.col] !== undefined ? colX[pos.col] : startX);
                let yOff = (pos.comp !== undefined && compYOffsets[pos.comp] !== undefined)
                    ? compYOffsets[pos.comp] : 0;
                node.y = Math.round(pos.row * spacingY + yOff);
            }

            // Flatten type-specific props (from both spec.props and root spec)
            let mergedProps = {};
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
            let SPEC_SKIP_KEYS = META_KEYS.concat(['props', '_llmAlias', 'config', 'flow']);
            Object.keys(spec).forEach(function(key) {
                if (SPEC_SKIP_KEYS.indexOf(key) === -1) {
                    mergedProps[key] = spec[key];
                }
            });

            Object.keys(mergedProps).forEach(function(key) {
                node[key] = mergedProps[key];
            });

            // Record exactly which property keys the LLM explicitly proposed
            // (i.e. came from the Vibe Schema spec, not from a type-specific
            // normaliser default). The importer uses this list when merging
            // into an existing node so that unmentioned properties - mqtt
            // `topic`, `broker`, function `outputs`, etc. - are preserved
            // from the user's current setup instead of being silently
            // replaced by normaliser defaults.
            let llmSpecKeys = Object.keys(mergedProps);
            if (spec.name) llmSpecKeys.push('name');
            node._llmSpecKeys = llmSpecKeys;

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

    // Layout primitives are NOT re-exported here. Use
    //   require('./canvas_layout.js')                  (Node)
    //   window.LLMPlugin.CanvasLayout                  (browser)
    // for layoutNodes / reflowCanvasNodes / placeAddedNodesNearNeighbors.
    return {
        toIntermediate:      toIntermediate,
        toNodeRed:           toNodeRed,
        isVibeSchema:        isVibeSchema,
        isConfigType:        isConfigType,
        isConfigNode:        isConfigNode,
        isCanvasNode:        isCanvasNode,
        isNoInputType:       isNoInputType,
        isNoOutputType:      isNoOutputType,
        setRuntimeGetType:   setRuntimeGetType
    };
});
