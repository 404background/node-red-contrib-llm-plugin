// Settings UI manager  Evanilla JS (no jQuery).
// Accepts a raw DOM element as root (the settings dialog container).
(function() {
    let DEFAULT_SYSTEM_PROMPT = 'Take priority in using core nodes';

    function createSettingsManager(root) {
        let providerSelect    = root.querySelector('#llm-provider');
        let ollamaSettings    = root.querySelector('#ollama-settings');
        let openaiSettings    = root.querySelector('#openai-settings');
        let ollamaUrlInput    = root.querySelector('#ollama-url');
        let apiKeyInput       = root.querySelector('#openai-api-key');
        let systemPromptInput = root.querySelector('#llm-system-prompt');
        let resetPromptBtn    = root.querySelector('#llm-system-prompt-reset');
        let maxPromptLenInput = root.querySelector('#llm-max-prompt-length');

        function updateVisibleSettings() {
            let isOllama = providerSelect.value === 'ollama';
            ollamaSettings.style.display = isOllama ? '' : 'none';
            openaiSettings.style.display = isOllama ? 'none' : '';
        }

        providerSelect.addEventListener('change', updateVisibleSettings);

        if (resetPromptBtn) {
            resetPromptBtn.addEventListener('click', function() {
                if (systemPromptInput) systemPromptInput.value = DEFAULT_SYSTEM_PROMPT;
            });
        }

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
                if (systemPromptInput) {
                    // Show saved prompt, or default if never set
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
                    systemPrompt: systemPromptInput ? systemPromptInput.value : '',
                    maxPromptLength: maxPromptLenInput ? maxPromptLenInput.value : 10000
                };
            },
            updateVisibility: updateVisibleSettings
        };
    }

    window.createLLMPluginSettings = createSettingsManager;
})();
