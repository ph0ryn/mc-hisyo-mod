# 通信プロトコル

ネットワーク境界はCLIとFabric Modの認証付きloopback TCPだけである。
Durable SDK、Tool、summary生成、usage記録はCLIと同じプロセスの型付きAPIで接続する。
[実装と検証の区別](<development.md>)を参照。実TCPのfake game境界テストはあるが、実ゲーム・有料providerの一連の受入れは未実施。

| 境界 | 方式 | 用途 |
| --- | --- | --- |
| CLI ↔ Fabric Mod | TCP / UTF-8 JSONL / JSON-RPC 2.0 | 接続・状態、観測と入力、game state、表示、reference |
| DurableAgent ↔ BridgeServer | in-processのtrusted host API | run binding、10 Tool、summary context、usage |
| Models ↔ provider | Pi AI SDKのnative provider | main / summaryのモデル要求とSDK認証 |

Modとの[protocol version](<../src/protocol/bridge.ts>)は`2`。TCPで受け付けるroleは`"game"`だけで、agent roleは拒否する。

## 接続手順

1. ユーザーが[通常CLI](<development.md#通常cliとmodの手動起動>)を起動する。公開名は`hisyo`。
2. CLIが`127.0.0.1`の空きportで待ち受け、起動ごとのtokenと接続先をprivateな接続情報fileへ公開する。
3. Modがfileを読み、`bridge.hello`でtoken、`role: "game"`、protocol versionを提示する。
4. `game.attach`でworld / player、言語コード`language`、対応イベント、pausedを送り、新しいsession bindingを得る。
5. Modがbindingと要求handlerを準備し、`game.ready`を送る。
   attach後にpause状態が変わっていれば、readyより前に`game.status`で同期する。
6. 通常CLIはready済みsessionのscopeでDurableを開く。schedulerが非pause時に保留runをdispatchする。
7. hostの`beginRun()`がnativeの`game.run.bind`の正確なACKを待つ。その後でDurableへ入力をsubmitし、モデル処理を許可する。

attach応答だけではrunを開始しない。現在はgame接続とsessionを各一つ扱う。
`--bridge-only`はモデル・run・summary生成を持たず、チャット受付を成功扱いにしない。
Modはsingleplayerだけを対象にし、自動再接続・再送・CLI自動起動は行わない。

### 言語とbinding

`game.attach.language`は1〜16文字の英数字・`_`・`-`に限り、必須である。
`ja_jp`などの値を専用system promptへ渡し、session中は固定する。
game stateに言語fieldはなく、変更時は再接続する。

- `worldId` / `playerId`は永続保存scope。
- `SessionBinding`はこれらと`sessionId`。再attachで新しいIDになる。
- `RunBinding`はさらにrunごとの`runId`を持つ。

Toolのbindingはモデル引数から受け取らず、trusted hostが現在runの値を付ける。
CLIは転送前・await後、Modはゲームスレッドの実行直前・結果返却前にも検証する。
別world / playerや古いsessionの権限を新しい接続へ付け替えない。
同じworld / playerの受付済み入力を再開する場合も、実行には新しいnative bindingが必要である。

## CLIの接続情報ファイル

既定は`~/.mc-hisyo/connection.json`。`--data-dir PATH`で変更する。
JSONは`protocolVersion: 2`、`host: "127.0.0.1"`、`port`、`token`、`pid`だけを持つ。
portはOS割当、tokenは32 bytesの乱数をbase64url化した43文字で、起動ごとに変える。tokenをログへ出さない。
PIDは診断用で、接続情報の自動回収に使わない。

[PrivateDataDirectory](<../src/runtime/privateDataDirectory.ts>)はPOSIXの所有者とmode `0700`を検査する。
[ConnectionFile](<../src/runtime/connectionFile.ts>)は同じdirectoryにtempを`0600`で排他作成し、write・fsync後にhard linkで公開する。
既存のfile / symlink / directoryは上書きしない。hard link非対応でも別方式へfallbackしない。
公開後はtemp名を外し、fdを終了まで保持して、削除後のinode再利用による誤認を避ける。

終了時は接続とSQLiteを閉じてから自分の接続情報を削除する。
canonical directory、device / inode / UIDが変わっていれば残してエラーにし、他のfileを走査・削除しない。
crash / SIGKILL後は所有プロセスの停止を確認して手動で回復する。
これは[Durable owner lock](<architecture.md#durabilityが保証する範囲>)のvalidated dead PID回収とは別のpolicyである。

信頼できる親directoryと同じUIDの非敵対的な利用を前提にする。
既存権限を自動変更せず、拡張ACL・Windows ACL・同UIDによる敵対的path差替えへの防御は保証しない。
SQLiteの検査はmetadata検査で、稼働中にDBや親を外部から差し替える運用には対応しない。

## メッセージ形式

- LF区切りで、1行につき一つのJSON-RPC 2.0オブジェクトを送る。
- `id`付きrequestには同じIDでresult / errorを返す。通知にはIDを付けない。
- TCP受信単位とJSON境界は一致しないため、UTF-8 bytesをLFまで蓄積する。
- JSON-RPC batch配列は未対応。`game.events`のparams内イベント配列とは別である。
- schema外のenvelopeキー、不正UTF-8、未完のframeでEOFになる接続を拒否する。

CLIからModへの要求例。

```json
{"jsonrpc":"2.0","id":"19","method":"game.state.get","params":{"worldId":"world-1","playerId":"player-1","sessionId":"s1","runId":"run-1","query":{}}}
```

resultは同じ4つのbinding fieldと、完全な`state`を持つ。
[共有fixture](<../src/protocol/fixtures/gameState.json>)と[game state契約](<gameState.md>)を参照。
空の状態・欠損field・未知queryで成功扱いにしない。

### 観測batchとACK

Modは約1秒間隔で`game.events`を送り、保存件数のACKを待つ。

```json
{"jsonrpc":"2.0","id":"42","method":"game.events","params":{"events":[{"worldId":"world-1","playerId":"player-1","sessionId":"s1","seq":85,"tick":12042,"observedAt":1792130000000,"event":"block_broken","dimension":"minecraft:overworld","position":[10.5,64,20.5],"data":{"blockId":"minecraft:stone","position":[10,64,20]}}]}}
{"jsonrpc":"2.0","id":"42","result":{"stored":1}}
```

`seq`は収集時にsession内で1から増加し、元の順序・tick・`observedAt`を保持する。
空batchは送らず、最大1024件かつ1 MiB frame内へ分割する。ACK待ちは一つだけで、残りは次の送信時刻を待つ。
観測queue上限は4 MiB。単一frame超過、queue超過、エラー・timeout・件数不一致ACKでは切断する。
退出・切断で未送信queueは失われ、通常でも末尾約1秒、backlog等ではさらに広い範囲が未配送になり得る。
Mod側に永続queueや再送はない。

hostは全件のscope・capabilityを検証し、event DBのbatchを確定してからactivity DBでlive hook照合・監査を確定する。
次に非同期のrun admissionを待ち、通知・`stored` ACKへ進む。domain DBとDurable inboxを跨ぐatomicityはない。
hook監査失敗なら観測が保存済みでもACKせずfaultにする。
一方、schedulerの容量超過は保存済み観測を取り消さず、run処理をfaultにして`stored` ACKを維持する。
チャット・pauseは即送信なので、観測とCLI事実の保存順を発生時刻順とみなさない。

### codecの上限と失敗

[JSON-RPC schema](<../src/protocol/jsonRpc.ts>)、[JSONL framing](<../src/transport/jsonLines.ts>)、[RpcPeer](<../src/transport/rpcPeer.ts>)が共通実装。

- frameはLFを除き1 MiB。送信待ちは4 MiB、未完了requestは送受信各64件、非同期notificationも64件まで。
- handlerの同期部分は受信順に呼ぶ。非同期の完了順は保証せず、応答をIDで照合する。
- request既定timeoutは5秒。timeout / 切断ではpeerと全pending要求を失敗させ、遅い応答や再送を行わない。
  モデル要求の5分期限はSDK ownerの別境界で、game RPC timeoutではない。
- parse失敗は`-32700`、不正requestは`-32600`、未知methodは`-32601`、handler / result異常は`-32603`。
- 不正notification、重複pending ID、不明response ID、不正responseは接続を閉じる。
- `RpcError`で明示した業務エラーだけcode / message / dataを公開する。

これらは初期予算で、実ゲームの性能・イベント量に基づく最適値ではない。
切断や取消で、すでに実行された副作用を巻き戻せない。

## 認証とtrusted host API

[BridgeServer](<../src/bridge/bridgeServer.ts>)は`127.0.0.1`のみ、全接続4本まで、hello期限は既定5秒。
version、game role、43文字tokenを厳密に検証し、tokenを定時間比較する。gameの重複接続を拒否する。
tokenを知る信頼済みprocess間の境界であり、同じUIDやtoken所持者の敵対的行為をsandboxするものではない。

`game.ready`まではattach完了をruntimeへ通知しない。
ready前の同一bindingのstatusは事実の更新だけで、readyを付与しない。ready通知には最新pause状態を使う。
`currentSession`は準備中も含むが、`readySession`は実行可能な接続だけを示す。

| in-process API | 責務 |
| --- | --- |
| `beginRun()` / `finishRun(binding)` | native bind ACK、単一slotの取得とsettlement後の解放 |
| `invalidateRun(reason)` | 現runを同期fenceし、nativeへ同一bindingのclearを送る |
| `executeTool(binding, name, args, signal?)` | 正確な10 Toolと引数schemaを検証し、domain処理かnative転送を行う |
| `getGameState(binding, signal?)` | 必須game stateの取得と検証 |
| `summaryContext(binding)` | 現在runのscopeにある保存済みsummaryを取得 |
| `beginModelRequest` / `recordUsage` / `finishModelRequest` | 元session・source・request IDのusage所有権を保持し、取消後の使用量も記録 |
| `handlePlayerMessages` / `handleObservations` | schedulerの排他的な非同期受付を登録 |

チャットはinboxへのcommitが完了して初めて`accepted: true`になる。run開始・完了のACKではない。
未ready・受付未登録・終了中は`-32003`、scheduler fault後は`-32004`。失敗を成功扱いで捨てない。

pause制限はschedulerが担う。送出済みrunの準備・Tool・完了をbridgeやModがpauseだけで拒否しない。
summaryはmain runのslot・Tool権限を取得せず、pause中も独立して動く。
run無効化後も、SDK処理がsettleするまでslotを重ねない。`game.run.clear`は**同じbindingだけ**を消す冪等処理とする。

## 主なgame wireメソッド

| メソッド | 方向 | 処理 |
| --- | --- | --- |
| `bridge.hello` | Mod → CLI | 認証とprotocol確認 |
| `game.attach` / `game.ready` | Mod → CLI | session発行と準備完了 |
| `game.status` / `game.detach` | Mod → CLI | pause状態・session終了 |
| `game.events` | Mod → CLI | 観測batchと保存件数ACK |
| `game.player_message` | Mod → CLI | チャットの永続受付 |
| `game.run.bind` / `game.run.clear` | CLI → Mod | run権限の設定と無効化 |
| `game.state.get` | CLI → Mod | 完全なgame stateの取得 |
| `game.message.send` | CLI → Mod | literalなHUD表示、成功は`displayed: true` |
| `game.files.list` / `game.files.read` / `game.files.search` | CLI → Mod | boundedな静的reference取得 |

hook、ログ検索、summary生成、usage記録はgame socketから呼べる公開APIではない。
Toolの意味は[Tool一覧](<tools.md>)、保存と再開は[run scheduling](<scheduling.md>)を参照。

## native側が先にrunを無効化した場合

hostは**現在のgame owner・同じrun capture**からのbare `-32001`（`data`なし）だけをnative-first取消として認識する。
availability待機を先に設置し、runを無効化、同一bindingをclear、同期の`runInvalidated`でSDK ownerを止める。
その後、厳密な無効化前の`RunBinding`を持つ`-32005`を返す。任意の`-32001`や外国bindingを通常取消へ変換しない。

次の`beginRun()`はnative bindを送る前にこの不確定状態を待つ。
実際の非pauseな`game.status`で解除し、pauseやstatusの事実を捏造しない。
待機取消はそのrunだけを起こし、共有availabilityを勝手に解除しない。
チャット受付、ready、active-play時計を、この待機だけを理由に変更しない。

同じcaptured bindingの正確な`displayed: true` ACKは、後着でstaleでも表示事実を保存してからstaleを返す。
不正ACKを成功記録せず、表示済みか不明な要求を再送しない。

## 切断と復旧

Mod切断は古いsessionのTool権限を直ちに無効にし、明示取消とinbox clearへ進む。
必須contextの不正・取得失敗ではprovider dispatchを拒否する。空データへの置換はない。
明示detachと違い、host close / crashではDurable内の保留を残す。
同じworld / playerで再openしても、現在のnative bindingを得るまでモデル・Toolを再開しない。
過去のevent logからhookを再照合せず、同scopeの保存記憶と新しいgame stateを使う。
[durabilityと副作用の限界](<architecture.md#durabilityが保証する範囲>)は別途確認する。

## 一次資料

- [JSON-RPC 2.0](<https://www.jsonrpc.org/specification>)
- [Node.js TCP API](<https://nodejs.org/api/net.html>)
- [Java Socket API](<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/Socket.html>)
- [Pi Durable 1.3.0](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md>)

## 関連資料

- [用語と命名](<naming.md>)
- [構成と責務](<architecture.md>)
- [Tool一覧](<tools.md>)
- [runの予約とhook](<scheduling.md>)
