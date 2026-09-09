// Chat management module - vanilla JS (no jQuery).
// Uses fetch API for server communication and native DOM for UI.
(function(){
    let ChatManager = {};
    let Common = window.LLMPlugin.Common;
    let el = Common.el;

    let currentChatId = null;
    let chatHistory = {};

    function generateChatId()    { return Common.randomId('chat_'); }
    function generateMessageId() { return Common.randomId('msg_'); }

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
        // includeCanvasExtras: checkpoints must record junctions and groups
        // too, else Restore removes them from the workspace and re-imports a
        // snapshot that never had them — deleting them for good.
        let flow = LLMPlugin.UI.getCurrentFlow(targetFlowIds, { includeCanvasExtras: true });
        return (Array.isArray(flow) && flow.length > 0) ? flow : null;
    }

    /**
     * POST a flow snapshot to the checkpoint endpoint.
     * Resolves to the checkpoint ID on success, or null on any failure.
     */
    function postCheckpointSave(chatId, label, flow, source, extraMeta) {
        let meta = Object.assign({ source: source }, extraMeta || {});
        return Common.apiFetch('llm-plugin/checkpoint/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chatId: chatId,
                label: label,
                flow: flow,
                meta: meta
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
        Common.notify('Started new chat', 'success');
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

    /**
     * The same snapshot, for an edit the Agent NODE is about to apply.
     *
     * The node path used to take none at all, which made it the one way to
     * change a flow that could not be undone — worse with auto deploy, where
     * the edit reaches the running runtime without anyone looking at it.
     *
     * It is deliberately not `saveImportCheckpoint`: there is no chat here,
     * and borrowing the "current" chat id would file the node's edit under
     * whatever conversation happens to be open in the sidebar and delete it
     * when that chat is deleted. `chatId` stays null; `meta.source` is what
     * tells the two apart, and `meta.node` records which node did it.
     */
    ChatManager.saveNodeApplyCheckpoint = function(nodeInfo, targetFlowIds) {
        let flow = snapshotCurrentFlow(targetFlowIds);
        if (!flow) return Promise.resolve(null);
        let info = nodeInfo || {};
        let who = info.name || info.id || 'llm-request';
        return postCheckpointSave(
            null,
            'pre-node-apply-' + who + '-' + new Date().toISOString(),
            flow,
            'node-apply',
            {
                node: { id: info.id || null, name: info.name || null },
                targetFlowIds: Array.isArray(targetFlowIds) ? targetFlowIds : []
            }
        );
    };

    ChatManager.saveChatToServer = function(chatId) {
        let chat = chatHistory[chatId];
        if (!chat) return;
        Common.apiFetch('llm-plugin/save-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: chatId, chatData: chat })
        }).then(function(res) {
            // fetch only rejects on a transport error, so a refusal (a chat
            // past the server's 5 MB storage cap, or a permission failure)
            // used to look exactly like a successful save.
            if (res && res.ok) return;
            return res.json()
                .catch(function() { return {}; })
                .then(function(d) {
                    Common.notify('Failed to save chat: ' +
                        ((d && d.error) || ('HTTP ' + (res ? res.status : '?'))), 'warning');
                });
        }).catch(function() {
            Common.notify('Failed to save chat', 'warning');
        });
    };

    ChatManager.loadChatHistoriesFromServer = function() {
        return Common.apiFetch('llm-plugin/chat-histories')
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (!data || !data.chatHistories) return;
                // Merge: server wins for chats it knows, but keep chats
                // created locally in the meantime (still unsaved server-side)
                // — replacing wholesale would drop them mid-conversation.
                let merged = data.chatHistories;
                Object.keys(chatHistory).forEach(function(id) {
                    if (!merged[id]) merged[id] = chatHistory[id];
                });
                chatHistory = merged;
                // Auto-load the most recent chat if nothing is currently open.
                if (currentChatId) return;
                let chatsArray = Object.values(chatHistory);
                if (chatsArray.length === 0) return;
                chatsArray.sort(function(a,b){ return new Date(b.created) - new Date(a.created); });
                currentChatId = chatsArray[0].id;
                try { ChatManager.loadChat(currentChatId); } catch(e) {}
            })
            .catch(function() {
                Common.notify('Failed to load chat histories', 'warning');
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
            LLMPlugin.UI.addMessageToUI(msg.content, msg.isUser, false, msg);
        });
        Common.notify('Loaded chat: ' + chat.title, 'success');
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

        Common.apiFetch('llm-plugin/delete-chat', {
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
        // The async history reload can replace chatHistory and drop a chat
        // created locally in the meantime; recreate rather than crash.
        if (!chat) {
            chat = chatHistory[chatId] = newChatObject(chatId);
        }

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

        return LLMPlugin.UI.addMessageToUI(content, isUser, !isUser, message);
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.ChatManager = ChatManager;
})();
