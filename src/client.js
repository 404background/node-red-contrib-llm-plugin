// Loader for modularized LLM Plugin client code
(function() {
    let scripts = [
        'llm-plugin/src/core/flow_converter_core.js',
        'llm-plugin/src/core/llm_json_parser.js',
        'llm-plugin/src/chat_manager.js',
        'llm-plugin/src/importer.js',
        'llm-plugin/src/ui_core.js',
        'llm-plugin/src/settings.js',
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
