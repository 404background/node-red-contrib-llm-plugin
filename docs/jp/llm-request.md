# `llm-request` ノード

LLM Plugin のサイドバーと並んで登録されるノード(パレットカテゴリ **llm-plugin**)。
フローから LLM を呼び出す。`msg.payload` を送り、モデルの応答を `msg.payload` に
入れて出力する。プロバイダ・モデル・(任意の)システムプロンプトはノードに設定し、
API キーと URL は **LLM Plugin サイドバー**(Settings)から継承する。

このノードはフローを編集しない。以前の設計には、応答を開いているエディタに適用する
**Agent** モードがあったが、リリース前に取り下げた。動いているフローの中から行われる
編集はデバッグが難しく、単純に入力と出力を扱うノードのほうが部品として使いやすいから
である。Agent モードがあった最後の版はコミット `2c0e3e9`(`node/llm-request/`、
`src/agent_apply.js`、`src/agent_dispatch.js`、`node/lib/admin_api.js`)。LLM による
フローの編集はサイドバーの役割である。

## `llm-request` ノードの設定

| フィールド | 説明 |
|-------|-------|
| Provider | Ollama / OpenAI / Custom。キーと URL はサイドバー由来。 |
| Model | フリーテキスト(例: `llama3.1`, `gpt-5-mini`)。**必須**。`msg.model` でメッセージ単位に上書き。 |
| System | 任意のシステムプロンプト。毎回のリクエストに付ける。`msg.system` でメッセージ単位に上書き(空文字列なら送らない)。サイドバーのシステムプロンプトは**使わない**。あれはフロー編集のためのものだからである。 |
| Timeout | 秒。デフォルト **3600**(1時間 — ローカル LLM は遅いことがある)。`0` = 無制限。`msg.timeout` でメッセージ単位に上書き。 |

**入力:** `payload`(プロンプト。そのまま送る。オブジェクトは JSON 文字列化)、
任意で `system`・`model`・`timeout`。
**出力:** `payload`(応答テキスト)と `llm`(`{ provider, model, elapsed }`。elapsed は
ミリ秒)。メッセージのほかのプロパティはそのまま通る。

**ステータス:** リクエスト中は青い点(経過秒数を更新)、成功で緑の `done (…)`、
失敗で赤の `error` / `timeout`。エラーは `done(err)` に渡る(Catch ノードで拾える)。
本文に API キーが含まれていても伏せ字にしてから渡す。

## プロバイダに送るもの

メッセージ1件につきリクエスト1回。送るのはシステムプロンプト(あれば)とプロンプト
だけで、プラグイン独自のプロンプトも、フローのコンテキストも会話履歴も加えない。
長さの制限もかけない(サイドバーのプロンプト長の制限は適用しない)。

| プロバイダ | API |
|----------|-----|
| OpenAI | **Responses API**(`POST /v1/responses`)をストリーミングで呼ぶ。システムプロンプトは `instructions` として送る。`store: false` なので OpenAI 側に応答は保存されない。新しいモデルはこの API で提供され、この API でしか使えないものもある。 |
| Custom | **Chat Completions**(`POST {Base URL}/chat/completions`)をストリーミングで呼ぶ。OpenAI 互換サーバ(llama.cpp、LM Studio、vLLM、LocalAI など)が話す形式である。 |
| Ollama | `POST /api/chat` をストリーミングで呼ぶ。 |

どのアダプタもストリーミングで呼ぶ。ストリーミングしないと、300 秒を超える応答は
ヘッダ待ちのまま切れてしまうからである。終了の印なしに途切れたストリームは、短い応答
として渡さずにエラーにする。OpenAI の応答が `incomplete` で終わった場合
(`max_output_tokens` など)も同様で、理由をエラーに含める。

## ファイル構成

```
node/
  llm-request/llm-request.js    ランタイム側: msg → プロンプト、プロバイダ呼び出し、msg 出力
  llm-request/llm-request.html  エディタ側: 設定ダイアログとヘルプパネル
```

共有 LLM エンジン(設定、認証情報、プロバイダアダプタ、伏せ字処理)は
[`src/llm_core.js`](../../src/llm_core.js) にあり、サイドバーと共用する。ノードが持つのは
ノードらしい部分だけ(`msg` の入出力、ステータス、タイムアウト、設定)である。

## サンプル

**メニュー → 読み込み → サンプル → llm-plugin → llm-nodes**: `llm-request` ノード2つ。
普通の質問と、システムプロンプトで動く翻訳の例(コアノードのみ)。デプロイ前に
両方のノードにモデルを設定すること。
