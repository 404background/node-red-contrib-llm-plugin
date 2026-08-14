// Main sidebar UI module — vanilla JS (no jQuery).
// Builds the plugin sidebar, settings dialog, and generation workflow.
(function(){
    let Common = window.LLMPlugin.Common;

    /**
     * Build the sidebar DOM from the templates in llm_plugin.html.
     * Node-RED's sidebar.addTab accepts DOM elements for its `content` property.
     */
    function fromTemplate(el, templateId, missingText) {
        let tpl = document.getElementById(templateId);
        el.innerHTML = tpl ? tpl.innerHTML
            : '<div class="llm-settings-missing">' + missingText + '</div>';
    }

    function createLLMPluginUI() {
        let container = document.createElement('div');
        container.className = 'llm-plugin-container';
        fromTemplate(container, 'llm-plugin-sidebar-template', 'Sidebar template not found.');

        let settingsDialog = container.querySelector('#llm-plugin-settings-dialog');
        if (settingsDialog) {
            fromTemplate(settingsDialog, 'llm-plugin-settings-template', 'Settings template not found.');
        }

        // Header buttons
        container.querySelector('[data-action="new-chat"]').addEventListener('click', function() {
            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.startNewChat();
        });
        container.querySelector('[data-action="chat-list"]').addEventListener('click', function() {
            if (window.LLMPlugin && LLMPlugin.ChatManager) LLMPlugin.ChatManager.showChatList();
        });

        // Settings manager (dialog controller defined in client.js)
        let settingsManager = null;
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
     * @param {Object|null} settingsManager  load/save
     */
    function initializeClientApp(settingsManager) {
        let generateBtn       = document.getElementById('llm-plugin-generate');
        let modelInput        = document.getElementById('llm-plugin-model');
        // Restore last used model from localStorage
        try {
            let lastModel = localStorage.getItem('llm-plugin-last-model');
            if (lastModel) {
                modelInput.value = lastModel;
            }
        } catch (e) { /* ignore localStorage errors */ }
        let promptInput       = document.getElementById('llm-plugin-prompt');
        let chatArea          = document.getElementById('llm-plugin-chat');
        let flowSelector      = document.getElementById('llm-plugin-flow-selector');
        let flowToggleBtn     = document.getElementById('llm-plugin-flow-toggle');
        let flowPanel         = document.getElementById('llm-plugin-flow-panel');
        let flowLabel         = document.getElementById('llm-plugin-flow-label');
        let modeSelect        = document.getElementById('llm-plugin-mode');
        // Restore last used mode from localStorage (only if it matches one of the
        // current <option> values, so stale entries can't put the dropdown into
        // an invalid state).
        try {
            let lastMode = localStorage.getItem('llm-plugin-last-mode');
            if (lastMode && modeSelect) {
                for (let i = 0; i < modeSelect.options.length; i++) {
                    if (modeSelect.options[i].value === lastMode) {
                        modeSelect.value = lastMode;
                        break;
                    }
                }
            }
        } catch (e) { /* ignore localStorage errors */ }
        let settingsOverlay   = document.getElementById('llm-plugin-settings-overlay');
        let settingsDialog    = document.getElementById('llm-plugin-settings-dialog');
        let openSettingsBtn   = document.getElementById('llm-plugin-settings-button');
        let saveSettingsBtn   = document.getElementById('llm-plugin-settings-save');
        let cancelSettingsBtn = document.getElementById('llm-plugin-settings-cancel');

        let currentAbortController = null;
        let cachedSettings = null;
        let settingsSaving = false;
        let lastFocusedBeforeSettings = null;
        // Selected workspace IDs to send as flow context. Initialized lazily to
        // the active tab on first use so the "Current Open Flow" default works
        // even before RED is fully ready.
        let selectedFlowIds = {};
        let selectionInitialized = false;

        // --- Chat history bootstrap ---
        if (window.LLMPlugin && LLMPlugin.ChatManager) {
            LLMPlugin.ChatManager.loadChatHistoriesFromServer();
        }

        // --- Settings helpers ---
        function fetchSettings(force) {
            if (!force && cachedSettings) return Promise.resolve(cachedSettings);
            return Common.apiFetch('llm-plugin/settings')
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
                let fields = settingsDialog.querySelectorAll('select, input');
                for (let i = 0; i < fields.length; i++) {
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
            let settings = settingsManager.save();
            settingsSaving = true;
            saveSettingsBtn.disabled = true;
            saveSettingsBtn.classList.add('saving');
            Common.apiFetch('llm-plugin/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(settings)
            })
            .then(function(res) {
                if (!res.ok) return res.json().then(function(d) { throw new Error(d.error || 'Failed to save settings'); });
                cachedSettings = null;
                Common.notify('LLM Plugin settings saved.', 'success');
                closeSettingsDialog();
            })
            .catch(function(err) {
                Common.notify(err.message || 'Failed to save settings', 'error');
            })
            .finally(function() {
                settingsSaving = false;
                saveSettingsBtn.disabled = false;
                saveSettingsBtn.classList.remove('saving');
            });
        });

        // --- Initial data fetch ---
        fetchSettings();
        initFlowSelector();

        // --- Generate / Stop toggle (single handler) ---
        generateBtn.addEventListener('click', function() {
            if (generateBtn.classList.contains('stop-btn')) {
                if (currentAbortController) {
                    currentAbortController.abort();
                    let loadingMsg = chatArea.querySelector('.loading-message');
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

        // --- Shell-style history navigation (Up/Down through this chat's
        // user messages; Down past the newest restores the draft). Only
        // fires on the textarea's first/last line so multi-line editing
        // still works.
        let historyIndex = null;        // null when not navigating
        let draftBeforeHistory = '';

        function getUserMessageHistory() {
            if (!window.LLMPlugin || !LLMPlugin.ChatManager) return [];
            let id = LLMPlugin.ChatManager.getCurrentChatId();
            let hist = LLMPlugin.ChatManager.getChatHistory && LLMPlugin.ChatManager.getChatHistory();
            let chat = hist && id ? hist[id] : null;
            if (!chat || !Array.isArray(chat.messages)) return [];
            return chat.messages.filter(function(m) { return m && m.isUser; });
        }
        function cursorAtFirstLine(el) {
            let s = el.selectionStart;
            return s === el.selectionEnd && el.value.lastIndexOf('\n', s - 1) === -1;
        }
        function cursorAtLastLine(el) {
            let s = el.selectionStart;
            return s === el.selectionEnd && el.value.indexOf('\n', s) === -1;
        }
        function applyHistoryValue(value) {
            promptInput.value = value;
            let end = value.length;
            try { promptInput.setSelectionRange(end, end); } catch (e) { /* ignore */ }
        }
        function resetHistoryNav() {
            historyIndex = null;
            draftBeforeHistory = '';
        }
        // Manual edits invalidate the current history walk. Programmatic
        // .value assignments (our applyHistoryValue, clear-on-send) do
        // NOT fire 'input', so this listener only catches real typing.
        promptInput.addEventListener('input', resetHistoryNav);

        promptInput.addEventListener('keydown', function(e) {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            if (e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;

            if (e.key === 'ArrowUp') {
                if (!cursorAtFirstLine(this)) return;
                let msgs = getUserMessageHistory();
                if (msgs.length === 0) return;
                if (historyIndex === null) {
                    draftBeforeHistory = this.value;
                    historyIndex = msgs.length - 1;
                } else if (historyIndex > 0) {
                    historyIndex--;
                } else {
                    return; // already at oldest
                }
                if (historyIndex >= msgs.length) historyIndex = msgs.length - 1;
                e.preventDefault();
                applyHistoryValue(msgs[historyIndex].content || '');
            } else { // ArrowDown
                if (historyIndex === null) return;
                if (!cursorAtLastLine(this)) return;
                let msgs = getUserMessageHistory();
                if (historyIndex < msgs.length - 1) {
                    historyIndex++;
                    e.preventDefault();
                    applyHistoryValue(msgs[historyIndex].content || '');
                } else {
                    // Stepped past the newest entry -> restore draft.
                    e.preventDefault();
                    applyHistoryValue(draftBeforeHistory);
                    resetHistoryNav();
                }
            }
        });

        // Expose so the send path can reset after clearing the input.
        promptInput._llmPluginResetHistoryNav = resetHistoryNav;

        function resetGenerateBtn() {
            generateBtn.disabled = false;
            generateBtn.classList.remove('stop-btn');
            generateBtn.textContent = 'Send';
            if (modeSelect) modeSelect.disabled = false;
        }

        // Toast on mode change so the user sees the dropdown took effect.
        if (modeSelect) {
            modeSelect.addEventListener('change', function() {
                try { localStorage.setItem('llm-plugin-last-mode', modeSelect.value); }
                catch (e) { /* ignore localStorage errors */ }
                Common.notify('LLM Plugin: Mode = ' + modeSelect.value, { type: 'info', timeout: 1500 });
            });
        }

        // --- Flow selector ---
        function listWorkspaces() {
            let out = [];
            if (window.RED && RED.nodes && typeof RED.nodes.eachWorkspace === 'function') {
                RED.nodes.eachWorkspace(function(ws) {
                    if (ws && ws.id && ws.type === 'tab') {
                        out.push({ id: ws.id, label: ws.label || ws.id });
                    }
                });
            }
            return out;
        }

        function getActiveWorkspaceId() {
            return (window.LLMPlugin && LLMPlugin.UI && typeof LLMPlugin.UI.getActiveWorkspaceId === 'function')
                ? LLMPlugin.UI.getActiveWorkspaceId()
                : null;
        }

        // Persist the user's flow selection across browser sessions, mirroring
        // the model/mode behaviour. We store the IDs as a JSON array; invalid
        // (e.g., deleted) IDs are filtered out lazily by pruneSelectedFlows.
        function saveSelectedFlows() {
            try {
                let ids = Object.keys(selectedFlowIds);
                localStorage.setItem('llm-plugin-selected-flows', JSON.stringify(ids));
            } catch (e) { /* ignore localStorage errors */ }
        }
        function loadSelectedFlows() {
            try {
                let raw = localStorage.getItem('llm-plugin-selected-flows');
                if (!raw) return false;
                let ids = JSON.parse(raw);
                if (!Array.isArray(ids) || ids.length === 0) return false;
                let any = false;
                ids.forEach(function(id) {
                    if (typeof id === 'string' && id) {
                        selectedFlowIds[id] = true;
                        any = true;
                    }
                });
                return any;
            } catch (e) { return false; }
        }

        // First-init default: saved localStorage selection, else the active
        // workspace. After that the user's explicit selection (even empty)
        // is preserved.
        function ensureDefaultSelection() {
            if (selectionInitialized) return;
            if (loadSelectedFlows()) {
                selectionInitialized = true;
                return;
            }
            let active = getActiveWorkspaceId();
            if (active) {
                selectedFlowIds[active] = true;
                selectionInitialized = true;
            }
        }

        // Drop selections that no longer correspond to an existing workspace.
        // Guarded against the transient "RED not ready yet → 0 workspaces"
        // state so we don't wipe a freshly-restored selection from
        // localStorage before the workspaces have actually loaded.
        function pruneSelectedFlows(workspaces) {
            let ws = workspaces || listWorkspaces();
            if (ws.length === 0) return;
            let valid = {};
            ws.forEach(function(w) { valid[w.id] = true; });
            let changed = false;
            Object.keys(selectedFlowIds).forEach(function(id) {
                if (!valid[id]) {
                    delete selectedFlowIds[id];
                    changed = true;
                }
            });
            if (changed) saveSelectedFlows();
        }

        // Re-sync the selector with current workspace state: prune deleted
        // flows, then refresh the label and (if open) the panel. The user's
        // explicit selection is preserved - we never re-add an active flow
        // here, only remove flows that no longer exist.
        function refreshFlowSelector() {
            let workspaces = listWorkspaces();
            pruneSelectedFlows(workspaces);
            if (isPanelOpen()) renderFlowPanel();
            updateFlowLabel(workspaces);
        }

        function updateFlowLabel(workspaces) {
            let ids = Object.keys(selectedFlowIds);
            let active = getActiveWorkspaceId();
            if (ids.length === 0) {
                flowLabel.textContent = 'No flow context';
                return;
            }
            if (ids.length === 1 && ids[0] === active) {
                flowLabel.textContent = 'Current Open Flow';
                return;
            }
            let ws = workspaces || listWorkspaces();
            let byId = {};
            ws.forEach(function(w) { byId[w.id] = w.label; });
            let names = ids.map(function(id) { return byId[id] || id; });
            if (names.length <= 2) {
                flowLabel.textContent = names.join(', ');
            } else {
                flowLabel.textContent = names[0] + ' +' + (names.length - 1);
            }
        }

        function renderFlowPanel() {
            while (flowPanel.firstChild) flowPanel.removeChild(flowPanel.firstChild);

            let workspaces = listWorkspaces();
            if (workspaces.length === 0) {
                let empty = document.createElement('div');
                empty.className = 'flow-selector-empty';
                empty.textContent = 'No flows available';
                flowPanel.appendChild(empty);
                return;
            }

            let active = getActiveWorkspaceId();
            workspaces.forEach(function(ws) {
                let row = buildFlowOption({
                    label: ws.label,
                    checked: !!selectedFlowIds[ws.id],
                    isActive: ws.id === active,
                    onToggle: function(checked) {
                        if (checked) selectedFlowIds[ws.id] = true;
                        else delete selectedFlowIds[ws.id];
                        saveSelectedFlows();
                        updateFlowLabel(workspaces);
                    }
                });
                flowPanel.appendChild(row);
            });
        }

        function buildFlowOption(opts) {
            let row = document.createElement('label');
            row.className = 'flow-selector-option';
            if (opts.isActive) row.classList.add('flow-selector-current');
            let cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!opts.checked;
            cb.addEventListener('change', function() { opts.onToggle(cb.checked); });
            let span = document.createElement('span');
            span.textContent = opts.label;
            row.appendChild(cb);
            row.appendChild(span);
            return row;
        }

        function isPanelOpen() {
            return flowPanel.classList.contains('is-open');
        }

        // Position the panel using fixed coordinates so it escapes any
        // overflow:hidden ancestor from Node-RED's sidebar/flex layout.
        function positionPanel() {
            let rect = flowToggleBtn.getBoundingClientRect();
            let panelHeight = flowPanel.offsetHeight || 220;
            let spaceAbove = rect.top;
            let spaceBelow = window.innerHeight - rect.bottom;
            let openUp = spaceBelow < panelHeight && spaceAbove > spaceBelow;
            flowPanel.style.left = rect.left + 'px';
            flowPanel.style.width = rect.width + 'px';
            if (openUp) {
                flowPanel.style.top = Math.max(4, rect.top - panelHeight - 2) + 'px';
            } else {
                flowPanel.style.top = (rect.bottom + 2) + 'px';
            }
        }

        // Listeners attached only while the panel is open, so they don't
        // run on every chat-area scroll during LLM streaming.
        let repositionOnScroll = function() { if (isPanelOpen()) positionPanel(); };
        let repositionOnResize = function() { if (isPanelOpen()) positionPanel(); };

        function openFlowPanel() {
            // Re-sync against current workspaces before rendering so stale
            // selections (e.g. for a flow deleted while the panel was closed)
            // never surface as raw IDs in the label or orphan checked rows.
            let workspaces = listWorkspaces();
            pruneSelectedFlows(workspaces);
            renderFlowPanel();
            updateFlowLabel(workspaces);
            flowPanel.classList.add('is-open');
            positionPanel();
            flowToggleBtn.setAttribute('aria-expanded', 'true');
            window.addEventListener('resize', repositionOnResize);
            window.addEventListener('scroll', repositionOnScroll, true);
        }

        function closeFlowPanel() {
            flowPanel.classList.remove('is-open');
            flowToggleBtn.setAttribute('aria-expanded', 'false');
            window.removeEventListener('resize', repositionOnResize);
            window.removeEventListener('scroll', repositionOnScroll, true);
        }

        function initFlowSelector() {
            ensureDefaultSelection();
            updateFlowLabel();
            flowToggleBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                if (isPanelOpen()) closeFlowPanel(); else openFlowPanel();
            });
            flowPanel.addEventListener('click', function(e) { e.stopPropagation(); });
            document.addEventListener('click', function(e) {
                if (isPanelOpen() && !flowSelector.contains(e.target) && !flowPanel.contains(e.target)) {
                    closeFlowPanel();
                }
            });
            if (window.RED && RED.events && typeof RED.events.on === 'function') {
                // flows:remove is critical — without it, deleted flow IDs
                // would linger in selectedFlowIds and surface as raw IDs.
                RED.events.on('workspace:change', refreshFlowSelector);
                RED.events.on('flows:add', refreshFlowSelector);
                RED.events.on('flows:change', refreshFlowSelector);
                RED.events.on('flows:remove', refreshFlowSelector);
            }
        }

        function getSelectedFlowIds() {
            return Object.keys(selectedFlowIds);
        }

        // --- Core generation flow ---
        function handleGenerate() {
            // Block Ctrl+Enter while a request is in flight (Send is Stop).
            if (generateBtn.classList.contains('stop-btn')) return;

            let model  = modelInput.value.trim();
            let prompt = promptInput.value.trim();
            
            // Save model to localStorage
            try {
                if (model) localStorage.setItem('llm-plugin-last-model', model);
            } catch (e) { /* ignore localStorage errors */ }

            let mode = (modeSelect && modeSelect.value) ? modeSelect.value : 'ask';
            if (!model || !prompt) {
                Common.notify('Please enter both model and prompt', 'warning');
                return;
            }

            let flowIdsToSend = getSelectedFlowIds();

            if (window.LLMPlugin && LLMPlugin.ChatManager) {
                LLMPlugin.ChatManager.addMessage(prompt, true, { mode: mode });
            }
            promptInput.value = '';
            if (typeof promptInput._llmPluginResetHistoryNav === 'function') {
                promptInput._llmPluginResetHistoryNav();
            }

            // Checkpoints are captured at import time (right before a flow
            // edit is applied), not here — chat sends that don't end up
            // modifying the flow no longer consume a checkpoint slot.
            let loadingMsg = (window.LLMPlugin && LLMPlugin.UI)
                ? LLMPlugin.UI.addMessageToUI('Generating...', false, false)
                : null;
            if (loadingMsg) loadingMsg.classList.add('loading-message');

            generateBtn.disabled = false;
            generateBtn.classList.add('stop-btn');
            generateBtn.innerHTML = '<i class="fa fa-stop" aria-hidden="true"></i>';
            // Mode for this turn is already captured in `mode`; lock the
            // dropdown so mid-flight switches obviously target only the next Send.
            if (modeSelect) modeSelect.disabled = true;

            let currentFlow = null;
            if (flowIdsToSend.length > 0 && window.LLMPlugin && LLMPlugin.UI && 
                typeof LLMPlugin.UI.getCurrentFlow === 'function') {
                currentFlow = LLMPlugin.UI.getCurrentFlow(flowIdsToSend);
            }

            if (currentAbortController) currentAbortController.abort();
            currentAbortController = new AbortController();

            // One endpoint for both modes: the server-side request is
            // identical; Agent only differs client-side (auto-import below).
            let fetchStart = Date.now();

            Common.apiFetch('llm-plugin/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    currentFlow: currentFlow,
                    activeWorkspaceId: getActiveWorkspaceId()
                }),
                signal: currentAbortController.signal
            })
            .then(function(res) {
                if (!res.ok) {
                    return res.json()
                        .catch(function() { return { error: 'Request failed (' + res.status + ')' }; })
                        .then(function(d) {
                            let err = new Error(d.error || 'Request failed');
                            err.status = res.status;
                            throw err;
                        });
                }
                return res.json();
            })
            .then(function(data) {
                if (loadingMsg) loadingMsg.remove();
                let totalElapsed = (data.elapsed != null) ? data.elapsed : (Date.now() - fetchStart);
                let msgEl = null;
                let usedModel = (data && data.model) ? data.model : model;
                let targetFlowName = Common.flowLabels(flowIdsToSend);
                let metaOpts = {
                    mode: mode,
                    elapsedMs: totalElapsed,
                    model: usedModel,
                    targetFlowIds: (flowIdsToSend && flowIdsToSend.length > 0) ? flowIdsToSend.slice() : null,
                    targetFlowName: targetFlowName
                };
                if (window.LLMPlugin && LLMPlugin.ChatManager) {
                    msgEl = LLMPlugin.ChatManager.addMessage(data.response, false, metaOpts);
                } else if (window.LLMPlugin && LLMPlugin.UI) {
                    msgEl = LLMPlugin.UI.addMessageToUI(data.response, false, true, { meta: metaOpts });
                }

                if (mode === 'agent' && msgEl) {
                    let importBtn = msgEl.querySelector('.import-btn');
                    if (importBtn) {
                        importBtn.click();
                    }
                }
            })
            .catch(function(err) {
                if (loadingMsg) loadingMsg.remove();
                if (err && err.name === 'AbortError') return; // user cancelled
                let errorMsg = 'Request failed';
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
            let cfg = window.LLMPlugin && window.LLMPlugin.FlowConverterCore;
            if (cfg && typeof cfg.setRuntimeGetType === 'function' &&
                RED.nodes && typeof RED.nodes.getType === 'function') {
                cfg.setRuntimeGetType(function(type) {
                    try { return RED.nodes.getType(type) || null; } catch(e) { return null; }
                });
            }
            // `closeable` is undocumented but matches Node-RED's own
            // debug/info tabs (close-X + re-open from the overflow menu).
            RED.sidebar.addTab({
                id: "llm-plugin-tab",
                label: "LLM Plugin",
                name: "LLM Plugin",
                content: createLLMPluginUI(),
                iconClass: "fa fa-comments",
                closeable: true
            });
        } else {
            setTimeout(initializeWhenReady, 100);
        }
    }

    // Auto-init: this module owns the sidebar tab; nothing outside it
    // needs a handle on the builder.
    initializeWhenReady();

})();
