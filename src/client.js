// Client bootstrap: loads the module files in dependency order, and hosts
// the (small) settings-dialog controller so it needs no file of its own.
(function() {
    let scripts = [
        'llm-plugin/src/common.js',
        // canvas_layout.js must load before flow_converter_core.js (toNodeRed
        // depends on its layoutNodes / computeComponentYOffsets primitives).
        'llm-plugin/src/core/canvas_layout.js',
        'llm-plugin/src/core/flow_converter_core.js',
        'llm-plugin/src/core/llm_json_parser.js',
        'llm-plugin/src/chat_manager.js',
        'llm-plugin/src/importer.js',
        'llm-plugin/src/ui_core.js',
        'llm-plugin/src/vibe_ui.js'
    ];

    // Fetch scripts in parallel but execute sequentially to preserve dependencies
    Promise.all(scripts.map(function(src) {
        return fetch(src + '?v=' + Date.now()).then(function(res) {
            if (!res.ok) throw new Error('Failed to fetch ' + src);
            return res.text();
        });
    }))
    .then(function(codes) {
        codes.forEach(function(code, index) {
            let s = document.createElement('script');
            // Execute script contents immediately and synchronously in order.
            // Add a sourceURL comment so devtools correctly name the dynamically loaded files.
            s.textContent = code + '\n//# sourceURL=' + encodeURI(scripts[index]);
            document.head.appendChild(s);
        });
    })
    .catch(function(err) {
        console.error('[LLM Plugin] Client load error:', err);
    });
})();

// Settings dialog controller (consumed by vibe_ui.js). Vanilla JS; `root`
// is the dialog container element holding the settings form.
(function() {
    let DEFAULT_SYSTEM_PROMPT = 'Take priority in using core nodes';

    function createSettingsManager(root) {
        let providerSelect    = root.querySelector('#llm-provider');
        let ollamaSettings    = root.querySelector('#ollama-settings');
        let openaiSettings    = root.querySelector('#openai-settings');
        let customSettings    = root.querySelector('#custom-settings');
        let ollamaUrlInput    = root.querySelector('#ollama-url');
        let apiKeyInput       = root.querySelector('#openai-api-key');
        let customBaseUrlInput= root.querySelector('#custom-base-url');
        let customApiKeyInput = root.querySelector('#custom-api-key');
        let systemPromptInput = root.querySelector('#llm-system-prompt');
        let resetPromptBtn    = root.querySelector('#llm-system-prompt-reset');
        let maxPromptLenInput = root.querySelector('#llm-max-prompt-length');

        function updateVisibleSettings() {
            let v = providerSelect.value;
            ollamaSettings.style.display = (v === 'ollama') ? '' : 'none';
            openaiSettings.style.display = (v === 'openai') ? '' : 'none';
            if (customSettings) customSettings.style.display = (v === 'custom') ? '' : 'none';
        }

        providerSelect.addEventListener('change', updateVisibleSettings);

        if (resetPromptBtn) {
            resetPromptBtn.addEventListener('click', function() {
                if (systemPromptInput) systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
            });
        }

        // The server refuses to keep a stored key while the Base URL changes
        // in the same save (that would send the key to a new endpoint without
        // the user ever seeing it). Clear the sentinel as soon as the URL is
        // edited so the requirement is visible in the form rather than
        // arriving as a save error.
        if (customBaseUrlInput && customApiKeyInput) {
            customBaseUrlInput.addEventListener('input', function() {
                if (customApiKeyInput.value !== '__EXISTING_KEY__') return;
                customApiKeyInput.value = '';
                customApiKeyInput.placeholder = 're-enter the key for the new Base URL';
            });
        }

        // Masked fields: saved URLs/keys are shown as placeholders only; the
        // '__EXISTING_KEY__' sentinel tells the server "keep the stored key".
        return {
            load: function(settings) {
                let data = settings || {};
                providerSelect.value = data.provider || 'ollama';
                ollamaUrlInput.value = '';
                ollamaUrlInput.placeholder = data.ollamaUrlMasked || 'http://localhost:11434';
                if (data.openaiApiKeyMasked) {
                    apiKeyInput.value = '__EXISTING_KEY__';
                    apiKeyInput.placeholder = data.openaiApiKeyMasked;
                } else {
                    apiKeyInput.value = '';
                    apiKeyInput.placeholder = 'sk-...';
                }
                if (customBaseUrlInput) {
                    customBaseUrlInput.value = '';
                    customBaseUrlInput.placeholder = data.customBaseUrlMasked || 'http://localhost:8080/v1';
                }
                if (customApiKeyInput) {
                    if (data.customApiKeyMasked) {
                        customApiKeyInput.value = '__EXISTING_KEY__';
                        customApiKeyInput.placeholder = data.customApiKeyMasked;
                    } else {
                        customApiKeyInput.value = '';
                        customApiKeyInput.placeholder = 'leave blank if not required';
                    }
                }
                if (systemPromptInput) {
                    let saved = data.systemPrompt;
                    systemPromptInput.value = (saved !== undefined && saved !== null) ? saved : DEFAULT_SYSTEM_PROMPT;
                }
                if (maxPromptLenInput) {
                    maxPromptLenInput.value = data.maxPromptLength || 10000;
                }
                updateVisibleSettings();
            },
            save: function() {
                return {
                    provider: providerSelect.value,
                    ollamaUrl: ollamaUrlInput.value,
                    openaiApiKey: apiKeyInput.value,
                    customBaseUrl: customBaseUrlInput ? customBaseUrlInput.value : '',
                    customApiKey: customApiKeyInput ? customApiKeyInput.value : '',
                    systemPrompt: systemPromptInput ? systemPromptInput.value : '',
                    maxPromptLength: maxPromptLenInput ? maxPromptLenInput.value : 10000
                };
            }
        };
    }

    window.createLLMPluginSettings = createSettingsManager;
})();
