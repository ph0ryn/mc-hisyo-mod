# ポーリングと応答hook

保留キュー、開始・チャット・一致hook・pollのsingle-flight実行制御、active-play計時と通常CLI / Modへの配線は実装済み。
実接続・実Pi受入れは未実施。[実装・検証状況](<development.md>)を参照。

## AIを起動する入口

1. ワールド開始時の最初の判断。
2. プレイヤーからのチャット。
3. 定期ポーリング。
4. LLMが登録したhookの発火。

通常のゲームイベントはCLIへ通知・記録するが、記録するだけではLLMを起動しない。
起動条件は上記4つに限り、LLMが判断と判断の間もゲームを常時監視しているわけではない。
対応するhookを登録しなければ、作業完了や行き詰まりが起きても次の定期pollまたはプレイヤー入力まで反応できない。この起動条件と制約をagentのsystem promptにも明記する。

## 定期ポーリング

AIが主導して目標と行動を決め、プレイヤーに有効な指示がある状態を保つ。開始時や次にやることが不明なときは、質問や新しいイベントを待たず、具体的な行動を伝える。
指示の個数や判断ごとの発言回数は固定せず、必要なら複数の手順をまとめて伝える。指示が有効でプレイヤーが取り組んでいる間は、pollでもhookでも指示を追加・反復せず、その作業を任せる。
例えば「鉄を1スタック集める」と指示済みで収集中なら追加指示は不要。達成・行き詰まり・状況に不適合になった時点で、次の行動を指示するか計画を修正する。
発言は指示に限定しない。作業中でもAIから自然な雑談・出来事への反応・励ましをしてよく、現在の目標に関係のない会話も許す。会話の好みはプレイヤーに合わせる。
質問や意味のある危険には応答し、指示の停止・削減の希望にも従う。会話に関連するアイテムの話題は許すが、HUDの通常値・所持品一覧は実況しない。
必要なhookの登録・更新は発言前に済ませ、その判断での指示や会話が済んだら終了する。状態の再取得や表示ACKを、新しい発言要求として扱わない。

```text
接続中・プレイ中であることを確認
  → CLIの定期タイマーが発火
  → 判断を予約
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

schedulerはreadyのworldごとに時計を作り、attach時点から非pauseの時間だけを計る。退出・切断・worldSession変更では時計と揮発予約を破棄する。
`poll(binding)`は現在のbinding・非pause・未故障・未closeを確認してから時刻をsampleし、期限到達時は既存queueのpoll flagへまとめる。
戻り値`true`は予約の受付・集約であり実行完了ではない。未到達・古いbinding・停止中は`false`、計時や受付の失敗は`fault`で明示して停止する。
プレイヤー入力・hookは同じ次回batchに保持し、pollだけのために別slotや割込みを作らない。
hookを含む判断が`settled`になった時点で、保留pollだけを取り消し、そこから60秒のactive-play計時をやり直す。
無言・pause取消を含むが、`not_started`ではリセットしない。保留のチャット・hookは残し、pause中の時間は引き続き数えない。
時計の既定入力は`performance.now()`で、unitでは`monotonicNow` portへ手動時刻を渡す。
[runtime](<../src/runtime/directorRuntime.ts>)は1,000 msごとにready worldへこの入口を呼び、shutdown時にtimerを最初に止める。

pause・退出・切断は実行中のbindingも直ちに無効化する。CLIはPiへabortを要求し、
`agent_settled`を確認するまでslotを解放しない。停止待ちの間に復帰しても判断を重ねない。

## 応答hook

hookは、指定イベントが起きたときにAIへ判断を依頼する予約である。
Pi自体のライフサイクルイベントとは区別する。

LLMによる登録例。

```json
{
  "event": "block_broken",
  "filter": {"blockId": "minecraft:stone"},
  "instruction": "かまど作成の進捗を確認し、次の行動を判断する"
}
```

`filter`はイベントに含まれるIDなど、監視対象を指定するためのものとする。
CLIはイベントと対象の一致を判定し、所持数や進捗の意味は解釈しない。
LLMは対応イベント一覧を参照し、必要なhookをToolで設定する。

```text
Modがイベントを通知
  → CLIが記録
  → 登録済みhookと照合
  → 一致したhookの指示とイベントを添えて判断を予約
  → PiがコンテキストやToolで状態を確認
  → 発言・hook変更・無言で終了
```

hookはLLMが削除するまで維持する。
登録後にCLIが受け取ったイベントを対象とし、過去の出来事はイベント履歴から確認する。
目標変更時に不要になったhookを削除する判断もLLMに任せる。

## かまど作成の例

| 起動理由 | LLMの動作 |
| --- | --- |
| 開始時 | 石破壊hookを追加し、「かまど用の丸石を8個集めましょう」と指示 |
| 定期ポーリング | 作業中なら指示は維持し、自然な会話も可。指示なし・達成・行き詰まりなら次の行動を示す |
| 石破壊hook | 所持数を確認し、足りなければ追加指示は不要 |
| 石破壊hook | 十分なら石破壊hookを削除し、かまど入手hookを追加して「クラフトしましょう」と指示 |
| かまど入手hook | 次の行動を判断し、必要なhookへ変更 |

この進行を専用の状態機械として実装しない。
石の破壊と丸石の入手のタイミングの違いなども、最新状態と履歴を取得してLLMが判断する。

## Pi実行中の扱い

Piは基本的に1実行ずつ処理する。
CLIが実行待ちを管理し、同じhookの発火はイベントを失わずにまとめて次回へ渡す。
プレイヤーからの入力も保持し、定期判断を重ねて予約しない。
処理待ち入力が容量上限を超えたら、明示エラーで判断処理を停止する。黙示的な破棄や永続inboxへの退避は行わない。

現在は優先度別laneや入力割込みを設けず、同じqueueで順番に処理する。
取消はpause・binding無効化・停止等で行い、入力到着だけで進行中の判断を中断しない。

Piの`steer`は進行中のAPI応答を即座に中断する機能ではなく、次のLLM呼び出し前に入力を渡す仕組みである。
実行の完了確認には`agent_settled`を使う。
`prompt`の受理応答や`agent_end`だけでは、その後の自動処理まで完了したと判断しない。

## 保留キュー

[JudgmentQueue](<../src/runtime/judgmentQueue.ts>)は、一つのworld / player / worldSessionIdに属する起動理由を保持する。
開始・pollはそれぞれ1予約へまとめ、チャットは同文でも受信順に別々に残す。
hookは発火時のID・指示・正確な保存イベントIDを保持し、同じhookの発火をまとめる。
一致イベントの内容と連番欠損情報はbatch内に1コピーだけ保持し、複数hookからIDで参照する。
後でhookを削除しても捕捉済みの指示は変えず、新規hookを過去イベントへ照合し直さない。

- 既定上限は保留batchをJSON化したUTF-8で1 MiB。指示・参照・イベント本文・JSON escapeも数える。
  初期の容量制限であり、最適値を計測したものでも、process全体のRSS上限でもない。
- 一つの観測に複数hookが一致した場合も、全件を収められなければ受付を失敗させる。一部だけを判断へ渡さない。
- 超過後は新しい受付もbatch取得も同じエラーで拒否し、自動回復しない。古い入力を追い出して空きを作らない。
- batch取得後の入力は次の保留batchへ入り、取得済みの内容を書き換えない。
  runtimeも取得済みbatchを1件に制限し、その実行前・実行中の入力を次の保留batchへ分離する。
- 保留は接続session内の揮発状態。crash・退出・明示停止を超えた配送保証や、次のsessionへの再送は行わない。
  永続する履歴・hook登録とは分ける。

[隣接するVitest](<../src/runtime/judgmentQueue.test.ts>)は、literalの`StoredEvent`・hook入力と公開queue APIだけを使うunit testである。
DB保存・hook登録や照合は検証しない。single-flightは次のscheduler unit testと区別する。

## 実行制御

[JudgmentScheduler](<../src/runtime/judgmentScheduler.ts>)はready済みworldから開始理由を1回取り込み、
チャット・一致hook・期限到達pollのbatchをPi session所有者へ順番に渡す。通常観測は保存だけを行う。
pause中も入力は保持するが判断を開始しない。pause解除がsettledより先でも、slotを重ねず次回へ進む。
`not_started`は取得済みbatchを保持し、開始後のsettledは取消済みでも消費する。曖昧な失敗は再送しない。

容量超過は同期的に失敗を固定し、実行bindingを無効化・Piを取消してから`fault`を通知する。
その後のチャットも`-32004`で拒否し、world再接続だけでは回復しない。
hook受付時点でrawイベントは保存済みなので、容量超過でも`stored` ACKと履歴は維持する。停止後も観測保存を続けられる。
RPCの明示エラーとruntimeの`fault`で失敗を伝える。独立したゲーム内scheduler診断HUDは提供しない。

退出時は古い揮発入力を次のbindingへ移さず、起動途中のcleanupと実子プロセスの終了を待ってから次の所有者を起動する。
起動中の明示`close()`は受付と新規実行を直ちに止め、既存の期限付き起動・cleanup完了を待つ。
終了確認に失敗したらcleanup promiseを失敗のまま保ち、leaseを回収したり次を起動したりしない。

[隣接するVitest](<../src/runtime/judgmentScheduler.test.ts>)は、bridgeの公開イベント・受付とPi所有者の境界だけを置き換えるunit testである。
ファイル・SQLite・TCP・子プロセスは使わず、closeの未解決promiseで所有権の引渡し待ちを検証する。
stubの解決順確認が実プロセスの終了検証を代替するとは扱わない。
[clock unit](<../src/runtime/activePlayClock.test.ts>)はactive時間・遅延集約・不正時刻を確認する。
[framing unit test](<../src/pi/piFraming.test.ts>)は、受付済みbatchのprompt・user echo、frame容量の境界・超過拒否を確認する。
Pi送受信の上限は2 MiB + 256 bytes、キューの上限は1 MiBとし、超過は明示失敗で停止する。
任意raw文字列、拡張した`maxPendingBytes`、複数message・Tool結果・モデル出力を集約した全イベントの配送保証ではない。
定期timer・CLI / Mod接続は実装済みだが、実Piでのscheduler受入れは未実施。
判断理由は`judge`前に保存する。要求記録はprovider実行の証拠ではない。
native-first取消の待機は[通信契約](<protocol.md#native側が先にrunを無効化した場合>)を参照。

## 推論設定

現在は全判断で`medium`固定。Pi 1.2.0のcatalog・対応thinking levels・実際のidle stateを毎判断前に検査し、未対応なら停止する。
`quick` / `high`切替や即応後の別laneは実装していない。応答時間の保証もない。

## 一次資料

- [Pi RPC仕様](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi RPCコマンド](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)
- [Fabricイベント](https://docs.fabricmc.net/develop/events/)

## 関連資料

- [Tool一覧と呼び出し](tools.md)
- [通信プロトコル](protocol.md)
