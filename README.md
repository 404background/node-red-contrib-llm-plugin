# LLM Plugin for Node-RED

LLM Plugin is a Node-RED sidebar extension that lets you interact with large language models (LLMs) directly from the Node-RED editor. You can chat with an LLM, send existing flows to the LLM for modification or explanation, and import flows the LLM suggests.

![LLM Plugin screenshot](images/plugin.png)

Current key capabilities
- Local Ollama support: the plugin communicates with a local Ollama instance to run models and generate responses.
- Send flows to the LLM: you can pass a flow (JSON) to the LLM to request edits, compact summaries, or translations.
- Import LLM-proposed flows: the plugin parses LLM responses containing a ```json``` flow block and imports the suggested flow into your workspace (ids are remapped and wires are normalized to avoid dangling references).
- Chat and history: chat with the LLM in the sidebar and manage chat history stored locally.

LLM Plugin is designed to make Node-RED automation and prototyping easier by leveraging LLMs while being conservative about modifying LLM output: the importer validates flows and avoids destructive automatic changes unless explicitly enabled.

Known limitations: in some cases an LLM's proposed flow may not be importable as-is (the importer validates structure and will abort on malformed or incomplete node shapes). If an import is aborted you may need to correct the JSON or revise the prompt and try again.

Note on LLM support: this release uses a local Ollama instance for model generation. Support for cloud-based models (for example ChatGPT/OpenAI) is planned for a future release.
