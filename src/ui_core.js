(function(){
    var UI = {};

    function formatMessage(text) {
        text = text.replace(/```json\s*\n([\s\S]*?)\n\s*```/g, function(match, jsonContent) {
            try {
                var parsed = JSON.parse(jsonContent);
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
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
        text = text.replace(/\n/g, '<br>');
        return text;
    }

    UI.addMessageToUI = function(content, isUser, showActions) {
        var chatArea = jQuery('#llm-plugin-chat');
        if (!chatArea || !chatArea.length) return null;
        var message = jQuery('<div>').addClass('llm-plugin-message')
            .addClass(isUser ? 'user-message' : 'assistant-message');
        var messageContent = jQuery('<div>').addClass('message-content')
            .html(formatMessage(content));
        message.append(messageContent);
        if (!isUser && showActions) {
            var messageActions = jQuery('<div>').addClass('message-actions');
            var retryBtn = jQuery('<button>').addClass('retry-btn')
                .html('<i class="fa fa-redo" aria-hidden="true" style="color:#222;"></i>')
                .attr('title', 'Retry message')
                .click(function() { UI.retryLastUserMessage(); });
            messageActions.append(retryBtn);
            message.append(messageActions);
        }
        if (!isUser && content.indexOf('```json') !== -1) {
            try {
                var jsonMatch = content.match(/```json\s*\n([\s\S]*?)\n\s*```/);
                if (jsonMatch) {
                    var testJSON = JSON.parse(jsonMatch[1]);
                    if (testJSON && (Array.isArray(testJSON) || testJSON.nodes)) {
                        var flowActions = jQuery('<div>').addClass('flow-actions');
                        var importBtn = jQuery('<button>').addClass('import-btn').text('Import Flow')
                            .click(function() { if (window.LLMPlugin && LLMPlugin.Importer) LLMPlugin.Importer.importFlowFromMessage(content); });
                        flowActions.append(importBtn);
                        message.append(flowActions);
                    }
                }
            } catch (e) {}
        }
        chatArea.append(message);
        chatArea.scrollTop(chatArea[0].scrollHeight);
        return message;
    };

    UI.formatMessage = formatMessage;

    UI.retryLastUserMessage = function() {
        try {
            // Find the last user message from the current chat and re-send it
            if (window.LLMPlugin && LLMPlugin.ChatManager) {
                var chatId = LLMPlugin.ChatManager.getCurrentChatId();
                var chatHistory = LLMPlugin.ChatManager.getChatHistory ? LLMPlugin.ChatManager.getChatHistory() : {};
                var chat = chatHistory[chatId];
                if (chat && chat.messages) {
                    // Find the last user message
                    var userMessages = chat.messages.filter(function(msg) { return msg.isUser; });
                    if (userMessages.length > 0) {
                        var lastUserMsg = userMessages[userMessages.length - 1];
                        // Set the prompt and trigger generation
                        var promptInput = jQuery('#llm-plugin-prompt');
                        var generateBtn = jQuery('#llm-plugin-generate');
                        if (promptInput.length && generateBtn.length) {
                            promptInput.val(lastUserMsg.content);
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
            if (window.RED && RED.workspaces && RED.nodes) {
                var activeWorkspace = RED.workspaces.active();
                if (activeWorkspace) {
                    var nodes = RED.nodes.filterNodes({z: activeWorkspace});
                    var workspace = RED.nodes.workspace(activeWorkspace);
                    var exportArray = [];
                    if (workspace) {
                        exportArray.push(workspace);
                    }
                    nodes.forEach(function(node) {
                        var nodeCopy = Object.assign({}, node);
                        delete nodeCopy._def;
                        delete nodeCopy.__proto__;
                        exportArray.push(nodeCopy);
                    });
                    return exportArray;
                }
            }
        } catch (error) {
            console.error('Error getting current flow:', error);
        }
        return null;
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = UI;
})();
