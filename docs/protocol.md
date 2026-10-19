# 通信プロトコル

codec、認証bridge、通常 / bridge-only CLI、Pi拡張、stdio driver、Piプロセス隔離、run / summary scheduler・timer、Mod接続は実装済み。
以下は実装契約であり、実TCP / Pi / provider / ゲームを含む一連の受入実績ではない。

| 接続 | 方式 | 用途 |
| --- | --- | --- |
| CLI ↔ Fabric Mod | ローカルTCP、UTF-8のJSONL、JSON-RPC 2.0 | 観測通知、game state取得、発言表示 |
| CLI ↔ Pi | stdin / stdout、Pi標準RPC | run開始、中断、状態・完了の確認 |
| CLI ↔ Pi拡張 | Modと同じTCPサーバーへの別接続 | Tool要求・結果、コンテキスト取得、独立summary |

Node.jsの`node:net`とJavaの`Socket`で双方向通信を実装できるため、TCPを使用する。
Piの標準RPCと、独自のJSON-RPC 2.0は別のプロトコルであり、形式を混同しない。

## Pi stdio

[driver](<../src/pi/piRpcClient.ts>)はPi 1.2.0の標準RPCだけを扱う。bridgeのJSON-RPC handlerは流用しない。
コマンドは`{id, type, ...}`、応答は`{id, type: "response", command, success, data? / error?}`で、
短い文字列IDとcommandの両方を照合する。`prompt`へ`streamingBehavior`は指定せず、ACKの`disposition: "started"`を要求する。
`handled` / `queued`、失敗応答、不明なID・commandは再利用を禁止する。

送信前から終端を捕捉し、ACK前の`agent_settled`も保持する。
ACKや`agent_end`、abort ACK、EOFはrun完了ではない。
書込後の取消はabortとqueue確認を行い、prompt開始前にabortが空振りした場合はstarted ACK後に再abortする。
slotは本物のsettledと取消RPCが揃うまで保持する。状態が不明なら子プロセスを引退・終了し、完了を捏造しない。

各runの前に`get_available_models`、`get_available_thinking_levels`、`get_state`を検査する。
指定provider / IDが一意で、許可済みかつ設定どおりのphysical APIを持ち、実選択と一致し、mediumでidleな状態を要求する。
これらはTool集合の証明にはならず、認証済みのbundled拡張のreadyが別途必要。
OS Toolや自動探索を無効化する起動policyも、stdioだけでは証明できない。

[Pi専用framing](<../src/pi/piFraming.ts>)の送受信上限はLFを除き**2 MiB + 256 bytes（2,097,408 bytes）**。
run入力messageはraw UTF-8で1 MiBまでとし、serialized run request JSONの再escapeは最大2倍となる。
256-byte予約はmessageから差し引かず、既知のprompt / user echo envelope用に確保する。
[unit test](<../src/pi/piFraming.test.ts>)の条件ではprompt 61 bytes、user start / end 117 / 115 bytes、userだけの`agent_end` 134 bytesである。
run queueとTCP / 共通codecの上限は1 MiB。送信待ち4 MiB、未完了request 64件とし、Piの最大1 frameはLF込みでも4 MiB未満となる。
任意raw制御文字の最大6倍escapeや、拡張した`maxPendingBytes`、全ての集約`agent_end`・Tool結果・モデル出力が収まる保証はしない。
送信frame超過は書込前に拒否し、受信frame超過は引退・停止する。不正UTF-8も拒否する。
既定の期限は要求5秒、run 5分、終了の各段階1秒。version検査も期限付きで強制終了する。
backpressureでも同じframeを再送しない。stderrは末尾16 KiBまでの診断に限り、assistant本文とともにゲーム表示しない。

## 接続手順

1. ユーザーが`node dist/cli.mjs`を[設定と一緒に起動する](<development.md#通常cliとmodの手動起動>)。公開CLI名は`hisyo`。
2. CLIが`127.0.0.1`の空きポートで待ち受ける。
3. 接続先、起動ごとのトークン、プロトコルバージョンを、ユーザー専用の接続情報ファイルへ保存する。
4. Modが接続情報を読み、CLIへ接続する。
5. `bridge.hello`でトークン、役割、プロトコルバージョンを確認する。
6. Modが`game.attach`でworld / player・言語コード`language`・対応イベント・pausedを送り、新しいsession bindingを受け取る。
7. Modがbindingと要求handlerを準備してから`game.ready`を送る。起動途中のpause変更は保持し、attach時点から変わっていれば先に`game.status`で同期する。attach応答前にrunを開始しない。
8. CLIが`--pi`またはPATH上のPiを起動する。接続先とトークンは子プロセスの環境変数でPi拡張へ渡す。
9. Pi拡張も認証し、handlerの準備後に`hisyo.ready`を送る。
10. 両者がreadyかつunpausedなら、CLIのschedulerがrun requestをPiへ渡す。認証更新後、`game.run.bind`と`hisyo.run.bind`のACKを待って推論を始める。この準備中のpauseでbindingを拒否しない。

通常CLIは上記全体を接続する。`--bridge-only`では待受とevent log・activity logの保存だけを行い、Pi・run・summaryのモデル呼出しを起動しない。
Modはローカルsingleplayerのみ対応し、CLIを自動起動しない。
現在は1つのgame sessionを扱う。

Modは接続時のMinecraftの言語設定を`game.attach.language`で一度だけ送る。
言語コードは1〜16文字の英数字・`_`・`-`に限り、省略や不正な値は拒否する。
CLIは受け取った`ja_jp`などのコードをsystem promptへ直接埋め込み、そのsession中は固定する。
`game.state.get`のgame stateには言語を含めず、途中の言語変更には追従しない。再接続時に取得し直す。

`worldId`は保存されたワールドを、`sessionId`は今回のgame attachmentを識別する。
`game.ready`によって準備が完了したsessionだけがrunを開始できる。再接続・再入場時には新しい`sessionId`を割り当てる。
`worldId`と`playerId`が永続化scope、これらと`sessionId`が`SessionBinding`、さらにrunごとの`runId`を加えたものが`RunBinding`となる。
run開始時の識別子をTool要求にも引き継ぎ、CLIとゲームスレッドの両方で現在のsessionと一致することを確認する。
古いrunの要求を、新しく接続したワールド向けに付け替えない。

## Pi拡張のbootstrap

hostは子プロセスの`MC_HISYO_BRIDGE`へ、`protocolVersion: 2`、`host: "127.0.0.1"`、`port`、`token`だけを含むJSONを渡す。
接続情報ファイルの`pid`など、追加キーは渡さない。bootstrap不正や認証失敗は拡張を引退させ、後続promptも拒否する。

[Pi拡張](<../src/pi/piExtension.ts>)はPi APIの`session_start`中にbind handlerを登録してから接続・認証する。
RPC mode、対応physical API、正確な10 Toolを確認してreadyを送る。ready ACKを待つ間にもhostからbindが届き得る。
開始したrunは`agent_settled`だけでslotとbindingを解放する。Pi stdioのprompt ACKや`agent_end`は完了ではない。
peer切断と必須game stateの不正・取得失敗は、同期abort、binding破棄、接続の引退でrunを止める。
同じrunのhost所有取消は後述のtyped取消として扱い、接続を引退させない。

## CLIの接続情報ファイル

保存先は既定で`~/.mc-hisyo/connection.json`。`--data-dir PATH`でディレクトリを変更する。
JSONのfieldは`protocolVersion: 2`、`host: "127.0.0.1"`、`port`、`token`、`pid`。
portは起動時にOSが割り当て、tokenは32 bytesの乱数をbase64url化した43文字で、起動ごとに変える。
PIDは診断用で、stale判定や自動回収の根拠にしない。tokenはログへ出さない。

[ディレクトリ検査](<../src/runtime/privateDataDirectory.ts>)でPOSIX所有者とmode `0700`を確認する。
[publisher](<../src/runtime/connectionFile.ts>)は同じディレクトリのUUID付きtempを`0600`で排他作成し、write・fsync後にhard linkで公開する。
既存の接続情報はfile / symlink / directoryのいずれでも拒否し、上書きしない。hard link未対応のfilesystemでも黙示的な代替方式は使わない。
公開後にtempの名前を外すが、fdは終了時まで保持する。
[POSIXが許す削除後のinode再利用](<https://pubs.opengroup.org/onlinepubs/9799919799/functions/unlink.html>)で、別fileを自分のものと誤認しないためである。

終了時は接続とSQLiteを閉じてから、自分が公開した接続情報を削除する。
削除前にcanonical directoryとdevice / inode / UIDを確認し、差し替わっていれば残してエラー終了する。
自分のtemp以外を走査・削除しない。crash / SIGKILL後の自動回収は行わない。
stateの既存権限を変更せず、信頼できる親ディレクトリと同じUIDの非敵対的な利用を前提とする。
拡張ACLやWindows ACL、同じUIDによる敵対的なpath差替えへの防御は保証しない。
SQLiteの検査はopen前のmetadata検査であり、稼働中にSQLiteのfileや親を外部から差し替える運用には対応しない。

## メッセージ形式

- 1行につき1つのJSONオブジェクトを送り、LFで区切る。
- `id`付きの要求には、同じ`id`で結果またはエラーを返す。
- 観測以外の状態通知など、応答が不要な通知には`id`を付けない。
- TCPの受信単位とJSONの境界は一致しないため、LFまでバイト列を蓄積して解析する。
- Piのstdoutは標準RPC専用とし、診断ログはstderrへ分ける。
- 送受信のバックプレッシャーを扱う。フレームサイズと要求時間の開発用上限は次節を参照。実ゲーム計測で見直す。

CLIからModへの要求例。

```json
{"jsonrpc":"2.0","id":"game-19","method":"game.state.get","params":{"worldId":"world-1","playerId":"player-1","sessionId":"s1","runId":"run-1","query":{}}}
```

応答の`result`は、要求と同じ4つのbinding fieldと`state`を持つ。
`state`全体は[共有fixture](<../src/protocol/fixtures/gameState.json>)、必須fieldと範囲は[game stateの契約](<gameState.md>)を参照。
一部のfieldだけを返す応答は受け付けない。

Modは観測イベントを1秒間隔で`game.events`の1 requestへまとめ、保存件数のACKを待つ。送信例。

```json
{"jsonrpc":"2.0","id":"42","method":"game.events","params":{"events":[{"worldId":"world-1","playerId":"player-1","sessionId":"s1","seq":85,"tick":12042,"observedAt":1792130000000,"event":"block_broken","dimension":"minecraft:overworld","position":[10.5,64,20.5],"data":{"blockId":"minecraft:stone","position":[10,64,20]}}]}}
{"jsonrpc":"2.0","id":"42","result":{"stored":1}}
```

`seq`は収集時に`sessionId`内で1から増加させ、元の順序・tick・`observedAt`を保持する。
空のbatchは送らず、最大1024件かつ1 MiBのframeに収まる範囲で分割する。ACK待ちは1 requestだけで、残りは次の送信時刻まで待つ。
全件のscope・capabilityを確認し、まずevent log DBで観測batchを確定する。次にlive hook照合・一致記録をactivity log DBで確定してから、順に通知し`{stored: 件数}`を返す。
照合・activity保存が失敗するとevent logは既に保存済みでも通知・ACKせずfaultにする。2つのDBを跨ぐatomicityは保証しない。
観測queueは4 MiBまで。単一イベントのframe超過、queue超過、エラー・timeout・件数不一致のACKは切断とし、黙って捨てて継続しない。
退出・切断で未送信queueは破棄するため、通常でも末尾約1秒分は未配送になり得る。ACK待ち・backlog・tick遅延があれば未確定範囲はさらに広がる。再送・永続queueはない。
チャット・pause通知は即送信するため、event logとactivity logの保存順を観測の発生時刻順とみなさない。
観測の受信口は`game.events`だけとする。
共通schemaとイベント定義は[gameEvent.ts](<../src/protocol/gameEvent.ts>)、
共有fixtureは[blockBroken.json](<../src/protocol/fixtures/blockBroken.json>)と
[gameEvents.json](<../src/protocol/fixtures/gameEvents.json>)を参照。
Modは収集できるイベントの部分集合だけを通知し、CLIのschema一覧を収集実績と混同しない。

## 実装済みの通信codec

[JSON-RPC schema](<../src/protocol/jsonRpc.ts>)、[JSONL framing](<../src/transport/jsonLines.ts>)、
[RpcPeer](<../src/transport/rpcPeer.ts>)が実装済み。
認証bridgeでもこのpeerを使う。以下は実装契約であり、unit testによる実TCPの通信検証実績ではない。

- JSON-RPCの単一オブジェクトのみ。JSON-RPC batch配列は未対応。`game.events`のparams内イベント配列とは別。schema外のenvelopeキーは拒否する。
- UTF-8のバイト列でLFまで蓄積し、分割された多バイト文字を途中でdecodeしない。
- フレーム上限はLFを除き**1 MiB**。上限超過、不正UTF-8、途中のままEOFになったframeは接続を閉じる。
- 送信待ちバイト列は**4 MiB**、未完了requestは送受信各**64件**、非同期notification処理も64件まで。
  送信待ちの上限超過は接続を閉じ、request数の超過は明示的なエラーにする。
- handlerの同期部分は受信順に呼ぶ。非同期の完了順は保証せず、応答はIDで対応付ける。
- requestの既定timeoutは**5秒**。独立した`hisyo.summary.create`だけは呼出単位で**5分**にする。
  timeoutや切断でpeerを閉じ、そのpeerの全pending requestを失敗させる。
  遅れて完了したhandlerの応答は送らず、要求を再送しない。
- JSON parse失敗は`-32700`、不正なrequestやbatchは`-32600`、不明なmethodは`-32601`。
  不明・不正なnotification、handler失敗のnotification、重複した未完了request ID、
  不明なresponse ID、不正なresponseは接続を閉じる。
- request handlerの例外、結果未返却、結果frameの上限超過は`-32603`で失敗する。
  業務上の明示エラーは`RpcError`のcode / message / dataを返す。

上限値は開発用の仮値であり、実ゲームでのイベント量測定は未実施。
切断で既に実行された副作用を取り消せるわけではない。
認証・役割・session / run bindingは次のbridgeが担う。Modはゲームスレッドの実行直前・結果返却前にも再検証する。

## 実装済みの認証・binding bridge

[BridgeServer](<../src/bridge/bridgeServer.ts>)と[要求schema](<../src/protocol/bridge.ts>)は通常 / bridge-only CLIへ組込済み。
unit testは認証・binding契約の実接続検証を行わない。
[Piプロセス所有者](<../src/runtime/piProcess.ts>)がrun無効化通知をstdioのabortへ渡す。CLI run schedulerとModも接続済み。
Pi拡張自身の必須game state取得失敗・切断時のabortとは区別する。

- loopbackの`127.0.0.1`のみ。全接続4本まで、認証期限は既定5秒。game / agentは各1接続。
- helloは`protocolVersion: 2`、`role: "game" | "agent"`、43文字のbase64url tokenを厳密に検証し、別versionは拒否する。
  起動ごとの256-bit tokenを呼出側が用意し、bridgeは定時間比較する。
  tokenを知る信頼済みプロセス間の境界であり、token所持者同士の役割偽装を防ぐものではない。
- attachで新しいsession bindingを発行する。`game.ready`まではruntimeへattach完了を通知せず、runを開始しない。
  同じbindingの`game.status`はready前も受け付け、状態の更新・記録だけを行う。runtimeへのstatus通知やreadyの付与はしない。
  起動中のpause変更で切断せず、ready通知には最新の報告状態を使う。
  後から接続するruntimeは`readySession`を参照する。`currentSession`はready前のattach済み状態も含む。
  agentも`hisyo.ready`が必要。両者のbind ACK後、現在のbindingを再確認してからrun開始を返す。
- チャットはrequestで送り、受付結果を確認する。`handlePlayerMessages`で排他的な同期受付を登録し、
  入力を保持して正常終了した場合だけ`accepted: true`を返す。runの開始・完了を意味しない。
  gameが未ready、受付未登録・解除後・bridge終了中は`-32003`で拒否する。bridge-onlyでも成功扱いにして捨てない。
  pause中の受付は可能だが、run実行の可否はruntimeが制御する。拒否されたnotificationは接続を閉じる。
- pauseの実行制限はschedulerだけで行い、次のrun requestの送出と定期実行までの計時を止める。
  bridge・Modはpauseをbinding拒否や切断の理由にしない。送出済みrunの認証更新・binding準備・Tool・完了は継続し、ゲーム内時刻も取得できる。
  summaryはpause中も経過時間を数え、新規開始・完了・保存する。
  各summary前のOAuth更新は信頼済みPi所有者が行い、隔離子にはaccess tokenだけを渡す。
  detach・切断・明示取消でrunを即時無効化し、Modへ`game.run.clear`を通知する。
  clearは**同じbindingだけ**を消す冪等処理とし、遅いclearが新runを消してはいけない。
- runはsingle-flight。無効化してもslotを保持し、呼出側が`agent_settled`を確認して`finishRun`するまで次を開始しない。
- Tool要求にはworld / player / session / runの完全一致が必要。Modからの応答もawait後にbindingを再確認する。
  ゲームスレッドへ渡した処理の直前にも、Modが同じ検証を行う。
- 観測のscopeとsessionを検証し、event log保存の後でhook照合・activity保存を行って通知する。偽のscopeは保存せず接続を閉じる。
  Modイベントの一覧・hook追加は、接続Modが広告したcapabilityに制限する。CLI事実は検索専用でhook対象にしない。
- 転送結果はbinding付きの厳密なenvelope。表示成功は`displayed: true`。
  状態は[version 2のgame state](<gameState.md>)を検証し、不完全な`state`を拒否する。queryは`{}`のみ。
- 起動途中の`close()`もlistenerの解放まで待つ。閉じたbridgeは再起動せず、新しいinstanceを使う。

## 主な通信メソッド

| メソッド | 要求・通知の方向 | 処理 |
| --- | --- | --- |
| `bridge.hello` | Mod / Pi拡張 → CLI | 接続の初期確認 |
| `game.attach` / `game.ready` | Mod → CLI | session bindingの発行と準備完了 |
| `hisyo.ready` | Pi拡張 → CLI | 拡張の準備完了 |
| `game.run.bind` / `hisyo.run.bind` | CLI → Mod / Pi拡張 | run bindingを準備しACKを返す |
| `game.run.clear` | CLI → Mod | 一致するrun bindingの無効化通知 |
| `game.status` | Mod → CLI | プレイ中・ポーズ中などの状態通知 |
| `game.detach` | Mod → CLI | session終了通知 |
| `game.events` | Mod → CLI | 観測の一括保存・通知。ACKは保存件数 |
| `game.player_message` | Mod → CLI | プレイヤーからhisyoへのチャット入力 |
| `game.state.get` | Pi拡張 → CLI → Mod | game stateの取得 |
| `game.message.send` | Pi拡張 → CLI → Mod | hisyoの発言表示 |
| `game.files.list` / `game.files.read` / `game.files.search` | Pi拡張 → CLI → Mod | boundedなreference取得 |
| `hisyo.run.invalidate` | CLI → Pi拡張 | 同じrunの所有取消を結果より先に通知 |
| `hisyo.hooks.add` / `hisyo.hooks.remove` / `hisyo.hooks.list` | Pi拡張 → CLI | hookの管理とページング |
| `hisyo.events.search` | Pi拡張 → CLI | event logまたは明示したactivity logと既知の欠損の検索 |
| `hisyo.events.list` | Pi拡張 → CLI | 対応イベント、schema、照合可能フィールドの一覧 |
| `hisyo.summary.create` | CLI → Pi拡張 | world / player / sessionとrequest IDに束縛した独立summary。Toolなし |
| `hisyo.summary.cancel` | CLI → Pi拡張 | 一致するsummary requestだけを取消す通知。実完了までslotを保持 |
| `hisyo.summary.get` | Pi拡張 → CLI | 認証済みの現在runに束縛した保存済みsummaryの背景情報 |
| `hisyo.usage.record` | Pi拡張 → CLI | 保持中のrun / summary要求に束縛したトークン使用量の保存。ACKは`{recorded: true}` |

表のhandler・送信処理は接続済み。最新状態は`game.state.get`、runの理由はrun requestで渡す。
summaryはrun bindingやTool権限を持たず、event logだけから作成する。pause中の処理と退出・終了時の取消は[summaryの契約](<context.md#summary>)を参照。

## native側が先にrunを無効化した場合

[host](<../src/bridge/bridgeServer.ts>)は**現在のgame owner・同じrun**からのbare `-32001`（`data`なし）だけをnative-first取消として認識する。
不確定状態の待機promiseを最初に設置してから、run無効化 → 拡張への`hisyo.run.invalidate` → game clear / 所有者のabort →
厳密な無効化前の`RunBinding`を付けた`-32005`の順で処理する。任意の`-32001`や外国bindingを通常取消へ変換しない。
[拡張](<../src/pi/piExtension.ts>)は通知済みの同じrunと一致するtyped replyだけを取消扱いにし、active runを同期abortするが引退しない。
不正・異なるbinding・通知と一致しないエラーはfatal。例外を投げるだけで次provider要求を止めたことにしない。

次の`beginRun`はnative bindを送る**前**にこの不確定状態を待つ。
実際のunpausedな`game.status`で解除し、pauseやstatusの事実を捏造しない。待機の取消はそのwaiterだけを起こし、共有状態を勝手に解除しない。
`readySession`、チャット / hook受付、active-play時計はこの待機だけを理由に変更しない。
退出・close・明示取消のfenceもabort / cleanupより先で、slotは実settledまたは子の終了確認まで保持する。

有効な`displayed: true`の同じcaptured binding ACKは、後着でstaleになっていてもactivity logへ保存してからstaleを返す。
曖昧な表示・game state取得は再送せず、不正なACKを成功記録しない。

## 切断・失敗時の扱い

- Mod切断時は、実行待ちのゲーム要求を失敗させ、pollとhookによる新しいrunを止める。
- 実行中のrunも停止させ、古いsession向けのTool処理を受け付けない。
- Toolのタイムアウト、データ取得失敗、未対応の要求はエラーとしてPiへ返す。空データで成功扱いにしない。
- 必須コンテキストを取得できない場合、そのrunを止める。
- 発言表示など、処理済みか不明な要求を自動再送しない。
- 再接続時は最新game stateを取得し、event logの既知の欠損を明示する。過去のhook一致をまとめて再実行しない。
- 同じworld / playerではconversation、event log、activity log、summary、hookを参照できるようにし、再開時にhisyoが状況を確認する。
- 既知の連番欠損がない場合でも、切断中やsession前後の観測を保証しない。
- PATH上のPiを起動できない場合は、起動エラーとして表示する。

## 一次資料

- [JSON-RPC 2.0仕様](<https://www.jsonrpc.org/specification>)
- [Node.js TCP API](<https://nodejs.org/api/net.html>)
- [Java Socket API](<https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/Socket.html>)
- [Pi RPC仕様](<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md>)
- [Fabricのクライアント・サーバー構成](<https://docs.fabricmc.net/develop/networking>)

## 関連資料

- [用語と命名](<naming.md>)
- [構成と責務](<architecture.md>)
- [Tool一覧と呼び出し](<tools.md>)
- [runの予約とhook](<scheduling.md>)
