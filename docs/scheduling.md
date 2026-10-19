# runの予約とhook

run queue、初回・チャット・実績解除・一致hook・pollのsingle-flight実行制御、active-play計時と通常CLI / Modへの配線は実装済み。
実ゲームを含むschedulerの受入れは未実施。[実装・検証状況](<development.md>)を参照。

## runを予約する入口

1. ready済みsessionの最初のrun（理由`initial`）。ワールドの新規作成やnative JOINを意味しない。
2. プレイヤーからのチャット。
3. 定期ポーリング。
4. hisyoが登録したhookの一致。
5. 表示を持つ実績の解除（`advancement_completed`かつ`hasDisplay: true`）。hook登録は不要。

通常のゲームイベントはCLIへ通知してevent logへ記録するが、記録するだけではrunを予約しない。
観測は1秒間隔の一括送信なので、実績解除・hookによる予約にも通常は1秒程度の送信待ちがある。チャット・pause通知はこの待ちに含めない。
予約条件は上記5つに限り、hisyoがrunとrunの間もゲームを常時監視しているわけではない。
実績解除以外の作業完了や行き詰まりに即応するには対応するhookが必要。この条件と制約をsystem promptにも明記する。
criterion単体や表示を持たない内部進捗は自動でrunを予約しない。event logへの記録とhook照合は引き続き行う。

## 定期ポーリング

hisyoが主導して目標と行動を決め、プレイヤーに有効な指示がある状態を保つ。初回や次にやることが不明なときは、質問や新しいイベントを待たず、具体的な行動を伝える。
指示の個数やrunごとの発言回数は固定せず、必要なら複数の手順をまとめて伝える。指示が有効でプレイヤーが取り組んでいる間は、pollでもhookでも指示を追加・反復せず、その作業を任せる。
例えば「鉄を1スタック集める」と指示済みで収集中なら追加指示は不要。達成・行き詰まり・状況に不適合になった時点で、次の行動を指示するか計画を修正する。
発言は指示に限定しない。作業中でもhisyoから自然な雑談・出来事への反応・励ましをしてよく、現在の目標に関係のない会話も許す。会話の好みはプレイヤーに合わせる。
質問や意味のある危険には応答し、指示の停止・削減の希望にも従う。会話に関連するアイテムの話題は許すが、HUDの通常値・所持品一覧は実況しない。
必要なhookの登録・更新は発言前に済ませ、そのrunでの指示や会話が済んだら終了する。game stateの再取得や表示ACKを、新しい発言要求として扱わない。

```text
sessionがready・プレイ中であることを確認
  → CLIの定期タイマーが発火
  → runを予約
  → Piが空いたら固定mediumで実行
  → 必要ならToolで確認
  → 発言・hook変更・無言で終了
```

プレイ中60秒を初期値とする。計測済みの最適値ではない。
[ActivePlayClock](<../src/runtime/activePlayClock.ts>)はタイマーを持たず、単調増加するミリ秒値だけを受け取る。
`setPlaying(playing, nowMs)`で状態変更直前までの経過を加算し、`poll(nowMs)`はactiveな累計が60秒に達した場合だけ`true`を返す。
ポーズ前の端数は保持するが、ポーズ中の経過は除外する。同時刻の再sampleは許し、非有限・負数・逆行する時刻は明示エラーにする。
遅れたsampleも1予約にまとめ、超過分は持ち越さず、そのsampleから次の60秒を数える。復帰後に過去の回数分を実行しない。
ポーズ直前に既に60秒へ達していた場合は復帰後のsampleで1回だけ予約できる。

run schedulerはready済みsessionごとに時計を作り、ready時点から非pauseの時間だけを計る。退出・切断・session変更では時計と揮発予約を破棄する。
`poll(binding)`は現在のbinding・非pause・未故障・未closeを確認してから時刻をsampleし、期限到達時は既存run queueのpoll flagへまとめる。
戻り値`true`は予約の受付・集約であり実行完了ではない。未到達・古いbinding・停止中は`false`、計時や受付の失敗は`fault`で明示して停止する。
プレイヤー入力・hookは同じ次回run requestに保持し、pollだけのために別slotや割込みを作らない。
hookを含むrunが`settled`になった時点で、保留pollだけを取り消し、そこから60秒のactive-play計時をやり直す。
無言・明示取消を含むが、`not_started`ではリセットしない。保留のチャット・hookは残し、pause中の時間は引き続き数えない。
時計の既定入力は`performance.now()`で、unitでは`monotonicNow` portへ手動時刻を渡す。
[hisyoRuntime](<../src/runtime/hisyoRuntime.ts>)は1,000 msごとにready済みsessionへこの入口を呼び、shutdown時にtimerを最初に止める。

pauseの実行制限はrun schedulerだけが担い、定期実行までの経過時間を数えず、次のrun requestをPiへ渡さない。
接続・起動・入力受付・ゲーム内時刻の取得を止める意味ではない。
既にPiへ渡したrunは、認証更新やbinding準備中にpauseされても拒否せず、開始済みのrun・Toolと同じく完了まで続ける。
[summary](<context.md#summary>)はrunとは別の時計でpause中も経過時間を数え、新規開始・完了・保存する。
退出・切断・明示停止では実行中のbindingを直ちに無効化し、CLIはPiへabortを要求する。
`agent_settled`を確認するまでslotを解放せず、停止待ちの間に復帰してもrunを重ねない。

## hook

hookはイベント条件と指示の組であり、一致した観測と指示をrun requestへ入れる。
Pi自体のライフサイクルイベントとは区別する。

hisyoによる`add_hook`の登録例。

```json
{
  "event": "block_broken",
  "filter": {"blockId": "minecraft:stone"},
  "instruction": "かまど作成の進捗を確認し、次の行動を判断する"
}
```

`filter`はイベントに含まれるIDなど、監視対象を指定するためのものとする。
CLIはイベントと対象の一致を判定し、所持数や進捗の意味は解釈しない。
hisyoは対応イベント一覧を参照し、必要なhookをToolで設定する。

```text
Modがイベントを通知
  → CLIがevent logへ記録
  → 登録済みhookと照合し、一致をactivity logへ記録
  → 一致したhookの指示と観測を添えてrunを予約
  → PiがコンテキストやToolでgame stateを確認
  → 発言・hook変更・無言で終了
```

hookはhisyoが削除するまで維持する。
登録後にCLIが受け取った観測を対象とし、過去の出来事はevent logから確認する。
目標変更時に不要になったhookを削除する判断もhisyoに任せる。

## かまど作成の例

| runの理由 | hisyoの動作 |
| --- | --- |
| sessionの初回 | 石破壊hookを追加し、「かまど用の丸石を8個集めましょう」と指示 |
| 定期ポーリング | 作業中なら指示は維持し、自然な会話も可。指示なし・達成・行き詰まりなら次の行動を示す |
| 石破壊hook | 所持数を確認し、足りなければ追加指示は不要 |
| 石破壊hook | 十分なら石破壊hookを削除し、かまど入手hookを追加して「クラフトしましょう」と指示 |
| かまど入手hook | 次の行動を判断し、必要なhookへ変更 |

この進行を専用の状態機械として実装しない。
石の破壊と丸石の入手のタイミングの違いなども、最新game stateとevent logを取得してhisyoが判断する。

## run実行中の扱い

Piはrunを1件ずつ処理する。
CLIが実行待ちを管理し、同じhookの一致は観測を失わずにまとめて次回へ渡す。
プレイヤーからの入力も保持し、pollを重ねて予約しない。
処理待ち入力が容量上限を超えたら、明示エラーでrun処理を停止する。黙示的な破棄や永続inboxへの退避は行わない。

現在は優先度別laneや入力割込みを設けず、同じrun queueで順番に処理する。
取消はbinding無効化・停止等で行い、pauseや入力到着だけで進行中のrunを中断しない。

Piの`steer`は進行中のAPI応答を即座に中断する機能ではなく、次のモデル呼出し前に入力を渡す仕組みである。
runの完了確認には`agent_settled`を使う。
`prompt`の受理応答や`agent_end`だけでは、その後の自動処理まで完了したと判断しない。

## run queue

[RunQueue](<../src/runtime/runQueue.ts>)は、一つのworld / player / `sessionId`に属するrun requestを保持する。
初回・pollはそれぞれ1予約へまとめ、チャットは同文でも受信順に別々に残す。
hookは一致時のID・指示・正確な保存イベントIDを保持し、同じhookの一致をまとめる。
一致した観測の内容と連番欠損情報はrun request内に1コピーだけ保持し、複数hookからIDで参照する。
実績解除も`observations`へ保持する。同時にhookが一致しても内容は1コピーで、別々のrunには分けない。
後でhookを削除しても捕捉済みの指示は変えず、新規hookを過去イベントへ照合し直さない。

- 既定上限は保留run requestをJSON化したUTF-8で1 MiB。指示・参照・観測本文・JSON escapeも数える。
  初期の容量制限であり、最適値を計測したものでも、process全体のRSS上限でもない。
- 一つの観測に複数hookが一致した場合も、全件を収められなければ受付を失敗させる。一部だけをrunへ渡さない。
- 超過後は新しい受付もrun request取得も同じエラーで拒否し、自動回復しない。古い入力を追い出して空きを作らない。
- run request取得後の入力は次の保留run requestへ入り、取得済みの内容を書き換えない。
  runtimeも取得済みrun requestを1件に制限し、その実行前・実行中の入力を次の保留run requestへ分離する。
- 保留はsession内の揮発状態。crash・退出・明示停止を超えた配送保証や、次のsessionへの再送は行わない。
  永続するevent log・activity log・hook登録とは分ける。

[隣接するVitest](<../src/runtime/runQueue.test.ts>)は、literalの`StoredEvent`・hook入力と公開queue APIだけを使うunit testである。
DB保存・hook登録や照合は検証しない。single-flightは次のscheduler unit testと区別する。

## 実行制御

[RunScheduler](<../src/runtime/runScheduler.ts>)はready済みsessionから初回理由を1回取り込み、
チャット・実績解除・一致hook・期限到達pollのrun requestをPiプロセス所有者へ順番に渡す。他の観測はhookに一致しなければ保存だけを行う。
pause中も入力は保持するがrunを開始しない。pause解除がsettledより先でも、slotを重ねず次回へ進む。
`not_started`は取得済みrun requestを保持し、開始後のsettledは取消済みでも消費する。曖昧な失敗は再送しない。

容量超過は同期的に失敗を固定し、実行bindingを無効化・Piを取消してから`fault`を通知する。
その後のチャットも`-32004`で拒否し、session再接続だけでは回復しない。
hook受付時点でevent logは保存済みなので、容量超過でも`stored` ACKとevent logは維持する。停止後も観測保存を続けられる。
RPCの明示エラーとruntimeの`fault`で失敗を伝える。独立したゲーム内scheduler診断HUDは提供しない。

退出時は古い揮発入力を次のbindingへ移さず、起動途中のcleanupと実子プロセスの終了を待ってから次の所有者を起動する。
起動中の明示`close()`は受付と新規runを直ちに止め、既存の期限付き起動・cleanup完了を待つ。
終了確認に失敗したらcleanup promiseを失敗のまま保ち、leaseを回収したり次を起動したりしない。

[隣接するVitest](<../src/runtime/runScheduler.test.ts>)は、bridgeの公開イベント・受付とPi所有者の境界だけを置き換えるunit testである。
ファイル・SQLite・TCP・子プロセスは使わず、closeの未解決promiseで所有権の引渡し待ちを検証する。
stubの解決順確認が実プロセスの終了検証を代替するとは扱わない。
[clock unit](<../src/runtime/activePlayClock.test.ts>)はactive時間・遅延集約・不正時刻を確認する。
[framing unit test](<../src/pi/piFraming.test.ts>)は、受付済みrun requestのprompt・user echo、frame容量の境界・超過拒否を確認する。
Pi送受信の上限は2 MiB + 256 bytes、run queueの上限は1 MiBとし、超過は明示失敗で停止する。
任意raw文字列、拡張した`maxPendingBytes`、複数message・Tool結果・モデル出力を集約した全イベントの配送保証ではない。
定期timer・CLI / Mod接続は実装済みだが、実Piでのscheduler受入れは未実施。
run要求の理由はPiへ実行を依頼する前にactivity logへ保存する。実績解除は`hisyo.run_requested_advancement`に元の保存イベントIDを記録する。要求記録はprovider実行の証拠ではない。
native-first取消の待機は[通信契約](<protocol.md#native側が先にrunを無効化した場合>)を参照。

## 推論設定

現在は全runで`medium`固定。Pi 1.2.0のcatalog・対応thinking levels・実際のidle stateを毎run前に検査し、未対応なら停止する。
`quick` / `high`切替や即応後の別laneは実装していない。応答時間の保証もない。

## 一次資料

- [Pi RPC仕様](<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md>)
- [Pi RPCコマンド](<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md>)
- [Fabricイベント](<https://docs.fabricmc.net/develop/events/>)

## 関連資料

- [用語と命名](<naming.md>)
- [Tool一覧と呼び出し](<tools.md>)
- [通信プロトコル](<protocol.md>)
