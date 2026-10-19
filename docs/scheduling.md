# runの予約とhook

runのadmission、集約、pause、single-flightはアプリのschedulerが管理し、conversationと実行taskはPi Durableが保持する。
[RunInbox](<../src/runtime/runInbox.ts>)は集約済み入力とdispatch予約を同じDurable SQLiteへ保存する。
実SDK / fake provider / temp SQLite / TCPの境界テストはあるが、実ゲームの受入れは未実施。[検証範囲](<development.md>)を参照。

## runを予約する入口

1. ready済みsessionの最初のrun（`initial`）。ワールド新規作成やnative JOINではない。
2. プレイヤーの通常チャット。
3. 定期poll。
4. 登録済みhookに一致した観測。
5. 表示対象の実績完了（`advancement_completed`かつ`hasDisplay: true`）。hook登録は不要。

通常イベントはevent logへ保存するだけで、すべてがrunを予約するわけではない。
criterion単体や表示を持たない内部進捗は、hookに一致しなければ予約しない。
観測は約1秒のbatch送信なので、hook・実績の予約にもその待ちがある。チャット・pauseは即送信する。
run間もモデルがゲームを常時監視しているわけではなく、即応したい作業には対応hookが必要である。

## 定期ポーリング

hisyoが主導して目標と次の行動を決める。初回や次の行動が不明なときは、質問やイベントを待たず具体的な行動を示す。
指示が有効でプレイヤーが取り組んでいる間は追加・反復せず、達成・行き詰まり・状況変化で計画を更新する。
自然な雑談・反応・励ましもよいが、HUDの通常値や所持品一覧を実況しない。
必要なhookは発言前に登録し、Toolの表示ACKや状態更新を新しい発言要求として扱わない。

```text
ready済み・非pauseのsession
  → active-playの期限到達
  → inboxへpoll理由をcommit
  → main slotが空いたらdispatch予約
  → native bindingを確保してDurableへsubmit
  → mediumのモデル要求・必要なTool
  → settled後にdispatchを消費
```

[ActivePlayClock](<../src/runtime/activePlayClock.ts>)は単調増加ミリ秒を受け、非pauseの累計60秒を初期周期とする。
これは計測済みの最適値ではない。
pause前の端数を保持し、pause中の時間は除外する。非有限・負数・逆行時刻はエラー。
遅れたsampleも1予約にまとめ、超過分を持ち越して連打しない。
ready時に時計を作り、退出・切断・session変更で時計を作り直す。

`poll(binding)`の`true`はadmissionを予約した意味で、provider実行や永続commitの完了ではない。
後から保存に失敗すればscheduler faultになる。binding不一致・pause・未到達・終了中は`false`。
[hisyoRuntime](<../src/runtime/hisyoRuntime.ts>)は1,000 msごとに現在のready sessionをsampleし、終了時はtimerを先に止める。

hookを含むrunが`settled`になれば保留pollだけを消し、その時点からactive-playの60秒を数え直す。
無言・明示取消を含むが`not_started`ではresetしない。保留チャット・hookは消さない。
時計そのものは永続化せず、host再起動後も以前の経過秒を復元するわけではない。

## pauseと取消

pauseは**次のmain runのdispatch**とpoll時計だけを止める。
接続・Durable storageの起動・入力受付・game state取得は止めない。
既にdispatchしたrunは、native bind準備中にpauseされても、その理由だけでは取消さない。
進行中のモデル・Tool・完了を待ち、解除後もslotを重ねない。
[独立summary](<context.md#summary>)はpause中も経過時間を数え、新規開始・完了・保存を続ける。

明示的な退出・切断・取消は、先にrun bindingをfenceし、SDKへabortを要求する。
abort signalを出しただけでsettledとみなさず、SDKと進行中native処理が終了するまで所有権を保つ。
次のrunで古い効果を新しいbindingへ付け替えない。
[native-first取消](<protocol.md#native側が先にrunを無効化した場合>)の不確定待機も、この単一slotとは別に維持する。

## hook

hookはイベント条件（`event`、任意の`filter`）と指示（`instruction`）の永続登録。
SDKのtask hookとは別の概念である。

```json
{
  "event": "block_broken",
  "filter": {"blockId": "minecraft:stone"},
  "instruction": "かまど作成の進捗を確認し、次の行動を判断する"
}
```

CLIは公開scalarへの型付き完全一致ANDで照合し、個数や目標の意味は解釈しない。
hisyoが対応一覧を参照して登録・削除する。
登録後に受信したlive観測だけを対象にし、過去のevent logを再照合しない。
hook削除はevent logを消さず、既に捕捉した指示も変更しない。

```text
Modの観測 → event DBへ保存
  → live hook照合とactivity監査
  → 一致した指示・正確な保存イベントをinboxへcommit
  → runで最新game stateを確認
  → 発言・hook変更・無言で終了
```

例えば石破壊hookで所持数を確認し、十分なら削除して次のクラフトのhookへ変える。
これを専用の目標別状態機械としてCLIに実装せず、hisyoが最新状態とevent logから判断する。

## run queue

[RunQueue](<../src/runtime/runQueue.ts>)は一つのbinding向けrun requestを集約する純粋なdomain部品。
[RunInbox](<../src/runtime/runInbox.ts>)がそのsnapshotをconversation内の`hisyo.run-inbox` documentへ保存する。

- `initial`とpollはそれぞれ1つのflagへまとめる。
- 同文チャットも受信順に別々に残す。
- hookは一致時点のID・指示・正確な保存event IDを保持し、同じhookの複数一致をまとめる。
- 観測本文と既知欠番情報は1コピーにし、複数hookからIDで参照する。実績とhookが重なっても二重runにしない。
- pendingの既定上限はJSON化したUTF-8で1 MiB。指示・参照・観測・escapeを含む。process全体のRSS上限ではない。
- 1観測に複数hookが一致して収まらない場合も、一部だけを採用しない。
  admissionのcommitをrollbackし、以前の受付済み入力を保持してscheduler faultにする。古い入力を追い出さない。
- dispatchを予約した後の入力は次のpendingへ入り、取得済みの束を書き換えない。

## 永続admissionとdispatch

inbox documentには`pending`と`dispatch`を持つ。dispatchは安定した`requestId`と入力を保持する。

1. チャット受付はpendingへのcommitをawaitする。成功した場合だけgameへ`accepted: true`を返す。
2. `take()`はpendingを取り出す操作とdispatch予約を同じcommitで行う。
3. schedulerは保存済みIDを`conversation.submit({ requestId, ... })`へ渡す。
4. hostが予約後・submit前後で止まっても、再open後は同じIDで元submissionを取得する。
5. `settled`を待ってdispatchを完了する。`not_started`では予約を保持する。

これは**入力のadmission重複排除**であり、表示やhook変更のexactly-onceではない。
全Toolを`replay: "unsafe"`とし、未確定の実行を再open後に自動dispatchしない。
[電源断・外部副作用・別DB transactionの限界](<architecture.md#durabilityが保証する範囲>)も参照。

| 終了理由 | 保留状態 |
| --- | --- |
| host close / process crash | conversationのtask、pending、dispatchを残す |
| 明示ゲームdetach / 切断 | SDK abort後、inboxをclearし、古い理由を次のsessionへ送らない |
| 保存・binding失敗などのruntime fault | schedulerを停止し、保存済み状態を成功扱いで捨てない |

host再起動後は同じworld / playerの受付済み入力を復旧できるが、storageをopenしただけではモデル要求を出さない。
ready済みの現在sessionと新しいnative run bindingを得て初めて、保存済みrequest IDで再開する。
元の観測に付いたsource sessionは変えず、現在の実行権限だけを新しいsessionへ結び付ける。

## 実行制御と検証

[RunScheduler](<../src/runtime/runScheduler.ts>)はmainをsingle-flightにし、優先度laneや入力割込みを設けない。
入力到着やpauseだけで進行中runを止めない。受付はsessionごとに直列化する。
容量超過後のチャットは`-32004`で拒否し、同じruntimeのsession再接続だけでは回復しない。
観測は既にdomain保存済みなので、run受付失敗を観測保存の失敗へすり替えない。
独立したゲーム内scheduler診断HUDはない。

退出のcleanup、SDK処理とstorage closeが完了するまで、次の所有者を起動しない。
closeが失敗したままleaseを奪ったり、settledを捏造したりしない。
run要求のactivityは実行依頼前に保存するが、provider送信や応答の証拠ではない。

- [queue unit tests](<../src/runtime/runQueue.test.ts>)は集約と容量を公開APIで確認する。
- [inbox tests](<../src/runtime/runInbox.test.ts>)は実SDK / temp SQLiteで予約と受付済み入力の再openを確認する。
- [scheduler tests](<../src/runtime/runScheduler.test.ts>)はbridgeとagentの依存境界、実Durable documentを使い、pause・単一slot・終了順序を確認する。
- [core tests](<../src/runtime/durableAgent.test.ts>)は実Harnessとfake providerでgeneration・Tool・contextの再openを確認する。
- [clock tests](<../src/runtime/activePlayClock.test.ts>)はactive時間・遅延集約・不正時刻を確認する。

主処理は全runで`medium`固定であり、`quick` / `high`切替や即応lane、応答時間の保証はない。

## 一次資料

- [Pi Durable 1.3.0のpersist / resume](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md#persist-and-resume>)
- [Pi Durable 1.3.0の独自document](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md#your-own-state>)

## 関連資料

- [用語と命名](<naming.md>)
- [Tool一覧](<tools.md>)
- [通信プロトコル](<protocol.md>)
