# LLM Plugin for Node-RED

[![GitHub Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=ff69b4)](https://github.com/sponsors/404background)
[![npm version](https://img.shields.io/npm/v/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)

LLM Plugin is a Node-RED sidebar extension for chatting with LLMs, generating/modifying flows, and importing results into the active tab. It also ships an **LLM workflow node** so flows can call an LLM (and, in Agent mode, add nodes to a flow) without the sidebar — see [Workflow Node](#workflow-node).

## Demos

Click the image below to watch the video:
[![LLM Plugin screenshot](images/plugin.png)](https://youtu.be/Z8nCtEs4Ows)

With python-venv node:
[![LLM Plugin with python-venv node](images/with_python_venv.png)](https://youtu.be/WAAmw7IXev0)

With Dashboard 2.0:
[![LLM Plugin with Dashboard 2.0](images/with_dashboard.png)](https://youtu.be/HPYuoEL6y_o)

With Node-RED MCU (v0.5):
[![LLM Plugin with Node-RED MCU(v0.5)](images/v0.5_thumbnail.jpg)](https://youtu.be/bnRr9mLuTVQ)

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
- Custom (OpenAI-compatible): set Base URL (e.g. `http://localhost:8080/v1`) and, if required, an API key. Use for llama.cpp, LM Studio, vLLM, LocalAI, or any other server speaking the OpenAI chat-completions API.
3. Pick which flow tabs to include via the **flow selector** (defaults to *Current Open Flow*; check additional tabs in the dropdown to send them too).
4. Select **Agent** mode for auto-apply, or **Ask** mode for manual import.
5. Enter model and prompt.
6. Click **Send** to generate and/or apply the flow.

## Recommended Usage

It is highly recommended to add custom or non-core nodes to your flow before passing them to the LLM. Since the LLM does not inherently know the required properties of custom nodes, keeping a small sample flow in the active tab ensures it is sent as the *Current Open Flow*.
The model will then follow real node/property patterns from that sample instead of relying on fixed per-node prompt rules.

The demo video above shows this pattern with the
[python-venv](https://flows.nodered.org/node/@background404/node-red-contrib-python-venv)
node: a minimal inject → venv → debug flow kept in the active tab.

## Features

- **Chat history**: conversations are persisted on the server and can be loaded, deleted, or continued across sessions.
- **Checkpoint / Restore**: a snapshot of the flow is taken immediately before each import, and a per-message Restore button rewinds the workspace to that pre-edit state.
- **Custom system prompt**: add persistent instructions (preferred node types, coding style, language) via Settings.

## Flow Import

- Supports Vibe Schema and raw Node-RED JSON.
- Accepts mixed response text + JSON (with or without code fences).
- Preserves robust parsing when function code contains comment tokens in JSON strings.
- Agent mode seamlessly handles connection updates and LLM-driven deletions.
- All schema applies use merge semantics: listed nodes are added or updated, aliases mapped to `null` are deleted, anything not mentioned is left alone.

## Workflow Node

The package also registers an `LLM` runtime node (palette category
**llm-plugin**) so a flow can call an LLM. Provider, model and target flows are
set on the node; API keys and URLs come from the sidebar Settings.

- **Ask** — returns the model's reply on `msg.payload`. Selected flows are sent as context.
- **Agent** — same, then applies the changes **live in the open editor**, like the sidebar; review and Deploy.

Flows are a multi-select (none / one / many) and apply in both modes. Agent mode
needs an open editor; node interactions are not saved to chat history and have no
Restore Checkpoint. The node shows its progress as a status (elapsed time while
waiting) and has a configurable timeout (default 3600 s — local LLMs can be slow;
0 = no limit, `msg.timeout` overrides).

Agent mode can optionally **Auto deploy** right after applying (a developer
feature — no review step; intended for automated dev loops, not production).

To try it, import an example via **Menu → Import → Examples**:
`llm-nodes` (Ask + Agent demo — Agent edits appear live in the editor and you
review and Deploy manually) or `llm-self-feedback` (a self-improvement loop:
Agent + Auto deploy, hard-capped at 5 iterations).

See **[docs/en/runtime-node.md](docs/en/runtime-node.md)** ([日本語](docs/jp/runtime-node.md)) for full details.

## Documentation

All developer documentation lives in **[`docs/`](docs/)**, with English (`docs/en/`)
and Japanese (`docs/jp/`) versions of every page. Start from the
[documentation hub](docs/README.md).

> **AI agents / contributors:** when developing on this repository, read the
> `docs/` folder first — especially [`design`](docs/en/design.md) (why the
> processing flow, rules, and priorities are the way they are) and
> [`architecture`](docs/en/architecture.md) (what each module does). Docs are
> consolidated here rather than scattered across `src/`, `src/core/`, and `node/`.
> Keep the `en/` and `jp/` versions in sync when you change either.

- Documentation hub: [docs/README.md](docs/README.md)
- Design notes (flow / rules / priorities & rationale): [en](docs/en/design.md) · [jp](docs/jp/design.md)
- Architecture (implementation guide): [en](docs/en/architecture.md) · [jp](docs/jp/architecture.md)
- Vibe Schema: [en](docs/en/vibe-schema.md) · [jp](docs/jp/vibe-schema.md)
- Layout engine: [en](docs/en/layout.md) · [jp](docs/jp/layout.md)
- Workflow node: [en](docs/en/runtime-node.md) · [jp](docs/jp/runtime-node.md)
- Prompt template: [src/prompt_system.txt](src/prompt_system.txt)

## Security Notice

API keys (OpenAI and Custom-endpoint) are stored encrypted in `<userDir>/llm-plugin/credentials.json` using AES-256-CTR with your Node-RED `credentialSecret` (the same algorithm Node-RED uses for `flows_cred.json`). Non-secret settings stay in `RED.settings`. The plugin also masks keys in the UI and redacts them from logs.

The encrypted file is only as safe as your `credentialSecret`. When sharing your Node-RED user directory (Git, backups, environment exports), keep `credentials.json`, `flows_cred.json`, `.config.*.json`, and your `settings.js` out of the share — and never publish your `credentialSecret`. Older installs that stored the key in plaintext are migrated to the encrypted file automatically on first boot.

## Notes

- This plugin is under active development.
- Model output quality varies by model and prompt.
- **Cloud / sandboxed Node-RED hosts** (e.g. enebular): chat history
  and flow checkpoints are persisted to `<userDir>/llm-plugin/` when
  that location is writable, else to the OS temp directory, else
  in-memory only. The plugin never writes to its own install dir, so
  it loads cleanly on read-only plugin filesystems.

## Links

Please report issues at: [GitHub Issues](https://github.com/404background/node-red-contrib-llm-plugin/issues)

Node-RED [API Reference](https://nodered.org/docs/api/)

My article: [『Node-REDのプラグインを開発してみる　その2（LLM Plugin v0.4.0）』](https://404background.com/program/node-red-plugin-2/)

