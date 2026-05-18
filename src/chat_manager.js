// Chat management module - vanilla JS (no jQuery).
// Uses fetch API for server communication and native DOM for UI.
(function(){
    let ChatManager = {};

    let currentChatId = null;
    let chatHistory = {};

    function randomSuffix() {
        return Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    }
    function generateChatId()    { return 'chat_' + randomSuffix(); }
    function generateMessageId() { return 'msg_'  + randomSuffix(); }

    /** Tiny DOM helper: createElement with optional className and textContent. */
    function el(tag, className, text) {
        let node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function newChatObject(id) {
        return {
            id: id,
            title: 'New Chat',
            messages: [],
            created: new Date().toISOString()
        };
    }

    function clearChatArea() {
        let chatArea = document.getElementById('llm-plugin-chat');
        while (chatArea && chatArea.firstChild) chatArea.removeChild(chatArea.firstChild);
    }

    function snapshotCurrentFlow(targetFlowIds) {
        if (!(window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.getCurrentFlow)) return null;
        let flow = LLMPlugin.UI.getCurrentFlow(targetFlowIds);
        return (Array.isArray(flow) && flow.length > 0) ? flow : null;
    }

    /**
     * POST a flow snapshot to the checkpoint endpoint.
     * Resolves to the checkpoint ID on success, or null on any failure.
     */
    function postCheckpointSave(chatId, label, flow, source) {
        return fetch('llm-plugin/checkpoint/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: chatId,
                label: label,
                flow: flow,
                meta: { source: source }
            })
        })
        .then(function(res) { return res.json(); })
        .then(function(data) { return (data && data.checkpointId) || null; })
        .catch(function() { return null; });
    }

    ChatManager.getCurrentChatId = function() {
        if (!currentChatId) {
            currentChatId = generateChatId();
            chatHistory[currentChatId] = newChatObject(currentChatId);
        }
        return currentChatId;
    };

    ChatManager.getChatHistory = function() {
        return chatHistory;
    };

    ChatManager.startNewChat = function() {
        currentChatId = generateChatId();
        chatHistory[currentChatId] = newChatObject(currentChatId);
        clearChatArea();
        if (window.RED && RED.notify) RED.notify('Started new chat', 'success');
    };

    /**
     * Snapshot the current flow as a Restore Checkpoint immediately before
     * a flow-modifying import. Returns the checkpoint ID on success, or
     * null on failure. Callers wait on this before applying the import so
     * the Restore button always points at the true pre-edit state.
     */
    ChatManager.saveImportCheckpoint = function(chatId, targetFlowIds) {
        let id = chatId || ChatManager.getCurrentChatId();
        let flow = snapshotCurrentFlow(targetFlowIds);
        if (!flow) return Promise.resolve(null);
        return postCheckpointSave(id, 'pre-import-' + new Date().toISOString(), flow, 'pre-import');
    };

    ChatManager.saveChatToServer = function(chatId) {
        let chat = chatHistory[chatId];
        if (!chat) return;
        fetch('llm-plugin/save-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: chatId, chatData: chat })
        }).catch(function() {
            if (window.RED && RED.notify) RED.notify('Failed to save chat', 'warning');
        });
    };

    ChatManager.loadChatHistoriesFromServer = function() {
        return fetch('llm-plugin/chat-histories')
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data || !data.chatHistories) return;
                chatHistory = data.chatHistories;
                // Auto-load the most recent chat if nothing is currently open.
                if (currentChatId) return;
                let chatsArray = Object.values(chatHistory);
                if (chatsArray.length === 0) return;
                chatsArray.sort(function(a,b){ return new Date(b.created) - new Date(a.created); });
                currentChatId = chatsArray[0].id;
                try { ChatManager.loadChat(currentChatId); } catch(e) {}
            })
            .catch(function() {
                if (window.RED && RED.notify) RED.notify('Failed to load chat histories', 'warning');
            });
    };

    ChatManager.showChatList = function() {
        // Remove any existing modal to avoid stacking
        document.querySelectorAll('.chat-modal').forEach(function(m) { m.remove(); });

        let chats = Object.values(chatHistory).sort(function(a, b) {
            return new Date(b.created) - new Date(a.created);
        });

        let modal        = el('div', 'chat-modal');
        let modalContent = el('div', 'chat-modal-content');

        let modalHeader  = el('div', 'modal-header');
        modalHeader.appendChild(el('h3', null, 'Chat History'));
        let closeBtn     = el('button', 'close-btn', '×');
        closeBtn.title   = 'Close';
        closeBtn.addEventListener('click', function() { modal.remove(); });
        modalHeader.appendChild(closeBtn);

        let chatList = el('div', 'chat-list');

        if (chats.length === 0) {
            chatList.appendChild(el('p', null, 'No chat history found.'));
        } else {
            chats.forEach(function(chat) {
                let chatItem = el('div', 'chat-item');
                if (chat.id === currentChatId) chatItem.classList.add('current-chat');

                let chatInfo = el('div', 'chat-info');
                chatInfo.appendChild(el('div', 'chat-title', chat.title));
                chatInfo.appendChild(el('div', 'chat-date', new Date(chat.created).toLocaleString()));
                chatInfo.appendChild(el('div', 'message-count', (chat.messages || []).length + ' messages'));

                let chatActions = el('div', 'chat-actions');
                let loadBtn = el('button', 'load-btn', 'Load');
                loadBtn.addEventListener('click', function() {
                    ChatManager.loadChat(chat.id);
                    modal.remove();
                });
                let deleteBtn = el('button', 'delete-btn', 'Delete');
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
        let chat = chatHistory[chatId];
        if (!chat) return;
        currentChatId = chatId;
        clearChatArea();
        (chat.messages || []).forEach(function(msg) {
            if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
                LLMPlugin.UI.addMessageToUI(msg.content, msg.isUser, false, msg);
            }
        });
        if (window.RED && RED.notify) RED.notify('Loaded chat: ' + chat.title, 'success');
    };

    ChatManager.updateMessageMeta = function(messageId, patch) {
        let chatId = ChatManager.getCurrentChatId();
        let chat = chatHistory[chatId];
        if (!chat || !chat.messages) return;
        for (let i = chat.messages.length - 1; i >= 0; i--) {
            if (chat.messages[i].id !== messageId) continue;
            chat.messages[i].meta = Object.assign({}, chat.messages[i].meta || {}, patch || {});
            ChatManager.saveChatToServer(chatId);
            return;
        }
    };

    ChatManager.deleteChat = function(chatId, callback) {
        if (!confirm('Delete this chat? This cannot be undone.')) {
            if (typeof callback === 'function') callback(false);
            return;
        }
        let chat = chatHistory[chatId] || {};
        let payload = chat.__file ? { filename: chat.__file } : { chatId: chatId };

        fetch('llm-plugin/delete-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).finally(function() {
            delete chatHistory[chatId];
            if (currentChatId === chatId) ChatManager.startNewChat();
            if (typeof callback === 'function') callback(true);
        });
    };

    ChatManager.addMessage = function(content, isUser, metaOverwrite) {
        let chatId = ChatManager.getCurrentChatId();
        let chat = chatHistory[chatId];

        let message = {
            id: generateMessageId(),
            content: content,
            isUser: isUser,
            timestamp: new Date().toISOString(),
            meta: metaOverwrite || {}
        };
        chat.messages.push(message);

        // Title = first user message (truncated)
        if (isUser && chat.messages.filter(function(m) { return m.isUser; }).length === 1) {
            chat.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        }
        ChatManager.saveChatToServer(chatId);

        if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
            return LLMPlugin.UI.addMessageToUI(content, isUser, !isUser, message);
        }
        // Fallback when UI module is unavailable
        let chatArea = document.getElementById('llm-plugin-chat');
        if (chatArea) {
            chatArea.appendChild(el('div', null, content));
            chatArea.scrollTop = chatArea.scrollHeight;
        }
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.ChatManager = ChatManager;
})();
