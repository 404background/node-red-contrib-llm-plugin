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
    function postCheckpointSave(chatId, label, flow, source) {
        let meta = { source: source };
        return Common.apiFetch('llm-plugin/checkpoints/save', {
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

    // The sidebar's flow selection belongs to the conversation too, and
    // lives outside this module — hence announce rather than reach.
    let newChatListeners = [];
    ChatManager.onNewChat = function(fn) {
        if (typeof fn === 'function') newChatListeners.push(fn);
    };

    ChatManager.startNewChat = function() {
        currentChatId = generateChatId();
        chatHistory[currentChatId] = newChatObject(currentChatId);
        clearChatArea();
        newChatListeners.forEach(function(fn) {
            // One bad listener must not leave the chat half-started.
            try { fn(currentChatId); } catch (e) { /* ignore */ }
        });
    };

    // A Restore Checkpoint taken immediately before a flow-modifying import.
    // The checkpoint id, or null on failure.
    ChatManager.saveImportCheckpoint = function(chatId, targetFlowIds) {
        let id = chatId || ChatManager.getCurrentChatId();
        let flow = snapshotCurrentFlow(targetFlowIds);
        if (!flow) return Promise.resolve(null);
        return postCheckpointSave(id, 'pre-import-' + new Date().toISOString(), flow, 'pre-import');
    };

    ChatManager.saveChatToServer = function(chatId) {
        let chat = chatHistory[chatId];
        if (!chat) return;
        Common.apiFetch('llm-plugin/chats/save', {
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
                    Common.notice('Failed to save chat: ' +
                        ((d && d.error) || ('HTTP ' + (res ? res.status : '?'))), 'warning');
                });
        }).catch(function() {
            Common.notice('Failed to save chat', 'warning');
        });
    };

    ChatManager.loadChatHistoriesFromServer = function() {
        return Common.apiFetch('llm-plugin/chats')
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
                Common.notice('Failed to load chat histories', 'warning');
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

        // Tick chats, or All, then Delete.
        let toolbar = el('div', 'chat-list-toolbar');
        let allLabel = el('label', 'chat-select-all');
        let allBox = el('input');
        allBox.type = 'checkbox';
        allLabel.appendChild(allBox);
        allLabel.appendChild(document.createTextNode(' All'));
        let deleteSelectedBtn = el('button', 'delete-btn', 'Delete');
        toolbar.appendChild(allLabel);
        toolbar.appendChild(deleteSelectedBtn);

        let boxes = [];
        function selectedIds() {
            return boxes.filter(function(b) { return b.checked; }).map(function(b) { return b.value; });
        }
        function syncToolbar() {
            let n = selectedIds().length;
            allBox.checked = boxes.length > 0 && n === boxes.length;
            allBox.indeterminate = n > 0 && n < boxes.length;
            deleteSelectedBtn.disabled = n === 0;
        }
        allBox.addEventListener('change', function() {
            boxes.forEach(function(b) { b.checked = allBox.checked; });
            syncToolbar();
        });
        deleteSelectedBtn.addEventListener('click', function() {
            ChatManager.deleteChats(selectedIds(), function(success) {
                if (!success) return;
                modal.remove();
                ChatManager.showChatList();
            });
        });

        if (chats.length === 0) {
            chatList.appendChild(el('p', null, 'No chat history found.'));
        } else {
            chats.forEach(function(chat) {
                let chatItem = el('div', 'chat-item');
                if (chat.id === currentChatId) chatItem.classList.add('current-chat');

                let box = el('input', 'chat-select');
                box.type = 'checkbox';
                box.value = chat.id;
                box.addEventListener('change', syncToolbar);
                boxes.push(box);
                chatItem.appendChild(box);

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
                chatActions.appendChild(loadBtn);

                chatItem.appendChild(chatInfo);
                chatItem.appendChild(chatActions);
                chatList.appendChild(chatItem);
            });
        }

        modalContent.appendChild(modalHeader);
        if (chats.length > 0) modalContent.appendChild(toolbar);
        modalContent.appendChild(chatList);
        syncToolbar();
        modal.appendChild(modalContent);
        document.body.appendChild(modal);
    };

    ChatManager.loadChat = function(chatId) {
        let chat = chatHistory[chatId];
        if (!chat) return;
        currentChatId = chatId;
        clearChatArea();
        (chat.messages || []).forEach(function(msg) {
            LLMPlugin.UI.addMessageToUI(msg.content, msg.isUser, msg);
        });
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

    // One confirmation for the whole selection.
    ChatManager.deleteChats = function(chatIds, callback) {
        let ids = (chatIds || []).filter(function(id) { return !!chatHistory[id]; });
        let done = function(ok) { if (typeof callback === 'function') callback(ok); };
        if (ids.length === 0) return done(false);
        let question = ids.length === 1
            ? 'Delete this chat? This cannot be undone.'
            : 'Delete ' + ids.length + ' chats? This cannot be undone.';
        if (!confirm(question)) return done(false);
        Promise.all(ids.map(function(id) {
            return Common.apiFetch('llm-plugin/chats/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: id })
            }).catch(function() { /* the local copy goes regardless */ });
        })).then(function() {
            ids.forEach(function(id) { delete chatHistory[id]; });
            if (ids.indexOf(currentChatId) !== -1) ChatManager.startNewChat();
            done(true);
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

        return LLMPlugin.UI.addMessageToUI(content, isUser, message);
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.ChatManager = ChatManager;
})();
