# 開発と実装状況

## この段階でできること

- ルートの単一TypeScriptパッケージをVite+で検査・ビルド・テストする。
- 独立したFabricプロジェクトをJava 21でビルドする。
- イベントと応答hookをSQLiteへ保存し、worldId / playerId単位で再読込する。
- 履歴をイベント種別・時刻・公開されたフィールドで検索し、ページングする。
- JSONL / JSON-RPC codecを、実際のlocalhost TCPで双方向要求・通知・切断・timeoutまで検証する。
- 13種類のserver observerと、共有fixtureによる純Javaのsnapshot・DTO検証を実装する。
- 認証付きloopback bridgeで、role・ready・world / run binding・古い応答の拒否を実TCPで検証する。
- ビルド済みCLIの`--bridge-only`でprivateな接続情報を公開し、イベントを永続化し、安全に終了する。

**Piの起動・接続、scheduler、Modへの配線はまだ未実装。**
`--bridge-only`はPiも判断も起動しない。通常モードは未対応としてエラーにし、黙ってPiを省略しない。
Modのobserverは空のclient initializerへまだ登録していない。
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

任意の`pnpm run verify:pi`はPATHのPi 1.2.0とローカル偽providerを使う。
実モデルやユーザー設定は使用しない。[Pi境界検証](<piFeasibility.md>)に条件と制限をまとめる。

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
Gradleの通常の`test`は`NO-SOURCE`だが、`check` / `build`は独立した`observerTest`を実行する。
Minecraft / Fabricを実行classpathに載せず、純Javaで共有fixtureとsnapshot差分を検証する。
登録API、明示nullのserialize、観測の限界は[観測資料](<observations.md>)を参照。

## bridge-only CLI

```bash
node dist/cli.mjs --bridge-only
# または、既存の親ディレクトリ配下へ保存先を指定する
node dist/cli.mjs --bridge-only --data-dir /absolute/private/state
```

既定の保存先は`~/.mc-hisyo`。新規ディレクトリは`0700`、新規ファイルは`0600`にし、processのumaskを`077`へ絞る。
既存ディレクトリには所有者と`0700`を要求し、symlinkは拒否する。既存の権限を自動でchmodしない。
親ディレクトリは信頼できる場所を使う。POSIX modeを検査する実装で、拡張ACLとWindows ACLは未検証、Windows起動は未対応。

- `history.sqlite`へ履歴とhookを保存する。既存のmain / WAL / SHM / journalは、所有者・regular file・`0600`・link数1をopen前に検査する。
- `connection.json`へprotocolVersion、loopback接続先、port、token、PIDを公開する。[公開と削除の契約](<protocol.md>)を参照。
- 接続情報が既にあれば停止する。内容が壊れていても読み飛ばして上書きしたり、PIDだけで古いと判断したりしない。
- Ctrl-C / SIGINT / SIGTERMでlistenerと接続、SQLite、自分の接続情報を順に閉じる。履歴とhookは残す。
- SIGKILLやcrash後の接続情報は自動回収しない。所有プロセスの停止を確認してから手動で処理する。

起動表示へtokenは出さない。`--help`はstateを作らず、SQLiteやPiも起動しない。
CLIの責務は引数・signal・診断、[runtime](<../src/runtime/bridgeRuntime.ts>)の責務はresourceの起動・終了とする。
[ビルド済みCLIのsubprocessテスト](<../tests/cli.test.ts>)は、一時保存先と偽gameの実TCP接続を使う。
ModやPiの起動、ゲーム内の動作確認ではない。

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
現在は13種類の組込定義と対応observerがある。
observerは未配線なので、実際の接続Modが収集・送信した実績とは区別する。

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
- hook一覧はID辞書順、既定8件・最大8件。`nextCursor`を次の`after`へ渡す。
  履歴の`through`とは異なりsnapshotではない。[一覧の契約](<tools.md>)を参照。

SQLiteにはschema versionを保存し、未対応versionは自動変換せず停止する。
現在は初期version 1のみで、過去の公開schemaからの移行はまだない。

## 次の段階

bridge-only CLIの起動・終了とprivate接続情報公開は実装済み。[通信の契約](<protocol.md>)を基に、
Pi拡張と単一実行scheduler、observerの登録・送信、pause・切断・再開を接続する。
レシピ専用Toolや独立した目標管理state machineは作らず、
ゲームの静的ファイルを読む方針と、実行中の生データ・履歴・hookを分ける。
OS上のファイルやコマンドへアクセスするToolの権限は、接続実装時に明示する。
