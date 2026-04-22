# LLM Plugin for Node-RED

[![GitHub Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=ff69b4)](https://github.com/sponsors/404background)
[![npm version](https://img.shields.io/npm/v/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)

LLM Plugin is a Node-RED sidebar extension for chatting with LLMs, generating/modifying flows, and importing results into the active tab.

## Demos

Click the image below to watch the video:
[![LLM Plugin screenshot](images/plugin.png)](https://youtu.be/Z8nCtEs4Ows)

With python-venv node:
[![LLM Plugin with python-venv node](images/with_python_venv.png)](https://youtu.be/WAAmw7IXev0)

With Dashboard 2.0:
[![LLM Plugin with Dashboard 2.0](images/with_dashboard.png)](https://youtu.be/HPYuoEL6y_o)

## Install

Add from "Manage palette" or

```bash
npm install @background404/node-red-contrib-llm-plugin
```

Restart Node-RED after install.

## Quick Start

1. Open the LLM Plugin sidebar.
2. Configure provider in Settings:
- Ollama: set URL (default `http://localhost:11434`)
- OpenAI: set API key
3. Pick which flow tabs to include via the **flow selector** (defaults to *Current Open Flow*; check additional tabs in the dropdown to send them too).
4. Select **Agent** mode for auto-apply, or **Ask** mode for manual import.
5. Enter model and prompt.
6. Click **Send** to generate and/or apply the flow.

## Recommended Usage

It is highly recommended to add custom or non-core nodes to your flow before passing them to the LLM. Since the LLM does not inherently know the required properties of custom nodes, keeping a small sample flow in the active tab ensures it is sent as the *Current Open Flow*.
The model will then follow real node/property patterns from that sample instead of relying on fixed per-node prompt rules.

## Features

- **Chat history**: conversations are persisted on the server and can be loaded, deleted, or continued across sessions.
- **Checkpoint / Restore**: flow snapshots are saved before and after each import, allowing rollback to any previous state.
- **Custom system prompt**: add persistent instructions (preferred node types, coding style, language) via Settings.

## Flow Import

- Supports Vibe Schema and raw Node-RED JSON.
- Accepts mixed response text + JSON (with or without code fences).
- Preserves robust parsing when function code contains comment tokens in JSON strings.
- Agent mode seamlessly handles connection updates and LLM-driven deletions.
- Apply strategy is model-driven via top-level `applyMode` (`edit-only`, `merge`, `overwrite`, `delete-only`, with a safe fallback to `edit-only`).

## More Docs

- Implementation guide: [src/README.md](src/README.md)
- Prompt template: [src/prompt_system.txt](src/prompt_system.txt)

## Security Notice

When sharing your Node-RED project (e.g., via Git, exporting the user directory, or sharing the environment), please be aware that this plugin saves your API keys (like OpenAI) using the standard Node-RED settings API (`RED.settings`). 
Depending on your Node-RED configuration, these settings may be stored in files such as `flows_cred.json` or `.config.json` within your Node-RED user directory. 
**This is not unique to this plugin; any Node-RED node or plugin storing credentials works similarly.**
Always ensure you ignore these credential files in your `.gitignore` and do not share them publicly to prevent accidental leakage of your private API keys. The plugin itself masks keys in the UI and redacts them from logs, but the underlying storage file on your disk remains sensitive.

## Notes

- This plugin is under active development.
- Model output quality varies by model and prompt.

## Links

Please report issues at: [GitHub Issues](https://github.com/404background/node-red-contrib-llm-plugin/issues)

My article: [『Node-REDのプラグインを開発してみる　その2（LLM Plugin v0.4.0）』](https://404background.com/program/node-red-plugin-2/)
