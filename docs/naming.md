# 用語と命名

このプロジェクトの概念・実装・文書で使う名前の基準。
クラスやファイルの数だけ概念を増やさず、主体・情報・処理・寿命を区別する。

## 主体

本体の名前は **hisyo**。プレイヤーと関わり、目標・次の行動・返答を考えるAIは一つである。
指示、提案、相談への返答、雑談、沈黙は同じhisyoの振る舞いであり、別の役職やAIではない。
`advisor`、`director`、`hisyo-chat`などの別名は付けない。

Modはゲームとの窓口、CLIはhisyoの常駐本体、Piは会話・モデル呼び出し・Tool実行の基盤。
ゲームを観測する仕組みやsummaryを生成する処理は、別の対話主体ではない。

## 扱う情報

| 用語 | 日本語での説明 | 含めないもの |
| --- | --- | --- |
| **game state** | 体力・所持品・位置・周辺など、取得時点の限定的なゲーム情報 | 過去の出来事やsummary |
| **event log** | Modから受け取ったゲーム内の観測記録の蓄積。1件はevent | プレイヤー入力、hisyoの発言、CLI内部のactivity |
| **conversation** | プレイヤー入力、AIメッセージ、Toolとのやり取りを含む継続的な会話 | ゲーム接続そのもの、画面表示された発言だけの一覧 |
| **activity log** | 接続、入力受付、runの要求、hook一致、表示確認などCLI側の事実の記録 | Mod由来の観測、開発用の診断ログ |
| **summary** | event logの一部を短く整理した記録 | conversationの短縮、現在値、activity logの要約 |
| **hook** | eventの種類・条件・一致時の指示を組にした永続的な登録 | ゲーム操作の自動実行、即時の発言の保証 |
| **reference** | 導入済みパッケージの静的なゲーム資料 | 現在のワールドで何かが起きたことの証拠 |

現在のgame state、観測されたevent、CLIが記録したactivity、生成されたsummaryは、互いの代わりに扱わない。
観測は不完全であり、eventがないことや既知の欠番がないことは、出来事がなかった証拠ではない。

`history`を記録全般の総称にしない。event log・conversation・activity log・summaryのどれかを明記する。
`chat`はMinecraftの入出力経路を指す場合だけ使い、保存されたconversationの別名にはしない。
`observation`は観測という行為・観測された事実・証拠の確度を説明する語として使えるが、別のAIの役職名にはしない。
`snapshot`は取得時点のコピーという技術的性質であり、game stateと別の情報カテゴリではない。
Mod内部の差分検出用snapshotを、公開するgame stateと混同しない。

## 処理と一回の実行

### run

hisyoの主処理を一回動かすまとまりを **run** と呼ぶ。
複数のモデル呼び出し・Tool実行を含み得るため、1回のAPI呼び出しや1発言とは同義ではない。
何も発言せずに終了してもrunである。`judgment`や`decision`という別の実行単位は設けない。

開始、時間経過、プレイヤー入力、表示対象の進捗達成、hook一致がrunを要求する理由になる。
hookはこのうちの一つであり、すべての呼び出し理由を指す名前ではない。
初回の理由を`initial`と呼ぶ。これはready済みsessionへの初回実行であり、ワールドの新規作成やnative JOINではない。

- **run request**：次のrunへ渡す理由・入力の束。実行前に集約できる。
- **run queue**：まだ消費していないrun requestを保持する仕組み。
- **run scheduler**：実行可能なタイミングと単一実行を調整する仕組み。
- **run binding**：実行中のrunを識別し、Tool操作の権限を結び付ける情報。

要求を記録したこと、runの権限を確保したこと、Piが入力を受理したこと、モデルが実行されたこと、
runが終了したことは別の事実である。要求を実行成功として記録しない。

### summarize

event logからsummaryを作る処理は **summarize**。
summaryは生成物、summary schedulerは生成の周期・単一実行・取消を管理する実装部品である。
このschedulerはCLIと同じプロセスで動き、別threadや別worker processではない。
summary inputの準備は、eventを決定的に選択・整形する処理であり、それ自体はモデルによるsummarizeではない。

summarizeはrun・conversation・Toolの権限を取得せず、独立したモデル呼び出しとして行う。
ゲームのpause中も周期と進行中の生成は継続する。ChatGPT OAuthは各生成の前に信頼済みPi所有者が更新し、
隔離したPi子プロセスにはaccess tokenだけを渡す。退出・終了時には取消し、無効になった結果を保存しない。

## 範囲と寿命

| 用語 | 識別するもの | 寿命 |
| --- | --- | --- |
| **world / player scope** | どのワールドのどのプレイヤーか | event log・activity log・summary・hook・conversationの保存範囲 |
| **session** | 今回readyになったゲームとの接続区間 | 再接続で別になる。`sessionId`で識別 |
| **run** | 今回のhisyo主処理 | 開始から終了まで。`runId`で識別 |
| **request** | 一つの要求と対応する応答・取消 | `requestId`で識別。summaryの要求もrunとは別 |
| **Pi process** | 会話を動かす子プロセス | sessionに応じて起動・終了。保存conversationとは別 |

保存conversationをsessionと呼ばない。Pi processが終了しても、同じworld / playerのconversationは次回へ持ち越す。
TCPのconnectionもsessionとは別であり、接続の認証とゲーム側のreadyを区別する。

## 実装への対応

TypeScriptのファイル名はcamelCase、型・クラスはPascalCase、関数・変数はcamelCase。
CLI名は`hisyo`。RPCはhisyo側の機能を`hisyo.*`、ゲーム側の機能を`game.*`に分ける。
Tool名はsnake_case。正規の用語を使い、同じものに別の役職名や歴史的な別名を付けない。

| 責務 | 実装名 |
| --- | --- |
| CLI全体の構成と終了処理 | `hisyoRuntime` / `startHisyoRuntime` |
| 信頼済みの本体設定 | `hisyoConfig` / `HisyoConfig` |
| TCP接続・認証・要求の中継 | `bridgeServer` / `BridgeServer` |
| Pi側のTool登録・中継・コンテキスト注入 | `piExtension`。同梱bundleも`piExtension.mjs` |
| 主処理の入力集約・実行調整 | `runQueue` / `RunRequest` / `runScheduler` |
| Pi子プロセスの所有と終了 | `piProcess` / `PiProcess` |
| summaryの周期と取消 | `summaryScheduler` / `SummaryScheduler` |
| summaryの保存・cursor・注入する文面 | `summaryStore` / `SummaryStore` |
| summary要求・結果のschema | `summary` |
| summary inputの選択・整形 | `summaryInput` / `prepareSummaryInput` / `SummarySource` |
| event logとactivity logのページ検索 | `logSearch` / `searchLog` / `LogPage` |
| Mod観測のDB | `eventDatabase` / `openEventDatabase` |
| CLI activityの定義 | `activity` / `Activity` |
| hookの永続化と照合 | `hookStore` / `HookStore` / `Hook` |
| 現在情報のschema | `gameState` / `GameState` |
| 本体のTool契約 | `hisyoTools` |
| sessionへの結び付け | `SessionBinding` |
| Mod側の構成 | `HisyoClient` |
| Modの起動設定・接続情報・ワールドIDのファイル | `BootstrapFiles` |

`bridgeServer`と`piExtension`は通信の両端だが、責務が異なるため同じbasenameにしない。
`queue`・`scheduler`・`store`・`bridge`は実装上の責務を示す語であり、新しいAIの役職ではない。
技術的に正確な既存名まで機械的に置き換えない。Modの`ServerObservations`や差分検出用snapshotはその例である。

## 通信・保存名

| 境界 | 正規の名前 |
| --- | --- |
| CLI | `hisyo` |
| 主処理のRPC | `hisyo.run.*` |
| summaryの生成・取消・取得 | `hisyo.summary.create` / `hisyo.summary.cancel` / `hisyo.summary.get` |
| event種別・ログ検索 | `hisyo.events.list` / `hisyo.events.search` |
| CLI activityのevent名 | `hisyo.*`。run要求は`hisyo.run_requested_*` |
| ログ検索Tool | `search_events` |
| hook Tool | `add_hook` / `remove_hook` / `list_hooks` |
| event logの保存 | `eventLog.sqlite`、`events`テーブル |
| activity logとhookの保存 | `activityLog.sqlite`、`activities` / `hooks`テーブル |
| summaryの保存 | `summary.sqlite`、`summaries`テーブル |
| conversationの保存 | world / playerごとの`conversation.jsonl` |

activityは観測のコピーではないため、activity logのpayloadは`activity`、保存列は`activity_json`、
記録時刻は`recordedAt` / `recorded_at`とする。Mod観測は`observation` / `observedAt`として区別する。
ゲームの一括送信は`game.events`に統一し、単件用の別RPCは設けない。

## 互換性

この整理では旧revisionとの互換性は維持しない。
旧CLI名・RPC名・Tool名のalias、旧形式の読取り分岐、旧DBやconversationの自動移行は作らない。
既存データを勝手に削除・変更もしない。古い形式を利用したければ、その形式を実装していたrevisionを使う。
通信protocol versionは2とし、旧versionとの接続は拒否する。

既に役割を表している`MC_HISYO_BRIDGE`、`mc_hisyo`、Javaのpackage namespace、world / playerのIDなどは、
互換性のためではなく名前が妥当なので維持する。
振る舞いや観測の確度を変えるための整理ではない。

## 関連資料

- [コンセプトと基本方針](concept.md)
- [構成と責務](architecture.md)
- [コンテキストと記憶](context.md)
- [通信プロトコル](protocol.md)
