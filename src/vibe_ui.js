(function(){
    function createLLMPluginUI() {
        var container = jQuery('<div>').addClass('llm-plugin-container');
        var header = jQuery('<div>').addClass('llm-plugin-header');
        var title = jQuery('<h3>').addClass('llm-plugin-title').text('LLM Plugin Chat');
        var headerButtons = jQuery('<div>').addClass('header-buttons');
        var newChatBtn = jQuery('<button>').addClass('header-btn').text('New Chat')
            .click(function() { if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.startNewChat(); });
        var chatListBtn = jQuery('<button>').addClass('header-btn').text('Chats')
            .click(function() { if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.showChatList(); });
        headerButtons.append(newChatBtn, chatListBtn);
        header.append(title, headerButtons);
        var chatArea = jQuery('<div>').addClass('llm-plugin-chat').attr('id', 'llm-plugin-chat');
        var inputArea = jQuery('<div>').addClass('llm-plugin-input');
        var flowContextOption = jQuery('<div>').addClass('flow-context-option');
        var flowContextCheckbox = jQuery('<input>').attr({
            type: 'checkbox',
            id: 'llm-plugin-include-flow',
            checked: true
        });
        var flowContextLabel = jQuery('<label>').attr('for', 'llm-plugin-include-flow').text(' Send current flow');
        flowContextOption.append(flowContextCheckbox, flowContextLabel);
        var modelInput = jQuery('<input>').attr({
            type: 'text',
            id: 'llm-plugin-model',
            placeholder: 'Model (e.g., llama3.2:latest)'
        }).addClass('model-input');
        var modelSuggestions = jQuery('<div>').addClass('model-suggestions').attr('id', 'llm-plugin-model-suggestions');
        var promptGroup = jQuery('<div>').addClass('prompt-input-group');
        var promptInput = jQuery('<textarea>').attr({
            id: 'llm-plugin-prompt',
            placeholder: 'Ask something or request a flow...'
        }).addClass('prompt-input');
        var generateBtn = jQuery('<button>').attr('id', 'llm-plugin-generate').addClass('generate-btn').text('Send');
        promptGroup.append(promptInput, generateBtn);
        inputArea.append(flowContextOption, modelInput, modelSuggestions, promptGroup);
        container.append(header, chatArea, inputArea);
        setTimeout(function() {
            initializeClientApp();
        }, 100);
        return container;
    }

    function initializeClientApp() {
        var generateBtn = jQuery('#llm-plugin-generate');
        var modelInput = jQuery('#llm-plugin-model');
        var promptInput = jQuery('#llm-plugin-prompt');
        var chatArea = jQuery('#llm-plugin-chat');
        var flowContextCheckbox = jQuery('#llm-plugin-include-flow');
        var currentRequest = null;
        if (window.LLMPlugin && LLMPlugin.ChatManager) {
            LLMPlugin.ChatManager.loadChatHistoriesFromServer().then(function() {
                console.log('Chat histories loaded from server');
            });
        }
        if (window.LLMPlugin && LLMPlugin.UI) {
            // no-op
        }
        loadRecentModels();
        function bindGenerateBtn() {
            generateBtn.off('click').on('click', function() {
                if (generateBtn.hasClass('stop-btn')) {
                    if (currentRequest) {
                        currentRequest.abort();
                        jQuery('.loading-message').remove();
                        generateBtn.prop('disabled', false).removeClass('stop-btn').html('Send');
                        currentRequest = null;
                    }
                } else {
                    handleGenerate();
                }
            });
        }
        bindGenerateBtn();
        promptInput.keypress(function(e) {
            if (e.which === 13 && e.ctrlKey) {
                handleGenerate();
            }
        });
        function loadRecentModels() {
            jQuery.get('llm-plugin/recent-models')
                .done(function(data) {
                    if (data.models && data.models.length > 0) {
                        var modelSuggestions = jQuery('#llm-plugin-model-suggestions');
                        modelSuggestions.empty();
                        data.models.forEach(function(model) {
                            var chip = jQuery('<span>').addClass('model-chip')
                                .text(model)
                                .click(function() { modelInput.val(model); });
                            modelSuggestions.append(chip);
                        });
                    }
                })
                .fail(function() {
                    console.log('Could not load recent models');
                });
        }
        function handleGenerate() {
            var model = modelInput.val().trim();
            var prompt = promptInput.val().trim();
            if (!model || !prompt) {
                if (window.RED && RED.notify) {
                    RED.notify('Please enter both model and prompt', 'warning');
                }
                return;
            }
            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.addMessage(prompt, true);
            promptInput.val('');
            var loadingMsg = (window.LLMPlugin && LLMPlugin.UI) ? LLMPlugin.UI.addMessageToUI('Generating...', false, false) : null;
            if (loadingMsg) loadingMsg.addClass('loading-message');
            generateBtn.prop('disabled', false).addClass('stop-btn').html('<i class="fa fa-stop" aria-hidden="true"></i>');
            bindGenerateBtn();
            var currentFlow = flowContextCheckbox.is(':checked') ? (window.LLMPlugin && LLMPlugin.UI ? LLMPlugin.UI.getCurrentFlow() : null) : null;
            if (currentRequest) { currentRequest.abort(); }
            currentRequest = jQuery.ajax({
                url: 'llm-plugin/generate',
                method: 'POST',
                contentType: 'application/json',
                data: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    currentFlow: currentFlow
                })
            })
            .done(function(data) {
                if (loadingMsg) loadingMsg.remove();
                // Save assistant response into chat history so it persists across restarts
                if (window.LLMPlugin && LLMPlugin.ChatManager) {
                    LLMPlugin.ChatManager.addMessage(data.response, false);
                } else if (window.LLMPlugin && LLMPlugin.UI) {
                    // fallback: just display
                    LLMPlugin.UI.addMessageToUI(data.response, false, true);
                }
            })
            .fail(function(xhr, status, error) {
                if (loadingMsg) loadingMsg.remove();
                var errorMsg = 'Request failed';
                if (xhr.responseJSON && xhr.responseJSON.error) {
                    errorMsg = xhr.responseJSON.error;
                } else if (status === 'timeout') {
                    errorMsg = 'Request timed out';
                } else if (xhr.status === 404) {
                    errorMsg = 'LLM Plugin endpoint not found. Check plugin installation.';
                } else if (status !== 'abort') {
                    errorMsg = error || 'Unknown error';
                }
                if (status !== 'abort') {
                    if (window.LLMPlugin && LLMPlugin.UI) LLMPlugin.UI.addMessageToUI('Error: ' + errorMsg, false, false);
                }
            })
            .always(function() {
                generateBtn.prop('disabled', false).removeClass('stop-btn').html('Send');
                bindGenerateBtn();
                currentRequest = null;
            });
        }
    }

    function initializeWhenReady() {
        if (typeof RED !== 'undefined' && RED.sidebar) {
            RED.sidebar.addTab({
                id: "llm-plugin-tab",
                label: "LLM Plugin",
                name: "LLM Plugin",
                content: createLLMPluginUI(),
                iconClass: "fa fa-comments",
                closeable: true,
                visible: true
            });
        } else {
            setTimeout(initializeWhenReady, 100);
        }
    }

    // expose minimal init
    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = window.LLMPlugin.UI || {};
    window.LLMPlugin.UI.createLLMPluginUI = createLLMPluginUI;
    window.LLMPlugin.initialize = initializeWhenReady;

    // Auto-init
    initializeWhenReady();

})();
