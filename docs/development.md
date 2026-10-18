# 開発と実装状況

## 実装範囲

- ルートの単一TypeScriptパッケージをVite+で検査・ビルド・テストする。
- 独立したFabricプロジェクトをJava 21でビルドする。
- イベントと応答hookをSQLiteへ保存し、worldId / playerId単位で再読込する。
- 履歴をイベント種別・時刻・公開されたフィールドで検索し、ページングする。
- JSONL / JSON-RPC codecで双方向要求・通知・切断・timeoutを扱う。
- 32種類のserver observerと、共有fixtureによる純Javaのsnapshot・DTO検証を実装する。
- 認証付きloopback bridgeで、role・ready・world / run bindingを管理し、古い応答を拒否する。
- 必須の[現在状態snapshot](<gameState.md>)を検証し、空の状態、欠損field、未対応queryを拒否する。
- ビルド済みCLIの`--bridge-only`でprivateな接続情報を公開し、イベントを永続化し、安全に終了する。
- ビルド済みPi拡張で10 Toolと毎回の必須context取得を提供する。
- Pi stdio driverでmetadataを検査し、単一判断の開始・実際のsettled・取消・子プロセス終了を管理する。
- 隔離したPi sessionを起動し、world / player単位の会話再開と、binding無効化時の取消・終了を管理する。
- [保留キュー](<scheduling.md#保留キュー>)でチャット順序・発火時のhookとイベントを保持し、容量超過を明示エラーにする。
- [scheduler](<scheduling.md#実行制御>)で開始・チャット・一致hookを単一判断へ渡し、pause・退出・過負荷時の取消と所有権を管理する。

**CLI通常モード・1秒timer・single-flight scheduler・Mod登録 / 通信は実装済み。**
`--bridge-only`はPiも判断も起動しない。Pi用flagとの併用は拒否する。
通常モードは設定を検証してからbridge資源を開き、ready worldでPiを開始する。
実ゲーム、実Pi / provider、実SQLite / TCP / Files境界の受入れは未実施。
実装済みと動作受入れ済みを混同しない。

## 検証コマンド

Node.js 24.15以降の24系、または26以降、pnpm 11、Java 21を使用する。
プロジェクトのNodeバージョン指定は[.node-version](<../.node-version>)にある。

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

自動テストはunit testのみ。設定・runtime・model gate・静的参照・履歴・host / 拡張の取消も対象にする。
依存portと手動peerを使い、CLI・Pi・provider・実接続・実DBは起動しない。
Pi 1.2.0の開発依存は拡張APIの型検査用で、実行時のPi importは残さない。

既に依存が配置済みなら、`./node_modules/.bin/vp check`、`./node_modules/.bin/vp pack`、`./node_modules/.bin/vp test`を直接使える。

Vite+はプロジェクトローカルの固定バージョンを使い、グローバル版は変更しない。
[設定](<../vite.config.ts>)で、型検査付きlint、Vitest、tsdownによるESMビルドを管理する。
追加するテストは対象コードの隣の`*.test.ts`にunit testとして書く。
拡張子だけでunitと判断せず、fixture・helperも含め実接続・実子プロセス・実DBを使わないことを確認する。
共通JSON fixtureも[protocolの隣](<../src/protocol/fixtures/gameSnapshot.json>)に置き、Javaから同じファイルを参照する。
[pnpm設定](<../pnpm-workspace.yaml>)は依存解決と供給網ポリシー用で、monorepo構成ではない。
Vite+ coreのバージョン表記に対するpeer例外は、検証したバージョンのみに限定している。

Fabricのビルドはルートで次を実行する。
Gradleの標準キャッシュ（既定は`~/.gradle`）とDaemonを再利用する。

```bash
pnpm run build:mod
```

Minecraft 1.21.11 / Loader 0.19.5 / Fabric API 0.141.6+1.21.11 / Java 21 / Loom 1.17.21 / Gradle 9.7.1を固定している。
このビルドはゲーム起動やEULA同意を行わず、既存ワールドを使わない。
依存がcache済みなら`pnpm run build:mod --offline`で実行できる。
Modのunit testは[JUnit Jupiter](<../mod/build.gradle#L32-L60>)を使い、`cd mod && ./gradlew test`で全件実行する。
テストは[`mod/src/test/java`](<../mod/src/test/java/>)へ置く。標準の`check` / `build`も同じテストを実行する。
生成物は`mod/build/libs/mc_hisyo-0.1.0.jar`（実行用）と`mc_hisyo-0.1.0-sources.jar`。
Minecraft / Fabricを実行classpathに載せず、純Javaで共有fixtureとsnapshot差分を検証する。
登録API、明示nullのserialize、観測の限界は[観測資料](<observations.md>)を参照。

## 通常CLIとModの手動起動

Node / pnpm / Java、Pi 1.2.0、依存cacheは別途準備する。
ルートでbuild後、`dist/cli.mjs`とbundled `dist/directorBridge.mjs`を同じ配布物に保つ。

```bash
# 既存のChatGPTログインを使い、openai/gpt-6-lunaで起動する。
node dist/cli.mjs --pi /absolute/path/to/pi
# 別のPi認証保存先を使う場合は --pi-agent-dir /absolute/private/pi-agent を追加する。
# API keyを使う場合は、安全に設定した環境変数を --api-key-env DIRECTOR_API_KEY で指定する。
```

引数の正は[parser / usage](<../src/cliOptions.ts>)、設定解決は[directorConfig.ts](<../src/runtime/directorConfig.ts>)。

CLIは時刻付きの人向け診断ログを標準エラーへ出す。接続・pause状態、判断要求と取消、Pi ready・prompt送信・settledを
文章の見出しで示し、Toolの引数・結果・Piが返した実行時間は項目別に整形する。Tool名とcall IDで開始・完了・失敗を対応付ける。
繰返しのsession / run IDと空の判断理由は表示しない。Tool結果に`details`がある場合は、重複する`content`ではなく結果本体を表示する。
引数と結果にはプレイヤーの入力やゲーム内テキストを含む。1回のログ本文は4,096文字までとし、省略時は`[truncated]`を付ける。
値の改行・端末制御文字はescapeし、Piの生stderr・認証情報・RPCの無関係なfieldは転送しない。ログファイルは自動作成しない。

- `--pi`の既定はPATH上の`pi`。このプロジェクトのPiは`openai/gpt-6-luna`に固定し、グローバルのモデル設定は読み書きしない。
  `--provider` / `--model`を指定する場合も両方が必要で、`openai` / `gpt-6-luna`以外は拒否する。
- 認証保存先は`--pi-agent-dir` → `PI_CODING_AGENT_DIR` → `~/.pi/agent`。子のprivate設定先とは別。
  strict JSONのみ。credentialは`--api-key-env NAME`、`auth.json`の`openai` entry、`models.json`の`apiKey`の順。
  既存のChatGPT OAuthログイン、または`{"type":"api_key","key":"..."}`を使う。API keyはliteralまたは全体が`${NAME}`の環境変数参照。
  コマンド、部分補間、custom model / API overrideは拒否する。選択provider設定は`apiKey`以外を許さない。
  OAuthは子起動前・各判断前にPi標準の`auth print-bearer-token --provider openai`で有効期間を確認し、必要なら元の保存先で更新する。
  更新失敗時はpromptを送らない。取消時もrefresh tokenの保存完了を待つため、停止が遅れることがある。
  `openai-codex`は別の旧OAuth方式であり、このログインの代替providerにはしない。
- Piのnative catalogでprovider / IDが一意、physical APIが`openai-completions` / `openai-responses` / `anthropic-messages`、
  `medium`対応を要求する。毎判断前に同一model / API、実選択`medium`、非streaming・非compacting・自動compaction無効・pending 0を検査する。
  不一致でfallbackしない。起動・各promptのready gateには認証済みbundled拡張と正確な10 Toolも必要。
- 無効な引数・設定はresource作成前に拒否する。`--help`はstate、SQLite、Piを開かない。

実行用JARを、上記versionのFabric APIとともにFabricクライアントの`mods`へ配置する（sources JARではない）。
ModはCLIを自動起動しない。上のCLIを先に起動してから、対応するclient Modでローカルsingleplayerへ入る。
LAN公開・remote / dedicated serverは対象外。`/ai <message>`で入力し、`send_message`のliteral textだけをローカルHUDへ表示する。
切断・起動失敗後は設定とCLIを確認して退出・再入場する。自動再接続・イベント再送はしない。

Modの既定接続先はJavaの`user.home`配下の`.mc-hisyo/connection.json`。
変更時はFabric config directoryの`mc-hisyo.json`へ**絶対path**だけを指定する。

```json
{"dataDirectory":"/absolute/private/state"}
```

この保存先をCLIの`--data-dir`と一致させる。Modは所有者・directory `0700`・接続file `0600`を検査し、symlinkを拒否する。
接続JSONの厳密なキーは[通信契約](<protocol.md#cliの接続情報ファイル>)を参照。
world rootの`mc-hisyo-world-id`へcanonical UUID + LFを排他新規作成し、以後再利用する。
既存の不正なIDを修復・上書きしない。player UUIDと合わせて会話・hook・履歴の永続scopeにする。

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
現在のunit suiteはCLIを起動しない。

## Pi stdio driver

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
起動policyは次のsession所有者が担い、通常CLIのschedulerから使用する。[通信境界](<protocol.md#pi-stdio>)を参照。

## Pi session所有者

[session所有者](<../src/runtime/piSession.ts>)は、信頼されたPi実行file、bundled拡張、明示的なmodel設定を受け取る。
world / playerの組をhash化したprivateディレクトリへ会話を保存し、同じscopeだけで再開する。
既存会話は所有者・regular file・`0600`・link数1と、headerの保存cwdを検査し、不一致を修復せず拒否する。

- scopeごとに空の`0700`作業ディレクトリを保持し、明示的なsession pathでPiを起動する。最近の会話を自動探索しない。
- 起動ごとにHOME・agent設定・一時領域を新設し、子の終了確認後に削除する。親の環境変数はPATH以外を引き継がない。
- 自動resource探索、context file、組込OS Tool、compaction、cache warmingを無効にし、bundled拡張と10 game Toolだけを明示する。
- API keyは専用環境変数で渡し、設定fileは固定の変数参照だけを保持する。
  OAuthは各判断の期限に余裕を加えた有効期間を要求し、access tokenだけをprivateな`0600`認証fileへatomicに渡す。
  refresh tokenや他providerの認証は子へ渡さず、いずれのkey / tokenも引数や診断へ出さない。
- モデル定義はPiの組込catalogを消さない。毎判断で正確なprovider / ID / 設定したphysical APIとmediumをRPC検査する。
- scopeの排他leaseとbridgeの所有権を、子の終了確認まで保持する。crash後のleaseをPIDだけで自動回収しない。
- pauseはbinding無効化後に取消し、実settledまで予約を保つ。detach・agent切断・開始済みか不明な失敗では子を終了する。
  終了を確認できなければleaseと予約を残し、別の所有者へ渡さない。

これはPiの起動・Tool policyであり、OSやネットワークのsandboxではない。`--offline`も推論先へのHTTPを禁止しない。
一般OSファイル・コマンド実行Toolは無効。静的ゲーム参照だけを[boundedな読取Tool](<tools.md#静的ゲームファイルの境界>)で許可する。
scheduler unit testはこの所有者をstub化し、実取消・子の終了や保存先の安全性は検証しない。

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

[イベント契約のunit test](<../src/protocol/gameEvent.test.ts>)で共有fixture、payload schema、公開scalar filterを確認する。
schema検証は、実SQLiteを使う永続化・検索・hook登録／照合の検証を代替しない。
現在は32種類の組込定義と接続済みobserverがある。
unit / compile結果は、実ゲームで収集・送信できた実績とは区別する。

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
現在はversion 2。新規version 0を初期化し、2を再利用する。version 1は拒否してDBを残す。
自動migrationはないため、既存DBを削除せず退避し、別の空のdata directoryを使う。

### ゲーム観測とCLI内部履歴

[EventLog](<../src/events/eventLog.ts>)はゲーム観測と[CLI事実](<../src/events/directorActivity.ts>)を同じ単調増加`events.id`で保存する。
ゲーム観測のSQL `seq`はsession内連番、CLI事実は`NULL`で、共通IDと混同しない。
有効なplayer入力、正確な`displayed: true` ACK、hook CRUD・一致、開始 / poll / 入力 / hookの判断要求を記録する。
hook CRUDとその事実は同一transaction。ゲームイベントは保存 → live hook照合 → 一致記録、判断理由は`judge`前に保存する。
要求・一致はprovider実行や応答の証拠ではない。CLI事実は検索可能だがhook不可で、過去履歴を再照合しない。
有効な古いbindingのHUD成功ACKは、stale fenceより先に記録する。結果が不明な表示は再送しない。

履歴は完全なrecord単位でページングする。`nextCursor`を`after`へ、同じ`through`を次ページへ渡す。
ページのproducer上限は697,770 bytes（TCP 1 MiB / Pi envelope・重複escape予算から4 KiB等を予約）。
一件だけでも収まらないrecordは明示エラーで、詳細を落としたり空ページで隠したりしない。
attach前 / ready前と最終観測後はunknown。CLI attach / detachはnative JOIN / LEAVEではなく、
`hasKnownGaps: false`でも終端や切断中の完全性を意味しない。
