// Main sidebar UI module — vanilla JS (no jQuery).
// Builds the plugin sidebar, settings dialog, and generation workflow.
(function(){

    /**
     * Build the sidebar DOM tree and return a raw DOM element.
     * Node-RED's sidebar.addTab accepts DOM elements for its `content` property.
     */
    function createLLMPluginUI() {
        var container = document.createElement('div');
        container.className = 'llm-plugin-container';
        container.innerHTML =
            '<div class="llm-plugin-header">' +
                '<h3 class="llm-plugin-title">LLM Plugin Chat</h3>' +
                '<div class="header-buttons">' +
                    '<button class="header-btn" data-action="new-chat">New Chat</button>' +
                    '<button class="header-btn" data-action="chat-list">Chats</button>' +
                    '<button class="header-btn" id="llm-plugin-settings-button"><i class="fa fa-cog"></i></button>' +
                '</div>' +
            '</div>' +
            '<div class="llm-plugin-chat" id="llm-plugin-chat"></div>' +
            '<div class="llm-plugin-input">' +
                '<div class="flow-context-option">' +
                    '<input type="checkbox" id="llm-plugin-include-flow" checked>' +
                    '<label for="llm-plugin-include-flow"> Send current flow</label>' +
                '</div>' +
                '<div class="agent-mode-row">' +
                    '<label for="llm-plugin-mode">Mode</label>' +
                    '<select id="llm-plugin-mode" class="mode-select">' +
                        '<option value="ask" selected>Ask</option>' +
                        '<option value="agent">Agent</option>' +
                    '</select>' +
                '</div>' +
                '<input type="text" id="llm-plugin-model" class="model-input" placeholder="Model (e.g., llama3.2:latest)">' +
                '<div class="model-suggestions" id="llm-plugin-model-suggestions"></div>' +
                '<div class="prompt-input-group">' +
                    '<textarea id="llm-plugin-prompt" class="prompt-input" placeholder="Ask something or request a flow..."></textarea>' +
                    '<button id="llm-plugin-generate" class="generate-btn">Send</button>' +
                '</div>' +
            '</div>' +
            '<div id="llm-plugin-settings-overlay" class="llm-settings-overlay" role="dialog" aria-modal="true" aria-hidden="true">' +
                '<div id="llm-plugin-settings-dialog" class="llm-settings-dialog"></div>' +
            '</div>';

        // Inject settings form from the <script> template defined in llm_plugin.html
        var settingsDialog = container.querySelector('#llm-plugin-settings-dialog');
        var templateEl = document.getElementById('llm-plugin-settings-template');
        settingsDialog.innerHTML = templateEl
            ? templateEl.innerHTML
            : '<div class="llm-settings-missing">Settings template not found.</div>';
        settingsDialog.insertAdjacentHTML('beforeend',
            '<div class="llm-settings-actions">' +
                '<button type="button" id="llm-plugin-settings-cancel" class="llm-settings-btn secondary">Cancel</button>' +
                '<button type="button" id="llm-plugin-settings-save" class="llm-settings-btn primary">Save</button>' +
            '</div>');

        // Header buttons
        container.querySelector('[data-action="new-chat"]').addEventListener('click', function() {
            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.startNewChat();
        });
        container.querySelector('[data-action="chat-list"]').addEventListener('click', function() {
            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.showChatList();
        });

        // Settings manager (accepts raw DOM element after settings.js refactor)
        var settingsManager = null;
        if (window.createLLMPluginSettings) {
            settingsManager = window.createLLMPluginSettings(settingsDialog);
        } else {
            console.warn('[LLM Plugin] Settings module not loaded.');
        }

        setTimeout(function() {
            initializeClientApp(settingsManager);
        }, 100);

        return container;
    }

    /**
     * Wire up all interactive behaviour once the DOM is in place.
     * @param {Object|null} settingsManager  load/save/updateVisibility
     */
    function initializeClientApp(settingsManager) {
        var generateBtn       = document.getElementById('llm-plugin-generate');
        var modelInput        = document.getElementById('llm-plugin-model');
        var promptInput       = document.getElementById('llm-plugin-prompt');
        var chatArea          = document.getElementById('llm-plugin-chat');
        var flowCheckbox      = document.getElementById('llm-plugin-include-flow');
        var modeSelect        = document.getElementById('llm-plugin-mode');
        var settingsOverlay   = document.getElementById('llm-plugin-settings-overlay');
        var settingsDialog    = document.getElementById('llm-plugin-settings-dialog');
        var openSettingsBtn   = document.getElementById('llm-plugin-settings-button');
        var saveSettingsBtn   = document.getElementById('llm-plugin-settings-save');
        var cancelSettingsBtn = document.getElementById('llm-plugin-settings-cancel');

        var currentAbortController = null;
        var cachedSettings = null;
        var settingsSaving = false;
        var lastFocusedBeforeSettings = null;

        // --- Chat history bootstrap ---
        if (window.LLMPlugin && LLMPlugin.ChatManager) {
            LLMPlugin.ChatManager.loadChatHistoriesFromServer();
        }

        // --- Settings helpers ---
        function fetchSettings(force) {
            if (!force && cachedSettings) return Promise.resolve(cachedSettings);
            return fetch('llm-plugin/settings')
                .then(function(res) { return res.json(); })
                .then(function(data) { cachedSettings = data || {}; return cachedSettings; })
                .catch(function()    { cachedSettings = cachedSettings || {}; return cachedSettings; });
        }

        function openSettingsDialog() {
            lastFocusedBeforeSettings = document.activeElement;
            fetchSettings().then(function(settings) {
                if (settingsManager && settingsManager.load) settingsManager.load(settings);
                settingsOverlay.classList.add('visible');
                settingsOverlay.setAttribute('aria-hidden', 'false');
                settingsDialog.setAttribute('tabindex', '-1');
                settingsDialog.focus();
                // Focus first visible input
                var fields = settingsDialog.querySelectorAll('select, input');
                for (var i = 0; i < fields.length; i++) {
                    if (fields[i].offsetParent !== null) {
                        (function(f) { setTimeout(function() { f.focus(); }, 30); })(fields[i]);
                        break;
                    }
                }
            });
        }

        function closeSettingsDialog() {
            settingsOverlay.classList.remove('visible');
            settingsOverlay.setAttribute('aria-hidden', 'true');
            settingsDialog.removeAttribute('tabindex');
            if (lastFocusedBeforeSettings && typeof lastFocusedBeforeSettings.focus === 'function') {
                setTimeout(function() { lastFocusedBeforeSettings.focus(); }, 30);
            }
        }

        openSettingsBtn.addEventListener('click', openSettingsDialog);
        cancelSettingsBtn.addEventListener('click', closeSettingsDialog);
        settingsOverlay.addEventListener('click', function(e) {
            if (e.target === settingsOverlay) closeSettingsDialog();
        });
        settingsDialog.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') { e.preventDefault(); closeSettingsDialog(); }
        });

        saveSettingsBtn.addEventListener('click', function() {
            if (!settingsManager || settingsSaving) return;
            var settings = settingsManager.save();
            settingsSaving = true;
            saveSettingsBtn.disabled = true;
            saveSettingsBtn.classList.add('saving');
            fetch('llm-plugin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            })
            .then(function(res) {
                if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Failed to save settings'); });
                cachedSettings = null;
                if (window.RED && RED.notify) RED.notify('LLM Plugin settings saved.', 'success');
                closeSettingsDialog();
            })
            .catch(function(err) {
                if (window.RED && RED.notify) RED.notify(err.message || 'Failed to save settings', 'error');
            })
            .finally(function() {
                settingsSaving = false;
                saveSettingsBtn.disabled = false;
                saveSettingsBtn.classList.remove('saving');
            });
        });

        // --- Initial data fetch ---
        fetchSettings();
        loadRecentModels();

        // --- Generate / Stop toggle (single handler) ---
        generateBtn.addEventListener('click', function() {
            if (generateBtn.classList.contains('stop-btn')) {
                if (currentAbortController) {
                    currentAbortController.abort();
                    var loadingMsg = chatArea.querySelector('.loading-message');
                    if (loadingMsg) loadingMsg.remove();
                    resetGenerateBtn();
                    currentAbortController = null;
                }
            } else {
                handleGenerate();
            }
        });

        promptInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && e.ctrlKey) handleGenerate();
        });

        function resetGenerateBtn() {
            generateBtn.disabled = false;
            generateBtn.classList.remove('stop-btn');
            generateBtn.textContent = 'Send';
        }

        // --- Model suggestions ---
        function loadRecentModels() {
            fetch('llm-plugin/recent-models')
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    if (data.models && data.models.length > 0) {
                        var container = document.getElementById('llm-plugin-model-suggestions');
                        while (container.firstChild) container.removeChild(container.firstChild);
                        data.models.forEach(function(model) {
                            var chip = document.createElement('span');
                            chip.className = 'model-chip';
                            chip.textContent = model;
                            chip.addEventListener('click', function() { modelInput.value = model; });
                            container.appendChild(chip);
                        });
                    }
                })
                .catch(function() {});
        }

        // --- Core generation flow ---
        function handleGenerate() {
            var model  = modelInput.value.trim();
            var prompt = promptInput.value.trim();
            var mode = (modeSelect && modeSelect.value) ? modeSelect.value : 'ask';
            if (!model || !prompt) {
                if (window.RED && RED.notify) RED.notify('Please enter both model and prompt', 'warning');
                return;
            }

            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.addMessage(prompt, true);
            promptInput.value = '';

            var loadingMsg = (window.LLMPlugin && LLMPlugin.UI)
                ? LLMPlugin.UI.addMessageToUI('Generating...', false, false)
                : null;
            if (loadingMsg) loadingMsg.classList.add('loading-message');

            generateBtn.disabled = false;
            generateBtn.classList.add('stop-btn');
            generateBtn.innerHTML = '<i class="fa fa-stop" aria-hidden="true"></i>';

            var currentFlow = flowCheckbox.checked
                ? (window.LLMPlugin && LLMPlugin.UI ? LLMPlugin.UI.getCurrentFlow() : null)
                : null;

            if (currentAbortController) currentAbortController.abort();
            currentAbortController = new AbortController();

            var endpoint = mode === 'agent' ? 'llm-plugin/agent-generate' : 'llm-plugin/generate';
            var fetchStart = Date.now();

            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    currentFlow: currentFlow,
                    mode: mode
                }),
                signal: currentAbortController.signal
            })
            .then(function(res) {
                if (!res.ok) {
                    return res.json()
                        .catch(function() { return { error: 'Request failed (' + res.status + ')' }; })
                        .then(function(d) {
                            var err = new Error(d.error || 'Request failed');
                            err.status = res.status;
                            throw err;
                        });
                }
                return res.json();
            })
            .then(function(data) {
                if (loadingMsg) loadingMsg.remove();
                var totalElapsed = (data.elapsed != null) ? data.elapsed : (Date.now() - fetchStart);
                var msgEl = null;
                var resolvedApplyMode = data && data.applyMode ? data.applyMode : 'auto';
                var usedModel = (data && data.model) ? data.model : model;
                var metaOpts = { mode: mode, applyMode: resolvedApplyMode, elapsedMs: totalElapsed, model: usedModel };
                if (window.LLMPlugin && LLMPlugin.ChatManager) {
                    msgEl = LLMPlugin.ChatManager.addMessage(data.response, false, metaOpts);
                } else if (window.LLMPlugin && LLMPlugin.UI) {
                    msgEl = LLMPlugin.UI.addMessageToUI(data.response, false, true, { meta: metaOpts });
                }
                
                if (mode === 'agent' && msgEl) {
                    var importBtn = msgEl.querySelector('.import-btn');
                    if (importBtn) {
                        importBtn.click();
                    }
                }
            })
            .catch(function(err) {
                if (loadingMsg) loadingMsg.remove();
                if (err && err.name === 'AbortError') return; // user cancelled
                var errorMsg = 'Request failed';
                if (err && err.message) {
                    errorMsg = err.message;
                }
                if (err && err.status === 404) {
                    errorMsg = 'LLM Plugin endpoint not found. Check plugin installation.';
                }
                if (window.LLMPlugin && LLMPlugin.UI) LLMPlugin.UI.addMessageToUI('Error: ' + errorMsg, false, false);
            })
            .finally(function() {
                resetGenerateBtn();
                currentAbortController = null;
            });
        }
    }

    // --- Sidebar registration ---
    function initializeWhenReady() {
        if (typeof RED !== 'undefined' && RED.sidebar) {
            // Wire runtime type info into FlowConverterCore so community
            // nodes are handled correctly (config detection, input checks).
            var cfg = window.LLMPlugin && window.LLMPlugin.Configurator;
            if (cfg && typeof cfg.setRuntimeGetType === 'function' &&
                RED.nodes && typeof RED.nodes.getType === 'function') {
                cfg.setRuntimeGetType(function(type) {
                    try { return RED.nodes.getType(type) || null; } catch(e) { return null; }
                });
            }
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

    // Expose minimal surface
    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = window.LLMPlugin.UI || {};
    window.LLMPlugin.UI.createLLMPluginUI = createLLMPluginUI;
    window.LLMPlugin.initialize = initializeWhenReady;

    // Auto-init
    initializeWhenReady();

})();
