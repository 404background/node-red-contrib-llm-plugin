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
comment — not the assertion names — is the place to look first. The order below
is the order `npm test` runs them in.

| Suite | Guards |
|-------|--------|
| `canvas_layout` | The layout engine: one uniform `dy` for cross-component push, insertion reflow anchored in place, and a component the edit did not touch translated as a whole rather than sheared. |
| `flow_converter_core` | Auto-stub creation — a config node's own value props (an `mqtt-broker`'s `broker: "localhost"`) are not dangling config references — and that the single-line `func` pretty-printer only ever changes whitespace. |
| `llm_core` | The credential key is the plugin's own and survives the user setting `credentialSecret`; older blobs still decrypt; a failed settings write reaches the caller; a configured API key escapes through none of its exits; the system prompt ships in the package. |
| `schema_conventions` | Both directions of the Vibe Schema boundary: `_`-prefixed metadata reaches neither the LLM nor the canvas, and the editor flags (`disabled` / `showLabel`) map to `d` / `l` only when set. |
| `junction_preserve` | The two entities an apply loses first: a junction survives an edit **with its wires** (it sits mid-chain, so losing it breaks the path silently), group membership survives, a deleted member is pruned from the group's `nodes`, and a locked workspace falls back rather than half-detaching. |
| `cross_flow_isolation` | The flow selection is the boundary in both directions: an edit may only write to the flows that were sent, and only those flows' config nodes leave the machine. |
| `import_safety` | Deletions reach the flow that owns them and no other; a failed import rolls back completely, junctions, groups and already-rewritten config nodes included; flow context follows config references transitively and through arrays. |
| `node_secret_exit` | The `llm-request` node's error exit is a secret exit — an endpoint that echoes the Authorization header into its error body must not put the stored key on a Catch node's `msg.error`. |
| `deploy_churn` | Applying an edit does not make the runtime restart nodes it did not edit: key-set fidelity against `diffNodes`, so no stray property lands on an untouched node. |
| `incremental_apply` | An edit touches only what it edits. The work done is asserted — which entities were removed, which nodes were handed to `import()`, which links were cut and made — not just the end state. |
| `node_checkpoint` | A flow change made by the Agent node is undoable: its checkpoint is saved with `chatId: null` and `meta.source: 'node-apply'`, so it is neither filed under an unrelated chat nor deleted with one. |
| `http_transport` | The two server-side HTTP callers against a real loopback server: a timeout still surfaces as `code === 'ETIMEDOUT'`, and both schemes go through one path. |
| `ui_templates` | The seam between `llm_plugin.html` and `ui_core.js`: every id the JS clones exists, every template has a single well-formed root, and the classes reached for after cloning are in the markup. |
| `checkpoint_api` | The restore-point endpoints through the real route handlers. The Agent node's checkpoints have no message, so the listing is the only way to find them. |
| `apply_queue` | Ordering between everything that writes to the same flow: an applied-but-undeployed flow is held, others targeting it wait in arrival order, and different flows never wait for each other. |
| `apply_queue_client` | The browser half of that protocol — no apply before its turn, no second apply on a re-pushed grant, and completion always reported. |

`helpers.js` holds the assertion counter and `loadPluginSandbox(RED)`, which runs
the real client modules in a vm context in the same order `client.js` uses — so a
load-order dependency cannot pass here and fail in production. Each suite keeps
its own `buildRED`: the registries it sets up and the state it captures are the
point of that suite.

## Live round-trip (`npm run test:llm`)

`llm_roundtrip.test.js` drives the same engine the sidebar and the `llm-request`
node use — prompt construction, a real HTTP call to the provider, Vibe Schema
extraction from the reply, and conversion into an importable flow — so it catches
breakage that only shows up against an actual model.

Model output is not deterministic, so its assertions are structural rather than
exact: a schema must be extractable, and the flow it yields must be one
`RED.nodes.import` would accept.

Endpoint and model come from `llm-test-config.json` in the repo root. That file
is git-ignored, so copy the template to create it:

```bash
cp llm-test-config.example.json llm-test-config.json
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
2. Add the file to the `test` script in `package.json`. There is no runner that
   discovers suites, so one that is not listed never runs.
3. One behaviour, one suite. Where two suites drive the same path — the apply
   is the obvious one — each asserts its own layer and says in its header what
   it deliberately leaves to the other: `incremental_apply` owns the work the
   editor does, `deploy_churn` owns whether the runtime would restart a node,
   `junction_preserve` owns junctions and groups. Asserting a behaviour twice
   means two suites to update for one change, and neither one tells you which
   is authoritative.
4. `.gitignore` tracks `test/*.test.js`, `helpers.js` and this README and ignores
   anything else dropped into `test/`, so scratch files and temp storage stay
   untracked. Tests are not published to npm (`files` in `package.json`).

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
の名前ではなく、まずそこを読むこと。並び順は `npm test` が実行する順。

| スイート | 守っているもの |
|------|------|
| `canvas_layout` | レイアウトエンジン。コンポーネント間の押し下げが単一の `dy` であること、挿入時の再配置が元の位置を基準に行われること、編集していないコンポーネントは形を変えずに平行移動だけすること。 |
| `flow_converter_core` | config ノードの自動補完 — config ノード自身の値(`mqtt-broker` の `broker: "localhost"`)を参照と誤認しないこと — と、1行 `func` の整形が空白しか変えないこと。 |
| `llm_core` | 暗号鍵がプラグイン自身のものであり、ユーザーが `credentialSecret` を設定しても保存済みキーが読めること。旧データも復号できること。設定の書き込み失敗が呼び出し元に届くこと。API キーがどの出口からも漏れないこと。システムプロンプトが同梱されていること。 |
| `schema_conventions` | Vibe Schema の境界の両方向。アンダースコア始まりのメタデータが LLM にもキャンバスにも届かないこと、エディタのフラグ(`disabled` / `showLabel`)が設定時のみ `d` / `l` になること。 |
| `junction_preserve` | 適用で最初に失われる 2 つの要素。junction が**ワイヤごと**残ること(経路の途中にあるので、消えると無言で経路が切れる)。group のメンバーシップが維持され、削除されたノードが `nodes` から取り除かれること。ロックされたワークスペースでは中途半端に外さずフォールバックすること。 |
| `cross_flow_isolation` | フローの選択が両方向の境界であること。編集は送ったフローにしか書き込めず、外に出る config ノードもそのフローが参照するものだけ。 |
| `import_safety` | 削除指示が所有するフローだけに届くこと。インポート失敗時に junction・group・書き換え済みの config ノードまで含めて完全に巻き戻ること。フローコンテキストが config の参照を推移的に、配列も辿ること。 |
| `node_secret_exit` | `llm-request` ノードのエラー出口は秘密の出口である。Authorization ヘッダをエラー本文に echo するエンドポイントがあっても、保存済みキーが Catch ノードの `msg.error` に乗らないこと。 |
| `deploy_churn` | 編集していないノードをランタイムが再起動しないこと。`diffNodes` に対するキー集合の忠実性 — 触っていないノードに余計なプロパティを付けないこと。 |
| `incremental_apply` | 編集が編集対象しか触らないこと。結果だけでなく「何をしたか」(削除した要素、`import()` に渡したノード、切った/張ったリンク)を検証する。 |
| `node_checkpoint` | Agent ノードによるフロー変更が元に戻せること。チェックポイントは `chatId: null` と `meta.source: 'node-apply'` で保存され、無関係なチャットに紐付いたり一緒に消えたりしない。 |
| `http_transport` | サーバ側の 2 つの HTTP 呼び出しを実際のループバックサーバ相手に検証。タイムアウトが `code === 'ETIMEDOUT'` として届くこと、http/https が同じ経路を通ること。 |
| `ui_templates` | `llm_plugin.html` と `ui_core.js` の継ぎ目。JS が複製する id がすべて存在し、各テンプレートのルートが単一かつ整形式で、複製後に参照するクラスがマークアップ側にあること。 |
| `checkpoint_api` | リストアポイントのエンドポイントを実際のルートハンドラ経由で検証。Agent ノードのチェックポイントにはメッセージがないので、一覧こそが唯一の発見手段である。 |
| `apply_queue` | 同じフローに書き込むもの同士の順序。適用済みで未デプロイのフローは保持され、同じフローを狙う他の要求は到着順に待ち、別のフロー同士は待たない。 |
| `apply_queue_client` | そのプロトコルのブラウザ側。順番が来る前に適用しないこと、再送された許可で二重に適用しないこと、完了を必ず報告すること。 |

`helpers.js` には、アサーションの集計と `loadPluginSandbox(RED)` を置いている。
後者はクライアントの各モジュールを実際に vm 上で読み込むもので、読み込み順は
`client.js` と同一にしてある。ある順序でしか成立しない依存が、テストだけ通って
本番で壊れることがないようにするためである。`buildRED` は各スイートが自前で持つ。
どんなレジストリを用意し、何を記録するかがそのスイートの本題だからである。

## 実 LLM との往復テスト(`npm run test:llm`)

`llm_roundtrip.test.js` は、サイドバーと `llm-request` ノードが使うのと同じ
エンジン — プロンプト組み立て、プロバイダへの実 HTTP リクエスト、応答からの
Vibe Schema 抽出、インポート可能なフローへの変換 — をそのまま通す。実際のモデル
相手でしか表に出ない壊れ方を捕まえるためである。

モデルの出力は決定的ではないため、検証は厳密な一致ではなく構造の確認にとどめる。
すなわち「スキーマが抽出できること」と「そこから得られるフローが
`RED.nodes.import` の受け付ける形であること」。

接続先とモデルはリポジトリ直下の `llm-test-config.json` から読む。このファイルは
git 管理外なので、テンプレートをコピーして作る。

```bash
cp llm-test-config.example.json llm-test-config.json
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
2. `package.json` の `test` スクリプトにファイルを追加する。スイートを自動で
   探す仕組みはないので、書かなければ動かない。
3. 一つの振る舞いは一つのスイートで検証する。同じ経路を通るスイートが複数ある
   場合(適用まわりが典型)、それぞれ自分の層だけを検証し、何を他に任せたかを
   冒頭コメントに書く。`incremental_apply` はエディタが行う作業、`deploy_churn`
   はランタイムがノードを再起動するかどうか、`junction_preserve` は junction と
   group を担当する。二重に検証すると、一つの変更で二つのスイートを直すことに
   なり、どちらが正なのかも分からなくなる。
4. `.gitignore` は `test/*.test.js`・`helpers.js`・この README だけを追跡し、
   `test/` に置かれたそれ以外は無視する。一時ファイルやテスト用ストレージが
   紛れ込まないようにするためである。テストは npm には公開されない
   (`package.json` の `files`)。
