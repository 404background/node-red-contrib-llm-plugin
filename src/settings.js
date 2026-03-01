// Settings UI manager — vanilla JS (no jQuery).
// Accepts a raw DOM element as root (the settings dialog container).
(function() {
    function createSettingsManager(root) {
        var providerSelect  = root.querySelector('#llm-provider');
        var ollamaSettings  = root.querySelector('#ollama-settings');
        var openaiSettings  = root.querySelector('#openai-settings');
        var ollamaUrlInput  = root.querySelector('#ollama-url');
        var apiKeyInput     = root.querySelector('#openai-api-key');

        function updateVisibleSettings() {
            var isOllama = providerSelect.value === 'ollama';
            ollamaSettings.style.display = isOllama ? '' : 'none';
            openaiSettings.style.display = isOllama ? 'none' : '';
        }

        providerSelect.addEventListener('change', updateVisibleSettings);

        return {
            load: function(settings) {
                var data = settings || {};
                providerSelect.value = data.provider || 'ollama';
                ollamaUrlInput.value = data.ollamaUrl || 'http://localhost:11434';
                // Don't populate the key field (server never sends the real key).
                // Show masked version as placeholder so user knows a key is set.
                apiKeyInput.value = '';
                apiKeyInput.placeholder = data.openaiApiKeyMasked || 'sk-...';
                updateVisibleSettings();
            },
            save: function() {
                return {
                    provider: providerSelect.value,
                    ollamaUrl: ollamaUrlInput.value,
                    openaiApiKey: apiKeyInput.value
                };
            },
            updateVisibility: updateVisibleSettings
        };
    }

    window.createLLMPluginSettings = createSettingsManager;
})();
