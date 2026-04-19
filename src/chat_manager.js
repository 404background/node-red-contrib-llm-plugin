// Chat management module — vanilla JS (no jQuery).
// Uses fetch API for server communication and native DOM for UI.
(function(){
    var ChatManager = {};

    var currentChatId = null;
    var chatHistory = {};

    function generateChatId() {
        return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    function generateMessageId() {
        return 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }

    /** Tiny DOM helper: createElement with optional className and textContent. */
    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    ChatManager.getCurrentChatId = function() {
        if (!currentChatId) {
            currentChatId = generateChatId();
            chatHistory[currentChatId] = {
                id: currentChatId,
                title: 'New Chat',
                messages: [],
                created: new Date().toISOString()
            };
        }
        return currentChatId;
    };

    ChatManager.getChatHistory = function() {
        return chatHistory;
    };

    ChatManager.startNewChat = function() {
        currentChatId = generateChatId();
        chatHistory[currentChatId] = {
            id: currentChatId,
            title: 'New Chat',
            messages: [],
            created: new Date().toISOString(),
            baselineCheckpointId: null
        };
        var chatArea = document.getElementById('llm-plugin-chat');
        while (chatArea && chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
        if (window.RED && RED.notify) RED.notify('Started new chat', 'success');
    };

    function renderBaselineCheckpointUI(checkpointId) {
        var chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea || !checkpointId) return;
        var existing = chatArea.querySelector('.baseline-checkpoint-row');
        if (existing) existing.remove();
        var row = document.createElement('div');
        row.className = 'baseline-checkpoint-row flow-actions';
        var btn = document.createElement('button');
        btn.className = 'restore-btn';
        btn.textContent = 'Restore Checkpoint';
        btn.dataset.checkpointId = checkpointId;
        btn.addEventListener('click', function() {
            if (!(window.LLMPlugin && LLMPlugin.Importer && LLMPlugin.Importer.restoreCheckpoint)) return;
            if (!confirm('Restore the flow from this checkpoint? Current flow will be replaced.')) return;
            btn.disabled = true;
            LLMPlugin.Importer.restoreCheckpoint(checkpointId)
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
                .finally(function() { btn.disabled = false; });
        });
        row.appendChild(btn);
        chatArea.insertBefore(row, chatArea.firstChild);
    }

    ChatManager.ensureBaselineCheckpoint = function(chatId, targetFlowIds) {
        var id = chatId || ChatManager.getCurrentChatId();
        var chat = chatHistory[id];
        if (!chat || chat.baselineCheckpointId || chat._baselinePending) return;
        if (!(window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.getCurrentFlow)) return;

        var flow = LLMPlugin.UI.getCurrentFlow(targetFlowIds);
        if (!Array.isArray(flow) || flow.length === 0) return;

        chat._baselinePending = true;
        fetch('llm-plugin/checkpoint/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: id,
                label: 'chat-start-pre-edit',
                flow: flow,
                meta: { source: 'chat-start' }
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data && data.checkpointId) {
                chat.baselineCheckpointId = data.checkpointId;
                ChatManager.saveChatToServer(id);
                renderBaselineCheckpointUI(data.checkpointId);
            }
        })
        .catch(function(e) {
            console.warn('[LLM Plugin] Failed to save baseline checkpoint:', e && e.message ? e.message : e);
        })
        .finally(function() {
            delete chat._baselinePending;
        });
    };

    ChatManager.getBaselineCheckpointId = function(chatId) {
        var id = chatId || ChatManager.getCurrentChatId();
        var chat = chatHistory[id];
        return chat ? (chat.baselineCheckpointId || null) : null;
    };

    /**
     * Snapshot the current flow as a Restore Checkpoint at chat-send time.
     * Returns a promise resolving to the checkpoint ID (or null on failure).
     * The ID is attached to the upcoming assistant message so the per-message
     * Restore button can rewind to the pre-send state without needing a
     * separate post-apply checkpoint.
     */
    ChatManager.savePreSendCheckpoint = function(chatId, targetFlowIds) {
        var id = chatId || ChatManager.getCurrentChatId();
        if (!(window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.getCurrentFlow)) {
            return Promise.resolve(null);
        }
        var flow = LLMPlugin.UI.getCurrentFlow(targetFlowIds);
        if (!Array.isArray(flow) || flow.length === 0) return Promise.resolve(null);

        return fetch('llm-plugin/checkpoint/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: id,
                label: 'pre-send-' + new Date().toISOString(),
                flow: flow,
                meta: { source: 'chat-send' }
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) { return (data && data.checkpointId) || null; })
        .catch(function() { return null; });
    };

    ChatManager.saveChatToServer = function(chatId) {
        var chat = chatHistory[chatId];
        if (chat) {
            fetch('llm-plugin/save-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: chatId, chatData: chat })
            }).catch(function(error) {
                if (window.RED && RED.notify) RED.notify('Failed to save chat', 'warning');
            });
        }
    };

    ChatManager.loadChatHistoriesFromServer = function() {
        return fetch('llm-plugin/chat-histories')
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data && data.chatHistories) {
                    chatHistory = data.chatHistories;
                    // If we don't already have a current chat, pick the most recent one and load it
                    if (!currentChatId) {
                        var chatsArray = Object.values(chatHistory || {});
                        if (chatsArray.length > 0) {
                            chatsArray.sort(function(a,b){ return new Date(b.created) - new Date(a.created); });
                            currentChatId = chatsArray[0].id;
                            try { ChatManager.loadChat(currentChatId); } catch(e) {}
                        }
                    }
                }
            })
            .catch(function(error) {
                if (window.RED && RED.notify) RED.notify('Failed to load chat histories', 'warning');
            });
    };

    ChatManager.showChatList = function() {
        // Remove any existing modal to avoid stacking
        document.querySelectorAll('.chat-modal').forEach(function(m) { m.remove(); });

        var chats = Object.values(chatHistory).sort(function(a, b) {
            return new Date(b.created) - new Date(a.created);
        });

        var modal        = el('div', 'chat-modal');
        var modalContent = el('div', 'chat-modal-content');

        var modalHeader  = el('div', 'modal-header');
        modalHeader.appendChild(el('h3', null, 'Chat History'));
        var closeBtn     = el('button', 'close-btn', '\u00d7');
        closeBtn.title   = 'Close';
        closeBtn.addEventListener('click', function() { modal.remove(); });
        modalHeader.appendChild(closeBtn);

        var chatList = el('div', 'chat-list');

        if (chats.length === 0) {
            chatList.appendChild(el('p', null, 'No chat history found.'));
        } else {
            chats.forEach(function(chat) {
                var chatItem = el('div', 'chat-item');
                if (chat.id === currentChatId) chatItem.classList.add('current-chat');

                var chatInfo = el('div', 'chat-info');
                chatInfo.appendChild(el('div', 'chat-title', chat.title));
                chatInfo.appendChild(el('div', 'chat-date', new Date(chat.created).toLocaleString()));
                chatInfo.appendChild(el('div', 'message-count', (chat.messages || []).length + ' messages'));

                var chatActions = el('div', 'chat-actions');
                var loadBtn = el('button', 'load-btn', 'Load');
                loadBtn.addEventListener('click', function() {
                    ChatManager.loadChat(chat.id);
                    modal.remove();
                });
                var deleteBtn = el('button', 'delete-btn', 'Delete');
                deleteBtn.addEventListener('click', function() {
                    ChatManager.deleteChat(chat.id, function(success) {
                        modal.remove();
                        if (success) ChatManager.showChatList();
                    });
                });
                chatActions.appendChild(loadBtn);
                chatActions.appendChild(deleteBtn);

                chatItem.appendChild(chatInfo);
                chatItem.appendChild(chatActions);
                chatList.appendChild(chatItem);
            });
        }

        modalContent.appendChild(modalHeader);
        modalContent.appendChild(chatList);
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
    };

    ChatManager.loadChat = function(chatId) {
        if (chatHistory[chatId]) {
            currentChatId = chatId;
            var chatArea = document.getElementById('llm-plugin-chat');
            while (chatArea && chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
            (chatHistory[chatId].messages||[]).forEach(function(msg) {
                if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
                    LLMPlugin.UI.addMessageToUI(msg.content, msg.isUser, false, msg);
                }
            });
            if (chatHistory[chatId].baselineCheckpointId) {
                renderBaselineCheckpointUI(chatHistory[chatId].baselineCheckpointId);
            }
            if (window.RED && RED.notify) RED.notify('Loaded chat: ' + chatHistory[chatId].title, 'success');
        }
    };

    ChatManager.updateMessageMeta = function(messageId, patch) {
        var chatId = ChatManager.getCurrentChatId();
        var chat = chatHistory[chatId];
        if (!chat || !chat.messages) return;
        for (var i = chat.messages.length - 1; i >= 0; i--) {
            if (chat.messages[i].id === messageId) {
                var base = chat.messages[i].meta || {};
                var next = patch || {};
                var merged = {};
                Object.keys(base).forEach(function(k) { merged[k] = base[k]; });
                Object.keys(next).forEach(function(k) { merged[k] = next[k]; });
                chat.messages[i].meta = merged;
                ChatManager.saveChatToServer(chatId);
                break;
            }
        }
    };

    ChatManager.deleteChat = function(chatId, callback) {
        if (!confirm('Delete this chat? This cannot be undone.')) {
            if (typeof callback === 'function') callback(false);
            return;
        }
        var chat = chatHistory[chatId] || {};
        var payload = {};
        if (chat.__file) payload.filename = chat.__file;
        else payload.chatId = chatId;

        fetch('llm-plugin/delete-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).finally(function() {
            delete chatHistory[chatId];
            if (currentChatId === chatId) {
                ChatManager.startNewChat();
            }
            if (typeof callback === 'function') callback(true);
        });
    };

    ChatManager.addMessage = function(content, isUser, metaOverwrite, targetFlowIds) {
        var chatId = ChatManager.getCurrentChatId();
        var chat = chatHistory[chatId];
        if (isUser) ChatManager.ensureBaselineCheckpoint(chatId, targetFlowIds);

        var message = {
            id: generateMessageId(),
            content: content,
            isUser: isUser,
            timestamp: new Date().toISOString(),
            meta: metaOverwrite || {}
        };
        chat.messages.push(message);
        if (isUser && (chat.messages.filter(function(m) { return m.isUser; }).length === 1)) {
            chat.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        }
        ChatManager.saveChatToServer(chatId);
        if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
            return LLMPlugin.UI.addMessageToUI(content, isUser, !isUser, message);
        }
        // fallback: append simple message
        var chatArea = document.getElementById('llm-plugin-chat');
        if (chatArea) {
            var msg = el('div', null, content);
            chatArea.appendChild(msg);
            chatArea.scrollTop = chatArea.scrollHeight;
        }
    };

    // expose
    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.ChatManager = ChatManager;
})();
