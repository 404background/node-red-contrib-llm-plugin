// Clean, balanced importer implementation.
// Parses a ```json block from assistant messages and imports into Node-RED.
(function(){
    var Importer = {};
    var LAST_SANITIZED = null;

    function genId() { return 'id_' + Math.random().toString(36).substr(2,9); }
    function safeLog(){ try { if (window && window.console && window.console.log) window.console.log.apply(window.console, arguments); } catch(e){} }

    function validateNodes(nodes){
        var issues = [];
        nodes.forEach(function(n){
            try{
                var t = String(n.type||'').toLowerCase();
                if (t.indexOf('inject') !== -1){
                    // Allow inject nodes without payload by defaulting to an empty string
                    if (typeof n.payload === 'undefined' || n.payload === null) {
                        n.payload = '';
                        n.payloadType = 'str';
                    }
                }
                if (t.indexOf('change') !== -1){
                    if (!Array.isArray(n.rules) || n.rules.length===0) {
                        issues.push({id:n.id,type:n.type,issue:'change_missing_rules'});
                    } else {
                        // validate each rule's shape - catch common LLM errors (e.g. t:'str' where t should be 'set')
                        n.rules.forEach(function(r, ri){
                            try{
                                if (!r || typeof r.t !== 'string' || r.t.trim()==='') { issues.push({id:n.id,type:n.type,issue:'change_rule_missing_t',ruleIndex:ri}); return; }
                                var rt = String(r.t).toLowerCase();
                                // If the rule type looks like a payload type (str/num/bool/json/date), it's likely malformed
                                if (/^(str|num|bool|json|date|jsonata)$/.test(rt)) { issues.push({id:n.id,type:n.type,issue:'change_rule_type_looks_like_payload_type',ruleIndex:ri,found:r.t}); return; }
                                // For 'set' action ensure a target value exists
                                if (rt==='set' && (typeof r.to === 'undefined' || r.to === null)) { issues.push({id:n.id,type:n.type,issue:'change_rule_set_missing_to',ruleIndex:ri}); return; }
                            }catch(e){}
                        });
                    }
                }
                if (t.indexOf('debug') !== -1){ if (n.active !== true || n.tosidebar !== true) issues.push({id:n.id,type:n.type,issue:'debug_not_active'}); }
            }catch(e){}
        });
        return issues;
    }

    function sanitizeNodes(nodes){
        // Conservative sanitizer: do minimal non-destructive normalization so Node-RED can import
        var out = nodes.map(function(n){ return Object.assign({}, n); });

        out.forEach(function(node){
            try{
                // ensure an id exists (Node-RED requires ids)
                if (!node.id) node.id = genId();

                // normalize wires to arrays of string ids when possible; keep values otherwise
                if (!Array.isArray(node.wires)) {
                    node.wires = [];
                } else {
                    node.wires = node.wires.map(function(arr){
                        if (!Array.isArray(arr)) return [];
                        return arr.filter(function(x){ return x !== null && typeof x !== 'undefined'; }).map(function(x){ return typeof x === 'string' ? x : String(x); });
                    });
                }

                // do NOT set payloads/default rules/debug flags/name etc. Preserve original properties.
            }catch(e){ /* keep original node if anything goes wrong */ }
        });

        return out;
    }

    Importer.importFlowFromMessage = function(messageContent){
        try{
            var m = messageContent.match(/```json\s*\n([\s\S]*?)\n\s*```/);
            if (!m){ if (window.RED && RED.notify) RED.notify('No JSON flow found in message','warning'); return; }
            var flow = JSON.parse(m[1]);
            var nodes = Array.isArray(flow)? flow : (flow.nodes? flow.nodes : [flow]);
            nodes = nodes.filter(function(n){ return n && n.type; });

            // ensure ids
            nodes.forEach(function(n){ if (!n.id) n.id = genId(); });

            // remap ids and wires to avoid collisions
            var originalIds = nodes.map(function(n){ return n.id; });
            var mapping = {}; originalIds.forEach(function(id){ mapping[id]=genId(); });
            var newNodes = nodes.map(function(n){
                var idx = originalIds.indexOf(n.id);
                var newId = mapping[n.id];
                // Perform a deep clone of the node to ensure all properties are preserved
                var nn = JSON.parse(JSON.stringify(n));
                nn.id = newId;
                if (nn.z) nn.z = mapping[nn.z] || nn.z;
                if (Array.isArray(nn.wires)) {
                    nn.wires = nn.wires.map(function(arr) {
                        if (!Array.isArray(arr)) return [];
                        return arr.map(function(t) {
                            return mapping[t] || null;
                        }).filter(function(x) {
                            return x !== null;
                        });
                    });
                } else {
                    nn.wires = [];
                }
                return nn;
            });

            // Remove any `tab` nodes to prevent creating new flow tabs
            newNodes = newNodes.filter(n => n.type !== 'tab');

            // Ensure all nodes are assigned to the current workspace
            const currentWorkspace = RED.workspaces.active();
            if (currentWorkspace) {
                newNodes.forEach(n => {
                    n.z = currentWorkspace;
                });
            }

            try{ LAST_SANITIZED = JSON.parse(JSON.stringify(newNodes)); }catch(e){ LAST_SANITIZED = null; }

            // Validation-only import: do not mutate assistant JSON automatically.
            var issues = validateNodes(newNodes);
            if (issues && issues.length>0){
                if (window.RED && RED.notify) RED.notify('Imported flow appears to be malformed. Correct the JSON before importing.','warning');
                safeLog('validation issues', issues);
                return;
            }

            var bad = newNodes.find(function(n){ return typeof n.type !== 'string' || n.type.length===0; }); if (bad){ if (RED && RED.notify) RED.notify('Import aborted: invalid node shape','error'); safeLog('bad node', bad); return; }

            var origEmit = null;
            try{
                if (RED && RED.events && typeof RED.events.emit === 'function'){ origEmit = RED.events.emit; RED.events.emit = function(evt){ try{ if (evt==='flows:add') return origEmit.apply(RED.events, arguments); return origEmit.apply(RED.events, arguments); }catch(e){ if (e && e.message && String(e.message).indexOf('indexOf')!==-1) return null; safeLog('emit suppressed', e); return null; } }; }
            }catch(e){ safeLog('wrap emit failed', e); }

            try {
                // Import nodes without generating new IDs or creating new tabs
                RED.view.importNodes(newNodes, { generateIds: false, addToHistory: true });
                if (RED && RED.notify) RED.notify('Flow imported successfully', 'success');
            } finally {
                try {
                    if (origEmit && RED && RED.events) RED.events.emit = origEmit;
                } catch ( e) {
                    safeLog('restore emit failed', e);
                }
            }

        }catch(err){ console.error('Import error:', err); if (RED && RED.notify) RED.notify('Failed to import flow: '+(err && err.message?err.message:String(err)),'error'); }
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.Importer = Importer;
    Importer.getLastSanitized = function(){ return LAST_SANITIZED; };
    // Auto-fix removed: importer is validation-only by design.

})();
