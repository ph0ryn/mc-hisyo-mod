# 用語と命名

概念・実装・文書で使う名前の基準。クラスやfileの数だけ概念を増やさず、主体・情報・処理・寿命を区別する。

## 主体

本体の名前は **hisyo**。目標・次の行動・返答を考え、プレイヤーと関わるAIは一つである。
指示、提案、相談、雑談、沈黙は同じhisyoの振る舞いで、別の役職ではない。
`advisor`、`director`、`hisyo-chat`などの別名を付けない。

Modはゲームとの窓口、CLIは常駐本体、Pi Durable / Pi AIは同一processの会話・モデル・Tool実行基盤。
summary生成や観測は別の対話主体ではない。

## 扱う情報

| 用語 | 意味 | 含めないもの |
| --- | --- | --- |
| **game state** | 体力・所持品・位置・周辺など、取得時点の限定情報 | 過去の出来事、summary |
| **event log** | Mod由来のゲーム内観測の蓄積。1件はevent | プレイヤー入力、HUD発言、CLI内部の事実 |
| **conversation** | 入力、AI応答、Toolとのやり取りを含む継続的な会話 | game接続、HUD発言だけの一覧 |
| **activity log** | 接続、入力受付、run要求、hook一致、表示確認などCLI事実 | Mod観測、開発用診断ログ |
| **summary** | event logの一部を短く整理した記録 | conversationの短縮、現在値、activity logの要約 |
| **hook** | eventの条件と一致時の指示を持つ永続登録 | SDKのtask hook、操作代行、即時発言の保証 |
| **reference** | 導入packageの静的ゲーム資料 | 現在のワールドの証拠、モデルへの命令 |

これらを互いの代用にしない。観測がないこと、既知欠番がないことは、出来事がなかった証拠ではない。
`history`を記録全般の総称にせず、保存種別を明記する。
`chat`はMinecraftの入出力経路で、保存conversationの別名ではない。
`snapshot`は取得時点のcopyという技術的性質。Modの差分検出用snapshotを公開game stateと混同しない。

## 処理と一回の実行

### run

hisyoの主処理を一回動かすまとまりを **run** と呼ぶ。
複数モデル要求・Tool実行を含み得るため、1 API呼出しや1発言とは違う。無言で終わってもrunである。
`judgment`や`decision`という別の実行単位を設けない。

- **run request**：集約する理由・入力の束。
- **run queue**：[RunQueue](<../src/runtime/runQueue.ts>)によるdomain集約。
- **run inbox**：[RunInbox](<../src/runtime/runInbox.ts>)によるpendingとdispatchの永続document。
- **dispatch**：安定した`requestId`を持つ、実行依頼用の予約。
- **submission**：Durableへdurably admitした入力。重複request IDは同じsubmissionを参照する。
- **run scheduler**：実行時期、pause、単一slot、入力受付を調整する部品。
- **run binding**：現在のゲーム接続でTool効果を許可する権限。

`initial`はready済みsessionへの初回runで、ワールドの新規作成やnative JOINではない。
要求記録、inbox受付、dispatch予約、SDK submission、provider送信、run完了は別の事実である。

### summarize

event logからsummaryを作る処理は **summarize**。
summary schedulerは同じCLI process内で周期・single-flight・取消を管理する部品で、別workerではない。
summary inputの準備は決定的な選択・整形であり、モデル生成そのものではない。

summarizeはDurableAgentを経由せず、mainの起動・conversation・保存領域に依存しない単発API要求とする。
固定指示と対象ログだけをModelsへ渡し、Tool・会話履歴・summary用sessionは持たない。
pause中も周期・進行中処理を続け、退出・終了時は結果を無効にして取消す。
認証はmainと同じSDK ownerとcredential storeを使う。

## 範囲と寿命

| 用語 | 識別するもの | 寿命・制約 |
| --- | --- | --- |
| **world / player scope** | 保存されたワールドとプレイヤー | domain記憶、conversation、run inboxの永続範囲 |
| **session** | 今回のgame attachment | 再接続で別の`sessionId`。readyは別途必要 |
| **run binding** | 今回のゲーム側の実行権限 | `runId`。取消・detachで無効になり、再利用しない |
| **request** | 一つの要求と応答・取消 | `requestId`。dispatchとsummaryは別の所有権 |
| **Harness owner** | scope別storageを開くSDK host | closeして処理がsettleするまでleaseを保持 |

保存conversationをsessionと呼ばない。SDKにも内部のsessionという語はあるが、gameの`sessionId`とは別である。
TCP connectionの認証、game attach、ready、モデル要求も区別する。
入力の重複排除に使うdispatch request IDと、usageに保存するnative run IDも別である。

## 実装への対応

TypeScriptのfileはcamelCase、型・classはPascalCase、関数・変数はcamelCase。Toolはsnake_case。
`queue`・`scheduler`・`store`・`bridge`は実装上の責務で、新しいAIの役職ではない。

| 責務 | 実装 |
| --- | --- |
| CLI構成と終了 | [hisyoRuntime](<../src/runtime/hisyoRuntime.ts>) |
| trusted設定 | [hisyoConfig](<../src/runtime/hisyoConfig.ts>) |
| native SDKモデルと認証 | [modelAccess](<../src/runtime/modelAccess.ts>) / [piCredentialStore](<../src/runtime/piCredentialStore.ts>) |
| game TCPとtrusted host API | [bridgeServer](<../src/bridge/bridgeServer.ts>) |
| Durable conversation・Tool・context | [durableAgent](<../src/runtime/durableAgent.ts>) |
| scope別SQLiteと所有者lock | [durableStorage](<../src/runtime/durableStorage.ts>) |
| 入力集約・永続admission・実行制御 | [runQueue](<../src/runtime/runQueue.ts>) / [runInbox](<../src/runtime/runInbox.ts>) / [runScheduler](<../src/runtime/runScheduler.ts>) |
| summary周期・単発生成・保存・入力加工 | [summaryScheduler](<../src/runtime/summaryScheduler.ts>) / [generateSummary](<../src/runtime/generateSummary.ts>) / [summaryStore](<../src/storage/summaryStore.ts>) / [summaryInput](<../src/events/summaryInput.ts>) |
| run / summary共通のusage記録 | [trackModelRequest](<../src/runtime/trackModelRequest.ts>) |
| event / activity検索 | [logSearch](<../src/storage/logSearch.ts>) |
| CLI事実の定義 | [activity](<../src/events/activity.ts>) |
| hook保存と照合 | [hookStore](<../src/storage/hookStore.ts>) |
| game state schema | [gameState](<../src/protocol/gameState.ts>) |
| 10 Toolの契約 | [hisyoTools](<../src/protocol/hisyoTools.ts>) |

## 通信・保存名

ネットワークRPCはModとの`bridge.hello`、`game.*`だけ。
Tool定義内部にある`hisyo.hooks.*` / `hisyo.events.*`はtrusted hostのdispatch名で、公開agent RPCではない。
CLI activityのevent名は`hisyo.*`、run要求は`hisyo.run_requested_*`。

| 保存対象 | 正規の名前 |
| --- | --- |
| event log | `eventLog.sqlite`、`events` |
| activity logとhook | `activityLog.sqlite`、`activities` / `hooks` |
| summary | `summary.sqlite`、`summaries` |
| conversationとtask | `durable/<scope hash>/conversation.sqlite` |
| run inbox document | `hisyo.run-inbox`、conversation scope |

Mod観測は`observation` / `observedAt`、保存列は`observation_json` / `observed_at`。
CLI事実は`activity` / `recordedAt`、保存列は`activity_json` / `recorded_at`。
ゲーム観測の一括送信は`game.events`とし、単件の別RPCを設けない。

## 関連資料

- [コンセプト](<concept.md>)
- [構成と責務](<architecture.md>)
- [コンテキスト](<context.md>)
- [通信プロトコル](<protocol.md>)
