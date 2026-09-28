# Documentation Hub / ドキュメントハブ

All developer-facing documentation for this project lives **here** under `docs/`,
so it is not scattered across `src/`, `src/core/`, and `node/`. Every document has
an English (`en/`) and a Japanese (`jp/`) version with identical content.

このプロジェクトの開発者向けドキュメントは、`src/` や `node/` に散らばらせず、すべて
この `docs/` 以下に集約しています。各ドキュメントは英語版(`en/`)と日本語版(`jp/`)を
用意しており、内容は同一です。

> **AI agents / contributors — read this first.**
> When working on this repository, consult `docs/` before editing. Start with
> **`design`** (why the flow/rules/priorities are what they are) and
> **`architecture`** (what each module does). Keep both language versions in sync:
> if you change one, update its counterpart in the other folder.
>
> **AI エージェント・コントリビューターへ。**
> このリポジトリで作業するときは、まず `docs/` を確認してください。特に
> **`design`**(処理フロー・ルール・優先順位とその理由)と **`architecture`**
> (各モジュールの役割)から読むこと。両言語版は常に同期させ、片方を更新したら
> もう片方も更新してください。

## Documents / ドキュメント一覧

| Topic | English | 日本語 | What it covers / 内容 |
|-------|---------|--------|------------------------|
| Design notes | [docs/en/design.md](./en/design.md) | [docs/jp/design.md](./jp/design.md) | Processing flow, rules, priorities, and the reasoning behind them / 処理フロー・ルール・優先順位とその理由 |
| Architecture | [docs/en/architecture.md](./en/architecture.md) | [docs/jp/architecture.md](./jp/architecture.md) | Module-by-module implementation guide, HTTP endpoints and their permissions, security measures, the test suites / モジュール別の実装ガイド、HTTP エンドポイントと権限、セキュリティ対策、テストスイート |
| Vibe Schema | [docs/en/vibe-schema.md](./en/vibe-schema.md) | [docs/jp/vibe-schema.md](./jp/vibe-schema.md) | The intermediate flow format (LLM ↔ Node-RED) / 中間フロー表現の仕様 |
| Layout | [docs/en/layout.md](./en/layout.md) | [docs/jp/layout.md](./jp/layout.md) | Canvas layout engine, spacing rules, comment placement / レイアウトエンジンと配置ルール |
| `llm-request` node | [docs/en/llm-request.md](./en/llm-request.md) | [docs/jp/llm-request.md](./jp/llm-request.md) | The node a flow calls an LLM from / フローから LLM を呼ぶノード |

## Other references / その他の参照

- Prompt template: [`src/prompt_system.txt`](../src/prompt_system.txt) — the system
  prompt the LLM receives (the rules it must follow). / LLM に渡すシステムプロンプト。
- Tests: [`test/README.md`](../test/README.md) — the suites, what each one
  guards, and the live round-trip. Kept with the tests themselves. /
  テストのドキュメント。各スイートが守っているものと実 LLM との往復テスト。
- User-facing README: [`README.md`](../README.md) — install and usage. / インストールと使い方。
