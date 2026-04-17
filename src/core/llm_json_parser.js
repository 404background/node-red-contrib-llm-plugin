// LLM JSON Parser Core: utilities for parsing structured data from LLM output.
//
// Handles the ambiguity that LLMs produce when generating JSON:
//  - JS-style comments in JSON, unescaped quotes inside string values
//  - JSON embedded in markdown code fences or free-form prose
//  - Fuzzy token matching for node aliases and names
//  - Vibe Schema extraction, connection hints, and flow directives
//  - Flow lookup tables for alias/name/ID resolution
//  - Partial schema merging and flow node extraction
//
// Works as both a CommonJS module (server/tests) and a browser global.
// Has NO dependency on plugin globals — pass `cfg` (Configurator) explicitly
// to any function that needs Vibe Schema conversion.
(function(factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        window.LLMPlugin = window.LLMPlugin || {};
        window.LLMPlugin.LLMJsonParser = factory();
    }
})(function() {
    'use strict';

    // ================================================================== //
    //  Token Normalization                                                //
    // ================================================================== //

    /** Normalize a string to a lowercase alphanumeric token (underscores as separators). */
    function normalizeToken(v) {
        return String(v || '').trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    /**
     * Looser normalization: same as normalizeToken but also strips trailing/leading
     * numeric segments, so "inject_1" and "inject" resolve to the same token.
     */
    function normalizeTokenLoose(v) {
        var k = normalizeToken(v);
        if (!k) return '';
        return k
            .replace(/(^|_)\d+(?=_|$)/g, '$1')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    /**
     * Record a token→id mapping, marking the slot null when a collision occurs.
     * Null entries signal that the token is ambiguous and should not be resolved.
     */
    function putUniqueToken(mapObj, token, id) {
        if (!mapObj || !token || !id) return;
        if (!Object.prototype.hasOwnProperty.call(mapObj, token)) {
            mapObj[token] = id;
            return;
        }
        if (mapObj[token] !== id) mapObj[token] = null;
    }

    /**
     * Fuzzy resolver: returns a match only when exactly one plausible candidate
     * exists (boundary/prefix overlap). Short tokens are rejected via `minLen`.
     *
     * @param {Object} mapObj   Token→value map (nulls = ambiguous, skipped).
     * @param {string} token    Normalized token to look up.
     * @param {number} [minLen] Minimum token length to attempt fuzzy matching (default 8).
     * @returns {*|null}
     */
    function resolveUniqueApprox(mapObj, token, minLen) {
        var source = mapObj || {};
        var k = normalizeToken(token);
        var threshold = (typeof minLen === 'number' && minLen > 0) ? minLen : 8;
        if (!k || k.length < threshold) return null;

        var candidates = [];
        Object.keys(source).forEach(function(rawKey) {
            var nk = normalizeToken(rawKey);
            if (!nk || nk === k) return;
            // Reject matches where one token is much shorter than the other.
            // e.g. "venv" (4) vs "venv_square" (11) → ratio 0.36 → skip.
            // Legitimate fuzzy: "inject_trigger" vs "inject_trigger_1" → 0.875 → ok.
            var shorter = Math.min(nk.length, k.length);
            var longer  = Math.max(nk.length, k.length);
            if (shorter / longer < 0.5) return;

            var boundaryHit = ('_' + nk + '_').indexOf('_' + k + '_') >= 0 ||
                              ('_' + k + '_').indexOf('_' + nk + '_') >= 0;
            var prefixHit = nk.indexOf(k) === 0 || k.indexOf(nk) === 0;
            if (boundaryHit || prefixHit) {
                var value = source[rawKey];
                if (value != null && candidates.indexOf(value) === -1) {
                    candidates.push(value);
                }
            }
        });
        return (candidates.length === 1) ? candidates[0] : null;
    }

    // ================================================================== //
    //  JSON Parsing Utilities                                             //
    // ================================================================== //

    /** Strip JS-style // and /* comments from text before JSON.parse. */
    function stripJsonComments(text) {
        var src = String(text || '');
        var out = [];
        var i = 0;
        var inString = false;
        var escape = false;

        while (i < src.length) {
            var ch = src[i];
            var next = src[i + 1];

            if (inString) {
                out.push(ch);
                if (escape) { escape = false; }
                else if (ch === '\\') { escape = true; }
                else if (ch === '"') { inString = false; }
                i++;
                continue;
            }

            if (ch === '"') { inString = true; out.push(ch); i++; continue; }
            if (ch === '/' && next === '/') {
                i += 2;
                while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                i += 2;
                while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
                if (i + 1 < src.length) i += 2;
                continue;
            }
            out.push(ch);
            i++;
        }
        return out.join('');
    }

    /**
     * Repair unescaped double quotes inside JSON string values.
     * LLMs often embed Python f-strings like f"text {var}" or inline
     * code snippets that break standard JSON.parse.
     */
    function repairJsonQuotes(text) {
        var result = [];
        var i = 0;
        var len = text.length;
        var inString = false;
        var isValueString = false;

        while (i < len) {
            var ch = text[i];
            if (!inString) {
                result.push(ch);
                if (ch === '"') {
                    inString = true;
                    var j = result.length - 2;
                    while (j >= 0 && /\s/.test(result[j])) j--;
                    isValueString = (j >= 0 && result[j] === ':');
                }
                i++;
            } else {
                if (ch === '\\' && i + 1 < len) {
                    result.push(ch, text[i + 1]);
                    i += 2;
                } else if (ch === '"') {
                    var rest = text.substring(i + 1);
                    var trimmed = rest.replace(/^\s+/, '');
                    var isEnd;
                    if (isValueString) {
                        isEnd = trimmed.length === 0 ||
                                trimmed[0] === ',' ||
                                trimmed[0] === '}' ||
                                trimmed[0] === ']';
                    } else {
                        isEnd = trimmed.length === 0 || trimmed[0] === ':';
                    }
                    if (isEnd) {
                        result.push('"');
                        inString = false;
                        i++;
                    } else {
                        result.push('\\"');
                        i++;
                    }
                } else {
                    result.push(ch);
                    i++;
                }
            }
        }
        return result.join('');
    }

    // ================================================================== //
    //  Balanced JSON Snippet Extraction                                   //
    // ================================================================== //

    /**
     * Collect all balanced JSON snippets delimited by openChar/closeChar from text.
     * Respects string literals so braces inside strings are not counted.
     *
     * @param {string} text
     * @param {string} openChar   e.g. '{' or '['
     * @param {string} closeChar  e.g. '}' or ']'
     * @returns {string[]}  All matched balanced substrings, ordered by start position.
     */
    function collectBalancedJsonSnippets(text, openChar, closeChar) {
        var snippets = [];
        var stack = [];
        var inString = false;
        var escape = false;

        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (inString) {
                if (escape) { escape = false; continue; }
                if (ch === '\\') { escape = true; continue; }
                if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === openChar) { stack.push(i); continue; }
            if (ch === closeChar && stack.length > 0) {
                var start = stack.pop();
                snippets.push(text.substring(start, i + 1));
            }
        }
        return snippets;
    }

    // ================================================================== //
    //  Vibe Schema Extraction                                             //
    // ================================================================== //

    /**
     * Parse a candidate JSON string and return it if it satisfies isVibeSchemaFn.
     */
    function parseVibeSchemaCandidate(text, isVibeSchemaFn) {
        var parsed = null;
        try {
            parsed = JSON.parse(stripJsonComments(text));
        } catch (e1) {
            try {
                parsed = JSON.parse(repairJsonQuotes(stripJsonComments(text)));
            } catch (e2) { /* ignore */ }
        }
        return (parsed && isVibeSchemaFn(parsed)) ? parsed : null;
    }

    /**
     * Extract the last Vibe Schema object from LLM message text.
     * Search order: code fences (last first) → full text → balanced objects.
     *
     * @param {string} messageContent  Raw LLM assistant message.
     * @param {Object} cfg             Configurator with `isVibeSchema(obj)` method.
     * @returns {Object|null}
     */
    function extractVibeSchema(messageContent, cfg) {
        if (!cfg || !cfg.isVibeSchema) return null;

        var raw = String(messageContent || '');
        var blocks = [];
        var codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        var m;
        while ((m = codeBlockRegex.exec(raw)) !== null) {
            blocks.push(m[1].trim());
        }
        for (var bi = blocks.length - 1; bi >= 0; bi--) {
            var fromBlock = parseVibeSchemaCandidate(blocks[bi], cfg.isVibeSchema);
            if (fromBlock) return fromBlock;
        }

        var stripped = raw.replace(/```[\s\S]*?```/g, '').trim();
        var whole = parseVibeSchemaCandidate(stripped, cfg.isVibeSchema);
        if (whole) return whole;

        var objectCandidates = collectBalancedJsonSnippets(stripped, '{', '}');
        for (var oi = objectCandidates.length - 1; oi >= 0; oi--) {
            var fromObj = parseVibeSchemaCandidate(objectCandidates[oi], cfg.isVibeSchema);
            if (fromObj) return fromObj;
        }
        return null;
    }

    /**
     * Extract explicit connection hints from a Vibe Schema embedded in the message.
     *
     * @param {string} messageContent
     * @param {Object} cfg   Configurator with `isVibeSchema` method.
     * @returns {Array<{from: string, to: string, fromPort: number}>}
     */
    function extractConnectionHints(messageContent, cfg) {
        var hints = [];
        var parsed = extractVibeSchema(messageContent, cfg);
        if (!parsed || !Array.isArray(parsed.connections)) return hints;
        parsed.connections.forEach(function(c) {
            if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') return;
            hints.push({ from: c.from, to: c.to, fromPort: c.fromPort || 0 });
        });
        return hints;
    }

    /**
     * Extract flow directives (node deletions, connection deletions) from the message.
     *
     * @param {string} messageContent
     * @param {Object} cfg   Configurator with `isVibeSchema` method.
     * @returns {{ removeTokens: string[], removeConnections: Array }}
     */
    function extractFlowDirectives(messageContent, cfg) {
        var directives = { removeTokens: [], removeConnections: [] };
        var parsed = extractVibeSchema(messageContent, cfg);
        if (!parsed) return directives;

        var remove = parsed.remove || parsed.delete || parsed.removeNodes || parsed.deleted;
        if (Array.isArray(remove)) {
            remove.forEach(function(t) {
                if (typeof t === 'string' && t.trim()) directives.removeTokens.push(t.trim());
            });
        }
        if (Array.isArray(parsed.connections)) {
            parsed.connections.forEach(function(c) {
                if (!c || !c.remove || typeof c.remove !== 'object') return;
                var r = c.remove;
                if (typeof r.from !== 'string' || typeof r.to !== 'string') return;
                directives.removeConnections.push({
                    from: r.from, to: r.to,
                    fromPort: (typeof r.fromPort === 'number' && r.fromPort >= 0) ? r.fromPort : 0
                });
            });
        }
        Object.keys(parsed.nodes || {}).forEach(function(alias) {
            if (parsed.nodes[alias] === null) directives.removeTokens.push(alias);
        });
        return directives;
    }

    // ================================================================== //
    //  Flow Lookup                                                        //
    // ================================================================== //

    /**
     * Build a unified lookup table for resolving aliases, names, and raw IDs to
     * node IDs from a Node-RED flow snapshot.
     *
     * Resolution cascade (resolve method):
     *   exact ID → exact alias → normalized alias → node name → loose alias → fuzzy
     *
     * @param {Array}  flowNodes  Node-RED flow nodes array.
     * @param {Object} [cfg]      Configurator with `toIntermediate` method (for alias maps).
     * @returns {{
     *   resolve: function(token: string, opts?: {minLen?: number, fuzzy?: boolean}): string|null,
     *   aliasToId: Object,
     *   idToAlias: Object,
     *   nameToId: Object,
     *   byId: Object,
     *   inter: Object|null
     * }}
     */
    function buildFlowLookup(flowNodes, cfg) {
        var aliasToId = {};
        var idToAlias = {};
        var nameToId = {};
        var byId = {};
        var _normAlias = {};
        var _looseAlias = {};
        var inter = null;

        if (cfg && cfg.toIntermediate && Array.isArray(flowNodes) && flowNodes.length > 0) {
            try {
                inter = cfg.toIntermediate(flowNodes, { includeIdMap: true });
                var raw = (inter && inter._meta && inter._meta.idToAlias) || {};
                Object.keys(raw).forEach(function(id) {
                    var alias = raw[id];
                    idToAlias[id] = alias;
                    aliasToId[alias] = id;
                    putUniqueToken(_normAlias, normalizeToken(alias), id);
                    putUniqueToken(_looseAlias, normalizeTokenLoose(alias), id);
                });
            } catch (e) { /* ignore */ }
        }

        (flowNodes || []).forEach(function(n) {
            if (!n || !n.id) return;
            byId[n.id] = n;
            var nk = normalizeToken(n.name || '');
            if (nk) putUniqueToken(nameToId, nk, n.id);
        });

        function resolve(token, opts) {
            if (!token || typeof token !== 'string') return null;
            var t = token.trim();
            if (!t) return null;
            var o = opts || {};
            var minLen = (typeof o.minLen === 'number') ? o.minLen : 8;

            if (byId[t]) return t;
            if (aliasToId[t]) return aliasToId[t];

            var k = normalizeToken(t);
            if (!k) return null;
            if (_normAlias[k]) return _normAlias[k];
            if (nameToId[k]) return nameToId[k];

            // exactOnly: stop before loose/fuzzy tiers. Used by the importer's
            // pre-pass so that strong matches can claim existing IDs before
            // weaker fuzzy matches are considered for other proposed nodes.
            if (o.exactOnly) return null;

            var lk = normalizeTokenLoose(t);
            if (lk) {
                if (_looseAlias[lk]) return _looseAlias[lk];
            }

            if (o.fuzzy !== false) {
                return resolveUniqueApprox(aliasToId, k, minLen)
                    || resolveUniqueApprox(nameToId, k, minLen)
                    || null;
            }
            return null;
        }

        return {
            aliasToId: aliasToId,
            idToAlias: idToAlias,
            nameToId: nameToId,
            byId: byId,
            inter: inter,
            resolve: resolve
        };
    }

    // ================================================================== //
    //  Schema Resolution                                                  //
    // ================================================================== //

    /**
     * Resolve a Vibe Schema alias token against the intermediate nodes of the
     * current flow. Falls back through normalized alias → name → fuzzy.
     *
     * @param {string} token          Alias to resolve.
     * @param {Object} currentNodes   Intermediate node map from toIntermediate().
     * @param {Object} explicitNodes  Nodes already defined in the schema being built.
     * @returns {string}  Resolved alias (or original token if unresolvable).
     */
    function resolveAliasInSchema(token, currentNodes, explicitNodes) {
        if (typeof token !== 'string' || !token) return token;
        if (explicitNodes && explicitNodes[token]) return token;
        if (currentNodes && currentNodes[token]) return token;

        var k = normalizeToken(token);
        if (!k) return token;

        var byAlias = {};
        var byName = {};
        Object.keys(currentNodes || {}).forEach(function(alias) {
            var ak = normalizeToken(alias);
            if (ak && !byAlias[ak]) byAlias[ak] = alias;
            var n = currentNodes[alias] || {};
            var nk = normalizeToken(n.name || '');
            if (nk && !byName[nk]) byName[nk] = alias;
        });

        if (byAlias[k]) return byAlias[k];
        if (byName[k]) return byName[k];

        var found = resolveUniqueApprox(byAlias, k, 8) || resolveUniqueApprox(byName, k, 8);
        return found || token;
    }

    /**
     * Merge a partial agent schema (which may only list changed nodes) with the
     * intermediate representation of the current flow. Pulls in any nodes that
     * appear as connection endpoints but are not defined in the partial schema.
     *
     * @param {Object} schema       Partial Vibe Schema from the LLM agent.
     * @param {Array}  currentFlow  Current Node-RED flow nodes.
     * @param {Object} cfg          Configurator with `toIntermediate` method.
     * @returns {Object}  Merged Vibe Schema.
     */
    function mergeAgentPartialSchemaWithCurrentFlow(schema, currentFlow, cfg) {
        try {
            if (!schema || !cfg || !cfg.toIntermediate || !Array.isArray(currentFlow) || currentFlow.length === 0) {
                return schema;
            }
            var lookup = buildFlowLookup(currentFlow, cfg);
            var currentInter = lookup.inter;
            if (!currentInter || !currentInter.nodes) return schema;

            var merged = {
                description: schema.description || '',
                nodes: {},
                connections: Array.isArray(schema.connections) ? schema.connections.slice() : []
            };

            var schemaNodes = (schema.nodes && typeof schema.nodes === 'object') ? schema.nodes : {};
            Object.keys(schemaNodes).forEach(function(alias) {
                merged.nodes[alias] = JSON.parse(JSON.stringify(schemaNodes[alias]));
            });

            // Resolve connection endpoints; pull in referenced nodes from current flow
            var requiredAliases = {};
            merged.connections.forEach(function(conn) {
                if (!conn) return;
                if (typeof conn.from === 'string') {
                    conn.from = resolveAliasInSchema(conn.from, currentInter.nodes, merged.nodes);
                    if (!merged.nodes[conn.from]) requiredAliases[conn.from] = true;
                }
                if (typeof conn.to === 'string') {
                    conn.to = resolveAliasInSchema(conn.to, currentInter.nodes, merged.nodes);
                    if (!merged.nodes[conn.to]) requiredAliases[conn.to] = true;
                }
            });

            Object.keys(requiredAliases).forEach(function(alias) {
                if (currentInter.nodes[alias]) {
                    merged.nodes[alias] = JSON.parse(JSON.stringify(currentInter.nodes[alias]));
                }
            });

            return merged;
        } catch (e) {
            return schema;
        }
    }

    // ================================================================== //
    //  Flow Node Extraction                                               //
    // ================================================================== //

    /**
     * Normalize a Vibe Schema for conversion to Node-RED JSON:
     * skips null/invalid entries and infers missing `type` from the current flow.
     *
     * @param {Object} schema
     * @param {Object} options   { currentFlow: Array }
     * @param {Object} cfg       Configurator with `toIntermediate` method.
     * @returns {Object}  Clean Vibe Schema ready for cfg.toNodeRed().
     */
    function normalizeSchemaForConversion(schema, options, cfg) {
        var out = {
            description: (schema && schema.description) || '',
            nodes: {},
            connections: []
        };

        var currentNodesByAlias = {};
        var currentNodesByName = {};
        try {
            if (options && options.currentFlow && cfg && typeof cfg.toIntermediate === 'function') {
                var ci = cfg.toIntermediate(options.currentFlow, { includeIdMap: true });
                var interNodes = ci && ci.nodes ? ci.nodes : {};
                Object.keys(interNodes).forEach(function(a) {
                    var n = interNodes[a] || {};
                    if (n && n.type) {
                        currentNodesByAlias[a] = n;
                        var nk = normalizeToken(n.name || '');
                        if (nk && !currentNodesByName[nk]) currentNodesByName[nk] = n;
                    }
                });
            }
        } catch (e) { /* ignore */ }

        Object.keys((schema && schema.nodes) || {}).forEach(function(alias) {
            var spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;

            if (typeof spec.type !== 'string' || !spec.type.trim()) {
                var inferred = null;
                if (currentNodesByAlias[alias] && currentNodesByAlias[alias].type) {
                    inferred = currentNodesByAlias[alias].type;
                }
                if (!inferred) {
                    var candidateName = (typeof spec.name === 'string' && spec.name)
                        ? spec.name
                        : (spec.props && spec.props.name ? spec.props.name : '');
                    var nk2 = normalizeToken(candidateName || '');
                    if (nk2 && currentNodesByName[nk2] && currentNodesByName[nk2].type) {
                        inferred = currentNodesByName[nk2].type;
                    }
                }
                if (inferred) {
                    spec = JSON.parse(JSON.stringify(spec));
                    spec.type = inferred;
                } else {
                    return; // skip — no type, can't convert
                }
            }
            out.nodes[alias] = JSON.parse(JSON.stringify(spec));
        });

        var conns = Array.isArray(schema && schema.connections) ? schema.connections : [];
        conns.forEach(function(c) {
            if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') return;
            out.connections.push({
                from: c.from, to: c.to,
                fromPort: (typeof c.fromPort === 'number' && c.fromPort >= 0) ? c.fromPort : 0
            });
        });
        return out;
    }

    /**
     * Try to parse Node-RED flow nodes from a single JSON text snippet.
     * Handles Vibe Schema, raw Node-RED arrays, and single-node objects.
     *
     * @param {string} text
     * @param {Object} options  { mode: string, currentFlow: Array }
     * @param {Object} cfg      Configurator with `isVibeSchema`, `toNodeRed`, `toIntermediate`.
     * @returns {Array|null}
     */
    function tryParseFlowNodes(text, options, cfg) {
        var cleaned = stripJsonComments(text).trim();
        var parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (e) {
            try {
                parsed = JSON.parse(repairJsonQuotes(cleaned));
            } catch (e2) { /* still invalid */ }
        }
        if (!parsed) return null;

        try {
            if (cfg && cfg.isVibeSchema && cfg.isVibeSchema(parsed)) {
                var sourceSchema = parsed;
                if (options && options.mode === 'agent') {
                    sourceSchema = mergeAgentPartialSchemaWithCurrentFlow(parsed, options.currentFlow, cfg);
                }

                var conversionSchema = normalizeSchemaForConversion(sourceSchema, options, cfg);
                if (Object.keys(conversionSchema.nodes).length === 0) return [];

                var converted = cfg.toNodeRed(conversionSchema, {
                    preserveAlias: !!(options && options.currentFlow && Array.isArray(options.currentFlow) && options.currentFlow.length > 0)
                });
                if (converted && converted.length > 0) return converted;
            }

            // Legacy: raw Node-RED JSON
            var nodes = null;
            if (Array.isArray(parsed)) {
                nodes = parsed;
            } else if (parsed && parsed.nodes && Array.isArray(parsed.nodes)) {
                nodes = parsed.nodes;
            } else if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
                nodes = [parsed];
            }
            if (nodes && nodes.length > 0 && nodes.some(function(n) {
                return n && typeof n.type === 'string' && n.type.trim().length > 0;
            })) {
                return nodes.filter(function(n) {
                    return n && typeof n.type !== 'undefined' && String(n.type).trim().length > 0;
                });
            }
        } catch (e) { /* not valid JSON */ }
        return null;
    }

    /**
     * Extract Node-RED flow nodes from LLM message content.
     * Tries (in order): code fences → full text → balanced objects → balanced arrays.
     *
     * @param {string} messageContent
     * @param {Object} options         { mode: string, currentFlow: Array }
     * @param {Object} cfg             Configurator module.
     * @returns {Array|null}
     */
    function extractFlowNodes(messageContent, options, cfg) {
        var codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        var candidates = [];
        var m;
        while ((m = codeBlockRegex.exec(messageContent)) !== null) {
            candidates.push(m[1].trim());
        }
        for (var i = candidates.length - 1; i >= 0; i--) {
            var nodes = tryParseFlowNodes(candidates[i], options, cfg);
            if (nodes) return nodes;
        }

        var stripped = messageContent.replace(/```[\s\S]*?```/g, '');
        var whole = stripped.trim();
        if (whole) {
            var wholeNodes = tryParseFlowNodes(whole, options, cfg);
            if (wholeNodes) return wholeNodes;
        }

        var objectCandidates = collectBalancedJsonSnippets(stripped, '{', '}');
        for (var oi = objectCandidates.length - 1; oi >= 0; oi--) {
            var objNodes = tryParseFlowNodes(objectCandidates[oi], options, cfg);
            if (objNodes) return objNodes;
        }

        var arrayCandidates = collectBalancedJsonSnippets(stripped, '[', ']');
        for (var ai = arrayCandidates.length - 1; ai >= 0; ai--) {
            var arrNodes = tryParseFlowNodes(arrayCandidates[ai], options, cfg);
            if (arrNodes) return arrNodes;
        }
        return null;
    }

    // ================================================================== //
    //  Public API                                                         //
    // ================================================================== //

    return {
        // Token normalization
        normalizeToken: normalizeToken,
        normalizeTokenLoose: normalizeTokenLoose,
        putUniqueToken: putUniqueToken,
        resolveUniqueApprox: resolveUniqueApprox,

        // JSON parsing / repair
        stripJsonComments: stripJsonComments,
        repairJsonQuotes: repairJsonQuotes,
        collectBalancedJsonSnippets: collectBalancedJsonSnippets,

        // Vibe Schema extraction (requires cfg with isVibeSchema)
        extractVibeSchema: extractVibeSchema,
        extractConnectionHints: extractConnectionHints,
        extractFlowDirectives: extractFlowDirectives,

        // Flow lookup (requires cfg with toIntermediate)
        buildFlowLookup: buildFlowLookup,

        // Schema resolution (requires cfg with toIntermediate)
        resolveAliasInSchema: resolveAliasInSchema,
        mergeAgentPartialSchemaWithCurrentFlow: mergeAgentPartialSchemaWithCurrentFlow,

        // Flow node extraction (requires cfg with isVibeSchema, toNodeRed, toIntermediate)
        normalizeSchemaForConversion: normalizeSchemaForConversion,
        tryParseFlowNodes: tryParseFlowNodes,
        extractFlowNodes: extractFlowNodes
    };
});
