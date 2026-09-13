# LLM Plugin for Node-RED

[![GitHub Sponsor](https://img.shields.io/static/v1?label=Sponsor&message=%E2%9D%A4&logo=GitHub&color=ff69b4)](https://github.com/sponsors/404background)
[![npm version](https://img.shields.io/npm/v/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@background404/node-red-contrib-llm-plugin?style=flat-square)](https://www.npmjs.com/package/@background404/node-red-contrib-llm-plugin)

LLM Plugin is a Node-RED sidebar extension for chatting with LLMs, generating/modifying flows, and importing results into the active tab. It also ships an **`llm-request` node** so flows can call an LLM (and, in Agent mode, add nodes to a flow) without the sidebar — see [`llm-request` node](#llm-request-node).

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

This covers **wiring as well as properties**. How many outputs a node has, and
what each one carries (stdout / stderr / status, …), lives in the node's editor
definition — not in the flow JSON — so it never reaches the model on its own. A
sample with every output already connected is what tells it, and is the
difference between three outputs wired one each and two links on the first one.

The demo video above shows this pattern with the
[python-venv](https://flows.nodered.org/node/@background404/node-red-contrib-python-venv)
node: a minimal inject → venv → debug flow kept in the active tab.

## Features

- **Chat history**: conversations are persisted on the server and can be loaded, deleted, or continued across sessions.
- **Checkpoint / Restore**: a snapshot of the flow is taken immediately before each import, and a per-message Restore button rewinds the workspace to that pre-edit state.
- **Custom system prompt**: add persistent instructions (preferred node types, coding style, language) via Settings.
- **Forgiving import**: the flow in a reply is found whether it is fenced or not and whatever prose surrounds it.
- **Edits are merges**: what the reply lists is added or updated, what it maps to `null` is deleted, and the rest of your flow is left alone — so a partial answer never rewrites the whole tab.

## `llm-request` node

The package also registers an `llm-request` node (palette category
**llm-plugin**) so a flow can call an LLM without the sidebar.

- **Ask** — returns the model's reply on `msg.payload`. The flows selected on the node are sent as context.
- **Agent** — same, then applies the changes **live in the open editor**, like the sidebar; you review and Deploy.

Provider, model and target flows are set on the `llm-request` node; API keys and
URLs come from the sidebar Settings. Agent mode needs an open editor. A node's
edit is not saved to chat history, but a checkpoint of the target flows is taken
immediately before it and is listed in the sidebar's **Restore Points** dialog,
so it can be rolled back.

Two examples ship with the package — import them via **Menu → Import →
Examples**: `llm-nodes` (Ask and Agent side by side, deployed manually) and
`llm-self-feedback` (a developer self-improvement loop using Auto deploy,
hard-capped at 5 iterations).

Field-by-field reference, how Agent mode reaches the canvas, and the Auto deploy
caveats: **[docs/en/llm-request.md](docs/en/llm-request.md)**
([日本語](docs/jp/llm-request.md)).

## Documentation

This README covers install and usage. Everything else — how the plugin works and
why — lives in **[`docs/`](docs/README.md)**, with an English (`docs/en/`) and a
Japanese (`docs/jp/`) version of every page.

| Document | Covers | English | 日本語 |
|----------|--------|---------|--------|
| Design notes | Processing flow, rules, priorities, and the reasoning behind them | [en](docs/en/design.md) | [jp](docs/jp/design.md) |
| Architecture | Module-by-module guide, HTTP endpoints, security measures | [en](docs/en/architecture.md) | [jp](docs/jp/architecture.md) |
| Vibe Schema | The intermediate flow format the LLM reads and writes | [en](docs/en/vibe-schema.md) | [jp](docs/jp/vibe-schema.md) |
| Layout | Canvas layout engine, spacing rules, comment placement | [en](docs/en/layout.md) | [jp](docs/jp/layout.md) |
| `llm-request` node | The node a flow calls an LLM from, in full | [en](docs/en/llm-request.md) | [jp](docs/jp/llm-request.md) |

Two more, kept next to what they describe:

- Tests: [`test/README.md`](test/README.md) — the suites, what each one guards, and how to run the live round-trip against a real LLM endpoint.
- Prompt template: [`src/prompt_system.txt`](src/prompt_system.txt) — the system prompt the LLM receives.

> **AI agents / contributors:** read [`docs/`](docs/README.md) before editing —
> start with *Design notes* (why the flow, rules and priorities are what they
> are) and *Architecture* (what each module does). Docs are consolidated there
> rather than scattered across `src/`, `src/core/` and `node/`; keep the `en/`
> and `jp/` versions in sync when you change either.

## Security Notice

### Agent mode executes what the model writes

Agent mode applies the model's reply to your canvas **without a confirmation step**, and **Auto deploy** deploys it immediately. Generated flows can contain `function` nodes (arbitrary JavaScript in the Node-RED process) and `exec` nodes (arbitrary shell commands), and there is deliberately no node-type restriction — limiting what the model may build would defeat the feature.

So whoever controls the model's output controls the Node-RED host. Point Agent mode only at an LLM endpoint you trust, and **do not feed untrusted text into an Agent node** (an `http in` payload, an inbound MQTT message, scraped page content). With Auto deploy enabled that is a direct path from a remote string to code execution on your machine. Ask mode has no such property — it only returns text.

### Credentials and shared instances

API keys are stored encrypted in `<userDir>/llm-plugin/credentials.json`, masked in the UI and redacted from logs, and a stored key is never carried over to a new endpoint behind your back. With `adminAuth` enabled the plugin's endpoints require an authenticated editor session — but Agent-mode results are broadcast to **every** open editor session, so on a shared instance one user's Agent node edits everyone's canvas.

When sharing your Node-RED user directory (Git, backups, environment exports), keep `credentials.json`, `flows_cred.json`, `.config.*.json` and `settings.js` out of the share.

Every measure and the reasoning behind it:
[architecture → Security measures](docs/en/architecture.md#security-measures)
([日本語](docs/jp/architecture.md#セキュリティ対策)).

## Notes

- This plugin is under active development.
- Model output quality varies by model and prompt.
- **Cloud / sandboxed Node-RED hosts** (e.g. enebular): chat history
  and flow checkpoints are persisted to `<userDir>/llm-plugin/` when
  that location is writable, and kept in memory only when it is not —
  nothing survives a restart in that case. The plugin never writes to
  its own install dir, so it loads cleanly on read-only plugin
  filesystems.

## Links

Please report issues at: [GitHub Issues](https://github.com/404background/node-red-contrib-llm-plugin/issues)

Node-RED [API Reference](https://nodered.org/docs/api/)

My article: [『Node-REDのプラグインを開発してみる　その2（LLM Plugin v0.4.0）』](https://404background.com/program/node-red-plugin-2/)

