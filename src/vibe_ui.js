// Main sidebar UI module — vanilla JS (no jQuery).
// Builds the plugin sidebar, settings dialog, and generation workflow.
(function(){
    let Common = window.LLMPlugin.Common;

    // Fill `el` from a markup template in llm_plugin.html (static, no reply text).
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
            LLMPlugin.ChatManager.startNewChat();
        });
        container.querySelector('[data-action="chat-list"]').addEventListener('click', function() {
            LLMPlugin.ChatManager.showChatList();
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
        // Workspace ids sent as flow context: restored from the chat or the last
        // session, else the open flow once the flows are loaded.
        let selectedFlowIds = {};
        let selectionInitialized = false;
        // The editor adds the tabs one by one while it loads the flows, so
        // until `flows:loaded` a tab missing from the list may just not be
        // there yet: nothing is pruned, and "the open flow" is not known.
        let flowsLoaded = false;
        let wantActiveFlow = false;

        // --- Chat history bootstrap ---
        LLMPlugin.ChatManager.loadChatHistoriesFromServer();

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
                closeSettingsDialog();
            })
            .catch(function(err) {
                Common.notice(err.message || 'Failed to save settings', 'error');
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
        function isGenerating() {
            return generateBtn.classList.contains('stop-btn');
        }
        function stopGeneration() {
            if (!isGenerating() || !currentAbortController) return false;
            currentAbortController.abort();
            let loadingMsg = chatArea.querySelector('.loading-message');
            if (loadingMsg) loadingMsg.remove();
            resetGenerateBtn();
            currentAbortController = null;
            return true;
        }

        generateBtn.addEventListener('click', function() {
            if (isGenerating()) stopGeneration();
            else handleGenerate();
        });

        // The Send path itself. The retry button drives this rather than
        // clicking the button, so there is one way a prompt is sent.
        LLMPlugin.sendPrompt = function(prompt) { handleGenerate(prompt); };

        promptInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                if (stopGeneration()) e.preventDefault();
                return;
            }
            if (e.key !== 'Enter') return;
            // Shift+Enter is the newline. An Enter that is still closing an
            // IME conversion is that conversion, not a send — without this
            // guard every Japanese phrase sends the message it was confirming.
            if (e.shiftKey || e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            handleGenerate();
        });

        // Esc stops a running request from anywhere in the sidebar, not only
        // the prompt box. While the settings dialog is open, Esc is that
        // dialog's — it closes it and nothing else.
        let sidebarRoot = generateBtn.closest('.llm-plugin-container') || document;
        sidebarRoot.addEventListener('keydown', function(e) {
            if (e.key !== 'Escape' || e.target === promptInput) return;
            if (settingsOverlay && settingsOverlay.classList.contains('visible')) return;
            if (stopGeneration()) e.preventDefault();
        });

        // --- Shell-style history: Up/Down through this chat's user
        // messages, only on the textarea's first/last line.
        let historyIndex = null;        // null when not navigating
        let draftBeforeHistory = '';

        function getUserMessageHistory() {
            let chat = LLMPlugin.ChatManager.getChatHistory()[LLMPlugin.ChatManager.getCurrentChatId()];
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

        // The mode is remembered for the next session.
        if (modeSelect) {
            modeSelect.addEventListener('change', function() {
                try { localStorage.setItem('llm-plugin-last-mode', modeSelect.value); }
                catch (e) { /* ignore localStorage errors */ }
            });
        }

        // --- Flow selector ---
        function listWorkspaces() {
            let out = [];
            RED.nodes.eachWorkspace(function(ws) {
                if (ws && ws.id && ws.type === 'tab') {
                    out.push({ id: ws.id, label: ws.label || ws.id });
                }
            });
            return out;
        }

        function getActiveWorkspaceId() {
            return LLMPlugin.UI.getActiveWorkspaceId();
        }

        // Persist the user's flow selection across browser sessions, mirroring
        // the model/mode behaviour. We store the IDs as a JSON array; invalid
        // (e.g., deleted) IDs are filtered out lazily by pruneSelectedFlows.
        function saveSelectedFlows() {
            let ids = Object.keys(selectedFlowIds);
            try {
                localStorage.setItem('llm-plugin-selected-flows', JSON.stringify(ids));
            } catch (e) { /* ignore localStorage errors */ }
            // The chat keeps it too, so reopening the chat brings it back.
            LLMPlugin.ChatManager.setFlowIds(ids);
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

        // Drop selections whose workspace is gone, once the flows are loaded.
        function pruneSelectedFlows(workspaces) {
            let ws = workspaces || listWorkspaces();
            if (!flowsLoaded || ws.length === 0) return;
            let valid = {};
            ws.forEach(function(w) { valid[w.id] = true; });
            let changed = false;
            Object.keys(selectedFlowIds).forEach(function(id) {
                if (!valid[id]) {
                    delete selectedFlowIds[id];
                    changed = true;
                }
            });
            // Every flow it named is gone: the open flow, not no context.
            if (changed && Object.keys(selectedFlowIds).length === 0) {
                let active = getActiveWorkspaceId();
                if (active) selectedFlowIds[active] = true;
            }
            if (changed) saveSelectedFlows();
        }

        // Prune, then refresh the label and panel. Only removes: the user's
        // explicit selection is never added back to.
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

            // Select-all / clear-all. Its own state mirrors the list, so it
            // doubles as "how much of this is selected" at a glance: checked
            // when everything is, indeterminate when only some of it is.
            let masterRow = buildFlowOption({
                label: 'All flows',
                checked: isEverySelected(workspaces),
                indeterminate: isSomeSelected(workspaces) && !isEverySelected(workspaces),
                onToggle: function(checked) {
                    Object.keys(selectedFlowIds).forEach(function(id) {
                        delete selectedFlowIds[id];
                    });
                    if (checked) {
                        workspaces.forEach(function(ws) { selectedFlowIds[ws.id] = true; });
                    }
                    selectionInitialized = true;
                    saveSelectedFlows();
                    renderFlowPanel();
                    updateFlowLabel(workspaces);
                }
            });
            masterRow.classList.add('flow-selector-all');
            flowPanel.appendChild(masterRow);
            let masterCb = masterRow.querySelector('input');

            // The open flow first; the rest keep tab order, so nothing else
            // moves between openings.
            let ordered = workspaces.filter(function(ws) { return ws.id === active; })
                .concat(workspaces.filter(function(ws) { return ws.id !== active; }));

            ordered.forEach(function(ws) {
                let row = buildFlowOption({
                    label: ws.label,
                    checked: !!selectedFlowIds[ws.id],
                    isActive: ws.id === active,
                    onToggle: function(checked) {
                        if (checked) selectedFlowIds[ws.id] = true;
                        else delete selectedFlowIds[ws.id];
                        selectionInitialized = true;
                        saveSelectedFlows();
                        syncMasterCheckbox(masterCb, workspaces);
                        updateFlowLabel(workspaces);
                    }
                });
                flowPanel.appendChild(row);
            });
        }

        function isEverySelected(workspaces) {
            return workspaces.length > 0 && workspaces.every(function(ws) {
                return !!selectedFlowIds[ws.id];
            });
        }

        function isSomeSelected(workspaces) {
            return workspaces.some(function(ws) { return !!selectedFlowIds[ws.id]; });
        }

        // One flow click changes one other thing, so it is patched in place;
        // the all-flows row re-renders, because every row changed.
        function syncMasterCheckbox(masterCb, workspaces) {
            if (!masterCb) return;
            masterCb.checked = isEverySelected(workspaces);
            masterCb.indeterminate = isSomeSelected(workspaces) && !masterCb.checked;
        }

        function buildFlowOption(opts) {
            let row = document.createElement('label');
            row.className = 'flow-selector-option';
            if (opts.isActive) row.classList.add('flow-selector-current');
            let cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!opts.checked;
            // Property, not attribute: there is no HTML for "indeterminate".
            cb.indeterminate = !!opts.indeterminate;
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

        // Back to just the open flow: the selection is the scope every edit
        // and checkpoint is confined to. See docs/{en,jp}/architecture.md.
        function selectActiveFlowOnly() {
            let active = flowsLoaded ? getActiveWorkspaceId() : null;
            // Before the flows are loaded there is no open flow yet.
            if (!active) { wantActiveFlow = true; return; }
            wantActiveFlow = false;
            replaceSelection([active]);
        }

        // `fromChat`: the ids came from the chat, which need not be told.
        function replaceSelection(ids, fromChat) {
            Object.keys(selectedFlowIds).forEach(function(id) {
                delete selectedFlowIds[id];
            });
            ids.forEach(function(id) { if (typeof id === 'string' && id) selectedFlowIds[id] = true; });
            selectionInitialized = true;
            if (fromChat) {
                try { localStorage.setItem('llm-plugin-selected-flows', JSON.stringify(Object.keys(selectedFlowIds))); }
                catch (e) { /* ignore localStorage errors */ }
            } else {
                saveSelectedFlows();
            }
            refreshFlowSelector();
        }

        // A chat that is opened (the latest one, when the editor starts)
        // brings back the flows it was working on.
        function restoreChatFlows(chatId, flowIds) {
            if (!Array.isArray(flowIds) || flowIds.length === 0) return;
            wantActiveFlow = false;
            replaceSelection(flowIds, true);
        }

        // Nothing chosen yet (no saved selection, no chat that names one), or
        // a new chat started before there was an open flow: the open flow.
        function onFlowsLoaded() {
            flowsLoaded = true;
            if (wantActiveFlow || !selectionInitialized) selectActiveFlowOnly();
            else refreshFlowSelector();
        }

        function initFlowSelector() {
            ensureDefaultSelection();
            updateFlowLabel();
            if (typeof LLMPlugin.ChatManager.onNewChat === 'function') {
                LLMPlugin.ChatManager.onNewChat(selectActiveFlowOnly);
            }
            if (typeof LLMPlugin.ChatManager.onChatLoaded === 'function') {
                LLMPlugin.ChatManager.onChatLoaded(restoreChatFlows);
            }
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
                RED.events.on('flows:loaded', onFlowsLoaded);
            }
            // Opened after the editor finished loading: nothing more will come.
            if (window.RED && RED.workspaces && typeof RED.workspaces.count === 'function' &&
                RED.workspaces.count() > 0 && getActiveWorkspaceId()) {
                onFlowsLoaded();
            }
        }

        function getSelectedFlowIds() {
            return Object.keys(selectedFlowIds);
        }

        // --- Core generation flow ---
        // `promptOverride` is how Retry sends: the turn after it is the same as a typed one.
        function handleGenerate(promptOverride) {
            // A request is already in flight (Send is Stop).
            if (isGenerating()) return;

            let model  = modelInput.value.trim();
            let prompt = (typeof promptOverride === 'string' ? promptOverride
                                                            : promptInput.value).trim();
            
            // Save model to localStorage
            try {
                if (model) localStorage.setItem('llm-plugin-last-model', model);
            } catch (e) { /* ignore localStorage errors */ }

            let mode = (modeSelect && modeSelect.value) ? modeSelect.value : 'ask';
            if (!model || !prompt) {
                Common.notice('Please enter both model and prompt', 'warning');
                return;
            }

            let flowIdsToSend = getSelectedFlowIds();

            LLMPlugin.ChatManager.addMessage(prompt, true, { mode: mode });
            promptInput.value = '';
            if (typeof promptInput._llmPluginResetHistoryNav === 'function') {
                promptInput._llmPluginResetHistoryNav();
            }

            // Checkpoints are taken at import time, not here: a send that edits nothing
            // takes no checkpoint slot.
            let loadingMsg = LLMPlugin.UI.addMessageToUI('Generating...', false);
            if (loadingMsg) loadingMsg.classList.add('loading-message');
            // The placeholder is last now, and it is not retryable.
            LLMPlugin.UI.refreshRetryButton();

            generateBtn.disabled = false;
            generateBtn.classList.add('stop-btn');
            generateBtn.innerHTML = '<i class="fa fa-stop" aria-hidden="true"></i>';
            // Mode for this turn is already captured in `mode`; lock the
            // dropdown so mid-flight switches obviously target only the next Send.
            if (modeSelect) modeSelect.disabled = true;

            // With the canvas extras, so the model sees where a wire through
            // a junction leads.
            let currentFlow = (flowIdsToSend.length > 0)
                ? LLMPlugin.UI.getCurrentFlow(flowIdsToSend, { includeCanvasExtras: true })
                : null;

            if (currentAbortController) currentAbortController.abort();
            currentAbortController = new AbortController();

            // One endpoint for both modes; Agent also imports the reply (below).
            let fetchStart = Date.now();

            Common.apiFetch('llm-plugin/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model,
                    prompt: prompt,
                    currentFlow: currentFlow,
                    activeWorkspaceId: getActiveWorkspaceId(),
                    // Ask and Agent are different questions, not the same one
                    // handled differently afterwards: the server picks the
                    // instructions from this.
                    mode: mode
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
                msgEl = LLMPlugin.ChatManager.addMessage(data.response, false, metaOpts);

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
                LLMPlugin.UI.addMessageToUI('Error: ' + errorMsg, false);
            })
            .finally(function() {
                resetGenerateBtn();
                currentAbortController = null;
                // Stop leaves the user message last, with no reply after it.
                LLMPlugin.UI.refreshRetryButton();
            });
        }
    }

    // --- Sidebar registration ---
    function initializeWhenReady() {
        if (typeof RED !== 'undefined' && RED.sidebar) {
            // Wire runtime type info into FlowConverterCore so community
            // nodes are handled correctly (config detection, input checks).
            let cfg = LLMPlugin.FlowConverterCore;
            cfg.setRuntimeGetType(function(type) { return RED.nodes.getType(type) || null; });
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
