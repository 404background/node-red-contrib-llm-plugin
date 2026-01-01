// Clean, balanced importer implementation.
// Parses a ```json block from assistant messages and imports into Node-RED.
(function(){
    var Importer = {};
    var LAST_SANITIZED = null;

    function genId() { return 'id_' + Math.random().toString(36).substr(2,9); }
    function safeLog(){ try { if (window && window.console && window.console.log) window.console.log.apply(window.console, arguments); } catch(e){} }

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
            // Drop anything that is not a node-like object with a usable type string
            nodes = nodes.filter(function(n){
                return n && typeof n.type !== 'undefined' && String(n.type).trim().length > 0;
            });

            // Import as-is with minimal changes - preserve original IDs when possible
            var existingIds = new Set();
            if (window.RED && RED.nodes) {
                RED.nodes.eachNode(function(n) { existingIds.add(n.id); });
            }
            
            var newNodes = nodes.map(function(n){
                // Deep clone to avoid modifying original
                var nn = JSON.parse(JSON.stringify(n));
                nn.type = String(nn.type || '').trim();
                
                // Only ensure required fields exist
                if (!nn.id) nn.id = genId();
                
                // Generate new ID only if collision exists
                while (existingIds.has(nn.id)) {
                    nn.id = genId();
                }
                existingIds.add(nn.id);
                
                if (!Array.isArray(nn.wires)) nn.wires = [];
                
                return nn;
            });

            // Remove any `tab` (flow) nodes aggressively (trim and case-insensitive)
            newNodes = newNodes.filter(function(n){ return n.type && n.type.toLowerCase() !== 'tab'; });

            // Ensure all nodes are assigned to the current workspace (use id string)
            var currentWorkspace = null;
            try {
                if (RED && RED.workspaces && typeof RED.workspaces.active === 'function') {
                    currentWorkspace = RED.workspaces.active();
                }
            } catch(e) { /* ignore */ }
            // If the API returned an object, extract its id
            if (currentWorkspace && typeof currentWorkspace === 'object' && currentWorkspace.id) {
                currentWorkspace = currentWorkspace.id;
            }
            if (currentWorkspace && typeof currentWorkspace === 'string') {
                newNodes.forEach(n => { n.z = currentWorkspace; });
            } else {
                // If we couldn't determine the active workspace, leave z as-is and warn
                try { if (window && window.RED && RED.notify) RED.notify('Warning: could not determine active workspace; imported nodes may not be in the deployed flow','warning'); } catch(e){}
            }

            try{ LAST_SANITIZED = JSON.parse(JSON.stringify(newNodes)); }catch(e){ LAST_SANITIZED = null; }

            // If nothing remains after sanitization, warn and bail out early
            if (!newNodes.length) {
                try { if (window && window.RED && RED.notify) RED.notify('Import aborted: no valid nodes found (removed tab/blank nodes)', 'warning'); } catch(e){}
                return;
            }

            // Basic structural validation - only check for required node properties
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
})();
