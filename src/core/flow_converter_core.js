// Flow Converter Core: Node-RED JSON ↔ Vibe Schema converter + type
// detection helpers. See docs/{en,jp}/vibe-schema.md.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./canvas_layout.js'));
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        // canvas_layout.js must be loaded first (see ../client.js).
        window.LLMPlugin.FlowConverterCore = factory(window.LLMPlugin.CanvasLayout);
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

    // Node-RED's single-letter editor flags, renamed to the words the
    // editor's own UI uses. Both are exported only when set, so the schema
    // key is absent for a normal node. A type owning a real property of the
    // alias name keeps it: the lift is skipped when the name is taken, and
    // an explicit raw `d`/`l` wins on the way back.
    // See docs/{en,jp}/vibe-schema.md#editor-flags-disabled-showlabel.
    let NODE_FLAGS = { d: 'disabled', l: 'showLabel' };
    let NODE_FLAG_RAW = { disabled: 'd', showLabel: 'l' };

    /**
     * A schema value is only read as an editor flag when it is boolean-ish
     * (models write `false` as often as `"false"`). Anything else is left
     * alone, so a node type whose own configuration happens to use one of
     * the alias names keeps that property instead of being disabled by it.
     */
    function isFlagValue(v) {
        if (typeof v === 'boolean') return true;
        if (typeof v !== 'string') return false;
        let s = v.trim().toLowerCase();
        return s === 'true' || s === 'false';
    }

    /** Coerce a boolean-ish flag value to a strict boolean. */
    function toFlagBool(v) {
        return (typeof v === 'string') ? v.trim().toLowerCase() === 'true' : !!v;
    }

    // `_`-prefixed = plugin-internal bookkeeping. The rule lives here alone
    // so both invariants hold: toIntermediate never emits such a key (the
    // LLM never sees metadata) and toNodeRed never accepts one (the LLM
    // cannot forge it). See docs/{en,jp}/design.md §0.1.
    function isMetaProp(key) {
        return typeof key === 'string' && key.charAt(0) === '_';
    }

    // ------------------------------------------------------------------ //
    //  Utilities                                                          //
    // ------------------------------------------------------------------ //

    /** Generate a short random ID compatible with Node-RED. */
    function genId() {
        return 'id_' + Math.random().toString(36).substring(2, 11);
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
                if (isMetaProp(key)) return;                    // metadata: not the LLM's business
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
            // Lift the single-letter editor flags out of props under their
            // readable names (see NODE_FLAGS). A disabled node keeps every
            // property it had — only the flag is renamed — so the model reads
            // it exactly as a user sees it on the canvas.
            Object.keys(NODE_FLAGS).forEach(function(raw) {
                if (!(raw in props)) return;
                let alias = NODE_FLAGS[raw];
                if (alias in props) return;   // the type owns a real property of that name
                entry[alias] = props[raw];
                delete props[raw];
            });
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


    // Vibe Schema → Node-RED nodes. `options.workspace` sets `z`; the layout
    // options fall back to LAYOUT_DEFAULTS.
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
        // Drop `null` entries early: they're deletion directives consumed by
        // the importer's flow-directives path, not nodes to assemble.
        let nodeSpecs = {};
        Object.keys(intermediate.nodes).forEach(function(k) {
            let spec = intermediate.nodes[k];
            if (spec === null) return;
            nodeSpecs[k] = spec;
        });

        // Stub the config nodes an LLM referenced by alias but never defined.
        // Two detections: a props key ending in "config", or a well-known
        // reference key. Stub aliases are tracked here rather than flagged on
        // the spec, so a schema can never claim to be an auto stub.
        let autoStubAliases = {};
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

            // Shared invariant for every stub strategy: never stub a ref
            // whose mapped type equals the owning spec's OWN type. An
            // mqtt-broker config node's `broker` prop is its hostname
            // (e.g. "localhost"), not a reference to another broker —
            // stubbing would replace the hostname with a spurious stub id.
            // Cross-type refs (ui-group's `tab` → ui-tab) still stub.
            function stubIfCrossType(refAlias, mappedType) {
                if (!mappedType || mappedType === spec.type) return;
                nodeSpecs[refAlias] = { type: mappedType, name: refAlias, config: true, props: {} };
                autoStubAliases[refAlias] = true;
            }

            Object.keys(spec.props).forEach(function(key) {
                let refAlias = spec.props[key];
                if (typeof refAlias !== 'string') return;
                if (nodeSpecs[refAlias]) return;           // already defined
                if (!/^[a-z][a-z0-9_]*$/i.test(refAlias)) return; // not alias-shaped

                // Strategy 1: key ends in "config"
                if (/config$/i.test(key)) {
                    stubIfCrossType(refAlias, key.replace(/config$/i, '-config'));
                    return;
                }

                // Strategy 2: well-known reference key
                let lowerKey = key.toLowerCase();
                if (CONFIG_REF_KEYS.hasOwnProperty(lowerKey)) {
                    stubIfCrossType(refAlias, CONFIG_REF_KEYS[lowerKey]);
                }
            });
        });

        // Drop only comments with no resolvable target: no `above`, and no
        // canvas node later in declaration order to head. A schema with no
        // canvas nodes at all is a deliberate annotation patch — keep those.
        (function dropTrailingComments() {
            function aliasIsCanvas(a) {
                let s = nodeSpecs[a];
                if (!s || typeof s.type !== 'string' || !s.type.trim()) return false;
                if (s.type === 'comment' || s.type === 'tab') return false;
                if (s.type.indexOf('subflow:') === 0) return false;
                if (s.config === true) return false;
                return !isConfigType(s.type);
            }
            let order = Object.keys(nodeSpecs);
            let hasCanvas = order.some(aliasIsCanvas);
            if (!hasCanvas) return;
            let kept = {};
            order.forEach(function(alias, idx) {
                let spec = nodeSpecs[alias];
                // `null` entries are deletion directives — they don't have a
                // `type` and aren't comments, so keep them so the importer
                // sees the delete request.
                if (!spec || spec.type !== 'comment') { kept[alias] = true; return; }
                // Explicit `above` means the LLM took ownership of the
                // anchor target. Keep the comment regardless of where it
                // sits in declaration order; the importer will resolve
                // the alias to either a new schema node or an existing
                // canvas node.
                if (typeof spec.above === 'string' && spec.above.length > 0) {
                    kept[alias] = true;
                    return;
                }
                for (let j = idx + 1; j < order.length; j++) {
                    if (aliasIsCanvas(order[j])) { kept[alias] = true; return; }
                }
            });
            Object.keys(nodeSpecs).forEach(function(a) { if (!kept[a]) delete nodeSpecs[a]; });
        })();

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

            // This pass only ever inserts or drops WHITESPACE — every other
            // character is pushed through verbatim. Assert that here rather
            // than trust it: the walker does not model regex literals or
            // comments, so a future edit that starts consuming characters
            // inside one would rewrite the user's function body. Falling back
            // to the original code costs only the pretty-printing.
            if (formatted.replace(/\s+/g, '') !== code.replace(/\s+/g, '')) return code;
            return formatted;
        }

        // Function nodes: Node-RED sandboxes func code so `require()` is
        // unavailable.  External modules must be declared in the `libs`
        // array.  This normaliser scans for require() calls, moves them
        // into `libs`, and rewrites the code to use plain variable names.
        function normalizeFunctionNode(node) {
            if (!node.func || typeof node.func !== 'string') return;

            // Anywhere in the code, not just line-initial: LLMs often emit a
            // whole function body on one line. Handles destructuring too.
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

        // Debug nodes: default to showing msg.payload. A debug spec without
        // an explicit `complete` gets payload/msg — the full msg object is
        // noisy in the sidebar. An explicit `complete` from the LLM (e.g. the
        // user asked to see the whole message) is left untouched, and edits
        // to existing debug nodes keep the user's setting via _llmSpecKeys.
        function normalizeDebugNode(node) {
            if (node.complete === undefined) {
                node.complete = 'payload';
                node.targetType = 'msg';
            }
            if (node.tosidebar === undefined) node.tosidebar = true;
            if (node.active === undefined) node.active = true;
        }

        // Switch node output count must match its branches.
        // If outputs stays at 1, Node-RED can collapse branch wires on import.
        function normalizeSwitchNode(node) {
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

        // Type-specific normalisers, applied by node type. Core types only;
        // any other type (custom / contrib nodes) passes through untouched —
        // its props were already flattened verbatim above. Add an entry here
        // to teach the converter a new type's defaults; the dispatch below
        // stays generic. A type may list several normalisers, run in order.
        const NODE_NORMALIZERS = {
            inject:   [normalizeInjectNode],
            function: [normalizeFunctionNode],
            change:   [normalizeRuleNodes],
            switch:   [normalizeRuleNodes, normalizeSwitchNode],
            template: [normalizeTemplateNode],
            debug:    [normalizeDebugNode]
        };

        // Stack disconnected components vertically using the shared helper
        // (also used by reflowCanvasNodes / placeAddedNodesNearNeighbors).
        // spacingY / componentGap are EDGE-TO-EDGE clearances; the helper
        // turns them into the centre-to-centre pitch internally.
        let nodeHeight = LAYOUT_DEFAULTS.nodeHeight;
        let rowPitch = nodeHeight + spacingY;
        let compYOffsets = computeComponentYOffsets(
            canvasAliases, layout, startY, spacingY, LAYOUT_DEFAULTS.componentGap, nodeHeight
        );

        // Per-predecessor left edges, mirroring the matching pass in
        // CanvasLayout.reflowCanvasNodes so that converting and then
        // reflowing yields the same coordinates.
        let nodeWidthByAlias = {};
        canvasAliases.forEach(function(alias) {
            let spec = nodeSpecs[alias];
            let probe = { type: spec.type, name: spec.name || '' };
            nodeWidthByAlias[alias] = CanvasLayout.getNodeWidth(probe, opts);
        });
        let leftEdgeByAlias = {};
        let compBuckets = {};
        canvasAliases.forEach(function(alias) {
            let ci = (layout[alias] || {}).comp || 0;
            (compBuckets[ci] = compBuckets[ci] || []).push(alias);
        });
        Object.keys(compBuckets).forEach(function(ci) {
            let compAliases = compBuckets[ci].slice().sort(function(a, b) {
                let pa = layout[a] || { col: 0, row: 0 };
                let pb = layout[b] || { col: 0, row: 0 };
                return (pa.col - pb.col) || (pa.row - pb.row);
            });
            compAliases.forEach(function(alias) {
                let preds = (incoming[alias] || []).filter(function(p) {
                    return leftEdgeByAlias[p] !== undefined;
                });
                let leftEdge;
                if (preds.length === 0) {
                    leftEdge = startX;
                } else {
                    let maxRight = -Infinity;
                    preds.forEach(function(p) {
                        let r = leftEdgeByAlias[p] + (nodeWidthByAlias[p] || 0);
                        if (r > maxRight) maxRight = r;
                    });
                    leftEdge = maxRight + edgeGap;
                }
                leftEdgeByAlias[alias] = leftEdge;
            });
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
            // Marks a config stub this module invented for a dangling props
            // reference. The importer uses it to skip the stub when the real
            // config node already exists (Config Node Protection).
            if (autoStubAliases[alias]) node._autoStub = true;
            // `spec.flow` is deliberately not carried onto the node: routing
            // happens on the raw schema, before this conversion runs.
            // `above` is, so the layout pass can anchor the comment; the
            // importer resolves it to a node id and strips it afterwards.
            if (spec.type === 'comment' && typeof spec.above === 'string' && spec.above.length > 0) {
                node._llmAbove = spec.above;
            }
            if (spec.name) node.name = spec.name;
            if (workspace && !isConfig) node.z = workspace;

            // Config nodes don't appear on the canvas — skip coordinates.
            // No snap on derived x/y: the per-pred leftEdge gives exact
            // `edgeGap` clearance from the upstream chain, and the
            // constant `rowPitch` keeps vertical spacing uniform.
            if (!isConfig) {
                let left = (leftEdgeByAlias[alias] !== undefined) ? leftEdgeByAlias[alias] : startX;
                let w = nodeWidthByAlias[alias] || CanvasLayout.getNodeWidth({ type: spec.type, name: spec.name || '' }, opts);
                node.x = left + w / 2;
                let yOff = (pos.comp !== undefined && compYOffsets[pos.comp] !== undefined)
                    ? compYOffsets[pos.comp] : 0;
                node.y = pos.row * rowPitch + yOff;
            }

            // Flatten type-specific props (from both spec.props and root spec)
            let mergedProps = {};
            if (typeof spec.props === 'object' && spec.props !== null && !Array.isArray(spec.props)) {
                Object.keys(spec.props).forEach(function(key) {
                    if (isMetaProp(key)) return;   // schema-supplied metadata is ignored
                    mergedProps[key] = spec.props[key];
                });
            } else if (Array.isArray(spec.props)) {
                // Handle case where LLM generates Node-RED array 'props' (e.g. for inject nodes) directly
                mergedProps.props = spec.props;
            }

            // Flatten spec root keys into mergedProps, skipping META_KEYS,
            // the Vibe-Schema-only keys (props, config, flow, above), and any
            // `_`-prefixed metadata (never a node property — see isMetaProp).
            let SPEC_SKIP_KEYS = META_KEYS.concat(['props', 'config', 'flow', 'above']);
            Object.keys(spec).forEach(function(key) {
                if (isMetaProp(key)) return;
                if (SPEC_SKIP_KEYS.indexOf(key) === -1) {
                    mergedProps[key] = spec[key];
                }
            });

            // Translate the readable editor flags back to Node-RED's
            // single-letter keys. An explicit raw key wins, so a type that
            // owns a real `disabled`/`showLabel` property round-trips intact.
            // `flagName` — not `alias`, which is this node's schema alias in
            // the enclosing scope.
            Object.keys(NODE_FLAG_RAW).forEach(function(flagName) {
                if (!(flagName in mergedProps)) return;
                let raw = NODE_FLAG_RAW[flagName];
                if (raw in mergedProps) return;
                if (!isFlagValue(mergedProps[flagName])) return;
                mergedProps[raw] = toFlagBool(mergedProps[flagName]);
                delete mergedProps[flagName];
            });
            if ('d' in mergedProps && isFlagValue(mergedProps.d)) mergedProps.d = toFlagBool(mergedProps.d);
            if ('l' in mergedProps && isFlagValue(mergedProps.l)) mergedProps.l = toFlagBool(mergedProps.l);

            Object.keys(mergedProps).forEach(function(key) {
                node[key] = mergedProps[key];
            });

            // `d` exists only while the node is disabled, so re-enabling
            // means removing the key, not writing `d: false`. It still
            // counts as explicitly proposed (_llmSpecKeys below keeps it),
            // which is what stops the importer's merge from restoring the
            // node's previous `d: true`.
            if (node.d !== true) delete node.d;

            // The keys the LLM actually proposed, as opposed to the ones the
            // normalisers below will default. The importer's merge preserves
            // everything not listed here from the user's existing node.
            let llmSpecKeys = Object.keys(mergedProps);
            if (spec.name) llmSpecKeys.push('name');
            node._llmSpecKeys = llmSpecKeys;

            // Resolve alias references in props → real IDs.
            // Only resolve type-specific properties (config-node references like
            // venvconfig: "my_venv" → "id_xxx"). Skip META_KEYS (id, type, name,
            // z, x, y, wires, g) and metadata to avoid corrupting node identity
            // when an alias happens to match a type or name (e.g. alias "inject"
            // colliding with type "inject").
            Object.keys(node).forEach(function(key) {
                if (isMetaProp(key)) return;
                if (META_KEYS.indexOf(key) !== -1) return;
                if (typeof node[key] === 'string' && aliasToId[node[key]]) {
                    node[key] = aliasToId[node[key]];
                }
            });

            if (!isConfig) {
                node.wires = wiresMap[alias] || [];
            }

            // Apply type-specific normalisers (no-op for custom/contrib types).
            (NODE_NORMALIZERS[node.type] || []).forEach(function(fn) { fn(node); });

            result.push(node);
        });

        return result;
    }

    // ------------------------------------------------------------------ //
    //  Detection helper                                                   //
    // ------------------------------------------------------------------ //

    // `nodes` and `connections` are each optional — the prompt tells the LLM
    // either may be omitted, so this has to accept one alone. A bare
    // `reposition` (or its aliases) also counts, for directive-only replies.
    function isVibeSchema(obj) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
        let hasNodesObj =
            typeof obj.nodes === 'object' &&
            obj.nodes !== null &&
            !Array.isArray(obj.nodes);
        let hasConnectionsArr = Array.isArray(obj.connections);
        if (hasNodesObj || hasConnectionsArr) return true;
        let repo = obj.reposition || obj.relayout || obj.reflow;
        if (Array.isArray(repo)) return true;
        // A deletion-only reply. The prompt asks for the `nodes: {alias: null}`
        // form, which always carries `nodes` — but the directive extractor also
        // accepts a top-level remove array, and a model that uses it for a pure
        // "delete this node" edit emits a schema with no other key. Without this
        // that tolerance is unreachable and the edit is rejected outright as
        // "No JSON flow found in message".
        let removals = obj.remove || obj.delete || obj.removeNodes || obj.deleted;
        return Array.isArray(removals);
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
