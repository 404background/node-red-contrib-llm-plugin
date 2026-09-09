# Vibe Schema — 中間フロー表現

LLM が生の Node-RED JSON の代わりに生成する、エイリアスを鍵にした JSON。ランダムな ID、
ピクセル座標、入れ子になった接続配列 — LLM が意味のある形で発明できない3つの要素 — を
取り除いてある。生の JSON との相互変換は変換器が受け持つ。

## 例

### 1. スキーマの形(一目で)

```json
{
  "description": "Tick → format → publish",
  "nodes": {
    "comment_publish_pipeline": {
      "type": "comment",
      "name": "Publish pipeline",
      "above": "inject_tick"
    },
    "inject_tick": {
      "type": "inject",
      "name": "Tick",
      "props": { "payload": "", "payloadType": "date" }
    },
    "function_format": {
      "type": "function",
      "name": "Format",
      "props": { "func": "msg.payload = { ts: msg.payload }; return msg;" }
    },
    "mqtt_out_publish": {
      "type": "mqtt out",
      "name": "Publish",
      "flow": "Sensors",
      "props": { "topic": "sensors/ticks", "broker": "broker_cfg" }
    },
    "broker_cfg": {
      "type": "mqtt-broker",
      "name": "Local broker",
      "config": true,
      "props": { "broker": "localhost", "port": "1883" }
    }
  },
  "connections": [
    { "from": "inject_tick", "to": "function_format" },
    { "from": "function_format", "to": "mqtt_out_publish" }
  ]
}
```

### 2. 等価な生 Node-RED JSON(変換器が生成するもの)

上のスキーマに対する実際の出力。ランダムな ID は `<gen-id-N>` に置き換えてある。変換器が
次の工程へ申し送るための内部的な目印(宣言順、コメントの貼り付け先、所属タブ、スキーマが
実際に書いたキーの一覧など)は、ここでは省いている。インポート側が使い切ったうえで、
ノードをキャンバスへ載せる前に必ず取り除くためである:

```json
[
  {
    "id": "<gen-id-1>", "type": "comment", "name": "Publish pipeline",
    "z": "<workspace>", "x": 140, "y": 60, "wires": []
  },
  {
    "id": "<gen-id-2>", "type": "inject", "name": "Tick",
    "z": "<workspace>", "x": 110, "y": 170,
    "payload": "", "payloadType": "date",
    "topic": "", "repeat": "", "crontab": "", "once": false, "onceDelay": 0.1,
    "props": [{ "p": "payload" }, { "p": "topic", "vt": "str" }],
    "wires": [["<gen-id-3>"]]
  },
  {
    "id": "<gen-id-3>", "type": "function", "name": "Format",
    "z": "<workspace>", "x": 260, "y": 170,
    "func": "msg.payload =  {\n  ts: msg.payload\n};\nreturn msg;",
    "outputs": 1,
    "wires": [["<gen-id-4>"]]
  },
  {
    "id": "<gen-id-4>", "type": "mqtt out", "name": "Publish",
    "z": "<workspace>", "x": 420, "y": 170,
    "topic": "sensors/ticks", "broker": "<gen-id-5>",
    "wires": []
  },
  {
    "id": "<gen-id-5>", "type": "mqtt-broker", "name": "Local broker",
    "broker": "localhost", "port": "1883"
  }
]
```

LLM が生成しなくて済んだものに注目してほしい: ランダムな ID、ピクセル座標、入れ子の接続配列、
ブローカー設定への ID 参照、inject ノードが内部的に持つルール配列。これらはすべて変換器が
生成する。一方、ブローカー設定自身が持つホスト名の値はそのまま通る。config ノード上の
「値としてのプロパティ」が「config への参照」と取り違えられることはない。

ここでのコメントの座標は、まだ素のレイアウト結果である。最終的な位置(対象ノードの上端に接し、
左端を揃える)は、インポート側のレイアウト処理が与える。その前段で、コメントの貼り付け先の
指定を実ノード ID へ解決している。[layout.md](./layout.md#コメント配置)を参照。

### 3. ラウンドトリップのコード

```js
const Cfg = require('./flow_converter_core.js');

const schema = Cfg.toIntermediate(exportedNodes);
//   schema.nodes[alias] = { type, name?, config?, disabled?, props? }
//   schema.connections = [{ from, to, fromPort? }, ...]

const flow = Cfg.toNodeRed(schema, { workspace: 'tabId' });
// flow now has fresh IDs, laid-out x / y, and proper wires arrays.
```

## 公開 API

| 関数 | 用途 |
|----------|---------|
| `toIntermediate(nodeRedJson, options?)` | Node-RED → Vibe Schema。`options.includeIdMap = true` で `_meta.idToAlias` を付与。 |
| `toNodeRed(intermediate, options?)` | Vibe Schema → Node-RED。オプション: `workspace`, `startX`, `startY`, `spacingY`, `edgeGap`, `maxColumns`, `preserveAlias`。 |
| `isVibeSchema(obj)` | `obj.nodes` がプレーンオブジェクト、または `obj.connections` が配列のとき `true`(どちらか単独でも有効 — ノードプロパティのみの編集は connections を省略、配線の微修正は nodes を省略)。トップレベルに `reposition` / `relayout` / `reflow` 配列を持つディレクティブのみの形も該当。 |
| `isConfigType(type)` / `isConfigNode(node)` | Config ノード判定(ランタイム + 構造的)。 |
| `isCanvasNode(node)` | `!tab && !subflow: && !isConfigNode`。 |
| `isNoInputType(type)` | ソース専用ノード(`inject`, `catch`, `comment`, …)で true。 |
| `isNoOutputType(type)` | `comment`(およびランタイム def 経由で出力 0 の型)で true。 |
| `setRuntimeGetType(fn)` | `RED.nodes.getType` を注入し、ヘルパーがコミュニティノードを見えるようにする。 |

メタデータ規約は内部で強制する。`_` で始まるプロパティは
プラグイン側の管理情報であり、`toIntermediate` はそれを出力せず、
`toNodeRed` はスキーマから受け付けない。

## スキーマリファレンス

```
{
  description? : string                 // toIntermediate が自動生成
  nodes        : { <alias>: NodeEntry | null }
  connections  : Array<ConnEntry | RemoveEntry>
}

NodeEntry = {
  type       : string                   // Node-RED ノード型
  name?      : string                   // 表示ラベル(エイリアスにも使う)
  flow?      : string                   // このノードが属するタブラベル
  config?    : true                     // config ノードの目印
  above?     : alias                    // comment 専用: この上に載る対象ノード
  disabled?  : boolean                  // ノードが無効化(コメントアウト)されている
  showLabel? : boolean                  // キャンバス上のラベル表示
  props?     : object                   // 型固有フィールド
  // その他のルートレベルキーは変換時に props にまとめられる。
  // ただし `_` 始まりのキーはメタデータ扱いで無視される
}

ConnEntry   = { from: alias, to: alias, fromPort?: number }
RemoveEntry = { remove: { from: alias, to: alias } }
```

### メタデータキー(アンダースコア始まり)

キー名がアンダースコアで始まることは、そのプロパティが「ノードの設定」ではなく「プラグイン内部の
申し送り」であることを示す。変換器は往路と復路の両方でこれを強制する。中間表現を作る側は
アンダースコア始まりのキーを一切出力しない(＝ LLM は見ない)。Node-RED の形へ戻す側は、
スキーマに書かれたアンダースコア始まりのキーを一切受け付けない(＝ LLM は書けない)。
メタデータを書き込めるのは変換器自身だけで、インポート側がキャンバスへ渡す前にすべて剥がす。
詳細は [design.md](./design.md) §0.1。

### エディタ上のフラグ(`disabled` / `showLabel`)

Node-RED は、エディタで切り替える 2 つのノード状態を、読んでも意味の分からない
1 文字のキーで保持している。`d`(右クリックメニューの有効/無効 — いわゆる
「ノードのコメントアウト」)と `l`(外観 → ラベル表示)である。どちらも型固有の
設定ではないので、スキーマではエディタの UI で使われている名前に改め、
エントリ直下に持ち上げる。

| Node-RED | スキーマ | 現れる条件 |
|----------|--------|--------------|
| `d: true` | `disabled: true` | ノードが無効化されているとき |
| `l: <bool>` | `showLabel: <bool>` | 型の既定と異なるとき(link ノードは既定で非表示) |

Node-RED はこの 2 つを設定されているときだけ書き出すので、普通のノードにはどちらも
現れない。つまり、人がキャンバスでグレーアウトしたノードを見ているのと同じ場所で、
LLM は `disabled: true` を見る。無効化されたノードはそれ以外は普通のノードと全く同じで、
プロパティをすべて保持したまま文脈に含まれる。人がエディタで開いて中身を確かめられるのと同じように、
LLM も中身を確認して編集できる。

`toNodeRed` はこの読める名前をエントリ直下でも `props` の中でも受け付け、1 文字キーに
戻して書き込む。`d` は無効の間だけ存在するキーなので、`disabled: false` は `d: false` を
書くのではなくキーを**削除**する。それでも「明示的に提案されたキー」として数えるので、
インポート時のマージが元の `d: true` を復元してしまうことはない
([architecture.md](./architecture.md) の `importFlowFromMessage`「プロパティ保存」を参照)。

したがって `disabled` と `showLabel` は予約名である。これらの名前のプロパティを
本当に持つノード型も壊れない。名前が埋まっているときは往路の持ち上げを行わず、
スキーマに生の `d` / `l` があればそちらを優先し、真偽値とみなせる値
(`true`, `false`, `"true"`, `"false"`)のときだけフラグとして読む。

### エイリアス

エイリアスは「種類 + 名前」を小文字化し、英数字とアンダースコア以外を落として作る。同じものが
できてしまう場合は末尾に連番を付ける(`inject_trigger`, `inject_trigger_2`, …)。いったん付いた
エイリアスは変わらない。インポート側は、新規ノードが名乗ったエイリアスを目印として保持し、
それと突き合わせる。

### 編集の意味づけ

インポートは常にマージである。列挙されたノードと接続は、エイリアスで突き合わせて追加または更新し、
空を指定されたエイリアスは削除し、言及されなかったものはそのまま残す。1つのスキーマの中で、
追加・更新・削除を任意に組み合わせてよい。

### 削除ディレクティブ

```json
{ "nodes": { "inject_old": null } }                                 // ノード削除
{ "connections": [ { "remove": { "from": "a", "to": "b" } } ] }     // エッジ削除
```

それ以外の接続はすべて足し算として扱われる。マージ規則の全体は
[architecture.md](./architecture.md) の「importer.js」を参照。

### reposition ディレクティブ

```json
{ "reposition": ["inject_tick", "function_format", "mqtt_out_publish"] }
```

トップレベルの `reposition` は、その場で並べ直してほしいキャンバスノードのエイリアスを列挙する。
ID もプロパティも接続も保たれ、変わるのは座標だけである。並べ直した一群は元の左上位置に固定
されるので、無関係なノードは見た目に動かない。既存ノードの配置を直したいときは、削除して
作り直すのではなくこれを使う。作り直すと ID が変わり、それ以前の会話ターンが参照していた ID が
無効になってしまうためである。

グルーピングを明示したい場合は、リストのリストの形で書いてもよい。インポート側が平坦にする。
キャンバスノードに解決しないエイリアス(config ノードや未知のエイリアス)は無視される。

### コメントノードのルール

すべてのコメントは、その上に載るキャンバスノードを**必ず**指定する:

```json
"comment_publish_header": {
  "type": "comment",
  "name": "Publish pipeline",
  "above": "inject_tick"
}
```

`above` には、そのコメントの直下に来るキャンバスノードのエイリアスを書く。レイアウトはコメントを
そのノードの上端に隙間なく接触させ、**さらに左端を**対象の左端に揃える。こうすることで、幅の広い
キャプションが見出し対象と同じ列に載る。対象は同じスキーマ内で定義したノードでも、すでに
キャンバス上にある既存ノードでもよい。インポート側がどちらでも解決する。同じ対象を指す
コメントが複数あるときは、宣言順に上へ積み上がる。

それでも指定が省略された場合、レイアウトは「宣言順で次に現れるキャンバスノード」を対象と
みなす。指定もなく、後ろにキャンバスノードもない末尾のコメントは、静かに落とされる。指定を
持つコメントは、一覧のどこに書かれていても必ず保持される。貼り付け先が決まっていれば宣言順は
関係ないからである。実際の配置の寸法は [layout.md](./layout.md#コメント配置)を参照。

### 判定ヘルパー

| ヘルパー | ロジック |
|--------|-------|
| `isConfigType(t)` | ランタイム: `getType(t).category === 'config'`。静的フォールバック: 型が `-config` で終わる。 |
| `isConfigNode(n)` | `isConfigType(type)` または構造的(x/y なし、wires なし、g なし)。`tab` / `subflow:*` を除外。 |
| `isCanvasNode(n)` | `!tab && !subflow: && !isConfigNode(n)`。 |
| `isNoInputType(t)` | ランタイム `inputs === 0`、または静的リスト(`inject`, `catch`, `status`, `complete`, `http in`, `mqtt in`, `websocket in`, `tcp in`, `udp in`, `comment`)。 |
| `isNoOutputType(t)` | ランタイム `outputs === 0`、または静的に `comment` のみ。 |

## 変換の詳細

### `toIntermediate(nodeRedJson, options?)`

1. タブ定義とサブフロー定義を落とす。
2. 各ノードにエイリアスを付ける。
3. 残った各ノードについて、同一性・配置・接続にあたるキーと、内部用のメタデータを除いたものを
   `props` にまとめる。値が他のノードの ID と一致する文字列プロパティは、そのノードのエイリアスへ
   置き換える。こうすることでスキーマが ID に依存しなくなる。
4. 各ノードの接続配列を走査し、接続先ごとに1つのエントリを出力する。出力ポートが 0 以外のときは
   ポート番号も添える。
5. 「3 node(s): inject, function, debug」のような短い説明を自動生成する。
6. 呼び出し元が求めた場合は、ID からエイリアスへの対応表も添える。

### `toNodeRed(intermediate, options?)`

1. **足りない config 参照の仮置き** — エイリアスの形をした文字列プロパティなのに、対応する
   ノードがスキーマ内に無い場合、その参照先の config ノードを仮に作る。型は、プロパティ名から
   決まる既定の対応(たとえばブローカー参照ならブローカー設定の型)に従う。仮に作ったという事実は
   変換器の内部に記録し、組み上げたノードにも目印として載せる。ただし、対応先の型がそのノード
   自身の型と同じになる場合は仮置きしない。ブローカー設定が持つブローカー名はホスト名であって
   参照ではないからである。型をまたぐ参照(ダッシュボードのグループが持つタブ参照など)は
   従来どおり仮置きする。
2. **末尾コメントを落とす** — 貼り付け先の指定がなく、宣言順で後ろにキャンバスノードもない
   コメントは、静かに取り除く。指定を持つコメントは常に残す。それ以外のコメントも残り、
   それぞれ宣言順で次に現れるキャンバスノードの見出しになる。
3. **ID の生成** — エイリアスごとに新しい ID を作る。
4. **キャンバス要素と config の切り分け** — config ノードはレイアウトの対象から外す。
5. **接続から隣接関係を組み立てる。** 送信元が出力を持たない種類、あるいは送信先が入力を
   持たない種類の接続は落とす。
6. **レイアウト** — まず論理的な位置(列・行)を求め、続いて幅を考慮して実座標に落とす。
   [layout.md](./layout.md)を参照。
7. **出力ポート単位の接続配列を組み立てる**(落とす条件は上と同じ)。
8. **ノードを組み立てる** — ID・種類・名前に加え、インポート側が必要とする申し送りを載せる。
   すなわち、名乗るエイリアス、所属タブ、コメントの貼り付け先、スキーマが実際に書いたキーの
   一覧、宣言順、仮置きノードである印である。キャンバス要素には所属タブを設定し、`props` と
   トップレベルのキーを1階層に平坦化し、その中に残るエイリアス参照を実 ID に解決したうえで、
   接続配列を設定する。
9. **型ごとの整形** — inject は内部のルール配列を作り直す。function は必要な外部モジュール宣言を
   取り出し、コードを整形し、出力数の既定を補う。change と switch はルール配列を、template は
   既定値を整える。
