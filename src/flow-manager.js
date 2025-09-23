// VibeCoding Plugin - Flow Manager
// Functions for managing Node-RED flows

function createFlowManager() {
    return {
        // Get current flow data
        getCurrentFlow: function() {
            try {
                if (typeof RED !== 'undefined' && RED.workspaces && RED.nodes) {
                    const activeWorkspace = RED.workspaces.active();
                    if (activeWorkspace) {
                        const nodes = RED.nodes.filterNodes({z: activeWorkspace});
                        return {
                            id: activeWorkspace,
                            nodes: nodes.map(node => ({
                                id: node.id,
                                type: node.type,
                                name: node.name || '',
                                x: node.x,
                                y: node.y,
                                z: node.z,
                                wires: node.wires || []
                            }))
                        };
                    }
                }
                return null;
            } catch (error) {
                console.error('[VibeCoding] Error getting current flow:', error);
                return null;
            }
        },
        
        // Import nodes to current workspace
        importFlow: function(flowJSON, callback) {
            try {
                if (typeof RED === 'undefined' || !RED.view || !RED.view.importNodes) {
                    throw new Error('RED.view.importNodes is not available');
                }
                
                let nodesToImport;
                
                // Handle different JSON formats
                if (Array.isArray(flowJSON)) {
                    nodesToImport = flowJSON;
                } else if (flowJSON.nodes && Array.isArray(flowJSON.nodes)) {
                    nodesToImport = flowJSON.nodes;
                } else {
                    throw new Error('Invalid flow format');
                }
                
                // Validate nodes
                if (!nodesToImport.every(node => node.id && node.type)) {
                    throw new Error('Flow contains invalid nodes');
                }
                
                // Get current workspace
                const activeWorkspace = RED.workspaces.active();
                if (!activeWorkspace) {
                    throw new Error('No active workspace');
                }
                
                // Set workspace ID for all nodes
                nodesToImport.forEach(node => {
                    if (!node.z) {
                        node.z = activeWorkspace;
                    }
                });
                
                // Import the nodes
                RED.view.importNodes(nodesToImport, {
                    generateIds: true,  // Generate new IDs to avoid conflicts
                    addToHistory: true  // Add to undo history
                });
                
                // Force redraw
                RED.view.redraw();
                
                if (callback) callback(null, 'Flow imported successfully');
                
            } catch (error) {
                console.error('[VibeCoding] Error importing flow:', error);
                if (callback) callback(error.message, null);
            }
        },
        
        // Update existing flow
        updateFlow: function(flowJSON, callback) {
            try {
                if (typeof RED === 'undefined') {
                    throw new Error('Node-RED API not available');
                }
                
                // For now, just import as new nodes
                // In the future, this could be smarter about updating existing nodes
                this.importFlow(flowJSON, callback);
                
            } catch (error) {
                console.error('[VibeCoding] Error updating flow:', error);
                if (callback) callback(error.message, null);
            }
        },
        
        // Position nodes automatically
        positionNodes: function(nodes, startX, startY) {
            startX = startX || 100;
            startY = startY || 100;
            
            const spacing = 150;
            let currentX = startX;
            let currentY = startY;
            
            nodes.forEach((node, index) => {
                node.x = currentX;
                node.y = currentY;
                
                // Move to next position
                currentX += spacing;
                
                // Wrap to next row after 5 nodes
                if ((index + 1) % 5 === 0) {
                    currentX = startX;
                    currentY += spacing;
                }
            });
            
            return nodes;
        },
        
        // Generate unique node ID
        generateNodeId: function() {
            return 'vc_' + Math.random().toString(36).substr(2, 9);
        },
        
        // Create basic flow template
        createBasicFlow: function(description) {
            const nodes = [];
            
            // Inject node
            nodes.push({
                id: this.generateNodeId(),
                type: 'inject',
                name: 'Start',
                topic: '',
                payload: '',
                payloadType: 'date',
                repeat: '',
                crontab: '',
                once: false,
                onceDelay: 0.1,
                x: 100,
                y: 100,
                wires: [[]]
            });
            
            // Debug node
            nodes.push({
                id: this.generateNodeId(),
                type: 'debug',
                name: 'Output',
                active: true,
                tosidebar: true,
                console: false,
                tostatus: false,
                complete: 'false',
                x: 300,
                y: 100,
                wires: []
            });
            
            // Wire them together
            if (nodes.length >= 2) {
                nodes[0].wires[0].push(nodes[1].id);
            }
            
            return {
                description: description || 'Basic flow template',
                nodes: nodes
            };
        },
        
        // Validate flow structure
        validateFlow: function(flowJSON) {
            try {
                let nodes;
                
                if (Array.isArray(flowJSON)) {
                    nodes = flowJSON;
                } else if (flowJSON.nodes && Array.isArray(flowJSON.nodes)) {
                    nodes = flowJSON.nodes;
                } else {
                    return { valid: false, error: 'Flow must contain a nodes array' };
                }
                
                // Check each node
                for (let i = 0; i < nodes.length; i++) {
                    const node = nodes[i];
                    
                    if (!node.id) {
                        return { valid: false, error: `Node ${i} missing id` };
                    }
                    
                    if (!node.type) {
                        return { valid: false, error: `Node ${i} missing type` };
                    }
                    
                    if (typeof node.x !== 'number' || typeof node.y !== 'number') {
                        return { valid: false, error: `Node ${i} missing valid position` };
                    }
                }
                
                return { valid: true };
                
            } catch (error) {
                return { valid: false, error: error.message };
            }
        }
    };
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = createFlowManager;
}