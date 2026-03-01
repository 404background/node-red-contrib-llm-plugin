// UI core module — vanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    var UI = {};

    // Escape HTML special characters to prevent XSS
    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function formatMessage(text) {
        // Use marked library if available for proper Markdown rendering
        if (typeof marked !== 'undefined' && marked.parse) {
            return marked.parse(text);
        }

        // Fallback simple formatter (deprecated but kept for safety)
        // Escape HTML first to prevent XSS, then apply formatting
        text = escapeHtml(text);
        text = text.replace(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/gi, function(match, jsonContent) {
            try {
                var unescaped = jsonContent.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
                var parsed = JSON.parse(unescaped);
                if (parsed && (Array.isArray(parsed) || parsed.nodes)) {
                    return '<pre class="raw-json">' + jsonContent + '</pre>';
                }
            } catch (e) {}
            return '';
        });
        text = text.replace(/```(\w+)?\s*\n([\s\S]*?)\n\s*```/g, '<pre><code class="language-$1">$2</code></pre>');
        text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
        text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
        text = text.replace(/^# (.*)$/gm, '<h1>$1</h1>');
        text = text.replace(/^---$/gm, '<hr>');
        text = text.replace(/^(\s*)[-*] (.*)$/gm, '$1<li>$2</li>');
        text = text.replace(/(<li>.*<\/li>)/g, function(match) {
            if (!/^<ul>/.test(match)) return '<ul>' + match + '</ul>';
            return match;
        });
        text = text.replace(/^(\s*)\d+\. (.*)$/gm, '$1<li>$2</li>');
        text = text.replace(/(<li>.*<\/li>)/g, function(match) {
            if (!/^<ol>/.test(match) && !/^<ul>/.test(match)) return '<ol>' + match + '</ol>';
            return match;
        });
        text = text.replace(/<\/ol>\s*<ol>/g, '');
        text = text.replace(/<\/ul>\s*<ul>/g, '');
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
        text = text.replace(/\n/g, '<br>');
        return text;
    }

    UI.addMessageToUI = function(content, isUser, showActions) {
        var chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return null;

        var message = document.createElement('div');
        message.className = 'llm-plugin-message ' + (isUser ? 'user-message' : 'assistant-message');

        var messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = formatMessage(content);
        message.appendChild(messageContent);

        if (!isUser && showActions) {
            var messageActions = document.createElement('div');
            messageActions.className = 'message-actions';
            var retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            retryBtn.innerHTML = '<i class="fa fa-redo" aria-hidden="true" style="color:#222;"></i>';
            retryBtn.title = 'Retry message';
            retryBtn.addEventListener('click', function() { UI.retryLastUserMessage(); });
            messageActions.appendChild(retryBtn);
            message.appendChild(messageActions);
        }

        if (!isUser) {
            try {
                var flowNodes = (window.LLMPlugin && LLMPlugin.Importer && LLMPlugin.Importer.extractFlowNodes)
                    ? LLMPlugin.Importer.extractFlowNodes(content)
                    : null;
                if (flowNodes && flowNodes.length > 0) {
                    var flowActions = document.createElement('div');
                    flowActions.className = 'flow-actions';
                    var importBtn = document.createElement('button');
                    importBtn.className = 'import-btn';
                    importBtn.textContent = 'Import Flow';
                    importBtn.addEventListener('click', function() {
                        if (window.LLMPlugin && LLMPlugin.Importer) LLMPlugin.Importer.importFlowFromMessage(content);
                    });
                    flowActions.appendChild(importBtn);
                    message.appendChild(flowActions);
                }
            } catch (e) {}
        }

        chatArea.appendChild(message);
        chatArea.scrollTop = chatArea.scrollHeight;
        return message;
    };

    UI.formatMessage = formatMessage;

    UI.retryLastUserMessage = function() {
        try {
            if (window.LLMPlugin && LLMPlugin.ChatManager) {
                var chatId = LLMPlugin.ChatManager.getCurrentChatId();
                var history = LLMPlugin.ChatManager.getChatHistory ? LLMPlugin.ChatManager.getChatHistory() : {};
                var chat = history[chatId];
                if (chat && chat.messages) {
                    var userMessages = chat.messages.filter(function(msg) { return msg.isUser; });
                    if (userMessages.length > 0) {
                        var lastUserMsg = userMessages[userMessages.length - 1];
                        var promptInput = document.getElementById('llm-plugin-prompt');
                        var generateBtn = document.getElementById('llm-plugin-generate');
                        if (promptInput && generateBtn) {
                            promptInput.value = lastUserMsg.content;
                            generateBtn.click();
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Error retrying message:', e);
        }
    };

    UI.getCurrentFlow = function() {
        try {
            if (window.RED && RED.nodes && RED.workspaces) {
                var activeWorkspace = RED.workspaces.active();
                if (!activeWorkspace) return null;

                var nodes = RED.nodes.filterNodes({z: activeWorkspace});
                if (!nodes || nodes.length === 0) return null;

                if (typeof RED.nodes.createExportableNodeSet === 'function') {
                    return RED.nodes.createExportableNodeSet(nodes);
                }

                // Fallback for older Node-RED versions
                var exportArray = [];
                nodes.forEach(function(node) {
                    var nodeCopy = Object.assign({}, node);
                    delete nodeCopy._def;
                    delete nodeCopy.credentials;
                    exportArray.push(nodeCopy);
                });
                return exportArray;
            }
        } catch (error) {
            console.error('Error getting current flow:', error);
        }
        return null;
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = UI;
})();
