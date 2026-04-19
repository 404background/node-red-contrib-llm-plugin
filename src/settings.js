// Settings UI manager — vanilla JS (no jQuery).
// Accepts a raw DOM element as root (the settings dialog container).
(function() {
    var DEFAULT_SYSTEM_PROMPT = 'Take priority in using core nodes';

    function createSettingsManager(root) {
        var providerSelect    = root.querySelector('#llm-provider');
        var ollamaSettings    = root.querySelector('#ollama-settings');
        var openaiSettings    = root.querySelector('#openai-settings');
        var ollamaUrlInput    = root.querySelector('#ollama-url');
        var apiKeyInput       = root.querySelector('#openai-api-key');
        var systemPromptInput = root.querySelector('#llm-system-prompt');
        var resetPromptBtn    = root.querySelector('#llm-system-prompt-reset');
        var maxPromptLenInput = root.querySelector('#llm-max-prompt-length');

        function updateVisibleSettings() {
            var isOllama = providerSelect.value === 'ollama';
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
                var data = settings || {};
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
                    var saved = data.systemPrompt;
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
