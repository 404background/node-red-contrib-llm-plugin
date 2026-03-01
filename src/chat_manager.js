// Chat management module — vanilla JS (no jQuery).
// Uses fetch API for server communication and native DOM for UI.
(function(){
    var ChatManager = {};

    var currentChatId = null;
    var chatHistory = {};

    function generateChatId() {
        return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
            created: new Date().toISOString()
        };
        var chatArea = document.getElementById('llm-plugin-chat');
        if (chatArea) chatArea.innerHTML = '';
        if (window.RED && RED.notify) RED.notify('Started new chat', 'success');
    };

    ChatManager.saveChatToServer = function(chatId) {
        var chat = chatHistory[chatId];
        if (chat && chat.messages && chat.messages.length > 0) {
            fetch('llm-plugin/save-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: chatId, chatData: chat })
            }).catch(function(error) {
                console.error('Failed to save chat:', error);
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
                console.error('Failed to load chat histories:', error);
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
            if (chatArea) chatArea.innerHTML = '';
            (chatHistory[chatId].messages||[]).forEach(function(msg) {
                if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
                    LLMPlugin.UI.addMessageToUI(msg.content, msg.isUser, false);
                }
            });
            if (window.RED && RED.notify) RED.notify('Loaded chat: ' + chatHistory[chatId].title, 'success');
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

    ChatManager.addMessage = function(content, isUser) {
        var chatId = ChatManager.getCurrentChatId();
        var chat = chatHistory[chatId];
        chat.messages.push({
            content: content,
            isUser: isUser,
            timestamp: new Date().toISOString()
        });
        if (isUser && (chat.messages.filter(function(m) { return m.isUser; }).length === 1)) {
            chat.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        }
        ChatManager.saveChatToServer(chatId);
        if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
            return LLMPlugin.UI.addMessageToUI(content, isUser, !isUser);
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
