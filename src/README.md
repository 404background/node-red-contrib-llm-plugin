# LLM Plugin - Source Files

This folder contains the source files for the LLM Plugin sidebar used by Node-RED. The code here implements a conservative, validation-first importer and a modular client that talks to a local LLM (Ollama) via server endpoints.

## Overview

The client-side code is modular. The browser entry is `src/client.js`, a small loader that injects client modules in sequence. The server registers admin HTTP endpoints under `/red/llm-plugin/` which the client uses for generation, chat persistence, and model history.

## Important files

- `src/client.js` — loader script that sequentially loads the client modules in the browser.
- `src/chat_manager.js` — chat session lifecycle, saving/loading chats to the backend, and chat list UI.
- `src/importer.js` — parses flow JSON from assistant messages and imports it into Node-RED; remaps ids and normalizes wires to prevent dangling references.
- `src/ui_core.js` — UI helpers for rendering chat messages and flow import actions.
- `src/vibe_ui.js` — constructs the sidebar UI and wires event handlers and network calls to the server endpoints.
- `server.js` — Node-RED server-side logic (registers endpoints, constructs prompts for the LLM, handles chat persistence).
- `llm_plugin.html` — Node-RED sidebar HTML (loads `src/client.js` and plugin styles).
- `llm_plugin.js` — Node-RED node bootstrap (ensures server routes are registered when the plugin loads).
- `llm-plugin_styles.css` — plugin CSS.

## Behavior notes

This `src/` folder contains the client and server source for the LLM Plugin. The importer is intentionally conservative: it remaps ids and normalizes wires to allow Node-RED to import flows suggested by an LLM while avoiding destructive automatic edits to assistant-provided JSON.

## Contributing and development tips

- Keep client code modular: add small focused modules under `src/` and load them via the loader.
- Edit `server.js` for server-side changes and restart Node-RED to apply them.
- When adding endpoints, use the `/red/llm-plugin/` namespace to remain backward-compatible.

If you'd like, I can add a short developer checklist, usage examples for Ollama (how to start it), or a minimal automated test harness to exercise client loading and the importer flow.