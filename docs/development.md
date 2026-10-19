# 開発と実装状況

## 実装範囲と検証の区別

通常CLIは、認証付きgame bridge、Durable SDKのconversationと実行、永続run inbox、run / summary schedulerを同じNode.jsプロセスへ構成する。
Modはローカルsingleplayerとの接続口で、CLIを自動起動しない。
`--bridge-only`はモデル認証・run・summary生成を起動しない。

- released 1.3.0のPi Durable / Pi AI / Chordを[依存定義](<../package.json>)で固定する。
- mainは`openai/gpt-6-luna` / `medium`。summaryは同じモデルのToolなし / `priority` / `low`。
- world / player別のDurable SQLiteにconversation、task、受付済み入力とdispatchを保存する。
- Mod観測、CLI事実・hook、summaryはそれぞれ独立したdomain SQLiteで管理する。
- 10 game Toolだけを公開し、各モデル要求前に最新game stateとsummaryを取得する。
- pauseは新しいmain runとそのpoll時計だけを制限する。入力受付と独立summaryは続ける。
- [トークン使用量](<tokenUsage.md>)は生のprovider counterを保存し、未報告値を`null`にする。

自動テストにはunit testだけでなく、**実SDKとfake provider、使い捨てのdisk SQLite、実loopback TCP**を使う境界テストがある。
これを実ゲーム・実providerでの受入れと混同しない。
実ゲームのcallback、native Mixin適用、HUD、既存ユーザーDB、有料モデルを通した一連の受入れは未実施。
storage境界ではSIGKILLした子processのcommitとdead-owner lock回収を確認するが、mid-modelの強制終了や電源断を網羅した試験ではない。

| 境界 | 主な確認内容 |
| --- | --- |
| [DurableAgent tests](<../src/runtime/durableAgent.test.ts>) | 実Harnessとtemp SQLiteで再open、submission重複排除、保留generation、10 Tool、Tool後のcontext更新、fail-closed、unsafe Toolの非再送、取消usage |
| [RunInbox tests](<../src/runtime/runInbox.test.ts>) | 受付済み同文チャットの順序、予約 / submit間の再open、安定request ID、clear、容量超過rollback |
| [Durable storage tests](<../src/runtime/durableStorage.test.ts>) | scope別所有者とprivate file、実SIGKILL後のcommit復旧・dead PID lock回収、symlink拒否 |
| [bridge tests](<../src/bridge/bridgeServer.test.ts>) | 実TCPのfake gameとSQLiteで認証、binding、直接host API、非同期受付ACK、記録、stale / native-first取消 |
| [modelAccess tests](<../src/runtime/modelAccess.test.ts>) / [credential tests](<../src/runtime/piCredentialStore.test.ts>) | fake認証とfake fetchでPATH非依存、固定catalog、lock下のrotation、取消中の保存、秘密の非露出、fallback拒否 |
| [scheduler tests](<../src/runtime/runScheduler.test.ts>) / [composition tests](<../src/runtime/hisyoRuntime.test.ts>) | 公開依存portと実Durableのdocumentを使い、single-flight、pause、受付、終了順序を確認 |
| [summary API tests](<../src/runtime/generateSummary.test.ts>) / [summary runtime tests](<../src/runtime/summaryRuntime.test.ts>) | Tool・履歴なしの単発要求、Durable起動待ちからの独立、切断・終了後の遅いusage記録、共有認証ownerの終了順序 |
| [summary scheduler tests](<../src/runtime/summaryScheduler.test.ts>) / [storage tests](<../src/storage/>) | 周期、取消、cursor、ページング、保存transaction、観測とCLI事実の分離 |
| [Java tests](<../mod/src/test/java/>) | Minecraft runtimeを起動せず、共有fixture、DTO、snapshot差分、schema / referenceの契約を確認 |

終了・再open試験は実際のSQLite保存を確認するが、stubの解決順を実native処理の完了と同一視しない。
テストごとに使用resourceを確認し、実認証や既存ワールドへ勝手に接続しない。

## 検証コマンド

Node.js 24.15以降の24系、または26以降、pnpm 11、Java 21を使用する。
Node指定は[.node-version](<../.node-version>)、scriptsは[package.json](<../package.json>)を正とする。

```bash
pnpm install --frozen-lockfile
pnpm run verify
pnpm run build:mod
```

`verify`はcheck・ESM build・Vitestを実行する。Fabric buildはゲーム起動やEULA同意を行わず、既存ワールドを使わない。
依存が配置済みなら、`./node_modules/.bin/vp check`、`./node_modules/.bin/vp pack`、`./node_modules/.bin/vp test`を直接使える。
Vite+はプロジェクトローカル版を使い、[設定](<../vite.config.ts>)で型検査付きlint、Vitest、ESM buildを管理する。
テストは対象実装の隣へ置く。

Markdown用のpackage scriptはないため、文書の検査には次を使う。利用できない環境ではその旨を報告し、global設定を変更しない。

```bash
nix run nixpkgs/nixpkgs-unstable#rumdl -- check --fix "docs/"
```

FabricはMinecraft 1.21.11 / Loader 0.19.5 / Fabric API 0.141.6+1.21.11 / Java 21 / Loom 1.17.21 / Gradle 9.7.1を固定する。
Gradleは既存の標準cacheとDaemonを使い、依存がcache済みなら`pnpm run build:mod --offline`で実行できる。
ModのJUnitは`pnpm run test:mod`で実行でき、標準のcheck / buildにも含まれる。
共有JSON fixtureは[protocolの隣](<../src/protocol/fixtures/gameState.json>)へ置き、Javaからも同じfileを参照する。
[pnpm設定](<../pnpm-workspace.yaml>)は依存解決・供給網policy用で、monorepo構成ではない。

## 通常CLIとModの手動起動

build後のCLIを起動する。別の実行基盤や拡張bundleの準備は不要である。
公開CLI名は`hisyo`。引数は[parser / usage](<../src/cliOptions.ts>)、設定は[hisyoConfig](<../src/runtime/hisyoConfig.ts>)を正とする。

```bash
# 既存のChatGPT認証を選択した保存先から使う。
node dist/cli.mjs
# 別の認証保存先を明示する。
node dist/cli.mjs --pi-agent-dir /absolute/private/pi-agent
# 安全に設定済みの環境変数を使い、保存済み認証は読まない。
node dist/cli.mjs --api-key-env HISYO_API_KEY
```

通常モードは設定と認証源を検証してからbridge資源を開く。
ready済みのゲーム接続でscope別Durable storageを開き、新規runを開始できる状態を待つ。
`--help`はstate、認証store、SQLiteを開かない。credential optionと`--bridge-only`の併用は拒否する。

### 認証と固定モデル

- `--api-key-env NAME`があれば、その環境変数だけをAPI keyとして使う。未設定・空値はエラーで、保存済み認証へ戻らない。
- それ以外の認証保存先は`--pi-agent-dir` → `PI_CODING_AGENT_DIR` → `~/.pi/agent`。
  strict JSONの`auth.json`の`openai` entryだけを解決する。他providerのentryは実行せず、更新時も保持する。
- 対応するのは既存ChatGPT OAuthと`{"type":"api_key","key":"..."}`。
  保存API keyはliteralまたは全体が`${NAME}`の環境変数参照に限り、追加のprovider設定・コマンド・部分補間を拒否する。
  `openai-codex`は別providerであり、代替の認証源にしない。
- 元の`auth.json`と同じcanonical path・`proper-lockfile`のlockを共有する。
  symlinkや別名pathは別lock領域になるため拒否する。実際の認証保存先のpathを指定する。
  lock内で現在のcredentialを再検証し、SDKがOAuthの期限判定・refresh・rotationを行い、元の保存先へatomicに保存する。
- 起動時に認証を検証するが、eager refreshはしない。各モデル要求のSDK認証解決が必要なrefreshを担う。
  refresh失敗でproviderへ進んだり、別の環境変数へfallbackしたりしない。
  取消で既に始まったrotationの保存を捨てず、closeも認証更新の完了を待つ。
  呼出側の取消後にrefresh・保存が失敗しても隠さず、以後の更新を止め、closeで秘密を含まないエラーを返す。
- native OpenAI providerの`openai/gpt-6-luna`を使う。globalなモデル・settings・context・plugin設定は読み書きしない。
  認証コマンドやcustom API / model overrideを実行しない。秘密は引数や診断へ出さない。

認証storeは秘密を含む。信頼できる同じUIDの利用と、他の利用者も共有lockを守る運用を前提にする。
アプリはlogin / logout管理や、任意の編集者との競合解決を提供しない。

### ゲームへ接続する

実行用の`mc_hisyo-0.1.0.jar`を、対応するFabric APIとともにクライアントの`mods`へ置く。sources JARは使わない。
CLIを先に起動してからローカルsingleplayerへ入る。LAN公開・remote / dedicated serverは対象外。
通常の送信チャットだけをhisyoへ入力し、`/`から始まるコマンドや受信メッセージを入力へ戻さない。
hisyoの発言は`send_message`のliteral textだけをローカルHUDへ表示する。

接続・起動失敗時は設定とCLIを確認して退出・再入場する。Modの自動再接続・観測再送はない。
ゲーム側の未送信観測と、CLIが受付済みの永続run inboxは別の境界である。

Modの既定接続情報はJavaの`user.home`配下の`.mc-hisyo/connection.json`。
保存先を変える場合、Fabric config directoryの`mc-hisyo.json`へ絶対pathを指定し、CLIの`--data-dir`と一致させる。

```json
{"dataDirectory":"/absolute/private/state"}
```

Modは所有者・directory `0700`・接続file `0600`を検査し、symlinkを拒否する。
world rootの`mc-hisyo-world-id`へcanonical UUID + LFを排他新規作成し、以後再利用する。
既存の不正なIDを修復・上書きせず、player UUIDと合わせて保存scopeにする。

### 未実施の手動確認

実ゲームを確認する場合は、空の専用data directoryと使い捨てsingleplayerを使う。有料モデルの呼出しは別途承認・準備が必要である。

1. 通常チャットが通常表示を保ち、CLIにも1件だけ入力される。
2. `/say`やhisyoのHUD表示で、新たなプレイヤー入力が生じない。
3. pauseで次のmain runは止まり、入力受付・進行中run・独立summaryの契約は維持される。
4. 退出・切断後に古いbindingで発言やhook変更が起きない。
5. LAN公開・remote serverでは通常チャットを維持し、hisyoへの入力を行わない。

これは確認手順であって、合格実績の記録ではない。[遮蔽の手動回帰確認](<gameState.md#実ゲームでの遮蔽回帰確認手動>)も別途必要である。

## 保存先と終了

既定のdata directoryは`~/.mc-hisyo`。親は既存の信頼できる場所を使う。
新規directoryは`0700`、fileは`0600`、process umaskは`077`。
既存directoryの所有者・modeを要求し、symlinkは拒否する。既存権限を自動修正しない。
POSIX modeを使う実装で、拡張ACLは未検証、Windows起動は未対応。

- domain DBは`eventLog.sqlite`、`activityLog.sqlite`、`summary.sqlite`。
  main / WAL / SHM / journalの所有者・regular file・`0600`・link数1をopen前に検査する。
- Durable DBはscope別の`durable/<scope hash>/conversation.sqlite`。
  保存場所・所有者lock・電源断と副作用の限界は[durabilityの境界](<architecture.md#durabilityが保証する範囲>)を参照。
- `connection.json`の公開と削除は[通信契約](<protocol.md#cliの接続情報ファイル>)に従う。
  既存fileは壊れていても上書きしない。crash後は所有者の停止を確認して手動で回復する。
- Ctrl-C / SIGINT / SIGTERMではtimerを止め、summaryを取消し、mainの保留状態を残してSDKをcloseする。
  モデル処理・usage・認証更新を待ってからbridgeとdomain SQLite、自分の接続情報を閉じる。
  明示的なゲーム退出・切断の取消とinbox clearとは区別する。

### bridge-only CLI

```bash
node dist/cli.mjs --bridge-only
node dist/cli.mjs --bridge-only --data-dir /absolute/private/state
```

モデルへ接続せず、game bridgeとdomain記録を調べるためのモード。
チャットの受付handlerはなく、入力を成功扱いで捨てない。

## 診断ログ

CLIは時刻付きの人向け診断をstderrへ出し、tokenや認証情報、生のproviderエラーを転送しない。
Toolの開始・終了とruntimeの状態を示すが、assistant本文をそのままHUDへ転送しない。
入力・ゲーム内textを含む診断もあるため、出力の共有には注意する。
本文は4,096文字まで、改行・端末制御文字はescapeし、省略時は`[truncated]`を付ける。
診断fileは自動作成せず、永続するactivity logとは区別する。

## イベントの追加

定義の所有者は[gameEvent](<../src/protocol/gameEvent.ts>)。名前・説明・観測の確度・payload schema・filter可能scalarを宣言する。

1. イベント定義を追加する。
2. Modに観測処理を追加する。
3. 正常・不正payloadの共有fixtureと検証を追加する。

[EventCatalog](<../src/events/eventCatalog.ts>)、[EventLog](<../src/storage/eventLog.ts>)、[HookStore](<../src/storage/hookStore.ts>)へイベント名ごとの分岐を足さない。
未登録イベント、schema違反、非対応filterはエラー。外部plugin自動探索は提供しない。
完了callback・snapshot差分・操作試行を区別し、slot差分から原因を捏造しない。
現在の32種類の観測処理と限界は[観測資料](<observations.md>)を参照。

### 保存・検索の契約

- 観測保存はhookやrunから独立し、元のenvelopeとpayloadを保持する。
- session内の`seq`は1から増加し、重複・逆順は拒否する。飛びは`missingSequencesBefore`として残す。
- 検索は保存順。`limit`は1〜500、既定100。`nextCursor`を次の`after`へ、同じ`through`を渡す。
- `through`は選択したログの上限ID。event logとactivity logは別のID / cursor空間で、混ぜない。
- `since`はevent logの`observedAt`、activity logの`recordedAt`のUnixミリ秒で境界を含む。
  filterはイベント名を必須とし、公開scalarへの型付き完全一致ANDである。
- `hasKnownGaps`はworld / player全体の`through`以前の既知欠番を示す。検索filterで隠さない。
  `false`も切断中・session前後・producer捕捉限界の完全性を保証しない。
- hook一覧はID辞書順、既定・最大8件。snapshotではない。[Tool契約](<tools.md>)を参照。
- domain DBはそれぞれschema version 1。未対応versionを変換・削除・修復せず拒否する。
- hook変更と活動記録は同じactivity transaction。summary保存とcursor更新も同じsummary transaction。
  観測batchはevent DBで先に確定し、hook照合・監査はactivity DBで後から確定する。DBを跨ぐatomicityはない。
- live hookの照合・監査に失敗すれば観測が保存済みでもACKせずfaultにする。
  run inboxへの容量超過は別のscheduler faultで、保存済み観測とその`stored` ACKを取り消さない。
- 有効な同一bindingの`displayed: true` ACKは、後着でstaleでも表示事実を記録してからstaleを返す。
  不明な表示を再送しない。

ページは完全なrecord単位で、[eventPageBytes](<../src/storage/logSearch.ts>)の1 MiB − 4 KiB以内にする。
単一recordすら収まらなければ明示エラーとし、詳細を削ったり空ページで隠したりしない。
要求・hook一致記録はprovider実行の証拠ではなく、過去のevent logを再照合してrunを増やさない。
