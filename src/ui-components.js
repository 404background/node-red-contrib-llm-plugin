// LLM Plugin - UI Components
// Shared UI components and utilities for the LLM Plugin

function createUIComponents() {
    return {
        // Create a styled button
        createButton: function(text, className, clickHandler) {
            const button = $('<button></button>')
                .addClass(className)
                .text(text)
                .click(clickHandler);
            return button;
        },
        
        // Create a text input field
        createInput: function(placeholder, value) {
            return $('<input>')
                .attr('type', 'text')
                .attr('placeholder', placeholder)
                .val(value || '');
        },
        
        // Create a textarea
        createTextarea: function(placeholder, rows) {
            return $('<textarea>')
                .attr('placeholder', placeholder)
                .attr('rows', rows || 4);
        },
        
        // Create a loading spinner
        createSpinner: function() {
            return $('<div class="llm-plugin-spinner">Generating...</div>');
        },
        
        // Create a message bubble for chat
        createMessageBubble: function(content, isUser) {
            const bubble = $('<div>')
                .addClass('llm-plugin-message')
                .addClass(isUser ? 'user-message' : 'assistant-message');
            
            const contentDiv = $('<div>')
                .addClass('message-content')
                .html(content);
            
            bubble.append(contentDiv);
            
            return bubble;
        },
        
        // Format text with code highlighting
        formatMessage: function(text) {
            // Convert markdown-like formatting
            text = text.replace(/```json\n([\s\S]*?)\n```/g, '<pre class="json-block"><code>$1</code></pre>');
            text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
            text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
            text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
            
            // Convert line breaks
            text = text.replace(/\n/g, '<br>');
            
            return text;
        },
        
        // Show notification
        showNotification: function(message, type) {
            if (typeof RED !== 'undefined' && RED.notify) {
                RED.notify(message, type || 'info');
            } else {
                console.log(`[LLM Plugin ${type}] ${message}`);
            }
        },
        
        // Show confirmation dialog
        showConfirm: function(title, message, callback) {
            const confirmed = confirm(`${title}\n\n${message}`);
            if (callback) {
                callback(confirmed);
            }
            return confirmed;
        },
        
        // Extract JSON from text
        extractJSON: function(text) {
            const jsonRegex = /```json\s*\n([\s\S]*?)\n\s*```/g;
            const matches = [];
            let match;
            
            while ((match = jsonRegex.exec(text)) !== null) {
                try {
                    const parsed = JSON.parse(match[1].trim());
                    matches.push(parsed);
                } catch (e) {
                    console.warn('Failed to parse JSON from response:', e);
                }
            }
            
            return matches;
        },
        
        // Validate Node-RED flow JSON
        isValidFlow: function(json) {
            if (!json || typeof json !== 'object') return false;
            
            // Check for nodes array
            if (!Array.isArray(json.nodes)) {
                // Maybe it's just the nodes array itself
                if (Array.isArray(json)) {
                    json = { nodes: json };
                } else {
                    return false;
                }
            }
            
            // Check each node has required properties
            return json.nodes.every(node => 
                node && 
                typeof node === 'object' &&
                node.id && 
                node.type &&
                typeof node.x === 'number' &&
                typeof node.y === 'number'
            );
        },
        
        // Create model suggestion chips
        createModelSuggestions: function(models, onSelect) {
            const container = $('<div class="model-suggestions"></div>');
            
            models.forEach(model => {
                const chip = $('<span class="model-chip"></span>')
                    .text(model)
                    .click(() => onSelect(model));
                container.append(chip);
            });
            
            return container;
        },
        
        // Auto-resize textarea
        autoResizeTextarea: function(textarea) {
            textarea.css('height', 'auto');
            textarea.css('height', textarea[0].scrollHeight + 'px');
        },
        
        // Scroll to bottom of chat
        scrollToBottom: function(container) {
            container.animate({
                scrollTop: container[0].scrollHeight
            }, 300);
        }
    };
}

// Export for use in plugin
if (typeof module !== 'undefined' && module.exports) {
    module.exports = createUIComponents;
}
