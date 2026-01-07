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
        var settingsBtn = jQuery('<button>').addClass('header-btn').attr('id', 'llm-plugin-settings-button').html('<i class="fa fa-cog"></i>');
        headerButtons.append(newChatBtn, chatListBtn, settingsBtn);
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
        var settingsOverlay = jQuery('<div>').attr({
            id: 'llm-plugin-settings-overlay',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-hidden': 'true'
        }).addClass('llm-settings-overlay');
        var settingsDialog = jQuery('<div>').attr('id', 'llm-plugin-settings-dialog').addClass('llm-settings-dialog');
        var settingsTemplate = jQuery('#llm-plugin-settings-template').html();
        if (!settingsTemplate) {
            settingsTemplate = '<div class="llm-settings-missing">Settings template not found.</div>';
        }
        settingsDialog.append(settingsTemplate);
        var settingsActions = jQuery('<div>').addClass('llm-settings-actions');
        var cancelSettingsBtn = jQuery('<button>').attr({
            type: 'button',
            id: 'llm-plugin-settings-cancel'
        }).addClass('llm-settings-btn secondary').text('Cancel');
        var saveSettingsBtn = jQuery('<button>').attr({
            type: 'button',
            id: 'llm-plugin-settings-save'
        }).addClass('llm-settings-btn primary').text('Save');
        settingsActions.append(cancelSettingsBtn, saveSettingsBtn);
        settingsDialog.append(settingsActions);
        settingsOverlay.append(settingsDialog);
        container.append(header, chatArea, inputArea, settingsOverlay);

        var settingsManager = null;
        if (window.createLLMPluginSettings) {
            settingsManager = window.createLLMPluginSettings(settingsDialog);
        } else {
            console.warn('[LLM Plugin] Settings module not loaded.');
        }
        settingsDialog.data('settingsManager', settingsManager);
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

        var settingsOverlay = jQuery('#llm-plugin-settings-overlay');
        var settingsDialog = jQuery('#llm-plugin-settings-dialog');
        var openSettingsBtn = jQuery('#llm-plugin-settings-button');
        var saveSettingsBtn = jQuery('#llm-plugin-settings-save');
        var cancelSettingsBtn = jQuery('#llm-plugin-settings-cancel');
        var settingsManager = settingsDialog.data('settingsManager');
    var cachedSettings = null;
    var settingsSaving = false;
    var lastFocusedBeforeSettings = null;

        function fetchSettings(force) {
            if (!force && cachedSettings) {
                return Promise.resolve(cachedSettings);
            }
            return new Promise(function(resolve) {
                jQuery.getJSON('llm-plugin/settings')
                    .done(function(data) {
                        cachedSettings = data || {};
                        resolve(cachedSettings);
                    })
                    .fail(function() {
                        cachedSettings = cachedSettings || {};
                        resolve(cachedSettings);
                    });
            });
        }

        function openSettingsDialog() {
            lastFocusedBeforeSettings = document.activeElement;
            fetchSettings().then(function(settings) {
                if (settingsManager && settingsManager.load) {
                    settingsManager.load(settings);
                }
                settingsOverlay.addClass('visible').attr('aria-hidden', 'false');
                settingsDialog.attr('tabindex', '-1').focus();
                var firstField = settingsDialog.find('select, input').filter(':visible').first();
                if (firstField.length) {
                    setTimeout(function() {
                        firstField.trigger('focus');
                    }, 30);
                }
            });
        }

        function closeSettingsDialog() {
            settingsOverlay.removeClass('visible').attr('aria-hidden', 'true');
            settingsDialog.removeAttr('tabindex');
            if (lastFocusedBeforeSettings && typeof lastFocusedBeforeSettings.focus === 'function') {
                setTimeout(function() {
                    lastFocusedBeforeSettings.focus();
                }, 30);
            }
        }

        openSettingsBtn.off('click').on('click', function() {
            openSettingsDialog();
        });

        cancelSettingsBtn.off('click').on('click', function() {
            closeSettingsDialog();
        });

        settingsOverlay.off('click').on('click', function(event) {
            if (event.target === this) {
                closeSettingsDialog();
            }
        });

        settingsDialog.off('keydown').on('keydown', function(event) {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeSettingsDialog();
            }
        });

        saveSettingsBtn.off('click').on('click', function() {
            if (!settingsManager || settingsSaving) {
                return;
            }
            var settings = settingsManager.save();
            settingsSaving = true;
            saveSettingsBtn.prop('disabled', true).addClass('saving');
            jQuery.ajax({
                url: 'llm-plugin/settings',
                type: 'POST',
                contentType: 'application/json',
                data: JSON.stringify(settings)
            })
            .done(function() {
                cachedSettings = settings;
                if (window.RED && RED.notify) {
                    RED.notify('LLM Plugin settings saved.', 'success');
                }
                closeSettingsDialog();
            })
            .fail(function(xhr) {
                var msg = (xhr.responseJSON && xhr.responseJSON.error) || 'Failed to save settings';
                if (window.RED && RED.notify) {
                    RED.notify(msg, 'error');
                }
            })
            .always(function() {
                settingsSaving = false;
                saveSettingsBtn.prop('disabled', false).removeClass('saving');
            });
        });

        fetchSettings();
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
