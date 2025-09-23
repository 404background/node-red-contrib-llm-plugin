# VibeCoding Plugin - Source Files

このフォルダには、VibeCodingプラグインのソースファイルが含まれています。

## ファイル構成

### `client.js`
- **役割**: クライアント側（ブラウザ）で動作するJavaScript
- **機能**: 
  - サイドバータブの作成とUI操作
  - チャット風インターフェース
  - Ollamaとの通信（HTTP API経由）
  - フロー更新機能
  - モデル履歴管理

### `server.js` 
- **役割**: サーバー側（Node-RED）で動作するJavaScript
- **機能**:
  - HTTPエンドポイント提供（/vibecoding/generate, /vibecoding/logs, /vibecoding/recent-models）
  - Ollamaとの通信処理
  - ログファイル管理
  - モデル履歴保存

### `ui-components.js`
- **役割**: UI関連のヘルパー関数
- **機能**:
  - チャットメッセージ表示
  - フロー更新ダイアログ
  - エラー表示

### `flow-manager.js`
- **役割**: Node-REDフロー管理機能
- **機能**:
  - フローJSONの解析
  - フローの更新・インポート
  - 現在のフロー取得

## 開発ガイドライン

- クライアント側コードは`client.js`から開始
- サーバー側の機能追加は`server.js`に実装
- UI関連の新機能は`ui-components.js`に追加
- フロー操作の機能拡張は`flow-manager.js`に実装

## プラグイン読み込み

メインファイル`vibecoding_plugin.html`と`vibecoding_plugin.js`が、これらのソースファイルを読み込んでプラグインとして動作します。