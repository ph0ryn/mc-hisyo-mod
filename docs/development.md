# 開発と実装状況

## この段階でできること

- ルートの単一TypeScriptパッケージをVite+で検査・ビルド・テストする。
- 独立したFabricプロジェクトをJava 21でビルドする。
- イベントと応答hookをSQLiteへ保存し、worldId / playerId単位で再読込する。
- 履歴をイベント種別・時刻・公開されたフィールドで検索し、ページングする。

**ゲームとPiを接続するDirector本体はまだ未実装。**
CLIはヘルプと引数検証だけを提供し、Modは空のクライアント初期化処理だけを持つ。
実ゲーム、実モデル、有料APIでの受入確認は行っていない。
設計資料のToolや通信メソッドは、実装済み機能の一覧ではない。

## 検証コマンド

Node.js 24.15以降の24系、または26以降、pnpm 11、Java 21を使用する。
プロジェクトのNodeバージョン指定は[.node-version](<../.node-version>)にある。

```bash
pnpm install --frozen-lockfile
pnpm run verify
node dist/cli.mjs --help
```

Vite+はプロジェクトローカルの固定バージョンを使い、グローバル版は変更しない。
[設定](<../vite.config.ts>)で、型検査付きlint、Vitest、tsdownによるESMビルドを管理する。
[pnpm設定](<../pnpm-workspace.yaml>)は依存解決と供給網ポリシー用で、monorepo構成ではない。
Vite+ coreのバージョン表記に対するpeer例外は、検証したバージョンのみに限定している。

Fabricのビルドはリポジトリ内の専用キャッシュを使う。
`mod`ディレクトリで次を実行する。

```bash
GRADLE_USER_HOME="$PWD/run/gradle-user-home" ./gradlew build
```

Minecraft 1.21.11 / Java 21 / Loom 1.17.21 / Gradle 9.7.1を固定している。
Wrapper本体と配布zipは公式SHA-256で確認した。
このビルドはゲーム起動やEULA同意を行わず、既存ワールドを使わない。
現在Java側のテストはなく、Gradleの`test`は`NO-SOURCE`になる。

## イベントの追加

定義の所有者は[gameEvent.ts](<../src/protocol/gameEvent.ts>)。
イベントごとに名前、説明、観測の確度、TypeBoxのpayload schema、照合可能なscalarフィールドを宣言する。

1. イベント定義を追加する。
2. Mod側に、その事実を取得できるobserverを追加する。
3. 正常・不正payloadのfixtureと検証を追加する。

[EventCatalog](<../src/events/eventCatalog.ts>)、[EventLog](<../src/events/eventLog.ts>)、
[ResponseHooks](<../src/hooks/responseHooks.ts>)にイベント名ごとの分岐は追加しない。
登録されていないイベント、schema違反、非対応フィールドのfilterはエラーにする。
任意の外部pluginをロードする仕組みは導入していない。

[履歴とhookのテスト](<../tests/eventHistory.test.ts>)では、
`example:machine_completed`を定義だけで追加し、永続化・検索・hook照合が動くことを確認する。
現在の組込定義は、ブロック破壊、inventory slot差分、体力差分の3種。
これはschemaの定義であり、現在のModが収集しているという意味ではない。

### 観測と推測を分ける

完了callbackで確認した事実、snapshot間の差分、操作の試行を区別する。
slot差分から「拾った」「クラフトした」とは断定しない。
同じtick内で相殺された変化も捕捉できない。
接続したModが実際に収集できる種類と、schemaの全定義は分けて扱う。

### 保存・検索の契約

- イベント収集・保存はhookの有無やLLM呼出しとは独立する。
- 元のenvelopeとpayloadをJSONで保持し、イベント名ごとのtableを作らない。
- `worldSessionId`ごとに`seq`は1から増加する。重複・逆順は拒否する。
- `seq`の飛びは次の観測に`missingSequencesBefore`として保存する。欠けた事実は捏造しない。
- 検索は保存順。`limit`は1〜500、既定値100。次ページは`nextCursor`と同じ`through`を渡す。
- `through`は検索開始時の上限IDで、ページング途中に追加されたイベントを混入させない。
- `since`は観測時刻のミリ秒、境界を含む。filterにはイベント名が必要。
- filterは公開されたpayload直下のscalar値に対する、型を区別する完全一致のAND条件。
- `hasKnownGaps`は、そのworld / playerの`through`以前に既知の連番欠損があるかを返す。
  イベント種別、filter、時刻条件、ページサイズで欠損を隠さない。
- `hasKnownGaps: false`は完全な観測を保証しない。切断中、新session前後、observerの捕捉限界による欠落は検出できない。
- hookの追加・一覧・削除・照合はworld / playerに隔離し、再接続後も保持する。

SQLiteにはschema versionを保存し、未対応versionは自動変換せず停止する。
現在は初期version 1のみで、過去の公開schemaからの移行はまだない。

## 次の段階

共有fixtureを用いたJava DTO検証、ローカルJSON-RPC、Pi拡張の接続、
実observer、単一実行scheduler、pause・切断・再開の順に接続する。
レシピ専用Toolや独立した目標管理state machineは作らず、
ゲームの静的ファイルを読む方針と、実行中の生データ・履歴・hookを分ける。
OS上のファイルやコマンドへアクセスするToolの権限は、接続実装時に明示する。
