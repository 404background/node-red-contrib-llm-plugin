// VibeCoding Plugin - Client Side JavaScript
(function() {
    var sessionHistory = [];

    // Add the plugin when DOM is ready
    $(document).ready(function() {
        addSidebarTab();
    });
    
    function addSidebarTab() {
        const tabId = 'vibecoding-tab';
        const title = 'VibeCoding';
        
        // Build HTML content
        const html = [
            '<div style="padding: 10px; height: 100%; display: flex; flex-direction: column;">',
            '  <h3>VibeCoding - LLM Flow Assistant</h3>',
            '  ',
            '  <!-- Model Input with Suggestions -->',
            '  <div style="margin-bottom: 8px;">',
            '    <label for="vibe-model">Model Name:</label>',
            '    <input type="text" id="vibe-model" style="width: 100%; margin-top: 4px;" placeholder="Enter model name (e.g., llama3.2:latest)" list="model-suggestions">',
            '    <datalist id="model-suggestions">',
            '      <!-- Recent models will be populated here -->',
            '    </datalist>',
            '  </div>',
            '  ',
            '  <!-- Current Flow Toggle -->',
            '  <div style="margin-bottom: 8px;">',
            '    <label>',
            '      <input type="checkbox" id="vibe-include-flow" checked> Include current flow in context',
            '    </label>',
            '  </div>',
            '  ',
            '  <!-- Chat Messages Area -->',
            '  <div id="vibe-chat-area" style="flex: 1; border: 1px solid #ccc; padding: 8px; overflow-y: auto; margin-bottom: 8px; min-height: 200px; background: #f9f9f9;">',
            '    <div class="initial-message" style="color: #666; font-style: italic;">Start a conversation...</div>',
            '  </div>',
            '  ',
            '  <!-- Input Area -->',
            '  <div style="display: flex; gap: 8px;">',
            '    <textarea id="vibe-prompt" rows="2" style="flex: 1;" placeholder="Ask for Node-RED flow modifications..."></textarea>',
            '    <div style="display: flex; flex-direction: column; gap: 4px;">',
            '      <button id="vibe-send" class="red-ui-button" type="button">Send</button>',
            '      <button id="vibe-logs" class="red-ui-button" type="button">History</button>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');

        // Add sidebar tab
        RED.sidebar.addTab({
            id: tabId,
            label: title,
            name: title,
            content: html,
            closeable: false,
            visible: true
        });

        // Add event listeners after a short delay to ensure DOM is ready
        setTimeout(function() {
            var sendButton = $('#vibe-send');
            var logsButton = $('#vibe-logs');
            var promptTextarea = $('#vibe-prompt');
            var modelInput = $('#vibe-model');
            var includeFlowCheckbox = $('#vibe-include-flow');
            var chatArea = $('#vibe-chat-area');
            
            // Load recent models
            loadRecentModels();
            
            if (sendButton.length && logsButton.length && 
                promptTextarea.length && modelInput.length && includeFlowCheckbox.length) {
                
                // Send button click
                sendButton.click(function() {
                    sendToOllama();
                });
                
                // History button click
                logsButton.click(function() {
                    showHistoryDialog();
                });
                
                // Enter key support
                promptTextarea.keydown(function(e) {
                    if (e.ctrlKey && e.keyCode === 13) {
                        sendButton.click();
                    }
                });
                
            } else {
                console.error('[VibeCoding] Could not find required DOM elements');
            }
        }, 500);
    }
    
    function loadRecentModels() {
        // Load recent models from server
        var baseUrl = RED.settings.httpAdminRoot || '/red/';
        if (!baseUrl.endsWith('/')) {
            baseUrl += '/';
        }
        
        $.ajax({
            url: baseUrl + 'vibecoding/recent-models',
            type: 'GET',
            success: function(data) {
                var datalist = $('#model-suggestions');
                datalist.empty();
                if (data.models && data.models.length > 0) {
                    data.models.forEach(function(model) {
                        datalist.append('<option value="' + model + '">');
                    });
                }
            },
            error: function() {
                // Ignore errors for recent models
            }
        });
    }
    
    function addChatMessage(content, isUser, hasFlowJson) {
        var chatArea = $('#vibe-chat-area');
        
        // Clear initial message if present
        if (chatArea.find('.initial-message').length > 0) {
            chatArea.empty();
        }
        
        var messageDiv = $('<div>').css({
            'margin-bottom': '12px',
            'padding': '8px',
            'border-radius': '8px',
            'max-width': '80%',
            'word-wrap': 'break-word'
        });
        
        if (isUser) {
            messageDiv.css({
                'background': '#007acc',
                'color': 'white',
                'margin-left': '20%',
                'text-align': 'right'
            });
            messageDiv.text(content);
        } else {
            messageDiv.css({
                'background': '#e8e8e8',
                'color': '#333',
                'margin-right': '20%'
            });
            
            // Handle flow JSON if present
            if (hasFlowJson && content.includes('```json')) {
                var parts = content.split('```json');
                var textPart = parts[0].trim();
                var jsonPart = parts[1].split('```')[0].trim();
                
                if (textPart) {
                    messageDiv.append($('<div>').text(textPart));
                }
                
                if (jsonPart) {
                    var jsonDiv = $('<div>').css({
                        'margin': '8px 0',
                        'padding': '8px',
                        'background': '#f0f0f0',
                        'border-radius': '4px',
                        'border': '1px solid #ddd'
                    });
                    
                    var preDiv = $('<pre>').css({
                        'font-size': '12px',
                        'margin': '0',
                        'white-space': 'pre-wrap',
                        'max-height': '150px',
                        'overflow-y': 'auto'
                    }).text(jsonPart);
                    
                    var updateButton = $('<button>').text('Update Flow').css({
                        'margin-top': '8px',
                        'padding': '4px 8px',
                        'background': '#28a745',
                        'color': 'white',
                        'border': 'none',
                        'border-radius': '4px',
                        'cursor': 'pointer'
                    }).click(function() {
                        updateFlow(jsonPart);
                    });
                    
                    jsonDiv.append($('<div>').text('Generated Flow:'));
                    jsonDiv.append(preDiv);
                    jsonDiv.append(updateButton);
                    messageDiv.append(jsonDiv);
                }
                
                var remainingText = parts[1].split('```').slice(1).join('```');
                if (remainingText.trim()) {
                    messageDiv.append($('<div>').text(remainingText.trim()));
                }
            } else {
                messageDiv.text(content);
            }
        }
        
        chatArea.append(messageDiv);
        
        // Scroll to bottom
        chatArea.scrollTop(chatArea[0].scrollHeight);
    }
    
    function updateFlow(flowJson) {
        try {
            var flow = JSON.parse(flowJson);
            
            // Validate flow structure
            if (!flow.nodes || !Array.isArray(flow.nodes)) {
                RED.notify('Invalid flow format: missing nodes array', 'error');
                return;
            }
            
            // Import the flow
            RED.view.importNodes(flowJson);
            RED.notify('Flow updated successfully', 'success');
            
        } catch (e) {
            RED.notify('Error parsing flow JSON: ' + e.message, 'error');
        }
    }

    function sendToOllama() {
        var prompt = $('#vibe-prompt').val().trim();
        var model = $('#vibe-model').val().trim();
        var includeFlow = $('#vibe-include-flow').is(':checked');
        
        if (!prompt) {
            RED.notify('Please enter a message', 'warning');
            return;
        }
        
        if (!model) {
            RED.notify('Please enter a model name', 'warning');
            return;
        }
        
        // Add user message to chat
        addChatMessage(prompt, true, false);
        
        // Clear input
        $('#vibe-prompt').val('');
        
        // Show loading state
        var sendButton = $('#vibe-send');
        var originalText = sendButton.text();
        sendButton.text('Generating...').prop('disabled', true);
        
        // Get current flow if requested
        var currentFlow = null;
        if (includeFlow) {
            try {
                currentFlow = RED.nodes.createCompleteNodeSet(false);
            } catch (e) {
                console.warn('[VibeCoding] Could not get current flow:', e);
            }
        }
        
        // Build correct URL for the API endpoint
        var baseUrl = RED.settings.httpAdminRoot || '/red/';
        if (!baseUrl.endsWith('/')) {
            baseUrl += '/';
        }
        var apiUrl = baseUrl + 'vibecoding/generate';
        
        // Send HTTP request to Node-RED backend
        $.ajax({
            url: apiUrl,
            type: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({
                model: model,
                prompt: prompt,
                currentFlow: currentFlow
            }),
            success: function(data) {
                sendButton.text(originalText).prop('disabled', false);
                
                // Check if response contains flow JSON
                var hasFlowJson = data.response.includes('```json') && 
                                 data.response.includes('"nodes"') && 
                                 data.response.includes('"type"');
                
                // Add assistant response to chat
                addChatMessage(data.response, false, hasFlowJson);
                
                // Show success notification
                RED.notify('Response generated successfully', 'success');
            },
            error: function(xhr, status, error) {
                sendButton.text(originalText).prop('disabled', false);
                
                var errorMsg = 'Unknown error';
                try {
                    var errorData = JSON.parse(xhr.responseText);
                    errorMsg = errorData.error || errorMsg;
                } catch (e) {
                    errorMsg = xhr.responseText || errorMsg;
                }
                
                // Add error message to chat
                addChatMessage('Error: ' + errorMsg, false, false);
                RED.notify('Error: ' + errorMsg, 'error');
            }
        });
    }

    function showHistoryDialog() {
        // Build correct URL for the API endpoint
        var baseUrl = RED.settings.httpAdminRoot || '/red/';
        if (!baseUrl.endsWith('/')) {
            baseUrl += '/';
        }
        var apiUrl = baseUrl + 'vibecoding/logs';
        
        $.ajax({
            url: apiUrl,
            type: 'GET',
            success: function(data) {
                var dialogContent = '';
                
                if (!data.logs || data.logs.length === 0) {
                    dialogContent = 'No conversation history available';
                } else {
                    dialogContent = '<div style="max-height: 400px; overflow-y: auto;">';
                    data.logs.forEach(function(log) {
                        dialogContent += '<div style="margin-bottom: 12px; padding: 8px; border: 1px solid #ddd; border-radius: 4px;">';
                        dialogContent += '<div><strong>Time:</strong> ' + log.timestamp + '</div>';
                        dialogContent += '<div><strong>Model:</strong> ' + log.model + '</div>';
                        dialogContent += '<div><strong>User:</strong> ' + log.prompt + '</div>';
                        dialogContent += '<div><strong>Assistant:</strong></div>';
                        dialogContent += '<pre style="white-space: pre-wrap; font-size: 12px; background: #f5f5f5; padding: 4px; margin: 4px 0; max-height: 100px; overflow-y: auto;">' + log.response + '</pre>';
                        dialogContent += '</div>';
                    });
                    dialogContent += '</div>';
                }
                
                // Use Node-RED notification instead of confirm dialog
                RED.notify(dialogContent, 'info', false, 10000);
            },
            error: function(xhr, status, error) {
                var errorMsg = 'Unknown error';
                try {
                    var errorData = JSON.parse(xhr.responseText);
                    errorMsg = errorData.error || errorMsg;
                } catch (e) {
                    errorMsg = xhr.responseText || errorMsg;
                }
                RED.notify('Error loading history: ' + errorMsg, 'error');
            }
        });
    }

    // Make functions available globally if needed
    window.VibeCoding = {
        addChatMessage: addChatMessage,
        updateFlow: updateFlow,
        sendToOllama: sendToOllama
    };

})();