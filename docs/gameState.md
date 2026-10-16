# 現在状態のsnapshot

[状態schema](<../src/protocol/gameSnapshot.ts>)と[bridge要求schema](<../src/protocol/bridge.ts>)を実装済み。
偽gameとの実TCP suiteはunit-only化で削除済み。現在のunit suiteはこの接続境界を検証しない。
[Pi拡張](<../src/pi/directorBridge.ts>)のcontext注入は実装済みで、過去のローカル検証と現在のcoverageは[検証状況](<validation.md>)で区別する。
**Modの取得・送信はまだ未接続。** 以下の取得方法はMod側で満たす契約であり、ゲーム内の動作実績ではない。

## 要求と検証

`game.state.get`はrun bindingと`query: {}`を受け、同じbindingと`state`を返す。
現在は全baselineを返す方式のみ。投影queryや任意のNBT取得は提供せず、未知のqueryキーは`-32602`で拒否する。

`state.version`は`1`。下記のfieldはすべて必須で、余分なfield、未対応version、型・件数の違反を許さない。
不正な結果は`-32603`、無効なbindingは`-32001`。空の`state: {}`で成功扱いにしない。
応答のawait後にもbindingを再検証する。schemaは形式の検証であり、Modが報告した値の真正性や実世界との一致を証明するものではない。

完全なJSON例は[共有fixture](<../src/protocol/fixtures/gameSnapshot.json>)を参照。

## 必須field

| field | 意味 |
| --- | --- |
| `version` | snapshot形式のversion。現在は`1`のみ |
| `tick` | 対象levelのgame time。非負safe integer |
| `observedAt` | 取得時のUnixミリ秒。非負safe integer |
| `dayTime` | 対象levelのday timeの生値。符号付きsafe integer。24,000で剰余を取らない |
| `dimension`, `position` | dimension IDとプレイヤーの`[x, y, z]` |
| `biomeId` | biomeのregistry ID。取得不能・registry keyなしは明示的`null` |
| `health`, `maxHealth` | 現在値と実際の最大値。最大値を20と決めつけない |
| `foodLevel`, `saturation` | food levelとsaturationの現在値 |
| `experience` | `level`, `progress`（0〜1）, `total` |
| `inventory` | 下記のID・個数snapshot。空slotも省略しない |
| `nearby` | 下記の範囲限定の周辺情報とcoverage flag |

数値は有限値、counterはsafe integerを要求する。ID文字列は1〜128文字。
時刻は取得時点を区別するための値で、壁時計との誤差や第三者による過去値の再送を検出する仕組みではない。
最新値は保存済みイベントから補完せず、Modへ要求して取得する。

## inventory

- `main`: 36個の`{itemId, count}`。配列indexがmain slot番号で、0〜8がhotbar。
- `selectedSlot`: 0〜8。main handは`main[selectedSlot]`から読む。
- `equipment`: `feet`, `legs`, `chest`, `head`, `offHand`, `body`, `saddle`をそれぞれ`{itemId, count}`で返す。
- 空stackは`{itemId: "minecraft:air", count: 0}`。非空stackはregistry IDと現在の個数を返す。

Minecraft 1.21.11の`Inventory.getContainerSize()`は36 mainと7 equipmentを含む43 slot。
wireでは装備を名前で分ける。body・saddleを省略したり、見ていないslotを空と推定したりしない。
IDと個数のbaselineであり、enchantment、damage、custom component、container内部は含めない。

## nearby

- `blockRadius: 4`: `floor(position)`を中心とした各軸±4のcube。候補は最大729座標。
  読めた非air blockの`{blockId, position}`のみを返す。positionは整数3要素。
- `blocksComplete`: cube内の有効な高さの座標をすべて読めたか。
  利用可能なchunkだけを読み、未ロードchunkは生成・ロードせず省略して`false`にする。
  `false`のとき、返っていない座標をairと判断してはいけない。
- `entityRadius: 16`: プレイヤー位置から3次元距離16以内の、メモリ上で参照可能なentity。
  プレイヤー自身と、独立entityではないEnderDragonのhitbox partは除外する。
  最大64件の`{entityId, entityType, position}`を返す。
- `entitiesTruncated`: 条件に合う65件目が存在したか。`false`でも未ロード領域を含む完全な世界観測は保証しない。
  近い順・固定順は保証しない。

値はすべてサーバースレッドで同じ取得処理内にコピーする。通信へMinecraftの可変objectを渡さない。
重い周辺走査はon-demandにし、毎tickのイベント差分snapshotへ追加しない。
biomeもchunk取得の待機や生成を伴わない経路を使い、取得できなければ`null`で表す。

半径と件数は初期のcontext・frame予算で、実ゲームの性能計測による最適値ではない。
上限件数の配列・上限長の文字列・大きな数値について、多バイト文字とJSON escapeを含む応答をテストする。
同梱の`RpcPeer`が生成する短い10進数字列のrequest IDで、最大長のbindingを含めても1 MiB frameへ収まることを確認する。
blockのstate propertyやblock entityのNBTは含めず、可視面だけに制限するものでもない。
未知の情報をどうプレイヤーへ伝えるかは、[Directorの方針](<concept.md>)と区別して扱う。
