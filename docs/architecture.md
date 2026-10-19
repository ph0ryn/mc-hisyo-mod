# 構成と責務

CLIは単一のTypeScript / Node.jsパッケージ、Modは独立したJava / Fabricプロジェクトとする。
推論とconversationの実行基盤は、CLIと同じプロセスで動くPi Durable SDKである。
依存する`@earendil-works/pi-durable`、`@earendil-works/pi-ai`、`@earendil-works/chord`はすべてreleased 1.3.0へ固定する。
[起動手順と検証範囲](<development.md>)を参照。

```mermaid
flowchart LR
    M["Fabric Mod"] <-->|"認証付きloopback TCP / JSONL"| B["BridgeServer"]
    subgraph C["hisyo CLI / 同一Node.jsプロセス"]
        B <--> R["RunScheduler / RunInbox"]
        R <--> D["DurableAgent / Harness"]
        D <-->|"型付きhost API"| B
        S["SummaryScheduler"] --> D
        D --> A["Models / credential adapter"]
        B --> L["event / activity / summary DB"]
        D --> Q["scope別Durable SQLite"]
    end
    A <-->|"SDK provider"| P["OpenAI"]
```

## 所有者と境界

| 要素 | 責務 |
| --- | --- |
| Fabric Mod | game state取得、観測、入力通知、hisyoの発言のローカル表示、ゲームスレッドでのbinding検証 |
| [hisyoRuntime](<../src/runtime/hisyoRuntime.ts>) | 設定・認証・bridge・scheduler・timerの構成と終了順序 |
| [RunScheduler](<../src/runtime/runScheduler.ts>) | pauseによる新規runの制限、単一実行、ゲーム接続の寿命、入力受付 |
| [RunInbox](<../src/runtime/runInbox.ts>) | 集約済みの保留理由とdispatch予約をconversation内のdocumentへ保存 |
| [DurableAgent](<../src/runtime/durableAgent.ts>) | Harness、conversation、10 Tool、毎要求のcontext、モデル呼出し、取消とclose |
| [BridgeServer](<../src/bridge/bridgeServer.ts>) | game TCP認証、session / run binding、Toolの実処理、domain記録と結果検証 |
| [modelAccess](<../src/runtime/modelAccess.ts>) | native OpenAI providerと固定モデル、選択した認証源だけを使うModels |
| [PiCredentialStore](<../src/runtime/piCredentialStore.ts>) | 元の認証保存先を共有lockで読む・更新するSDK CredentialStore adapter |

Modとのwireは[protocol version 2](<protocol.md>)。TCPで受け付ける役割は`game`だけである。
DurableからのTool、summary context、usage記録は信頼済みのin-process APIを使い、追加のagent socketは開かない。
SDKのregistryへ登録するのは専用promptと[10 game Tool](<tools.md>)だけ。
コーディングTool、shell、一般OSファイル、任意ネットワーク、ゲーム操作代行はモデルへ公開しない。
これはToolの権限境界であり、Node.jsプロセスのOS / network sandboxではない。

モデルはnative catalogの`openai/gpt-6-luna`、主処理は`medium`固定とする。
独立summaryは同じモデルへToolなし、`reasoningEffort: low`、`serviceTier: priority`で要求する。
主処理とsummaryのsingle-flight・時計・取消は別であり、summaryはpause中も進める。
モデルやtierの自動fallbackは行わない。

## 永続化の分担

world / playerが保存scopeで、再接続ごとに変わる`sessionId`とは独立する。
CLIはゲーム未接続でも待機できるが、主処理のモデル要求とTool効果には現在のready済みsessionとnative run bindingが必要である。
独立summaryは現在のready済みSessionBindingだけを要求し、native runのslot・bindingを取得しない。

| 保存対象 | 場所と所有者 |
| --- | --- |
| Modの観測 | `eventLog.sqlite`。 [EventLog](<../src/storage/eventLog.ts>) |
| CLI事実とhook | `activityLog.sqlite`。 [ActivityLog](<../src/storage/activityLog.ts>) / [HookStore](<../src/storage/hookStore.ts>) |
| 観測のsummaryとcursor | `summary.sqlite`。 [SummaryStore](<../src/storage/summaryStore.ts>) |
| conversation、実行task、run inbox | `durable/<scope hash>/conversation.sqlite`。 [durableStorage](<../src/runtime/durableStorage.ts>)とHarness |

scope hashは`JSON.stringify([worldId, playerId])`のSHA-256。
DurableのSQLiteは新しい保存形式・場所であり、既存のPi conversation JSONLを読み込まず、変換・削除もしない。

[events](<../src/events/>)はイベントの意味・schema・summary入力加工を、[storage](<../src/storage/>)はdomain SQL永続化を持つ。
Durableのtask保存をevent logやactivity logの代用にせず、domain記録のためにSDK内部tableへ直接SQLを書かない。
summaryはevent logだけから派生し、conversationの短縮やactivity logの要約ではない。

## durabilityが保証する範囲

- 受付済みの入力はRunInboxのdocumentへcommitしてからチャットのACKを返す。
  pendingからdispatchへの予約は一つのcommitで行い、安定した`requestId`を保存する。
  `submit`前後でhostが止まっても、同じIDで元のsubmissionを探し、入力を二重に投入しない。
- hostのcloseはHarnessを閉じ、保留taskとinboxを残す。明示的なゲーム退出・切断は取消とinboxのclearを行う。
  再openだけでは実行を再開せず、同じworld / playerの新しいnative bindingを得たrunから再開する。
- [released SQLite adapter](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md#storage>)は
  WAL / `synchronous = NORMAL`を使う。process crashからの復旧を対象にするが、電源断・host障害では最新commitが失われ得る。
  filesystem破損やbackupの代替を保証するものではない。
- 外部の表示やhook変更はexactly-onceではない。全game Toolを`replay: "unsafe"`とし、未確定の実行を再open後に自動再dispatchしない。
  中断したToolは`interrupted`として扱う。既に表示された内容を取り消せるわけでも、結果不明の効果を復元できるわけでもない。
- domain DB、Durable DB、ゲームの副作用を跨ぐtransactionはない。
  観測保存・hook監査・run admissionの境界も別であり、ACKや要求記録をモデル実行成功の証拠にはしない。

scopeごとに一つの所有者だけがDurable storageを開く。所有者lockはprivateな`owner.lock`。
所有者・mode・形式・同じfileのidentityを検証し、記載PIDが`ESRCH`の場合だけstale lockを回収する。
生存PID、再利用されたPID、不正なlockでは自動的に奪わない。
一方、CLIの接続情報は[手動のstale回復](<protocol.md#cliの接続情報ファイル>)が必要であり、同じ回収policyではない。

closeは進行中のSDK・native処理を待ってからstorageの所有権を解放する。
取消signalは外部処理の完了証明ではなく、signalを無視する処理や認証rotationの保存で終了が遅れることがある。

## 毎要求の安全性

主処理の**各モデル要求**のdispatch直前に、最新game stateと保存済みsummaryを取得し、transientな背景情報として渡す。
Tool後の再判断と復旧したgenerationも対象とする。
必須contextの失敗・stale bindingではproviderを呼ばない。
released Durableでは投げたhook例外が報告後skipされるため、fail-closed境界はhookではなくModelsのdispatch wrapperに置く。
詳細は[コンテキスト](<context.md>)と[取消・binding](<protocol.md>)を参照。

## 一次資料

upstreamの`main`ではなく、実際に依存するreleaseを参照する。SDKはexperimentalなAPIであり、将来の変更を現在の機能として扱わない。

- [Pi Durable 1.3.0](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md>)
- [Pi AI 1.3.0](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md>)
- [Chord 1.3.0](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/chord/README.md>)

## 関連資料

- [用語と命名](<naming.md>)
- [コンセプトと基本方針](<concept.md>)
- [通信プロトコル](<protocol.md>)
- [Tool一覧と呼び出し](<tools.md>)
