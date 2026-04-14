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
            // If the whole response is raw JSON, render it as a formatted
            // code block so UI can fold it like fenced JSON output.
            var raw = String(text || '').trim();
            if (raw && (raw.charAt(0) === '{' || raw.charAt(0) === '[')) {
                try {
                    var parsedRaw = JSON.parse(raw);
                    if (parsedRaw && typeof parsedRaw === 'object') {
                        var descHtml = '';
                        var displayObj = parsedRaw;
                        // Vibe Schema with description: show description as text
                        if (parsedRaw.nodes && parsedRaw.connections &&
                            parsedRaw.description && typeof parsedRaw.description === 'string') {
                            descHtml = '<p>' + escapeHtml(parsedRaw.description) + '</p>';
                            displayObj = JSON.parse(JSON.stringify(parsedRaw));
                            delete displayObj.description;
                        }
                        return descHtml + '<pre><code class="language-json">' +
                            escapeHtml(JSON.stringify(displayObj, null, 2)) +
                            '</code></pre>';
                    }
                } catch (e) { /* not raw JSON */ }
            }

            // Prevent raw HTML injection from model responses while preserving markdown.
            var safeText = String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return marked.parse(safeText);
        }

        // Fallback simple formatter (deprecated but kept for safety)
        // Escape HTML first to prevent XSS, then apply formatting
        text = escapeHtml(text);
        text = text.replace(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/gi, function(match, jsonContent) {
            try {
                var unescaped = jsonContent.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
                var parsed = JSON.parse(unescaped);
                if (parsed && (Array.isArray(parsed) || parsed.nodes)) {
                    // Re-escape: use the parsed object to produce clean JSON, then escape for safe HTML display
                    return '<pre class="raw-json">' + escapeHtml(JSON.stringify(parsed, null, 2)) + '</pre>';
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

    function createRestoreCheckpointButton(checkpointId) {
        var btn = document.createElement('button');
        btn.className = 'restore-btn';
        btn.textContent = 'Restore Checkpoint';
        btn.dataset.checkpointId = checkpointId;
        btn.addEventListener('click', function() {
            var cpId = btn.dataset.checkpointId;
            if (!cpId || !(window.LLMPlugin && LLMPlugin.Importer && LLMPlugin.Importer.restoreCheckpoint)) return;
            var ok = confirm('Restore the flow from this checkpoint? Current flow in the active tab will be replaced.');
            if (!ok) return;
            btn.disabled = true;
            LLMPlugin.Importer.restoreCheckpoint(cpId)
                .then(function(result) {
                    if (result && result.ok) {
                        if (window.RED && RED.notify) RED.notify('Checkpoint restored', 'success');
                    } else if (window.RED && RED.notify) {
                        RED.notify((result && result.error) || 'Failed to restore checkpoint', 'error');
                    }
                })
                .catch(function(err) {
                    if (window.RED && RED.notify) RED.notify((err && err.message) || 'Failed to restore checkpoint', 'error');
                })
                .finally(function() {
                    btn.disabled = false;
                });
        });
        return btn;
    }

    UI.addMessageToUI = function(content, isUser, showActions, messageMeta) {
        var chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return null;

        var message = document.createElement('div');
        message.className = 'llm-plugin-message ' + (isUser ? 'user-message' : 'assistant-message');
        if (messageMeta && messageMeta.id) {
            message.dataset.messageId = messageMeta.id;
        }

        var messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = formatMessage(content);

        // Wrap JSON / Vibe-Schema code blocks in a collapsible <details> element
        var codeBlocks = messageContent.querySelectorAll('pre');
        for (var i = 0; i < codeBlocks.length; i++) {
            var pre = codeBlocks[i];
            var codeEl = pre.querySelector('code') || pre;
            try {
                var text = codeEl.textContent || '';
                var parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') {
                    var details = document.createElement('details');
                    details.className = 'json-collapsible';
                    var summary = document.createElement('summary');

                    var isVibeSchema = parsed.nodes && parsed.connections;
                    if (isVibeSchema) {
                        summary.textContent = 'Vibe Schema JSON';
                        // If the LLM included a description inside the JSON,
                        // show it as a text paragraph and strip from the JSON display.
                        if (parsed.description && typeof parsed.description === 'string') {
                            var descPara = document.createElement('p');
                            descPara.textContent = parsed.description;
                            pre.parentNode.insertBefore(descPara, pre);
                            // Re-render the code block without the description field
                            var display = JSON.parse(JSON.stringify(parsed));
                            delete display.description;
                            codeEl.textContent = JSON.stringify(display, null, 2);
                        }
                    } else if (Array.isArray(parsed)) {
                        summary.textContent = 'Flow JSON (' + parsed.length + ' nodes)';
                    } else {
                        summary.textContent = 'JSON';
                    }
                    pre.parentNode.insertBefore(details, pre);
                    details.appendChild(summary);
                    details.appendChild(pre);
                }
            } catch (e) { /* not JSON — leave as-is */ }
        }

        message.appendChild(messageContent);

        if (!isUser) {
            var meta = messageMeta && messageMeta.meta ? messageMeta.meta : null;
            if (meta && typeof meta.elapsedMs === 'number' && isFinite(meta.elapsedMs)) {
                var elapsed = document.createElement('div');
                elapsed.className = 'message-elapsed';
                var elapsedText = (meta.elapsedMs / 1000).toFixed(1) + 's';
                if (meta.model && typeof meta.model === 'string') {
                    elapsedText = meta.model + ' / ' + elapsedText;
                }
                elapsed.textContent = elapsedText;
                message.appendChild(elapsed);
            }
        }

        if (!isUser && showActions) {
            var messageActions = document.createElement('div');
            messageActions.className = 'message-actions';
            var retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            var retryIcon = document.createElement('i');
            retryIcon.className = 'fa fa-redo';
            retryIcon.setAttribute('aria-hidden', 'true');
            retryIcon.style.color = '#222';
            retryBtn.appendChild(retryIcon);
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
                var hasDirectivesOnly = !flowNodes || flowNodes.length === 0
                    ? !!(window.LLMPlugin && LLMPlugin.Importer && LLMPlugin.Importer.hasFlowDirectives && LLMPlugin.Importer.hasFlowDirectives(content))
                    : false;
                if ((flowNodes && flowNodes.length > 0) || hasDirectivesOnly) {
                    var flowActions = document.createElement('div');
                    flowActions.className = 'flow-actions';
                    var importBtn = document.createElement('button');
                    importBtn.className = 'import-btn';
                    importBtn.textContent = 'Import Flow';
                    
                    var isAgent = messageMeta && messageMeta.meta && messageMeta.meta.mode === 'agent';
                    if (isAgent) importBtn.style.display = 'none';

                    importBtn.addEventListener('click', function() {
                        if (!(window.LLMPlugin && LLMPlugin.Importer && LLMPlugin.Importer.importFlowFromMessage)) return;
                        importBtn.disabled = true;
                        var chatId = (window.LLMPlugin && LLMPlugin.ChatManager && LLMPlugin.ChatManager.getCurrentChatId)
                            ? LLMPlugin.ChatManager.getCurrentChatId()
                            : null;
                        var selectedApplyMode = 'auto';
                        if (messageMeta && messageMeta.meta && messageMeta.meta.applyMode) {
                            selectedApplyMode = messageMeta.meta.applyMode;
                        }

                        LLMPlugin.Importer.importFlowFromMessage(content, {
                            chatId: chatId,
                            checkpointLabel: 'pre-import-' + new Date().toISOString(),
                            mode: (messageMeta && messageMeta.meta && messageMeta.meta.mode) ? messageMeta.meta.mode : 'ask',
                            applyMode: selectedApplyMode
                        })
                        .then(function(result) {
                            if (!result || !result.ok) return;
                            // Restore should target the flow state at this chat step (post-import snapshot).
                            var checkpointId = result.postCheckpointId || result.checkpointId;
                            if (checkpointId) {
                                flowActions.querySelectorAll('.restore-btn').forEach(function(b) { b.remove(); });
                                flowActions.appendChild(createRestoreCheckpointButton(checkpointId));
                                if (messageMeta && messageMeta.id && window.LLMPlugin && LLMPlugin.ChatManager && LLMPlugin.ChatManager.updateMessageMeta) {
                                    LLMPlugin.ChatManager.updateMessageMeta(messageMeta.id, {
                                        pluginEdited: true,
                                        checkpointId: checkpointId
                                    });
                                }
                            }
                        })
                        .finally(function() {
                            importBtn.disabled = false;
                        });
                    });
                    flowActions.appendChild(importBtn);

                    // Rebuild restore button for previously edited plugin messages.
                    var existingCheckpointId = messageMeta && messageMeta.meta && messageMeta.meta.pluginEdited
                        ? messageMeta.meta.checkpointId
                        : null;
                    if (existingCheckpointId) {
                        flowActions.appendChild(createRestoreCheckpointButton(existingCheckpointId));
                    }

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

                // Collect config nodes referenced by workspace nodes.
                // Dashboard nodes (ui_button, etc.) reference config nodes
                // (ui-group, ui-tab, ui-base) that live outside any workspace.
                // BFS follows transitive references (e.g. ui-group → ui-tab).
                var configNodes = [];
                var allConfigById = {};
                if (RED.nodes.eachConfig) {
                    RED.nodes.eachConfig(function(cn) {
                        allConfigById[cn.id] = cn;
                    });
                }
                if (Object.keys(allConfigById).length > 0) {
                    var collected = {};
                    var queue = nodes.slice();
                    while (queue.length > 0) {
                        var cur = queue.shift();
                        if (!cur) continue;
                        Object.keys(cur).forEach(function(key) {
                            if (typeof cur[key] !== 'string') return;
                            var cn = allConfigById[cur[key]];
                            if (cn && !collected[cn.id]) {
                                collected[cn.id] = cn;
                                queue.push(cn);
                            }
                        });
                    }
                    configNodes = Object.keys(collected).map(function(id) { return collected[id]; });
                }

                var allNodes = nodes.concat(configNodes);

                if (typeof RED.nodes.createExportableNodeSet === 'function') {
                    return RED.nodes.createExportableNodeSet(allNodes);
                }

                // Fallback for older Node-RED versions
                var exportArray = [];
                allNodes.forEach(function(node) {
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
