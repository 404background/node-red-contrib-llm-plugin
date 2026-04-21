// UI core module  Evanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    let UI = {};

    // Escape HTML special characters to prevent XSS
    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function formatMessage(text) {
        // Run with marked.js (assumed present in modern Node-RED environments)
        if (typeof marked !== 'undefined' && marked.parse) {
            let raw = String(text || '').trim();
            if (raw && (raw.charAt(0) === '{' || raw.charAt(0) === '[')) {
                try {
                    let parsedRaw = JSON.parse(raw);
                    if (parsedRaw && typeof parsedRaw === 'object') {
                        let descHtml = '';
                        let displayObj = parsedRaw;
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

            let safeText = String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            let html = marked.parse(safeText);
            return html.replace(/href\s*=\s*(["'])\s*javascript:/gi, 'href=$1#blocked:');
        }

        return escapeHtml(text);
    }

    function createRestoreCheckpointButton(checkpointId) {
        let btn = document.createElement('button');
        btn.className = 'restore-btn';
        btn.textContent = 'Restore Checkpoint';
        btn.dataset.checkpointId = checkpointId;
        btn.addEventListener('click', function() {
            let cpId = btn.dataset.checkpointId;
            if (!cpId || !LLMPlugin.Importer) return;
            let ok = confirm('Restore the flow from this checkpoint? Current flow will be replaced.');
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
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return null;

        let message = document.createElement('div');
        message.className = 'llm-plugin-message ' + (isUser ? 'user-message' : 'assistant-message');
        if (messageMeta && messageMeta.id) {
            message.dataset.messageId = messageMeta.id;
        }

        let messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = formatMessage(content);

        // Wrap JSON / Vibe-Schema code blocks in a collapsible <details> element
        let codeBlocks = messageContent.querySelectorAll('pre');
        for (let i = 0; i < codeBlocks.length; i++) {
            let pre = codeBlocks[i];
            let codeEl = pre.querySelector('code') || pre;
            try {
                let text = codeEl.textContent || '';
                let parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') {
                    let details = document.createElement('details');
                    details.className = 'json-collapsible';
                    let summary = document.createElement('summary');

                    let isVibeSchema = parsed.nodes && parsed.connections;
                    if (isVibeSchema) {
                        summary.textContent = 'Vibe Schema JSON';
                        // If the LLM included a description inside the JSON,
                        // show it as a text paragraph and strip from the JSON display.
                        if (parsed.description && typeof parsed.description === 'string') {
                            let descPara = document.createElement('p');
                            descPara.textContent = parsed.description;
                            pre.parentNode.insertBefore(descPara, pre);
                            // Re-render the code block without the description field
                            let display = JSON.parse(JSON.stringify(parsed));
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
            } catch (e) { /* not JSON  Eleave as-is */ }
        }

        message.appendChild(messageContent);

        if (!isUser) {
            let meta = messageMeta && messageMeta.meta ? messageMeta.meta : null;
            if (meta && typeof meta.elapsedMs === 'number' && isFinite(meta.elapsedMs)) {
                let elapsed = document.createElement('div');
                elapsed.className = 'message-elapsed';
                let elapsedText = (meta.elapsedMs / 1000).toFixed(1) + 's';
                if (meta.model && typeof meta.model === 'string') {
                    elapsedText = meta.model + ' / ' + elapsedText;
                }
                elapsed.textContent = elapsedText;
                message.appendChild(elapsed);
            }
        }

        if (!isUser && showActions) {
            let messageActions = document.createElement('div');
            messageActions.className = 'message-actions';
            let retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            let retryIcon = document.createElement('i');
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
                let flowNodes = LLMPlugin.Importer ? LLMPlugin.Importer.extractFlowNodes(content) : null;
                let hasDirectivesOnly = !flowNodes || flowNodes.length === 0
                    ? !!(LLMPlugin.Importer && LLMPlugin.Importer.hasFlowDirectives(content))
                    : false;
                if ((flowNodes && flowNodes.length > 0) || hasDirectivesOnly) {
                    let flowActions = document.createElement('div');
                    flowActions.className = 'flow-actions';
                    let importBtn = document.createElement('button');
                    importBtn.className = 'import-btn';
                    importBtn.textContent = 'Import Flow';
                    
                    let isAgent = messageMeta && messageMeta.meta && messageMeta.meta.mode === 'agent';
                    if (isAgent) importBtn.style.display = 'none';

                    importBtn.addEventListener('click', function() {
                        if (!LLMPlugin.Importer) return;
                        importBtn.disabled = true;
                        let chatId = LLMPlugin.ChatManager ? LLMPlugin.ChatManager.getCurrentChatId() : null;
                        let selectedApplyMode = 'auto';
                        if (messageMeta && messageMeta.meta && messageMeta.meta.applyMode) {
                            selectedApplyMode = messageMeta.meta.applyMode;
                        }

                        LLMPlugin.Importer.importFlowFromMessage(content, {
                            chatId: chatId,
                            mode: (messageMeta && messageMeta.meta && messageMeta.meta.mode) ? messageMeta.meta.mode : 'ask',
                            applyMode: selectedApplyMode
                        })
                        .then(function(result) {
                            if (!result || !result.ok) return;
                            // Restore targets the pre-send snapshot saved by
                            // ChatManager.savePreSendCheckpoint when this message
                            // was dispatched; no post-apply checkpoint exists.
                            let checkpointId = messageMeta && messageMeta.meta && messageMeta.meta.preSendCheckpointId
                                ? messageMeta.meta.preSendCheckpointId
                                : null;
                            if (checkpointId) {
                                let preChatActions = message.querySelector('.pre-chat-actions');
                                if (!preChatActions) {
                                    preChatActions = document.createElement('div');
                                    preChatActions.className = 'flow-actions pre-chat-actions';
                                    preChatActions.style.marginTop = '0';
                                    preChatActions.style.marginBottom = '10px';
                                    message.insertBefore(preChatActions, message.firstChild);
                                }
                                preChatActions.querySelectorAll('.restore-btn').forEach(function(b) { b.remove(); });
                                preChatActions.appendChild(createRestoreCheckpointButton(checkpointId));
                                if (messageMeta && messageMeta.id && LLMPlugin.ChatManager) {
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
                    let existingCheckpointId = messageMeta && messageMeta.meta && messageMeta.meta.pluginEdited
                        ? messageMeta.meta.checkpointId
                        : null;
                    if (existingCheckpointId) {
                        let preChatActions = document.createElement('div');
                        preChatActions.className = 'flow-actions pre-chat-actions';
                        preChatActions.style.marginTop = '0';
                        preChatActions.style.marginBottom = '10px';
                        preChatActions.appendChild(createRestoreCheckpointButton(existingCheckpointId));
                        message.insertBefore(preChatActions, message.firstChild);
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
            if (LLMPlugin.ChatManager) {
                let chatId = LLMPlugin.ChatManager.getCurrentChatId();
                let history = LLMPlugin.ChatManager.getChatHistory ? LLMPlugin.ChatManager.getChatHistory() : {};
                let chat = history[chatId];
                if (chat && chat.messages) {
                    let userMessages = chat.messages.filter(function(msg) { return msg.isUser; });
                    if (userMessages.length > 0) {
                        let lastUserMsg = userMessages[userMessages.length - 1];
                        let promptInput = document.getElementById('llm-plugin-prompt');
                        let generateBtn = document.getElementById('llm-plugin-generate');
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

    UI.getFlowsByIds = function(flowIds) {
        try {
            if (!window.RED || !RED.nodes) return null;
            let ids = Array.isArray(flowIds) ? flowIds.filter(Boolean) : [];
            if (ids.length === 0) return null;

            let seenIds = {};
            let nodes = [];
            // Include tab definition nodes so the server can resolve
            // flow names when grouping multi-flow context for the LLM.
            ids.forEach(function(zid) {
                let ws = RED.nodes.workspace(zid);
                if (ws && ws.id && !seenIds[ws.id]) {
                    seenIds[ws.id] = true;
                    nodes.push(ws);
                }
            });
            
            ids.forEach(function(zid) {
                let n = RED.nodes.filterNodes({z: zid}) || [];
                n.forEach(function(node) {
                    if (node && node.id && !seenIds[node.id]) {
                        seenIds[node.id] = true;
                        nodes.push(node);
                    }
                });
            });
            if (nodes.length === 0) return null;

            let configNodes = collectReferencedConfigs(nodes, seenIds);
            let allNodes = nodes.concat(configNodes);

            return RED.nodes.createExportableNodeSet(allNodes);
        } catch (error) {
            console.error('Error getting flows by ids:', error);
            return null;
        }
    };

    function collectReferencedConfigs(nodes, seenIds) {
        let configNodes = [];
        let referencedIds = {};

        // Find which config node IDs are actually referenced by the targeted canvas nodes
        nodes.forEach(function(n) {
            Object.keys(n).forEach(function(k) {
                if (k === 'id' || k === 'z' || k === 'type' || k === 'wires' || k === 'x' || k === 'y') return;
                if (typeof n[k] === 'string' && n[k].length > 5) {
                    referencedIds[n[k]] = true;
                }
            });
        });

        if (RED.nodes.eachConfig) {
            RED.nodes.eachConfig(function(cn) {
                // Include config nodes ONLY if they are explicitly referenced
                if (cn && (!seenIds || !seenIds[cn.id]) && referencedIds[cn.id]) {
                    configNodes.push(cn);
                    seenIds[cn.id] = true;
                }
            });
        }
        return configNodes;
    }

    /**
     * Get the ID of the currently active workspace/tab.
     */
    UI.getActiveWorkspaceId = function() {
        if (window.RED && RED.workspaces) {
            return RED.workspaces.active() || null;
        }
        return null;
    };

    /**
     * Automatically extract unique tab/workspace IDs referenced by a list of nodes.
     */
    UI.extractWorkspaceIds = function(nodes) {
        if (!Array.isArray(nodes)) return [];
        let workspaceIds = {};
        nodes.forEach(function(n) {
            if (n && n.type === 'tab' && n.id) workspaceIds[n.id] = true;
            if (n && n.z) workspaceIds[n.z] = true;
        });
        return Object.keys(workspaceIds);
    };

    /**
     * Gets the full JSON configuration for the specified tab workspaces (or the active tab if omitted),
     * including nodes, subflows, and config nodes that are referenced by nodes on these tabs.
     */
    UI.getCurrentFlow = function(flowIds) {
        let active = UI.getActiveWorkspaceId();
        let targetIds = [];
        if (flowIds && Array.isArray(flowIds) && flowIds.length > 0) {
            targetIds = flowIds;
        } else if (typeof flowIds === 'string' && flowIds.trim() !== '') {
            targetIds = [flowIds];
        } else if (active) {
            targetIds = [active];
        }
        return targetIds.length > 0 ? UI.getFlowsByIds(targetIds) : null;
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = UI;
})();
