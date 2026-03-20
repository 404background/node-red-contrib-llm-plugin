# LLM Plugin for Node-RED

LLM Plugin is a Node-RED sidebar extension for chatting with LLMs, generating/modifying flows, and importing results into the active tab.

[![LLM Plugin screenshot](images/plugin.png)](https://youtu.be/DSk61QEyg0w)

## Install

```bash
npm install @background404/node-red-contrib-llm-plugin
```

Restart Node-RED after install.

## Quick Start

1. Open the LLM Plugin sidebar.
2. Configure provider in Settings:
- Ollama: set URL (default `http://localhost:11434`)
- OpenAI: set API key
3. Enter model and prompt.
4. Enable **Send current flow** to include active-tab context.
5. Use **Agent** mode for auto-apply, or **Ask** mode for manual import.
6. Apply strategy is decided by the model (`applyMode`) and enforced by the importer (safe fallback: `edit-only`).

## Recommended Usage

For custom/community nodes, keep a small sample flow in the active tab and enable **Send current flow**.
The model then follows real node/property patterns from that sample instead of relying on fixed per-node prompt rules.

## Flow Import

- Supports Vibe Schema and raw Node-RED JSON.
- Accepts mixed response text + JSON (with or without code fences).
- Preserves robust parsing when function code contains comment tokens in JSON strings.
- Agent mode supports connection updates, LLM-driven deletions, and checkpoint-based restore.
- Apply mode is model-driven via top-level `applyMode` (`edit-only`, `merge`, `overwrite`, `delete-only`).

## More Docs

- Implementation guide: [src/README.md](src/README.md)
- Prompt template: [src/prompt_system.txt](src/prompt_system.txt)

## Notes

- This plugin is under active development.
- Model output quality varies by model and prompt.

## Feedback

Please report issues at:
https://github.com/404background/node-red-contrib-llm-plugin/issues
