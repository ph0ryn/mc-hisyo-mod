# ポーリングと応答hook

保留キューと開始・チャット・一致hookのsingle-flight実行制御はcheckpoint実装済み。
Piの通信容量との整合は未解決で、タイマー・CLI / Modへの配線も未完了。[実装状況](<development.md>)を参照。

## AIを起動する入口

1. ワールド開始時の最初の判断。
2. プレイヤーからのチャット。
3. 定期ポーリング。
4. LLMが登録したhookの発火。

通常のゲームイベントはCLIへ通知・記録するが、記録するだけではLLMを起動しない。
ポーリングや登録済みhookなど、起動理由がある場合に判断を依頼する。

## 定期ポーリング

```text
接続中・プレイ中であることを確認
  → CLIの定期タイマーが発火
  → 判断を予約
  → Piが空いたらmedium以上で実行
  → 必要ならToolで確認
  → 発言・hook変更・無言で終了
```

初期検証ではプレイ中60秒程度を仮置きする。計測済みの最適値ではない。
CLIがプレイ中の経過時間を管理し、ポーズ中・切断中は新しい定期判断を止める。
定期判断の予約は1件にまとめ、復帰後に過去の回数分を実行しない。
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
| 開始時 | 「かまどを作りましょう」と発言し、石破壊hookを追加 |
| 定期ポーリング | 木を切り続けていれば「先に丸石を集めてください」と発言 |
| 石破壊hook | 所持数を確認し、足りなければ無言で終了 |
| 石破壊hook | 十分なら「クラフトしましょう」と発言。石破壊hookを削除し、かまど入手hookを追加 |
| かまど入手hook | 次の行動を判断し、必要なhookへ変更 |

この進行を専用の状態機械として実装しない。
石の破壊と丸石の入手のタイミングの違いなども、最新状態と履歴を取得してLLMが判断する。

## Pi実行中の扱い

Piは基本的に1実行ずつ処理する。
CLIが実行待ちを管理し、同じhookの発火はイベントを失わずにまとめて次回へ渡す。
プレイヤーからの入力も保持し、定期判断を重ねて予約しない。
処理待ち入力が容量上限を超えたら、明示エラーで判断処理を停止する。黙示的な破棄や永続inboxへの退避は行わない。

即応を優先して割り込む場合は、現在の処理を中断し、停止を確認してから次を開始する。
即応と通常処理の具体的な優先順位は、初期検証で確定する。

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

[隣接するVitest](<../src/runtime/judgmentQueue.test.ts>)は、実SQLiteのhook照合・履歴と公開queue APIで確認する。
queue単体の検証であり、single-flightは次のscheduler unit test、Pi取消は所有者の境界検証で区別する。

## 実行制御checkpoint

[JudgmentScheduler](<../src/runtime/judgmentScheduler.ts>)はready済みworldから開始理由を1回取り込み、
チャットと一致hookのbatchをPi session所有者へ順番に渡す。通常観測は保存だけを行う。
pause中も入力は保持するが判断を開始しない。pause解除がsettledより先でも、slotを重ねず次回へ進む。
`not_started`は取得済みbatchを保持し、開始後のsettledは取消済みでも消費する。曖昧な失敗は再送しない。

容量超過は同期的に失敗を固定し、実行bindingを無効化・Piを取消してから`fault`を通知する。
その後のチャットも`-32004`で拒否し、world再接続だけでは回復しない。
hook受付時点でrawイベントは保存済みなので、容量超過でも`stored` ACKと履歴は維持する。停止後も観測保存を続けられる。
ゲームへのエラー表示は未配線で、RPCの明示エラーとruntimeの`fault`を提供する段階である。

退出時は古い揮発入力を次のbindingへ移さず、起動途中のcleanupと実子プロセスの終了を待ってから次の所有者を起動する。
起動中の明示`close()`は受付と新規実行を直ちに止め、既存の期限付き起動・cleanup完了を待つ。
終了確認に失敗したらcleanup promiseを失敗のまま保ち、leaseを回収したり次を起動したりしない。

[隣接するVitest](<../src/runtime/judgmentScheduler.test.ts>)は、bridgeの公開イベント・受付とPi所有者の境界だけを置き換えるunit testである。
ファイル・SQLite・TCP・子プロセスは使わず、closeの未解決promiseで所有権の引渡し待ちを検証する。
実際の取消・子プロセス終了は[所有者の既存境界検証](<../src/runtime/piSession.test.ts>)へ分離する。
26ケース中25ケースが成功したが、quoteを多く含む受付済みbatchの通信容量を確認する1ケースは**RED**である。
同じunit test内で、保留JSON約544 KBがPiのprompt envelopeで再escapeされると1 MiBを超えることを再現する。
実Piは入力を受信イベントにも含めて返すため、送信側だけの拡張では解決しない。
通信上限の方針確認と回帰修正まで、このcheckpointは利用可能なschedulerの完成ではない。
active-play timer、CLI / Mod接続、実Piでのscheduler受入は未実装・未実施である。

## 推論設定

| 用途 | 初期案 |
| --- | --- |
| 定期的な進行判断 | `medium`以上 |
| 短い即応判断 | `quick`というアプリ側の呼び名で、利用可能な低推論設定へ対応付ける |
| 詳しい再検討 | 必要に応じて`high`で続ける |

Piの推論設定に`instant`はない。
`quick`の具体的な設定は選択モデルの対応状況を確認し、未対応の設定へ黙ってフォールバックしない。
モデル・推論設定の変更は実行停止後に行う。
即応後の詳しい判断は毎回必須にせず、必要な場合に予約する。
低推論設定でも応答時間は保証されない。

## 一次資料

- [Pi RPC仕様](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Pi RPCコマンド](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md)
- [Fabricイベント](https://docs.fabricmc.net/develop/events/)

## 関連資料

- [Tool一覧と呼び出し](tools.md)
- [通信プロトコル](protocol.md)
- [検証状況と未確定事項](validation.md)
