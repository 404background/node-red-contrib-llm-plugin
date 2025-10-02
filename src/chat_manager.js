(function(){
    // Chat management module
    var ChatManager = {};

    var currentChatId = null;
    var chatHistory = {};

    function generateChatId() {
        return 'chat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
        var chatArea = jQuery('#llm-plugin-chat');
        if (chatArea && chatArea.length) chatArea.empty();
        if (window.RED && RED.notify) RED.notify('Started new chat', 'success');
    };

    ChatManager.saveChatToServer = function(chatId) {
        var chat = chatHistory[chatId];
        if (chat && chat.messages && chat.messages.length > 0) {
            jQuery.ajax({
                url: 'llm-plugin/save-chat',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({
                    chatId: chatId,
                    chatData: chat
                })
            }).fail(function(error) {
                console.error('Failed to save chat:', error);
            });
        }
    };

    ChatManager.loadChatHistoriesFromServer = function() {
        return jQuery.get('llm-plugin/chat-histories')
            .done(function(data) {
                if (data && data.chatHistories) {
                    chatHistory = data.chatHistories;
                    // If we don't already have a current chat, pick the most recent one and load it
                    if (!currentChatId) {
                        var chatsArray = Object.values(chatHistory || {});
                        if (chatsArray.length > 0) {
                            chatsArray.sort(function(a,b){ return new Date(b.created) - new Date(a.created); });
                            currentChatId = chatsArray[0].id;
                            // load into UI
                            try { ChatManager.loadChat(currentChatId); } catch(e) {}
                        }
                    }
                }
            })
            .fail(function(error) {
                console.error('Failed to load chat histories:', error);
            });
    };

    ChatManager.showChatList = function() {
        // Remove any existing modal to avoid stacking multiple modals
        jQuery('.chat-modal').remove();

        var chats = Object.values(chatHistory).sort((a, b) => new Date(b.created) - new Date(a.created));
        var modal = jQuery('<div>').addClass('chat-modal');
        var modalContent = jQuery('<div>').addClass('chat-modal-content');
        var modalHeader = jQuery('<div>').addClass('modal-header');
        var modalTitle = jQuery('<h3>').text('Chat History');
        var closeBtn = jQuery('<button>').addClass('close-btn').text('×')
            .attr('title', 'Close')
            .click(function() { modal.remove(); });
        modalHeader.append(modalTitle, closeBtn);
        var chatList = jQuery('<div>').addClass('chat-list');
        if (chats.length === 0) {
            chatList.append(jQuery('<p>').text('No chat history found.'));
        } else {
            chats.forEach(function(chat) {
                var chatItem = jQuery('<div>').addClass('chat-item');
                if (chat.id === currentChatId) chatItem.addClass('current-chat');
                var chatInfo = jQuery('<div>').addClass('chat-info');
                var chatTitle = jQuery('<div>').addClass('chat-title').text(chat.title);
                var chatDate = jQuery('<div>').addClass('chat-date').text(new Date(chat.created).toLocaleString());
                var messageCount = jQuery('<div>').addClass('message-count').text((chat.messages||[]).length + ' messages');
                chatInfo.append(chatTitle, chatDate, messageCount);
                var chatActions = jQuery('<div>').addClass('chat-actions');
                var loadBtn = jQuery('<button>').addClass('load-btn').text('Load')
                    .click(function() { ChatManager.loadChat(chat.id); modal.remove(); });
                var deleteBtn = jQuery('<button>').addClass('delete-btn').text('Delete')
                    .click(function() {
                        // Use deleteChat with a callback so we can refresh safely
                        ChatManager.deleteChat(chat.id, function(success) {
                            // Remove current modal first to avoid stacking
                            modal.remove();
                            if (success) {
                                // Re-open refreshed list
                                ChatManager.showChatList();
                            }
                        });
                    });
                chatActions.append(loadBtn, deleteBtn);
                chatItem.append(chatInfo, chatActions);
                chatList.append(chatItem);
            });
        }
        modalContent.append(modalHeader, chatList);
        modal.append(modalContent);
        jQuery('body').append(modal);
    };

    ChatManager.loadChat = function(chatId) {
        if (chatHistory[chatId]) {
            currentChatId = chatId;
            var chatArea = jQuery('#llm-plugin-chat');
            if (chatArea && chatArea.length) chatArea.empty();
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
        // Prefer to send the server-side filename (if available) to the delete endpoint
        var chat = chatHistory[chatId] || {};
        var payload = {};
        if (chat.__file) payload.filename = chat.__file;
        else payload.chatId = chatId; // fallback for older servers

        jQuery.ajax({
            url: 'llm-plugin/delete-chat',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify(payload)
        }).always(function() {
            // Update client-side state and UI regardless of server result to stay consistent
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
        if (isUser && (chat.messages.filter(m => m.isUser).length === 1)) {
            chat.title = content.substring(0, 50) + (content.length > 50 ? '...' : '');
        }
        ChatManager.saveChatToServer(chatId);
        if (window.LLMPlugin && LLMPlugin.UI && LLMPlugin.UI.addMessageToUI) {
            // Show retry button for assistant messages (isUser = false)
            return LLMPlugin.UI.addMessageToUI(content, isUser, !isUser);
        }
        // fallback: append simple message
        var chatArea = jQuery('#llm-plugin-chat');
        if (chatArea && chatArea.length) {
            var msg = jQuery('<div>').text(content);
            chatArea.append(msg);
            chatArea.scrollTop(chatArea[0].scrollHeight);
        }
    };

    // expose
    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.ChatManager = ChatManager;
})();
