// LLM JSON Parser Core.
//
// Absorbs the ways LLM output is not quite JSON: comments, unescaped quotes
// inside strings, JSON buried in code fences or prose, and alias references
// that do not match any existing node exactly.
//
// CommonJS module and browser global both. No plugin globals — `cfg`
// (FlowConverterCore) is passed in wherever Vibe Schema conversion is needed.
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
        let k = normalizeToken(v);
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

    // Boundary/prefix match, but only when exactly ONE candidate qualifies —
    // an ambiguous token resolves to nothing rather than to a guess. Tokens
    // shorter than `minLen` (default 8) are not matched at all.
    function resolveUniqueApprox(mapObj, token, minLen) {
        let source = mapObj || {};
        let k = normalizeToken(token);
        let threshold = (typeof minLen === 'number' && minLen > 0) ? minLen : 8;
        if (!k || k.length < threshold) return null;

        let candidates = [];
        Object.keys(source).forEach(function(rawKey) {
            let nk = normalizeToken(rawKey);
            if (!nk || nk === k) return;
            // Reject matches where one token is much shorter than the other.
            // e.g. "venv" (4) vs "venv_square" (11) → ratio 0.36 → skip.
            // Legitimate fuzzy: "inject_trigger" vs "inject_trigger_1" → 0.875 → ok.
            let shorter = Math.min(nk.length, k.length);
            let longer  = Math.max(nk.length, k.length);
            if (shorter / longer < 0.5) return;

            let boundaryHit = ('_' + nk + '_').indexOf('_' + k + '_') >= 0 ||
                              ('_' + k + '_').indexOf('_' + nk + '_') >= 0;
            let prefixHit = nk.indexOf(k) === 0 || k.indexOf(nk) === 0;
            if (boundaryHit || prefixHit) {
                let value = source[rawKey];
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
        let src = String(text || '');
        let out = [];
        let i = 0;
        let inString = false;
        let escape = false;

        while (i < src.length) {
            let ch = src[i];
            let next = src[i + 1];

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
        let result = [];
        let i = 0;
        let len = text.length;
        let inString = false;
        let isValueString = false;

        while (i < len) {
            let ch = text[i];
            if (!inString) {
                result.push(ch);
                if (ch === '"') {
                    inString = true;
                    let j = result.length - 2;
                    while (j >= 0 && /\s/.test(result[j])) j--;
                    isValueString = (j >= 0 && result[j] === ':');
                }
                i++;
            } else {
                if (ch === '\\' && i + 1 < len) {
                    result.push(ch, text[i + 1]);
                    i += 2;
                } else if (ch === '"') {
                    let k = i + 1;
                    while (k < len && /\s/.test(text[k])) k++;
                    let next = k < len ? text[k] : '';
                    let isEnd;
                    if (isValueString) {
                        isEnd = next === '' ||
                                next === ',' ||
                                next === '}' ||
                                next === ']';
                    } else {
                        isEnd = next === '' || next === ':';
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

    // All balanced `openChar`…`closeChar` spans, in start order. String
    // literals are tracked so a brace inside one is not counted.
    function collectBalancedJsonSnippets(text, openChar, closeChar) {
        let snippets = [];
        let stack = [];
        let inString = false;
        let escape = false;

        for (let i = 0; i < text.length; i++) {
            let ch = text[i];
            if (inString) {
                if (escape) { escape = false; continue; }
                if (ch === '\\') { escape = true; continue; }
                if (ch === '"') { inString = false; }
                continue;
            }
            if (ch === '"') { inString = true; continue; }
            if (ch === openChar) { stack.push(i); continue; }
            if (ch === closeChar && stack.length > 0) {
                let start = stack.pop();
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
        let parsed = null;
        try {
            parsed = JSON.parse(stripJsonComments(text));
        } catch (e1) {
            try {
                parsed = JSON.parse(repairJsonQuotes(stripJsonComments(text)));
            } catch (e2) { /* ignore */ }
        }
        return (parsed && isVibeSchemaFn(parsed)) ? parsed : null;
    }

    // The last Vibe Schema in a reply. Search order: code fences (last
    // first) → full text → balanced objects.
    function extractVibeSchema(messageContent, cfg) {
        if (!cfg || !cfg.isVibeSchema) return null;

        let raw = String(messageContent || '');
        let blocks = [];
        let codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        let m;
        while ((m = codeBlockRegex.exec(raw)) !== null) {
            blocks.push(m[1].trim());
        }
        for (let bi = blocks.length - 1; bi >= 0; bi--) {
            let fromBlock = parseVibeSchemaCandidate(blocks[bi], cfg.isVibeSchema);
            if (fromBlock) return fromBlock;
        }

        let stripped = raw.replace(/```[\s\S]*?```/g, '').trim();
        let whole = parseVibeSchemaCandidate(stripped, cfg.isVibeSchema);
        if (whole) return whole;

        let objectCandidates = collectBalancedJsonSnippets(stripped, '{', '}');
        for (let oi = objectCandidates.length - 1; oi >= 0; oi--) {
            let fromObj = parseVibeSchemaCandidate(objectCandidates[oi], cfg.isVibeSchema);
            if (fromObj) return fromObj;
        }
        return null;
    }

    // → [{ from, to, fromPort }]
    function extractConnectionHints(messageContent, cfg) {
        let hints = [];
        let parsed = extractVibeSchema(messageContent, cfg);
        if (!parsed || !Array.isArray(parsed.connections)) return hints;
        parsed.connections.forEach(function(c) {
            if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') return;
            hints.push({ from: c.from, to: c.to, fromPort: c.fromPort || 0 });
        });
        return hints;
    }

    // Node deletions, connection deletions and reposition requests.
    // → { removeTokens, removeConnections, repositionTokens }
    function extractFlowDirectives(messageContent, cfg) {
        let directives = { removeTokens: [], removeConnections: [], repositionTokens: [] };
        let parsed = extractVibeSchema(messageContent, cfg);
        if (!parsed) return directives;

        let remove = parsed.remove || parsed.delete || parsed.removeNodes || parsed.deleted;
        if (Array.isArray(remove)) {
            remove.forEach(function(t) {
                if (typeof t === 'string' && t.trim()) directives.removeTokens.push(t.trim());
            });
        }
        if (Array.isArray(parsed.connections)) {
            parsed.connections.forEach(function(c) {
                if (!c || !c.remove || typeof c.remove !== 'object') return;
                let r = c.remove;
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
        // `reposition` accepts either a flat alias array
        //   "reposition": ["a", "b"]
        // or grouped sequences (e.g. when the LLM wants to make the
        // grouping explicit) — they are flattened: aliases are simply
        // collected so the importer can relayout that subset together.
        let repo = parsed.reposition || parsed.relayout || parsed.reflow;
        if (Array.isArray(repo)) {
            repo.forEach(function(entry) {
                if (typeof entry === 'string' && entry.trim()) {
                    directives.repositionTokens.push(entry.trim());
                } else if (Array.isArray(entry)) {
                    entry.forEach(function(inner) {
                        if (typeof inner === 'string' && inner.trim()) {
                            directives.repositionTokens.push(inner.trim());
                        }
                    });
                }
            });
        }
        return directives;
    }

    // ================================================================== //
    //  Flow Lookup                                                        //
    // ================================================================== //

    // Resolve an alias, name or raw ID to a node ID, in this order:
    //   exact ID → exact alias → normalized alias → name → loose alias → fuzzy
    // `resolve(token, { minLen, fuzzy, exactOnly })` plus the maps it built.
    function buildFlowLookup(flowNodes, cfg) {
        let aliasToId = {};
        let idToAlias = {};
        let nameToId = {};
        let byId = {};
        let _normAlias = {};
        let _looseAlias = {};
        let inter = null;

        if (cfg && cfg.toIntermediate && Array.isArray(flowNodes) && flowNodes.length > 0) {
            try {
                inter = cfg.toIntermediate(flowNodes, { includeIdMap: true });
                let raw = (inter && inter._meta && inter._meta.idToAlias) || {};
                Object.keys(raw).forEach(function(id) {
                    let alias = raw[id];
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
            let nk = normalizeToken(n.name || '');
            if (nk) putUniqueToken(nameToId, nk, n.id);
        });

        function resolve(token, opts) {
            if (!token || typeof token !== 'string') return null;
            let t = token.trim();
            if (!t) return null;
            let o = opts || {};
            let minLen = (typeof o.minLen === 'number') ? o.minLen : 8;

            if (byId[t]) return t;
            if (aliasToId[t]) return aliasToId[t];

            let k = normalizeToken(t);
            if (!k) return null;
            if (_normAlias[k]) return _normAlias[k];
            if (nameToId[k]) return nameToId[k];

            // exactOnly: stop before loose/fuzzy tiers. Used by the importer's
            // pre-pass so that strong matches can claim existing IDs before
            // weaker fuzzy matches are considered for other proposed nodes.
            if (o.exactOnly) return null;

            let lk = normalizeTokenLoose(t);
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

    // Alias → alias, against the current flow's intermediate nodes
    // (normalized → name → fuzzy). Returns the token unchanged if nothing
    // resolves.
    function resolveAliasInSchema(token, currentNodes, explicitNodes) {
        if (typeof token !== 'string' || !token) return token;
        if (explicitNodes && explicitNodes[token]) return token;
        if (currentNodes && currentNodes[token]) return token;

        let k = normalizeToken(token);
        if (!k) return token;

        let byAlias = {};
        let byName = {};
        Object.keys(currentNodes || {}).forEach(function(alias) {
            let ak = normalizeToken(alias);
            if (ak && !byAlias[ak]) byAlias[ak] = alias;
            let n = currentNodes[alias] || {};
            let nk = normalizeToken(n.name || '');
            if (nk && !byName[nk]) byName[nk] = alias;
        });

        if (byAlias[k]) return byAlias[k];
        if (byName[k]) return byName[k];

        let found = resolveUniqueApprox(byAlias, k, 8) || resolveUniqueApprox(byName, k, 8);
        return found || token;
    }

    // An Agent reply may list only what changed, so connection endpoints it
    // never declared have to be pulled in from the current flow.
    function mergeAgentPartialSchemaWithCurrentFlow(schema, currentFlow, cfg) {
        try {
            if (!schema || !cfg || !cfg.toIntermediate || !Array.isArray(currentFlow) || currentFlow.length === 0) {
                return schema;
            }
            let lookup = buildFlowLookup(currentFlow, cfg);
            let currentInter = lookup.inter;
            if (!currentInter || !currentInter.nodes) return schema;

            let merged = {
                description: schema.description || '',
                nodes: {},
                // Deep-cloned, not `slice()`d: the endpoint-resolution pass
                // below rewrites `conn.from` / `conn.to`, and a shallow copy
                // shares those objects with the caller's schema — so the
                // caller would silently see the merged aliases too.
                connections: Array.isArray(schema.connections)
                    ? JSON.parse(JSON.stringify(schema.connections))
                    : []
            };
            // Preserve directive fields the merger doesn't otherwise touch
            // so a reposition-only agent message survives the merge.
            ['reposition', 'relayout', 'reflow', 'remove', 'delete', 'removeNodes', 'deleted'].forEach(function(k) {
                if (schema[k] !== undefined) merged[k] = schema[k];
            });

            let schemaNodes = (schema.nodes && typeof schema.nodes === 'object') ? schema.nodes : {};
            Object.keys(schemaNodes).forEach(function(alias) {
                merged.nodes[alias] = JSON.parse(JSON.stringify(schemaNodes[alias]));
            });

            // Resolve connection endpoints; pull in referenced nodes from current flow
            let requiredAliases = {};
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

    // Drop null/invalid entries and infer a missing `type` from the current
    // flow, so the result is safe to hand to cfg.toNodeRed().
    function normalizeSchemaForConversion(schema, options, cfg) {
        let out = {
            description: (schema && schema.description) || '',
            nodes: {},
            connections: []
        };

        let currentNodesByAlias = {};
        let currentNodesByName = {};
        try {
            if (options && options.currentFlow && cfg && typeof cfg.toIntermediate === 'function') {
                let ci = cfg.toIntermediate(options.currentFlow, { includeIdMap: true });
                let interNodes = ci && ci.nodes ? ci.nodes : {};
                Object.keys(interNodes).forEach(function(a) {
                    let n = interNodes[a] || {};
                    if (n && n.type) {
                        currentNodesByAlias[a] = n;
                        let nk = normalizeToken(n.name || '');
                        if (nk && !currentNodesByName[nk]) currentNodesByName[nk] = n;
                    }
                });
            }
        } catch (e) { /* ignore */ }

        Object.keys((schema && schema.nodes) || {}).forEach(function(alias) {
            let spec = schema.nodes[alias];
            if (!spec || typeof spec !== 'object') return;

            if (typeof spec.type !== 'string' || !spec.type.trim()) {
                let inferred = null;
                if (currentNodesByAlias[alias] && currentNodesByAlias[alias].type) {
                    inferred = currentNodesByAlias[alias].type;
                }
                if (!inferred) {
                    let candidateName = (typeof spec.name === 'string' && spec.name)
                        ? spec.name
                        : (spec.props && spec.props.name ? spec.props.name : '');
                    let nk2 = normalizeToken(candidateName || '');
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

        let conns = Array.isArray(schema && schema.connections) ? schema.connections : [];
        conns.forEach(function(c) {
            if (!c || typeof c.from !== 'string' || typeof c.to !== 'string') return;
            out.connections.push({
                from: c.from, to: c.to,
                fromPort: (typeof c.fromPort === 'number' && c.fromPort >= 0) ? c.fromPort : 0
            });
        });
        return out;
    }

    // One snippet → nodes. Accepts Vibe Schema, a raw Node-RED array, or a
    // single node object.
    function tryParseFlowNodes(text, options, cfg) {
        let cleaned = stripJsonComments(text).trim();
        let parsed;
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
                let sourceSchema = parsed;
                if (options && options.mode === 'agent') {
                    sourceSchema = mergeAgentPartialSchemaWithCurrentFlow(parsed, options.currentFlow, cfg);
                }

                let conversionSchema = normalizeSchemaForConversion(sourceSchema, options, cfg);
                if (Object.keys(conversionSchema.nodes).length === 0) return [];

                // preserveAlias is always on: the importer matches a comment's
                // `above: <alias>` against `_llmAlias` to find its target, and
                // strips the marker once consumed.
                let converted = cfg.toNodeRed(conversionSchema, {
                    preserveAlias: true
                });
                if (converted && converted.length > 0) return converted;
            }

            // Legacy: raw Node-RED JSON
            let nodes = null;
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

    // Whole reply → nodes. Tries code fences → full text → balanced objects
    // → balanced arrays, last candidate first at each stage.
    function extractFlowNodes(messageContent, options, cfg) {
        let raw = String(messageContent || '');
        let codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        let candidates = [];
        let m;
        while ((m = codeBlockRegex.exec(raw)) !== null) {
            candidates.push(m[1].trim());
        }
        for (let i = candidates.length - 1; i >= 0; i--) {
            let nodes = tryParseFlowNodes(candidates[i], options, cfg);
            if (nodes) return nodes;
        }

        let stripped = raw.replace(/```[\s\S]*?```/g, '');
        let whole = stripped.trim();
        if (whole) {
            let wholeNodes = tryParseFlowNodes(whole, options, cfg);
            if (wholeNodes) return wholeNodes;
        }

        let objectCandidates = collectBalancedJsonSnippets(stripped, '{', '}');
        for (let oi = objectCandidates.length - 1; oi >= 0; oi--) {
            let objNodes = tryParseFlowNodes(objectCandidates[oi], options, cfg);
            if (objNodes) return objNodes;
        }

        let arrayCandidates = collectBalancedJsonSnippets(stripped, '[', ']');
        for (let ai = arrayCandidates.length - 1; ai >= 0; ai--) {
            let arrNodes = tryParseFlowNodes(arrayCandidates[ai], options, cfg);
            if (arrNodes) return arrNodes;
        }
        return null;
    }

    // Why extractFlowNodes returned null, so the importer can say "JSON parse
    // failed at line X" instead of "no JSON found". The usual cause is an
    // unescaped quote inside a JSONata expression. Null when there was no
    // fenced block at all, or when every block parses (failure was elsewhere).
    function diagnoseJsonExtractionFailure(messageContent) {
        let raw = String(messageContent || '');
        let codeBlockRegex = /```(?:json|javascript)?\s*\n?([\s\S]*?)\n?\s*```/gi;
        let candidates = [];
        let m;
        while ((m = codeBlockRegex.exec(raw)) !== null) {
            candidates.push(m[1].trim());
        }
        if (candidates.length === 0) return null;

        for (let i = candidates.length - 1; i >= 0; i--) {
            let text = stripJsonComments(candidates[i]).trim();
            if (!text) continue;
            try { JSON.parse(text); continue; } catch (e) {}
            try { JSON.parse(repairJsonQuotes(text)); continue; } catch (e2) {
                let info = { error: (e2 && e2.message) ? e2.message : String(e2) };
                let posMatch = /position\s+(\d+)/.exec(info.error);
                if (posMatch) {
                    let pos = parseInt(posMatch[1], 10);
                    if (!isNaN(pos) && pos >= 0 && pos <= text.length) {
                        let before = text.substring(0, pos);
                        info.line = (before.match(/\n/g) || []).length + 1;
                        info.column = pos - (before.lastIndexOf('\n') + 1) + 1;
                        info.snippet = text
                            .substring(Math.max(0, pos - 30), Math.min(text.length, pos + 30))
                            .replace(/\n/g, '↵');
                    }
                }
                return info;
            }
        }
        return null;
    }

    // ================================================================== //
    //  Public API                                                         //
    // ================================================================== //

    // Token normalization, JSON repair and schema resolution are internal
    // steps of the entry points below, not part of the callable surface.
    return {
        // Vibe Schema extraction (requires cfg with isVibeSchema)
        extractVibeSchema: extractVibeSchema,
        extractConnectionHints: extractConnectionHints,
        extractFlowDirectives: extractFlowDirectives,

        // Flow lookup (requires cfg with toIntermediate)
        buildFlowLookup: buildFlowLookup,

        // Flow node extraction (requires cfg with isVibeSchema, toNodeRed, toIntermediate)
        extractFlowNodes: extractFlowNodes,
        diagnoseJsonExtractionFailure: diagnoseJsonExtractionFailure
    };
});
