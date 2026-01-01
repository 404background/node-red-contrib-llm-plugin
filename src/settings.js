(function() {
    function createSettingsManager(root) {
        const providerSelect = root.find('#llm-provider');
        const ollamaSettings = root.find('#ollama-settings');
        const openaiSettings = root.find('#openai-settings');

        const ollamaModelInput = root.find('#ollama-model');
        const ollamaModelOptions = root.find('#ollama-model-options');
        const openaiApiKeyInput = root.find('#openai-api-key');
        const openaiModelInput = root.find('#openai-model');

        let ollamaModelsLoaded = false;

        function populateOllamaOptions(models) {
            if (!ollamaModelOptions || !ollamaModelOptions.length) {
                return;
            }
            ollamaModelOptions.empty();
            (models || []).forEach(function(model) {
                const trimmed = (model || '').trim();
                if (!trimmed) return;
                const option = jQuery('<option>').attr('value', trimmed);
                ollamaModelOptions.append(option);
            });
        }

        function fetchOllamaModels() {
            return new Promise(function(resolve) {
                jQuery.getJSON('llm-plugin/ollama/models')
                    .done(function(data) {
                        const models = (data && data.models) ? data.models : [];
                        populateOllamaOptions(models);
                        ollamaModelsLoaded = true;
                        resolve(models);
                    })
                    .fail(function() {
                        populateOllamaOptions([]);
                        resolve([]);
                    });
            });
        }

        function ensureOllamaModelsLoaded() {
            if (ollamaModelsLoaded) {
                return Promise.resolve();
            }
            return fetchOllamaModels();
        }

        function updateVisibleSettings() {
            const provider = providerSelect.val();
            if (provider === 'ollama') {
                ollamaSettings.show();
                openaiSettings.hide();
                ensureOllamaModelsLoaded();
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
                ollamaModelInput.val(data.ollamaModel || '');
                openaiApiKeyInput.val(data.openaiApiKey || '');
                openaiModelInput.val(data.openaiModel || '');
                updateVisibleSettings();
            },
            save() {
                return {
                    provider: providerSelect.val(),
                    ollamaModel: ollamaModelInput.val(),
                    openaiApiKey: openaiApiKeyInput.val(),
                    openaiModel: openaiModelInput.val()
                };
            },
            updateVisibility: updateVisibleSettings,
            refreshOllamaModels: fetchOllamaModels
        };
    }

    window.createLLMPluginSettings = createSettingsManager;
})();
