# 開発と実装状況

## この段階でできること

- ルートの単一TypeScriptパッケージをVite+で検査・ビルド・テストする。
- 独立したFabricプロジェクトをJava 21でビルドする。
- イベントと応答hookをSQLiteへ保存し、worldId / playerId単位で再読込する。
- 履歴をイベント種別・時刻・公開されたフィールドで検索し、ページングする。
- JSONL / JSON-RPC codecを、実際のlocalhost TCPで双方向要求・通知・切断・timeoutまで検証する。
- 13種類のserver observerと、共有fixtureによる純Javaのsnapshot・DTO検証を実装する。
- 認証付きloopback bridgeで、role・ready・world / run binding・古い応答の拒否を実TCPで検証する。
- 必須の[現在状態snapshot](<gameState.md>)を検証し、空の状態、欠損field、未対応queryを拒否する。
- ビルド済みCLIの`--bridge-only`でprivateな接続情報を公開し、イベントを永続化し、安全に終了する。
- ビルド済みPi拡張で7 Toolと毎回の必須context取得を提供し、実Pi・偽provider・偽gameで接続検証する。
- Pi stdio driverでmetadataを検査し、単一判断の開始・実際のsettled・取消・子プロセス終了を管理する。
- 隔離したPi sessionを起動し、world / player単位の会話再開と、binding無効化時の取消・終了を管理する。

**scheduler、CLIとModへの配線はまだ未実装。**
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

任意の`pnpm run verify:pi`はPATHのPi 1.2.0とローカル偽providerで、独立した境界probeを実行する。
`pnpm run verify:pi:built`は再ビルドしたproduction拡張を同じPiへ読み込み、3 APIで7 Tool・context・stdio driver・隔離sessionの再開を検証する。
どちらも一時HOME・会話・設定とloopbackを使い、実モデルやユーザー設定は使用しない。
[Pi境界検証](<piFeasibility.md>)と[production拡張の検証](<validation.md#production-pi拡張>)に条件と制限をまとめる。
通常の`verify`はPiを起動しない。Pi 1.2.0の開発依存は拡張APIの型検査用で、実行時のPi importは残さない。

Vite+はプロジェクトローカルの固定バージョンを使い、グローバル版は変更しない。
[設定](<../vite.config.ts>)で、型検査付きlint、Vitest、tsdownによるESMビルドを管理する。
テストは対象コードの隣へ置く。通常の`*.test.ts`と、実Piを必要とする任意の`*.test.mjs`は別設定で実行する。
共通JSON fixtureだけは、Javaと共有するため[fixtureディレクトリ](<../tests/fixtures/protocol/gameSnapshot.json>)に残す。
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
[ビルド済みCLIのsubprocessテスト](<../src/cli.test.ts>)は、一時保存先と偽gameの実TCP接続を使う。
ModやPiの起動、ゲーム内の動作確認ではない。

## Pi stdio driver（CLI未配線）

[driver](<../src/pi/piRpcClient.ts>)は、実行fileのPi 1.2.0を検査した後にstdio子プロセスを起動する。
各判断の前に、認証済み拡張のready、指定provider / modelとphysical API、mediumの対応と実際の選択、
compaction無効・非実行中・空queueを確認する。不一致はpromptを送らず失敗にする。

- `run`は単一実行。prompt ACKや`agent_end`ではslotを解放せず、`agent_settled`と取消RPCの完了を待つ。
- 書込前の取消だけは`not_started`を返す。書込後の失敗は開始済みの可能性を残し、子プロセスを再利用しない。
- 取消前に所有者がbridge bindingを無効化する。abort ACKを終了とは扱わず、prompt preflight中の取消も再abortで止める。
- `isRetired`は再利用禁止を示し、終了済みの保証ではない。異常時のslot解放前には`close()`で子プロセスの終了を待つ。
- `close()`は取消を期限付きで待ち、EOF、SIGTERM、SIGKILLへ段階的に移る。これを成功したsettledとは扱わない。
- stdoutのassistant本文とstderrの診断は、ゲーム表示へ転送しない。

引数・環境変数・作業場所・ready判定は信頼されたsession所有者が渡す。
このdriverだけでは、settings、cache warming、組込Tool、拡張・resourceの自動探索を隔離しない。
起動policyは次のsession所有者が担う。schedulerを接続するまでは通常CLIを有効にしない。[通信境界](<protocol.md#pi-stdio>)を参照。

## Pi session所有者（CLI未配線）

[session所有者](<../src/runtime/piSession.ts>)は、信頼されたPi実行file、bundled拡張、明示的なmodel設定を受け取る。
world / playerの組をhash化したprivateディレクトリへ会話を保存し、同じscopeだけで再開する。
既存会話は所有者・regular file・`0600`・link数1と、headerの保存cwdを検査し、不一致を修復せず拒否する。

- scopeごとに空の`0700`作業ディレクトリを保持し、明示的なsession pathでPiを起動する。最近の会話を自動探索しない。
- 起動ごとにHOME・agent設定・一時領域を新設し、子の終了確認後に削除する。親の環境変数はPATH以外を引き継がない。
- 自動resource探索、context file、組込OS Tool、compaction、cache warmingを無効にし、bundled拡張と7 game Toolだけを明示する。
- credentialは専用環境変数で渡す。設定fileは固定の変数参照だけを保持し、keyを引数へ出さない。
- モデル定義はPiの組込catalogを消さない。毎判断で正確なprovider / ID / 設定したphysical APIとmediumをRPC検査する。
- scopeの排他leaseとbridgeの所有権を、子の終了確認まで保持する。crash後のleaseをPIDだけで自動回収しない。
- pauseはbinding無効化後に取消し、実settledまで予約を保つ。detach・agent切断・開始済みか不明な失敗では子を終了する。
  終了を確認できなければleaseと予約を残し、別の所有者へ渡さない。

これはPiの起動・Tool policyであり、OSやネットワークのsandboxではない。`--offline`も推論先へのHTTPを禁止しない。
ファイル読取・コマンド実行の権限は未決定で、有効化していない。
[隣接するVitestテスト](<../src/runtime/piSession.test.ts>)は実子プロセスと認証付きTCPで境界を確認する。

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

[履歴とhookのテスト](<../src/events/eventLog.test.ts>)では、
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

bridge-only CLI、Pi拡張、stdio driver、隔離sessionの起動管理は実装済み。[通信の契約](<protocol.md>)を基に、
単一実行scheduler、observerの登録・送信、pause・切断・再開を接続する。
schedulerの処理待ち入力が上限へ達した場合の方針は、黙示的な破棄を避けるため実装前に確定する。
レシピ専用Toolや独立した目標管理state machineは作らず、
ゲームの静的ファイルを読む方針と、実行中の生データ・履歴・hookを分ける。
OS上のファイルやコマンドへアクセスするToolの権限は、接続実装時に明示する。
