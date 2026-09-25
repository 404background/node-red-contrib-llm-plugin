# Tests

Everything about this project's tests lives here: what the suites are, what each
one protects, and how to run the live round-trip. The rest of the developer
documentation is in [`../docs/`](../docs/README.md).

日本語版は[このページの後半](#テスト)にあります。

## Running

```bash
npm test          # the offline suites — nothing but Node required
npm run test:llm  # the live round-trip against a real LLM endpoint
```

`npm test` is the gate: it makes no network call, needs no model, and is the one
that must pass before a change lands. `npm run test:llm` is deliberately
separate — it talks to an actual model, so it cannot be deterministic.

## Offline suites

Each suite states the guarantee it protects in its own header comment, and that
comment — not the assertion names — is the place to look first. `npm test` is
`test/run_all.js`: it finds every `*.test.js` in this folder and runs each in
its own process, in name order, so a new suite runs the moment it is written.
Every suite is run even after one fails, and the tally at the end names the
ones that did.

| Suite | Guards |
|-------|--------|
| `canvas_layout` | The layout engine: one uniform `dy` for cross-component push, insertion reflow anchored in place, a component the edit did not touch translated as a whole rather than sheared, every box fitted and aligned, and `settleCollisions` leaving no node, caption or box on another (a stray note is the one that moves). |
| `chat_history` | Several chats, or all of them, are deleted together behind one confirmation that says how many; deleting the open chat starts a new one; cancelling deletes nothing. |
| `flow_converter_core` | Auto-stub creation — a config node's own value props (an `mqtt-broker`'s `broker: "localhost"`) are not dangling config references — and that the single-line `func` pretty-printer only ever changes whitespace. |
| `llm_core` | The credential key is the plugin's own and survives the user setting `credentialSecret`; older blobs still decrypt; a failed settings write reaches the caller; settings and the key an older build kept in the runtime settings move into `<userDir>/llm-plugin`, where everything the plugin keeps is; a configured API key escapes through none of its exits; a request with no key set says so; the system prompt ships in the package. |
| `schema_conventions` | Both directions of the Vibe Schema boundary: `_`-prefixed metadata reaches neither the LLM nor the canvas, and the editor flags (`disabled` / `showLabel`) map to `d` / `l` only when set. |
| `junction_preserve` | The two entities an apply loses first: a junction survives an edit **with its wires** (it sits mid-chain, so losing it breaks the path silently), group membership survives, a deleted member is pruned from the group's `nodes`, and a locked workspace falls back rather than half-detaching. Junctions are the user's: an edit that leaves its targets in place does not move one, and none rewires it or lands on it; routing between two boxes follows the box it feeds when that box is pushed down; the context reads a wire through a junction or a link out → link in pair as a connection to where it leads, and restating that connection adds no wire, while removing it cuts it inside the routing, keeps every other connection and takes down the routing left idle — across two tabs too when both are in the context, never touching a tab outside it; a link node's hover-only virtual link does not join two sequences. |
| `cross_flow_isolation` | The flow selection is the boundary in both directions: an edit may only write to the flows that were sent, and only those flows' config nodes leave the machine. A reply is read against the alias numbering the model was shown over every context flow, so an alias names one node and it is edited on its own tab; node ids inside properties round-trip as aliases; the runtime and the editor number alike. |
| `import_safety` | Deletions reach the flow that owns them and no other; a failed import rolls back completely, junctions, groups and already-rewritten config nodes included; flow context follows config references transitively and through arrays. |
| `node_secret_exit` | The `llm-request` node's error exit is a secret exit — an endpoint that echoes the Authorization header into its error body must not put the stored key on a Catch node's `msg.error`. |
| `deploy_churn` | Applying an edit does not make the runtime restart nodes it did not edit: key-set fidelity against `diffNodes`, so no stray property lands on an untouched node. |
| `incremental_apply` | An edit touches only what it edits. The work done is asserted — which entities were removed, which nodes were handed to `import()`, which links were cut and made — not just the end state. |
| `http_transport` | The two server-side HTTP callers against a real loopback server: a timeout still surfaces as `code === 'ETIMEDOUT'`, and both schemes go through one path. |
| `json_repair` | A reply whose JSON is not quite JSON: what is recovered (an unterminated string, unescaped quotes inside a value, a JSONata expression whose own outer quotes the repair ate) and what is left to fail loudly — a block that was already valid is never "repaired", an expression that already reads correctly is not re-quoted, and a block that was recovered is not also reported as a failure. Also `parseJsonBlock`, the reading the sidebar folds a JSON block on. |
| `ui_templates` | The seam between `llm_plugin.html` and `ui_core.js`: every id the JS clones exists, every template has a single well-formed root, and the classes reached for after cloning are in the markup. Also the two static seams that rot silently — the docs link in the header, and the `llm-request` node, whose html must hold no plugin logic and whose help panel must stay short enough to read. And the plugin raises no editor notification of its own: nothing calls `RED.notify`, and a warning is a line in the chat. |
| `server_api` | The admin routes' guarantees: the unauthenticated `src/` routes serve exactly what `client.js` loads, an Agent-node reply is claimed once, checkpoint `meta` is bounded, an unknown provider is refused, a chat is deleted by id. |
| `group_schema` | Group boxes are the user's: a reply cannot create, edit or delete one, and the context shows none without moving any node alias. An edit keeps a box around its one sequence: a new node wired into it joins the box, a comment follows the node its `above` names into (or out of) a box, a box stays when emptied, and every box is refitted around where its members end up, clear of the next sequence. A branch added inside a box lands clear of the others in port order. |

`helpers.js` holds the assertion counter and `loadPluginSandbox(RED, opts)`, which
runs the real client modules in a vm context in the same order `client.js` uses —
so a load-order dependency cannot pass here and fail in production. Pass
`opts.fetch` when the requests going out are what the suite asserts. `coreRED()`
is its runtime counterpart: the minimal Node-RED that `llm_core` and the
`llm-request` node need to be constructed. Beyond those, each suite keeps its own
`buildRED`: the registries it sets up and the state it captures are the point of
that suite.

## Live round-trip (`npm run test:llm`)

`llm_roundtrip.test.js` drives the same engine the sidebar and the `llm-request`
node use — prompt construction, a real HTTP call to the provider, Vibe Schema
extraction from the reply, and conversion into an importable flow — so it catches
breakage that only shows up against an actual model.

Model output is not deterministic, so its assertions are structural rather than
exact: a schema must be extractable, and the flow it yields must be one
`RED.nodes.import` would accept.

`llm_scenarios.test.js` goes one step further: realistic requests — building, inserting, editing properties (inject, function, change with JSONata, debug), renaming, disabling, deleting nodes and single connections (also through a junction or link nodes), comments, layout, group boxes, config nodes (reuse, never invent), several sequences, switches and multi-output functions, other flows, a request for a node that does not exist, and questions in both modes — are sent to the model, applied to a mocked editor through the real importer, and the canvas is checked for the outcome the user asked for, plus two invariants (every wire lands on a node, nothing overlaps). Each scenario gets `attempts` tries. `LLM_TEST_MODELS=gemma3:4b,gemma4:e2b` runs it against several models and prints a table; `LLM_TEST_SHOW_FAILED=1` prints the replies that failed. `LLM_TEST_ONLY=delete` runs only the scenarios whose name contains it. `LLM_TEST_RUNS=5` runs each scenario 5 times without retries and reports how many passed, plus an overall pass rate per model; `LLM_TEST_URL` points it at another Ollama server (a Tailscale address works).

Endpoint and model come from `llm-test-config.json`, next to the suites it
configures. That file is git-ignored, so copy the template to create it:

```bash
cp test/llm-test-config.example.json test/llm-test-config.json
```

| Field | Meaning |
|-------|---------|
| `ollamaUrl` | Endpoint to test against (default `http://localhost:11434`) |
| `model` | Model name (default `gemma3:4b`) |
| `timeoutMs` | Per-request timeout |
| `attempts` | Retries allowed for a reply to contain a parseable schema — small models sometimes answer in prose first |
| `showReplies` | Print the model's raw replies so you can see what it actually said |

`LLM_TEST_URL` / `LLM_TEST_MODEL` override the file for a single run:

```bash
LLM_TEST_MODEL=llama3.2 npm run test:llm
```

Exit codes: `0` passed, `1` failed, `2` skipped — the endpoint was unreachable,
the model was not installed, or the endpoint failed to serve the request.

## Adding a suite

1. Open with a header comment naming the guarantee and why it exists — the
   history that made it necessary is the useful part.
2. Name it `<what it guards>.test.js` and leave it in `test/`. The runner
   discovers it; nothing has to be listed in `package.json`.
3. One behaviour, one suite. Where two suites drive the same path — the apply
   is the obvious one — each asserts its own layer and says in its header what
   it deliberately leaves to the other: `incremental_apply` owns the work the
   editor does, `deploy_churn` owns whether the runtime would restart a node,
   `junction_preserve` owns junctions and groups. Asserting a behaviour twice
   means two suites to update for one change, and neither one tells you which
   is authoritative.
4. `.gitignore` tracks `test/*.test.js`, `run_all.js`, `helpers.js`,
   `llm-test-config.example.json` and this README, and ignores anything else
   dropped into `test/`, so scratch files, temp storage and the local
   `llm-test-config.json` stay untracked. Tests are not published to npm
   (`files` in `package.json`).

---

# テスト

このプロジェクトのテストに関することはすべてここにまとめてある。どんなスイートが
あり、それぞれ何を守っているか、実 LLM との往復テストをどう動かすか。その他の
開発者向けドキュメントは [`../docs/`](../docs/README.md) にある。

## 実行方法

```bash
npm test          # オフラインのスイート。Node 以外に必要なものはない
npm run test:llm  # 実際の LLM エンドポイントとの往復テスト
```

`npm test` が門番である。ネットワークにも出ず、モデルも要らず、変更を入れる前に
必ず通っていなければならないのはこちら。`npm run test:llm` は意図的に分けてある。
実際のモデルと話す以上、決定的にはなりえないからである。

## オフラインのスイート

各スイートは「何を守るためのテストか」を冒頭のコメントに書いてある。アサーション
の名前ではなく、まずそこを読むこと。`npm test` の実体は `test/run_all.js` で、
このフォルダの `*.test.js` をすべて見つけ、名前順に 1 つずつ別プロセスで実行する。
スイートを書けばその時点で実行対象になる。途中で失敗しても最後まで走らせ、
末尾の集計で落ちたスイート名を挙げる。

| スイート | 守っているもの |
|------|------|
| `canvas_layout` | レイアウトエンジン。コンポーネント間の押し下げが単一の `dy` であること、挿入時の再配置が元の位置を基準に行われること、編集していないコンポーネントは形を変えずに平行移動だけすること、すべての枠を合わせて揃えること、`settleCollisions` のあとにノード・キャプション・枠が互いに重ならないこと(どこにも紐づかない注釈はそちらが動く)。 |
| `chat_history` | 複数のチャット、または全チャットを、件数を示す1回の確認でまとめて削除できること。開いているチャットを消すと新しいチャットが始まること。キャンセルすれば何も消えないこと。 |
| `flow_converter_core` | config ノードの自動補完 — config ノード自身の値(`mqtt-broker` の `broker: "localhost"`)を参照と誤認しないこと — と、1行 `func` の整形が空白しか変えないこと。 |
| `llm_core` | 暗号鍵がプラグイン自身のものであり、ユーザーが `credentialSecret` を設定しても保存済みキーが読めること。旧データも復号できること。設定の書き込み失敗が呼び出し元に届くこと。以前のビルドがランタイムの設定に置いた設定と暗号鍵が、プラグインの保存物がすべて入る `<userDir>/llm-plugin` へ移ること。キー未設定で送信すると、その旨が返ること。API キーがどの出口からも漏れないこと。システムプロンプトが同梱されていること。 |
| `schema_conventions` | Vibe Schema の境界の両方向。アンダースコア始まりのメタデータが LLM にもキャンバスにも届かないこと、エディタのフラグ(`disabled` / `showLabel`)が設定時のみ `d` / `l` になること。 |
| `junction_preserve` | 適用で最初に失われる 2 つの要素。junction が**ワイヤごと**残ること(経路の途中にあるので、消えると無言で経路が切れる)。group のメンバーシップが維持され、削除されたノードが `nodes` から取り除かれること。ロックされたワークスペースでは中途半端に外さずフォールバックすること。 junction はユーザーのもので、つなぐ先が動かない編集では動かず、どの編集でも配線が変わらず、何も上に載らないこと。2つの枠の間の中継が、押し下げられた枠に付いていくこと。コンテキストは junction や link out → link in を通るワイヤをその先への接続として読み、接続を書き直してもワイヤが増えず、削除すると中継の中で切断され、他の接続が保たれ、役目を失った中継が消えること(両方のタブがコンテキストにあればタブをまたいでも同じで、コンテキスト外のタブには触れない)。link ノードのホバー時だけ見える仮想リンクで2本のシーケンスが1本にならないこと。 |
| `cross_flow_isolation` | フローの選択が両方向の境界であること。編集は送ったフローにしか書き込めず、外に出る config ノードもそのフローが参照するものだけ。返答はモデルに見せた全コンテキストフロー共通のエイリアス番号で読むので、1つのエイリアスは1つのノードを指し、そのノードのタブで編集されること。プロパティ中のノード ID がエイリアスとして往復すること。ランタイムとエディタで番号が一致すること。 |
| `import_safety` | 削除指示が所有するフローだけに届くこと。インポート失敗時に junction・group・書き換え済みの config ノードまで含めて完全に巻き戻ること。フローコンテキストが config の参照を推移的に、配列も辿ること。 |
| `node_secret_exit` | `llm-request` ノードのエラー出口は秘密の出口である。Authorization ヘッダをエラー本文に echo するエンドポイントがあっても、保存済みキーが Catch ノードの `msg.error` に乗らないこと。 |
| `deploy_churn` | 編集していないノードをランタイムが再起動しないこと。`diffNodes` に対するキー集合の忠実性 — 触っていないノードに余計なプロパティを付けないこと。 |
| `incremental_apply` | 編集が編集対象しか触らないこと。結果だけでなく「何をしたか」(削除した要素、`import()` に渡したノード、切った/張ったリンク)を検証する。 |
| `http_transport` | サーバ側の 2 つの HTTP 呼び出しを実際のループバックサーバ相手に検証。タイムアウトが `code === 'ETIMEDOUT'` として届くこと、http/https が同じ経路を通ること。 |
| `json_repair` | 「ほぼ JSON」な応答の扱い。何を復元し(閉じられていない文字列、値の中の未エスケープのクォート、修復が外側のクォートを食べてしまった JSONata 式)、何を復元せずに失敗として出すか。もともと妥当なブロックは決して「修復」せず、すでに正しく読める式を囲み直さず、復元できたブロックを失敗として報告もしない。サイドバーが JSON を折りたたむときの読み取り(`parseJsonBlock`)も含む。 |
| `ui_templates` | `llm_plugin.html` と `ui_core.js` の継ぎ目。JS が複製する id がすべて存在し、各テンプレートのルートが単一かつ整形式で、複製後に参照するクラスがマークアップ側にあること。無言で腐る 2 つの継ぎ目 — ヘッダのドキュメントリンクと、`llm-request` ノード(html にプラグインのロジックを持たないこと、ヘルプが読める長さに収まっていること)も見る。プラグインが独自の通知を出さないこと(`RED.notify` を呼ぶ箇所がなく、警告はチャット欄の1行になること)も確かめる。 |
| `server_api` | 管理ルートの保証を検証。未認証の `src/` ルートが `client.js` の読み込むものだけを配ること、Agent ノードの応答が1回だけ受け取られること、チェックポイントの `meta` に上限があること、未知のプロバイダを拒むこと、チャットを ID で削除できること。 |
| `group_schema` | グループの枠はユーザーのもの。応答は枠を作れず、編集も削除もできず、コンテキストは枠を見せずにノードのエイリアスも動かさないこと。編集は枠を1本のシーケンスに沿わせたまま保つこと。つながれた新しいノードは枠に入り、コメントは `above` で指定したノードに従って枠に出入りし、空になった枠も残り、すべての枠はメンバーの最終位置に合わせ直されて次の並びと重ならないこと。枠内に追加した分岐が他と重ならずポート順に並ぶこと。 |

`helpers.js` には、アサーションの集計と `loadPluginSandbox(RED, opts)` を置いている。
後者はクライアントの各モジュールを実際に vm 上で読み込むもので、読み込み順は
`client.js` と同一にしてある。ある順序でしか成立しない依存が、テストだけ通って
本番で壊れることがないようにするためである。外に出ていくリクエスト自体を検証する
スイートは `opts.fetch` を渡す。ランタイム側の対になるのが `coreRED()` で、
`llm_core` と `llm-request` ノードを構築するのに必要な最小限の Node-RED である。
それ以外の `buildRED` は各スイートが自前で持つ。どんなレジストリを用意し、
何を記録するかがそのスイートの本題だからである。

## 実 LLM との往復テスト(`npm run test:llm`)

`llm_roundtrip.test.js` は、サイドバーと `llm-request` ノードが使うのと同じ
エンジン — プロンプト組み立て、プロバイダへの実 HTTP リクエスト、応答からの
Vibe Schema 抽出、インポート可能なフローへの変換 — をそのまま通す。実際のモデル
相手でしか表に出ない壊れ方を捕まえるためである。

モデルの出力は決定的ではないため、検証は厳密な一致ではなく構造の確認にとどめる。
すなわち「スキーマが抽出できること」と「そこから得られるフローが
`RED.nodes.import` の受け付ける形であること」。

`llm_scenarios.test.js` はさらに一歩進める。現実的な依頼(新規作成、挿入、プロパティの変更(inject、function、JSONata の change、debug)、名前の変更、無効化、ノードや接続1本の削除(junction や link ノード経由も)、コメント、整列、グループ枠、設定ノード(再利用し、作り出さない)、複数シーケンス、switch や複数出力の function、別フロー、存在しないノードへの依頼、両モードでの質問)をモデルに送り、実際のインポート処理でモックのエディタに適用し、依頼どおりの結果になったかをキャンバスで確かめる。あわせて2つの不変条件(すべてのワイヤが実在するノードに届くこと、何も重ならないこと)も確かめる。各シナリオは `attempts` 回まで試す。`LLM_TEST_MODELS=gemma3:4b,gemma4:e2b` で複数のモデルを続けて試し、結果を表で出す。`LLM_TEST_SHOW_FAILED=1` で失敗した応答を表示する。`LLM_TEST_ONLY=delete` で名前にその文字列を含むシナリオだけを実行する。`LLM_TEST_RUNS=5` で各シナリオを再試行なしで5回ずつ実行し、通過した回数とモデルごとの通過率を出す。`LLM_TEST_URL` で別の Ollama サーバーを指定できる(Tailscale のアドレスでもよい)。

接続先とモデルは、スイートと同じ `test/` に置く `llm-test-config.json` から読む。
このファイルは git 管理外なので、テンプレートをコピーして作る。

```bash
cp test/llm-test-config.example.json test/llm-test-config.json
```

| フィールド | 意味 |
|------|------|
| `ollamaUrl` | テスト対象のエンドポイント(既定 `http://localhost:11434`) |
| `model` | モデル名(既定 `gemma3:4b`) |
| `timeoutMs` | リクエストごとのタイムアウト |
| `attempts` | 解析可能なスキーマを含む応答が返るまでの再試行回数。小さいモデルはまず散文で答えてくることがある |
| `showReplies` | モデルの応答をそのまま表示する。実際に何を返したか確認したいとき |

`LLM_TEST_URL` / `LLM_TEST_MODEL` を指定すると、その 1 回だけファイルの設定を
上書きできる。

```bash
LLM_TEST_MODEL=llama3.2 npm run test:llm
```

終了コード: `0` 成功、`1` 失敗、`2` スキップ(エンドポイントに到達できない、
モデルが入っていない、エンドポイントがリクエストを処理できなかった)。

## スイートを追加するとき

1. 冒頭のコメントに「何を守るテストか」と「なぜ必要になったか」を書く。必要に
   なった経緯こそが後から効いてくる。
2. ファイル名は `<何を守るか>.test.js` とし、`test/` に置く。ランナーが自動で
   見つけるので、`package.json` に書き足す必要はない。
3. 一つの振る舞いは一つのスイートで検証する。同じ経路を通るスイートが複数ある
   場合(適用まわりが典型)、それぞれ自分の層だけを検証し、何を他に任せたかを
   冒頭コメントに書く。`incremental_apply` はエディタが行う作業、`deploy_churn`
   はランタイムがノードを再起動するかどうか、`junction_preserve` は junction と
   group を担当する。二重に検証すると、一つの変更で二つのスイートを直すことに
   なり、どちらが正なのかも分からなくなる。
4. `.gitignore` は `test/*.test.js`・`run_all.js`・`helpers.js`・
   `llm-test-config.example.json`・この README だけを追跡し、`test/` に置かれた
   それ以外は無視する。一時ファイルやテスト用ストレージ、手元の
   `llm-test-config.json` が紛れ込まないようにするためである。テストは npm には
   公開されない(`package.json` の `files`)。
