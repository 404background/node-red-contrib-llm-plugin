# LLM Plugin - Source Files

This folder contains the source files for the LLM Plugin sidebar used by Node-RED.

## Overview

The client-side code is modular. The browser entry is `src/client.js`, a small loader that injects client modules in sequence. The server registers admin HTTP endpoints under `/red/llm-plugin/` which the client uses for generation, chat persistence, and model history.

## Important files

- `src/client.js` — Loader script for client modules.
- `src/chat_manager.js` — Manages chat sessions and history.
- `src/importer.js` — Parses and imports flow JSON from LLM responses.
- `src/ui_core.js` — UI helpers for rendering messages and handling imports.
- `src/vibe_ui.js` — Main UI construction and event handling.
- `server.js` — Node-RED server-side logic (endpoints, prompts, persistence).
- `llm_plugin.html` — Sidebar HTML template.
- `llm_plugin.js` — Node-RED node bootstrap.
- `llm-plugin_styles.css` — Plugin styles.

## Development

- **Modular Client**: Add focused modules under `src/` and load them via `client.js`.
- **Server Logic**: Edit `server.js` for backend changes. Restart Node-RED to apply.
- **Endpoints**: Use `/red/llm-plugin/` namespace for compatibility.

This plugin is under active development. Contributions and feedback are welcome!