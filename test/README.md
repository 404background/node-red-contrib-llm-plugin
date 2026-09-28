# Tests

Everything about this project's tests lives here: what the suites are, what each
one protects, and how to run the live suites. The rest of the developer
documentation is in [`../docs/`](../docs/README.md).

日本語版は[このページの後半](#テスト)にあります。

## Running

```bash
npm test                   # test/unit: the static suites — nothing but Node required
npm run test:llm           # test/llm: the node, the round-trip and the scenarios against a real LLM
npm run test:llm:accuracy  # test/llm: the pass rate of every model on every configured server
```

```
test/
  README.md, helpers.js   shared by both
  unit/                   the plugin's code, no model: npm test
  llm/                    a real model's replies: npm run test:llm, test:llm:accuracy
    llm-test-config.json  this machine's servers and models (git-ignored)
    results/              what the runs produced (git-ignored)
```

`npm test` is the gate: it makes no network call, needs no model, and is the one
that must pass before a change lands. `npm run test:llm` is deliberately
separate — it talks to an actual model, so it cannot be deterministic.

## Offline suites

Each suite states the guarantee it protects in its own header comment, and that
comment — not the assertion names — is the place to look first. `npm test` is
`test/unit/run_all.js`: it finds every `*.test.js` in `test/unit/` and runs each in
its own process, in name order, so a new suite runs the moment it is written.
Every suite is run even after one fails, and the tally at the end names the
ones that did.

| Suite | Guards |
|-------|--------|
| `canvas_layout` | The layout engine: one uniform `dy` for cross-component push, insertion reflow anchored in place, a component the edit did not touch translated as a whole rather than sheared, every box fitted and aligned, and `settleCollisions` leaving no node, caption or box on another (a stray note is the one that moves). Everything the layout places or moves lands on the grid (centre y, left edge), sequences one pitch apart boxed or not. |
| `chat_history` | Several chats, or all of them, are deleted together behind one confirmation that says how many; deleting the open chat starts a new one; cancelling deletes nothing. Opening a chat hands back the flows it was working on. |
| `flow_converter_core` | Auto-stub creation — a config node's own value props (an `mqtt-broker`'s `broker: "localhost"`) are not dangling config references — and that the single-line `func` pretty-printer only ever changes whitespace. |
| `flow_selection` | In jsdom, through the editor's start-up order (tabs added one by one, then `flows:loaded`): a restart keeps the saved selection, the latest chat restores its flows, a new chat takes the open flow, and a selection whose flows are gone becomes the open flow. |
| `llm_core` | The credential key is the plugin's own and survives the user setting `credentialSecret`; older blobs still decrypt; a failed settings write reaches the caller; settings and the key an older build kept in the runtime settings move into `<userDir>/llm-plugin`, where everything the plugin keeps is; a configured API key escapes through none of its exits; a request with no key set says so; the system prompt ships in the package. |
| `schema_conventions` | Both directions of the Vibe Schema boundary: `_`-prefixed metadata reaches neither the LLM nor the canvas, and the editor flags (`disabled` / `showLabel`) map to `d` / `l` only when set. |
| `junction_preserve` | The two entities an apply loses first: a junction survives an edit **with its wires** (it sits mid-chain, so losing it breaks the path silently), group membership survives, a deleted member is pruned from the group's `nodes`, and a locked workspace falls back rather than half-detaching. Junctions are the user's: an edit that leaves its targets in place does not move one, and none rewires it or lands on it; routing between two boxes follows the box it feeds when that box is pushed down; the context reads a wire through a junction or a link out → link in pair as a connection to where it leads, and restating that connection adds no wire, while removing it cuts it inside the routing, keeps every other connection and takes down the routing left idle — across two tabs too when both are in the context, never touching a tab outside it; a link node's hover-only virtual link does not join two sequences. |
| `cross_flow_isolation` | The flow selection is the boundary: an edit may only write to the flows that were sent. A reply is read against the alias numbering the model was shown over every context flow, so an alias names one node and it is edited on its own tab; node ids inside properties round-trip as aliases. |
| `import_safety` | Deletions reach the flow that owns them and no other; a failed import rolls back completely, junctions, groups and already-rewritten config nodes included; flow context follows config references transitively and through arrays. |
| `node_secret_exit` | The `llm-request` node's error exit is a secret exit — an endpoint that echoes the Authorization header into its error body must not put the stored key on a Catch node's `msg.error`. |
| `reply_rendering` | In jsdom, with the scripts the editor loads: a reply's raw HTML is text, unsafe links lose their `href`, an image becomes a link, code blocks and tables still render, and the plugin's DOMPurify leaves the editor's global one alone. |
| `deploy_churn` | Applying an edit does not make the runtime restart nodes it did not edit: key-set fidelity against `diffNodes`, so no stray property lands on an untouched node. |
| `incremental_apply` | An edit touches only what it edits. The work done is asserted — which entities were removed, which nodes were handed to `import()`, which links were cut and made — not just the end state. |
| `http_transport` | The provider adapters against a real loopback server: Ollama, chat completions (Custom) and the Responses API (OpenAI) each join a streamed reply, a timeout surfaces as `code === 'ETIMEDOUT'`, and a stream cut before its end marker — or an OpenAI response that ends `incomplete` or `failed` — is an error, not a short reply. |
| `json_repair` | A reply whose JSON is not quite JSON: what is recovered (an unterminated string, unescaped quotes inside a value, a JSONata expression whose own outer quotes the repair ate) and what is left to fail loudly — a block that was already valid is never "repaired", an expression that already reads correctly is not re-quoted, and a block that was recovered is not also reported as a failure. Also `parseJsonBlock`, the reading the sidebar folds a JSON block on. |
| `ui_templates` | The seam between `llm_plugin.html` and `ui_core.js`: every id the JS clones exists, every template has a single well-formed root, and the classes reached for after cloning are in the markup. Also the two static seams that rot silently — the docs link in the header, and the `llm-request` node, which must stay a thin caller of the shared core (no editor path, no plugin logic in its html), be registered and published by `package.json`, and keep a help panel short enough to read. And the plugin raises no editor notification of its own: nothing calls `RED.notify`, and a warning is a line in the chat. |
| `server_api` | The admin routes' guarantees: the unauthenticated `src/` routes serve exactly what `client.js` loads, checkpoint `meta` is bounded, an unknown provider is refused, a chat is deleted by id. |
| `group_schema` | Group boxes are the user's: a reply cannot create, edit or delete one, and the context shows none without moving any node alias. An edit keeps a box around its one sequence: a new node wired into it joins the box, a comment follows the node its `above` names into (or out of) a box, a box stays when emptied, and every box is refitted around where its members end up, clear of the next sequence. A branch added inside a box lands clear of the others in port order. |

`helpers.js` holds the assertion counter and `loadPluginSandbox(RED, opts)`, which
runs the real client modules in a vm context in the same order `client.js` uses —
so a load-order dependency cannot pass here and fail in production. Pass
`opts.fetch` when the requests going out are what the suite asserts. `coreRED()`
is its runtime counterpart: the minimal Node-RED that `llm_core` and the
`llm-request` node need to be constructed. Beyond those, each suite keeps its own
`buildRED`: the registries it sets up and the state it captures are the point of
that suite.

## Live suites (`npm run test:llm`)

`llm_node.test.js` sends messages through the `llm-request` node to a real model:
the reply comes back on `msg.payload` with the other properties untouched,
`msg.llm` is filled in, the node's system prompt is followed and `msg.system`
overrides it, an object payload is sent as JSON, `msg.model` and `msg.timeout`
are honoured, and a blank payload is refused before any request.

`llm_roundtrip.test.js` drives the same engine the sidebar and the `llm-request`
node use — prompt construction, a real HTTP call to the provider, Vibe Schema
extraction from the reply, and conversion into an importable flow — so it catches
breakage that only shows up against an actual model.

Model output is not deterministic, so its assertions are structural rather than
exact: a schema must be extractable, and the flow it yields must be one
`RED.nodes.import` would accept.

`llm_scenarios.test.js` goes one step further: realistic requests — building, inserting, editing properties (inject, function, change with JSONata, debug), renaming, disabling, deleting nodes and single connections (also through a junction or link nodes), comments, layout, group boxes, config nodes (reuse, never invent), several sequences, switches and multi-output functions, other flows, a request for a node that does not exist, and questions in both modes — are sent to the model, applied to a mocked editor through the real importer, and the canvas is checked for the outcome the user asked for, plus two invariants (every wire lands on a node, nothing overlaps). Each scenario gets `attempts` tries. `LLM_TEST_MODELS=gemma3:4b,gemma4:e2b` runs it against several models and prints a table; `LLM_TEST_SHOW_FAILED=1` prints the replies that failed. `LLM_TEST_ONLY=delete,switch` runs only the scenarios whose name contains one of them. `LLM_TEST_RUNS=5` runs each scenario 5 times without retries and reports how many passed, plus an overall pass rate per model (a run the endpoint never answered, even after retries, is counted apart as unanswered); `LLM_TEST_URL` points it at another Ollama server (a Tailscale address works). `LLM_TEST_PROVIDER=openai` runs it against OpenAI with the key in `LLM_TEST_OPENAI_KEY` or the git-ignored `.credentials.json` at the repository root (`{ "OpenAI": "sk-..." }`); the tokens the API reports (reasoning included) are counted, and `LLM_TEST_TOKEN_BUDGET=200000` stops before the next scenario once that many are spent. `LLM_TEST_REPLAY=run.log[,more.log]` sends nothing: it takes the failed replies a run logged with `LLM_TEST_SHOW_FAILED=1`, judges them again against the code as it is now, and reports which would pass (a reply longer than the 3000 characters the log keeps is marked as cut) — a way to see what a parser or importer change buys without the server.

`npm run test:llm` is `test/llm/run_llm.js`: the node test and the round-trip once
per model given, then the scenarios.

Endpoint and model come from `test/llm/llm-test-config.json`, next to the suites it
configures. That file is git-ignored, so copy the template to create it:

```bash
cp test/llm/llm-test-config.example.json test/llm/llm-test-config.json
```

| Field | Meaning |
|-------|---------|
| `ollamaUrl` | Endpoint to test against (default `http://localhost:11434`) |
| `model` | Model name (default `gemma3:4b`) |
| `timeoutMs` | Per-request timeout |
| `attempts` | Retries allowed for a reply to contain a parseable schema — small models sometimes answer in prose first |
| `showReplies` | Print the model's raw replies so you can see what it actually said |

Arguments override the file for a single run (`npm run test:llm -- --help`):

```bash
npm run test:llm -- --url 192.0.2.10 --model gemma3:4b,gemma4:e4b
npm run test:llm -- --url http://192.0.2.10:11434 --model gemma3:4b --only delete,switch --runs 5
```

| Argument | Meaning |
|----------|---------|
| `--url <host\|url>` | Ollama server. A bare host gets `http://` and port `11434` |
| `--model <a[,b]>` | Model, or several: the round-trip runs once per model, the scenarios print a table |
| `--only <a[,b]>` | Scenarios whose name contains one of these |
| `--runs <n>` | Each scenario n times without retries, with a pass rate |
| `--provider <name>` | `ollama` (default) or `openai` |
| `--show-failed` | Print the replies that failed |

Each flag sets the matching `LLM_TEST_*` variable (`LLM_TEST_URL`, `LLM_TEST_MODEL(S)`,
`LLM_TEST_ONLY`, `LLM_TEST_RUNS`, `LLM_TEST_PROVIDER`, `LLM_TEST_SHOW_FAILED`), so the
variables still work, and a flag wins over them. Each suite also takes the flags when
run directly (`node test/llm/llm_scenarios.test.js --url …`).

### Accuracy (`npm run test:llm:accuracy`)

`test/llm/llm_accuracy.js` measures how well each model does the sidebar's job: for
every server under `accuracy.servers` in the config, it lists the models the server
has (embedding models aside, and cloud models: those run at ollama.com whichever server
relays them, so they are measured once, on a server marked `"cloud": true`, which measures
only them), checks each one loads, and runs the scenarios
with `runs` per scenario. Servers run in parallel, the models on one server one after
another. `--server`, `--model` and `--runs` narrow a run.

```json
"accuracy": { "runs": 3, "servers": [
  { "name": "gpu-box", "url": "http://192.0.2.10:11434" },
  { "name": "slow-box", "url": "http://192.0.2.11:11434", "runs": 1, "skip": ["llama3.2-vision:latest"] },
  { "name": "ollama-cloud", "url": "http://localhost:11434", "cloud": true } ] }
```

The results stay on this machine, in `test/llm/results/`: `accuracy.md` (the latest
pass rate of each server and model, with a per-scenario table), `accuracy.json` (every
run, appended) and the raw log of each run in a dated folder.

Exit codes: `0` passed, `1` failed, `2` skipped — the endpoint was unreachable,
the model was not installed, or the endpoint failed to serve the request.

## Adding a suite

1. Open with a header comment naming the guarantee and why it exists — the
   history that made it necessary is the useful part.
2. Name it `<what it guards>.test.js`. A suite that needs no model goes in
   `test/unit/`, where the runner discovers it; one that talks to a model goes in
   `test/llm/` and is added to `run_llm.js`.
3. One behaviour, one suite. Where two suites drive the same path — the apply
   is the obvious one — each asserts its own layer and says in its header what
   it deliberately leaves to the other: `incremental_apply` owns the work the
   editor does, `deploy_churn` owns whether the runtime would restart a node,
   `junction_preserve` owns junctions and groups. Asserting a behaviour twice
   means two suites to update for one change, and neither one tells you which
   is authoritative.
4. Test code is tracked. `.gitignore` leaves out only what describes this machine or
   a run of it: `test/llm/llm-test-config.json` (it names hosts), `test/llm/results/`
   and the suites' `.tmp-*` storage. Tests are not published to npm (`files` in
   `package.json`).

---

# テスト

このプロジェクトのテストに関することはすべてここにまとめてある。どんなスイートが
あり、それぞれ何を守っているか、実 LLM とのテストをどう動かすか。その他の
開発者向けドキュメントは [`../docs/`](../docs/README.md) にある。

## 実行方法

```bash
npm test                   # test/unit: 静的なスイート。Node 以外に必要なものはない
npm run test:llm           # test/llm: ノード・往復・シナリオを実際の LLM で
npm run test:llm:accuracy  # test/llm: 設定した各サーバの全モデルの通過率
```

```
test/
  README.md, helpers.js   両方で共有
  unit/                   プラグインのコード。モデルは使わない: npm test
  llm/                    実際のモデルの応答: npm run test:llm, test:llm:accuracy
    llm-test-config.json  この端末のサーバとモデル(git 管理外)
    results/              実行結果(git 管理外)
```

`npm test` が門番である。ネットワークにも出ず、モデルも要らず、変更を入れる前に
必ず通っていなければならないのはこちら。`npm run test:llm` は意図的に分けてある。
実際のモデルと話す以上、決定的にはなりえないからである。

## オフラインのスイート

各スイートは「何を守るためのテストか」を冒頭のコメントに書いてある。アサーション
の名前ではなく、まずそこを読むこと。`npm test` の実体は `test/unit/run_all.js` で、
`test/unit/` の `*.test.js` をすべて見つけ、名前順に 1 つずつ別プロセスで実行する。
スイートを書けばその時点で実行対象になる。途中で失敗しても最後まで走らせ、
末尾の集計で落ちたスイート名を挙げる。

| スイート | 守っているもの |
|------|------|
| `canvas_layout` | レイアウトエンジン。コンポーネント間の押し下げが単一の `dy` であること、挿入時の再配置が元の位置を基準に行われること、編集していないコンポーネントは形を変えずに平行移動だけすること、すべての枠を合わせて揃えること、`settleCollisions` のあとにノード・キャプション・枠が互いに重ならないこと(どこにも紐づかない注釈はそちらが動く)。 レイアウトが置いたり動かしたりしたものはすべてマス目に乗ること(中心の y と左端)、シーケンス同士は枠の有無にかかわらず同じピッチで離れること。 |
| `chat_history` | 複数のチャット、または全チャットを、件数を示す1回の確認でまとめて削除できること。開いているチャットを消すと新しいチャットが始まること。キャンセルすれば何も消えないこと。 チャットを開くと、そのチャットが作業していたフローが戻ること。 |
| `flow_converter_core` | config ノードの自動補完 — config ノード自身の値(`mqtt-broker` の `broker: "localhost"`)を参照と誤認しないこと — と、1行 `func` の整形が空白しか変えないこと。 |
| `flow_selection` | jsdom 上で、エディタの起動順(タブが1枚ずつ追加され、最後に `flows:loaded`)どおりに動かす。再起動しても保存した選択が残ること、最新のチャットがそのフローを戻すこと、新しいチャットは開いているフローになること、選んでいたフローが消えたら開いているフローになること。 |
| `llm_core` | 暗号鍵がプラグイン自身のものであり、ユーザーが `credentialSecret` を設定しても保存済みキーが読めること。旧データも復号できること。設定の書き込み失敗が呼び出し元に届くこと。以前のビルドがランタイムの設定に置いた設定と暗号鍵が、プラグインの保存物がすべて入る `<userDir>/llm-plugin` へ移ること。キー未設定で送信すると、その旨が返ること。API キーがどの出口からも漏れないこと。システムプロンプトが同梱されていること。 |
| `schema_conventions` | Vibe Schema の境界の両方向。アンダースコア始まりのメタデータが LLM にもキャンバスにも届かないこと、エディタのフラグ(`disabled` / `showLabel`)が設定時のみ `d` / `l` になること。 |
| `junction_preserve` | 適用で最初に失われる 2 つの要素。junction が**ワイヤごと**残ること(経路の途中にあるので、消えると無言で経路が切れる)。group のメンバーシップが維持され、削除されたノードが `nodes` から取り除かれること。ロックされたワークスペースでは中途半端に外さずフォールバックすること。 junction はユーザーのもので、つなぐ先が動かない編集では動かず、どの編集でも配線が変わらず、何も上に載らないこと。2つの枠の間の中継が、押し下げられた枠に付いていくこと。コンテキストは junction や link out → link in を通るワイヤをその先への接続として読み、接続を書き直してもワイヤが増えず、削除すると中継の中で切断され、他の接続が保たれ、役目を失った中継が消えること(両方のタブがコンテキストにあればタブをまたいでも同じで、コンテキスト外のタブには触れない)。link ノードのホバー時だけ見える仮想リンクで2本のシーケンスが1本にならないこと。 |
| `cross_flow_isolation` | フローの選択が境界であること。編集は送ったフローにしか書き込めない。返答はモデルに見せた全コンテキストフロー共通のエイリアス番号で読むので、1つのエイリアスは1つのノードを指し、そのノードのタブで編集されること。プロパティ中のノード ID がエイリアスとして往復すること。 |
| `import_safety` | 削除指示が所有するフローだけに届くこと。インポート失敗時に junction・group・書き換え済みの config ノードまで含めて完全に巻き戻ること。フローコンテキストが config の参照を推移的に、配列も辿ること。 |
| `node_secret_exit` | `llm-request` ノードのエラー出口は秘密の出口である。Authorization ヘッダをエラー本文に echo するエンドポイントがあっても、保存済みキーが Catch ノードの `msg.error` に乗らないこと。 |
| `reply_rendering` | jsdom 上で、エディタが読み込むスクリプトを使う。応答の生の HTML はテキストになること、危険なリンクは `href` を失うこと、画像はリンクになること、コードブロックと表は描画されること、プラグインの DOMPurify がエディタのグローバルに触れないこと。 |
| `deploy_churn` | 編集していないノードをランタイムが再起動しないこと。`diffNodes` に対するキー集合の忠実性 — 触っていないノードに余計なプロパティを付けないこと。 |
| `incremental_apply` | 編集が編集対象しか触らないこと。結果だけでなく「何をしたか」(削除した要素、`import()` に渡したノード、切った/張ったリンク)を検証する。 |
| `http_transport` | プロバイダアダプタを実際のループバックサーバ相手に検証。Ollama、Chat Completions(Custom)、Responses API(OpenAI)のそれぞれがストリーミング応答をつなげること、タイムアウトが `code === 'ETIMEDOUT'` として届くこと、終了の印の前に切れたストリームや `incomplete` / `failed` で終わった OpenAI の応答が短い応答ではなくエラーになること。 |
| `json_repair` | 「ほぼ JSON」な応答の扱い。何を復元し(閉じられていない文字列、値の中の未エスケープのクォート、修復が外側のクォートを食べてしまった JSONata 式)、何を復元せずに失敗として出すか。もともと妥当なブロックは決して「修復」せず、すでに正しく読める式を囲み直さず、復元できたブロックを失敗として報告もしない。サイドバーが JSON を折りたたむときの読み取り(`parseJsonBlock`)も含む。 |
| `ui_templates` | `llm_plugin.html` と `ui_core.js` の継ぎ目。JS が複製する id がすべて存在し、各テンプレートのルートが単一かつ整形式で、複製後に参照するクラスがマークアップ側にあること。無言で腐る 2 つの継ぎ目 — ヘッダのドキュメントリンクと、`llm-request` ノード(共有コアを呼ぶだけでエディタ側の経路を持たず、html にプラグインのロジックがないこと、`package.json` で登録・公開されること、ヘルプが読める長さに収まっていること)も見る。プラグインが独自の通知を出さないこと(`RED.notify` を呼ぶ箇所がなく、警告はチャット欄の1行になること)も確かめる。 |
| `server_api` | 管理ルートの保証を検証。未認証の `src/` ルートが `client.js` の読み込むものだけを配ること、チェックポイントの `meta` に上限があること、未知のプロバイダを拒むこと、チャットを ID で削除できること。 |
| `group_schema` | グループの枠はユーザーのもの。応答は枠を作れず、編集も削除もできず、コンテキストは枠を見せずにノードのエイリアスも動かさないこと。編集は枠を1本のシーケンスに沿わせたまま保つこと。つながれた新しいノードは枠に入り、コメントは `above` で指定したノードに従って枠に出入りし、空になった枠も残り、すべての枠はメンバーの最終位置に合わせ直されて次の並びと重ならないこと。枠内に追加した分岐が他と重ならずポート順に並ぶこと。 |

`helpers.js` には、アサーションの集計と `loadPluginSandbox(RED, opts)` を置いている。
後者はクライアントの各モジュールを実際に vm 上で読み込むもので、読み込み順は
`client.js` と同一にしてある。ある順序でしか成立しない依存が、テストだけ通って
本番で壊れることがないようにするためである。外に出ていくリクエスト自体を検証する
スイートは `opts.fetch` を渡す。ランタイム側の対になるのが `coreRED()` で、
`llm_core` と `llm-request` ノードを構築するのに必要な最小限の Node-RED である。
それ以外の `buildRED` は各スイートが自前で持つ。どんなレジストリを用意し、
何を記録するかがそのスイートの本題だからである。

## 実 LLM とのテスト(`npm run test:llm`)

`llm_node.test.js` は `llm-request` ノードに実際のモデルでメッセージを通す。応答が
`msg.payload` に入りほかのプロパティはそのまま通ること、`msg.llm` が入ること、ノードの
システムプロンプトに従い `msg.system` で上書きできること、オブジェクトの payload が
JSON として送られること、`msg.model` と `msg.timeout` が効くこと、空の payload は
リクエストを送らずに拒むことを確かめる。

`llm_roundtrip.test.js` は、サイドバーと `llm-request` ノードが使うのと同じ
エンジン — プロンプト組み立て、プロバイダへの実 HTTP リクエスト、応答からの
Vibe Schema 抽出、インポート可能なフローへの変換 — をそのまま通す。実際のモデル
相手でしか表に出ない壊れ方を捕まえるためである。

モデルの出力は決定的ではないため、検証は厳密な一致ではなく構造の確認にとどめる。
すなわち「スキーマが抽出できること」と「そこから得られるフローが
`RED.nodes.import` の受け付ける形であること」。

`llm_scenarios.test.js` はさらに一歩進める。現実的な依頼(新規作成、挿入、プロパティの変更(inject、function、JSONata の change、debug)、名前の変更、無効化、ノードや接続1本の削除(junction や link ノード経由も)、コメント、整列、グループ枠、設定ノード(再利用し、作り出さない)、複数シーケンス、switch や複数出力の function、別フロー、存在しないノードへの依頼、両モードでの質問)をモデルに送り、実際のインポート処理でモックのエディタに適用し、依頼どおりの結果になったかをキャンバスで確かめる。あわせて2つの不変条件(すべてのワイヤが実在するノードに届くこと、何も重ならないこと)も確かめる。各シナリオは `attempts` 回まで試す。`LLM_TEST_MODELS=gemma3:4b,gemma4:e2b` で複数のモデルを続けて試し、結果を表で出す。`LLM_TEST_SHOW_FAILED=1` で失敗した応答を表示する。`LLM_TEST_ONLY=delete,switch` で名前にどれかを含むシナリオだけを実行する。`LLM_TEST_RUNS=5` で各シナリオを再試行なしで5回ずつ実行し、通過した回数とモデルごとの通過率を出す(再試行しても応答が無かった回は unanswered として別に数える)。`LLM_TEST_URL` で別の Ollama サーバーを指定できる(Tailscale のアドレスでもよい)。`LLM_TEST_PROVIDER=openai` で OpenAI を使う。キーは `LLM_TEST_OPENAI_KEY` か、リポジトリ直下の git 管理外の `.credentials.json`(`{ "OpenAI": "sk-..." }`)から読む。API が報告するトークン数(推論分を含む)を数え、`LLM_TEST_TOKEN_BUDGET=200000` でその量に達したら次のシナリオの前で止める。`LLM_TEST_REPLAY=run.log[,more.log]` は何も送らない。`LLM_TEST_SHOW_FAILED=1` で記録した失敗応答を今のコードで判定し直し、どれが通るようになったかを出す(ログが残す 3000 文字を超えた応答は切れていると示す)。パーサやインポータの変更の効果を、サーバーなしで確かめられる。

`npm run test:llm` の実体は `test/llm/run_llm.js` で、ノードのテストと往復テストを
モデルごとに実行し、最後にシナリオを実行する。

接続先とモデルは、スイートと同じ `test/llm/` に置く `llm-test-config.json` から読む。
このファイルは git 管理外なので、テンプレートをコピーして作る。

```bash
cp test/llm/llm-test-config.example.json test/llm/llm-test-config.json
```

| フィールド | 意味 |
|------|------|
| `ollamaUrl` | テスト対象のエンドポイント(既定 `http://localhost:11434`) |
| `model` | モデル名(既定 `gemma3:4b`) |
| `timeoutMs` | リクエストごとのタイムアウト |
| `attempts` | 解析可能なスキーマを含む応答が返るまでの再試行回数。小さいモデルはまず散文で答えてくることがある |
| `showReplies` | モデルの応答をそのまま表示する。実際に何を返したか確認したいとき |

引数を渡すと、その 1 回だけファイルの設定を上書きできる(`npm run test:llm -- --help`)。

```bash
npm run test:llm -- --url 192.0.2.10 --model gemma3:4b,gemma4:e4b
npm run test:llm -- --url http://192.0.2.10:11434 --model gemma3:4b --only delete,switch --runs 5
```

| 引数 | 意味 |
|------|------|
| `--url <host\|url>` | Ollama サーバ。ホスト名だけなら `http://` とポート `11434` を補う |
| `--model <a[,b]>` | モデル。複数なら、往復テストはモデルごとに実行し、シナリオは表にまとめる |
| `--only <a[,b]>` | 名前にどれかを含むシナリオだけを実行する |
| `--runs <n>` | 各シナリオを再試行なしで n 回ずつ実行し、通過率を出す |
| `--provider <name>` | `ollama`(既定)か `openai` |
| `--show-failed` | 失敗した応答を表示する |

各引数は対応する `LLM_TEST_*` 変数(`LLM_TEST_URL`、`LLM_TEST_MODEL(S)`、`LLM_TEST_ONLY`、
`LLM_TEST_RUNS`、`LLM_TEST_PROVIDER`、`LLM_TEST_SHOW_FAILED`)を設定するだけなので、変数も
そのまま使え、両方あれば引数が優先される。各スイートを直接実行するときも同じ引数が使える
(`node test/llm/llm_scenarios.test.js --url …`)。

### 精度(`npm run test:llm:accuracy`)

`test/llm/llm_accuracy.js` は、各モデルがサイドバーの仕事をどれだけこなせるかを測る。
設定の `accuracy.servers` にある各サーバについて、そのサーバにあるモデル(埋め込み用を除く。
クラウドモデルはどのサーバを経由しても ollama.com で動くので、`"cloud": true` を付けた
サーバでだけ、それだけを測る)を一覧し、読み込めるか確かめてから、シナリオを1つにつき `runs` 回
実行する。サーバ同士は並行、1台のサーバのモデルは1つずつ順に実行する。`--server`・
`--model`・`--runs` で対象を絞れる。

```json
"accuracy": { "runs": 3, "servers": [
  { "name": "gpu-box", "url": "http://192.0.2.10:11434" },
  { "name": "slow-box", "url": "http://192.0.2.11:11434", "runs": 1, "skip": ["llama3.2-vision:latest"] },
  { "name": "ollama-cloud", "url": "http://localhost:11434", "cloud": true } ] }
```

結果はこの端末の `test/llm/results/` に残る。`accuracy.md`(サーバ・モデルごとの最新の
通過率と、シナリオ別の表)、`accuracy.json`(全実行の追記)、日付フォルダに各実行の生ログ。

終了コード: `0` 成功、`1` 失敗、`2` スキップ(エンドポイントに到達できない、
モデルが入っていない、エンドポイントがリクエストを処理できなかった)。

## スイートを追加するとき

1. 冒頭のコメントに「何を守るテストか」と「なぜ必要になったか」を書く。必要に
   なった経緯こそが後から効いてくる。
2. ファイル名は `<何を守るか>.test.js` とする。モデルを使わないスイートは
   `test/unit/` に置けばランナーが自動で見つける。モデルと話すスイートは `test/llm/`
   に置き、`run_llm.js` に書き足す。
3. 一つの振る舞いは一つのスイートで検証する。同じ経路を通るスイートが複数ある
   場合(適用まわりが典型)、それぞれ自分の層だけを検証し、何を他に任せたかを
   冒頭コメントに書く。`incremental_apply` はエディタが行う作業、`deploy_churn`
   はランタイムがノードを再起動するかどうか、`junction_preserve` は junction と
   group を担当する。二重に検証すると、一つの変更で二つのスイートを直すことに
   なり、どちらが正なのかも分からなくなる。
4. テストのコードはすべて追跡する。`.gitignore` が外すのは、この端末やその実行を
   表すものだけである。`test/llm/llm-test-config.json`(ホスト名を含む)、
   `test/llm/results/`、スイートの一時領域 `.tmp-*`。テストは npm には公開されない
   (`package.json` の `files`)。
