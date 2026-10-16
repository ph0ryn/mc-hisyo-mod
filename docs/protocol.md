# 通信プロトコル

| 接続 | 方式 | 用途 |
| --- | --- | --- |
| CLI ↔ Fabric Mod | ローカルTCP、UTF-8のJSONL、JSON-RPC 2.0 | イベント通知、状態取得、発言表示 |
| CLI ↔ Pi | stdin / stdout、Pi標準RPC | 判断開始、中断、状態・完了の確認 |
| CLI ↔ Pi拡張 | Modと同じTCPサーバーへの別接続 | Tool要求・結果、コンテキスト取得 |

Node.jsの`node:net`とJavaの`Socket`で双方向通信を実装できるため、初期案はTCPとする。
Piの標準RPCと、独自のJSON-RPC 2.0は別のプロトコルであり、形式を混同しない。

## 接続手順

1. ユーザーが`ai-director`を起動する。
2. CLIが`127.0.0.1`の空きポートで待ち受ける。
3. 接続先、起動ごとのトークン、プロトコルバージョンを、ユーザー専用の接続情報ファイルへ保存する。
4. Modが接続情報を読み、CLIへ接続する。
5. `bridge.hello`でトークン、役割、プロトコルバージョンを確認する。
6. ワールド入場時、Modがワールド・プレイヤー情報と対応イベント一覧を通知する。
7. CLIがPATH上のPiを起動する。接続先とトークンは子プロセスの環境変数でPi拡張へ渡す。
8. Pi拡張がCLIへ接続し、準備が整ったら最初の判断を開始する。

接続情報ファイルの配置場所は実装時に確定する。
秘密情報を含むため所有ユーザーだけが読める権限にし、トークンをログへ出さない。
初版は1つのゲーム接続を扱う。

`worldId`は保存されたワールドを、`worldSessionId`は今回の接続・入場を識別する。
再接続・再入場時には新しい`worldSessionId`を割り当てる。
実行開始時の識別子をTool要求にも引き継ぎ、CLIは現在の接続と一致することを確認する。
古い実行の要求を、新しく接続したワールド向けに付け替えない。

## メッセージ形式

- 1行につき1つのJSONオブジェクトを送り、LFで区切る。
- `id`付きの要求には、同じ`id`で結果またはエラーを返す。
- イベントなど、応答が不要な通知には`id`を付けない。
- TCPの受信単位とJSONの境界は一致しないため、LFまでバイト列を蓄積して解析する。
- Piのstdoutは標準RPC専用とし、診断ログはstderrへ分ける。
- 送受信のバックプレッシャーを扱う。フレームサイズと要求時間にも上限を設け、具体値は検証時に決める。

CLIからModへの要求例。

```json
{"jsonrpc":"2.0","id":"game-19","method":"game.state.get","params":{"worldSessionId":"w1","query":{"inventory":true}}}
```

Modからの応答例。

```json
{"jsonrpc":"2.0","id":"game-19","result":{"worldSessionId":"w1","tick":12040,"inventory":[{"itemId":"minecraft:cobblestone","count":7}]}}
```

Modからのイベント通知例。

```json
{"jsonrpc":"2.0","method":"game.event","params":{"worldSessionId":"w1","seq":85,"tick":12042,"event":"block_broken","data":{"blockId":"minecraft:stone","position":[10,64,20]}}}
```

`seq`は`worldSessionId`内で増加するイベント番号とし、順序や欠損の確認に使う。

## 主な通信メソッド

| メソッド案 | 要求・通知の方向 | 処理 |
| --- | --- | --- |
| `bridge.hello` | Mod / Pi拡張 → CLI | 接続の初期確認 |
| `game.attach` | Mod → CLI | ワールド・プレイヤー・対応イベントの登録 |
| `game.status` | Mod → CLI | プレイ中・ポーズ中などの状態通知 |
| `game.detach` | Mod → CLI | ワールド退出通知 |
| `game.event` | Mod → CLI | ゲーム内イベントの通知 |
| `game.player_message` | Mod → CLI | プレイヤーからAIへのチャット入力 |
| `game.state.get` | Pi拡張 → CLI → Mod | ゲーム状態の取得 |
| `game.recipes.get` | Pi拡張 → CLI → Mod | レシピの取得 |
| `game.message.send` | Pi拡張 → CLI → Mod | AIの発言表示 |
| `director.context.get` | Pi拡張 → CLI | 最新状態と起動理由などの取得 |
| `director.hooks.add` / `remove` / `list` | Pi拡張 → CLI | hookの管理 |
| `director.events.get` | Pi拡張 → CLI | イベント履歴の取得 |
| `director.memory.search` | Pi拡張 → CLI | 観測記憶の検索 |

## 切断・失敗時の扱い

- Mod切断時は、実行待ちのゲーム要求を失敗させ、ポーリングとhookによる新しい起動を止める。
- 実行中の判断も停止させ、古いワールド向けのTool処理を受け付けない。
- Toolのタイムアウト、データ取得失敗、未対応の要求はエラーとしてPiへ返す。空データで成功扱いにしない。
- 必須コンテキストを取得できない場合、その判断を止める。
- 発言表示など、処理済みか不明な要求を自動再送しない。
- 再接続時は最新状態を取得し、イベント欠損があれば明示する。古いhook発火をまとめて再実行しない。
- 同じワールドでは既存hookと記憶を参照できるようにし、再開時にLLMが状況を確認する。
- PATH上のPiを起動できない場合は、起動エラーとして表示する。

## 一次資料

- [JSON-RPC 2.0仕様](https://www.jsonrpc.org/specification)
- [Node.js TCP API](https://nodejs.org/api/net.html)
- [Java Socket API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/Socket.html)
- [Pi RPC仕様](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Fabricのクライアント・サーバー構成](https://docs.fabricmc.net/develop/networking)

## 関連資料

- [構成と責務](architecture.md)
- [Tool一覧と呼び出し](tools.md)
- [ポーリングと応答hook](scheduling.md)
