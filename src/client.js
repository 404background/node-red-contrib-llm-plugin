// Loader for modularized LLM Plugin client code
(function() {
    var scripts = [
        'llm-plugin/src/chat_manager.js',
        'llm-plugin/src/importer.js',
        'llm-plugin/src/ui_core.js',
        'llm-plugin/src/settings.js',
        'llm-plugin/src/vibe_ui.js'
    ];

    // Dynamically load scripts sequentially
    function loadNext(i) {
        if (i >= scripts.length) return;
        var s = document.createElement('script');
        s.src = scripts[i];
        s.onload = function() { loadNext(i+1); };
        s.onerror = function() { console.error('Failed to load', scripts[i]); loadNext(i+1); };
        document.head.appendChild(s);
    }
    loadNext(0);
})();
