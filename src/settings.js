(function() {
    function createSettingsManager(root) {
        const providerSelect = root.find('#llm-provider');
        const ollamaSettings = root.find('#ollama-settings');
        const openaiSettings = root.find('#openai-settings');

        const ollamaUrlInput = root.find('#ollama-url');
        const openaiApiKeyInput = root.find('#openai-api-key');

        function updateVisibleSettings() {
            const provider = providerSelect.val();
            if (provider === 'ollama') {
                ollamaSettings.show();
                openaiSettings.hide();
            } else {
                ollamaSettings.hide();
                openaiSettings.show();
            }
        }

        providerSelect.on('change', updateVisibleSettings);

        return {
            load(settings) {
                const data = settings || {};
                providerSelect.val(data.provider || 'ollama');
                ollamaUrlInput.val(data.ollamaUrl || 'http://localhost:11434');
                openaiApiKeyInput.val(data.openaiApiKey || '');
                updateVisibleSettings();
            },
            save() {
                return {
                    provider: providerSelect.val(),
                    ollamaUrl: ollamaUrlInput.val(),
                    openaiApiKey: openaiApiKeyInput.val()
                };
            },
            updateVisibility: updateVisibleSettings
        };
    }

    window.createLLMPluginSettings = createSettingsManager;
})();
