# game state

[状態schema](<../src/protocol/gameState.ts>)と[bridge要求schema](<../src/protocol/bridge.ts>)を実装済み。
[bridge tests](<../src/bridge/bridgeServer.test.ts>)には実TCPのfake gameを使う境界検証がある。
[DurableAgent tests](<../src/runtime/durableAgent.test.ts>)は実SDK / fake provider / temp SQLiteで、毎要求のtransient contextとTool後の再取得を確認する。
[Mod producer](<../mod/src/main/java/io/github/ph0ryn/mchisyo/observation/ServerGameState.java>)と接続済み。
以下は実装契約であり、ゲーム内の動作実績ではない。

## 要求と検証

`game.state.get`はrun bindingと`query: {}`を受け、同じbindingと`state`を返す。
現在は全baselineを返す方式のみ。投影queryや任意のNBT取得は提供せず、未知のqueryキーは`-32602`で拒否する。

`state.version`は`2`。下記のfieldはすべて必須で、余分なfield、未対応version、型・件数の違反を許さない。
不正な結果は`-32603`、無効なbindingは`-32001`。host所有の取消済みrunにはbinding付き`-32005`を返す。
空の`state: {}`で成功扱いにしない。[取消の順序](<protocol.md#native側が先にrunを無効化した場合>)を参照。
応答のawait後にもbindingを再検証する。schemaは形式の検証であり、Modが報告した値の真正性や実世界との一致を証明するものではない。

完全なJSON例は[共有fixture](<../src/protocol/fixtures/gameState.json>)を参照。

## 必須field

| field | 意味 |
| --- | --- |
| `version` | snapshot形式のversion。現在は`2`のみ |
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

- `visibility: "unobstructed"`: 現在の目の位置から、nativeのOUTLINEとCOLLIDER双方で遮蔽を調べる。
  壁・床の裏を除き、glass・fluidも保守的に遮蔽物として扱う。画面の向き・FOV・明るさの判定ではない。
- `blockRadius: 4`: `floor(position)`を中心とした各軸±4のcube。候補は最大729座標。
  非air blockの中心へ向かうOUTLINEの最初のhitがそのblockで、COLLIDERにも手前のhitがない場合のみ返す。
  `{blockId, position}`のpositionは整数3要素。部分形状は見えていても中心rayが外れれば省略する。
- `blocksComplete`: cube内の有効な高さの座標をすべて読めたか。可視blockの網羅性ではない。
  利用可能なchunkだけを読み、未ロードchunkは生成・ロードせず省略して`false`にする。
  rayもloaded-onlyで、未知chunkや未準備のblock entityの形状は遮蔽物として扱う。
  native rayが隣接cellへのはみ出しを見逃すため、移動中のpistonとその周囲1 blockを通るrayも省略する。
  flagにかかわらず、返っていない座標をairと判断してはいけない。
- `entityRadius: 16`: プレイヤー位置から3次元距離16以内の、メモリ上で参照可能なentity。
  自身・EnderDragonのhitbox partを除く候補を最大65件取得し、最初の64件に対して視線を判定する。
  spectator・そのプレイヤーから不可視のentityを除き、目同士の距離も16以内で遮蔽がなければ返す。
  最大64件の`{entityId, entityType, position}`。近い順・固定順は保証しない。
- `entitiesTruncated`: 遮蔽判定前の65件目が存在したか。省略された候補が可視とは限らない。
  `false`も完全な世界観測や視認を保証しない。

値はすべてサーバースレッドで同じ取得処理内にコピーする。通信へMinecraftの可変objectを渡さない。
現在状態はon-demand。観測側のbounded周辺sampleは20 ticksごとで、毎tickのinventory差分とは分ける。
biomeもchunk取得の待機や生成を伴わない経路を使い、取得できなければ`null`で表す。

半径と件数は初期のcontext・frame予算で、実ゲームの性能計測による最適値ではない。
上限件数の配列・上限長の文字列・大きな数値について、多バイト文字とJSON escapeを含む応答をテストする。
同梱の`RpcPeer`が生成する短い10進数字列のrequest IDで、最大長のbindingを含めても1 MiB frameへ収まることを確認する。
blockのstate propertyやblock entityのNBTは含めない。これは保守的な幾何sampleで、実際に見たことの証明ではない。
未知の情報をどうプレイヤーへ伝えるかは、[hisyoの方針](<concept.md>)と区別して扱う。

### 実ゲームでの遮蔽回帰確認（手動）

Java unit testはMinecraft runtimeを含まないため、shapeやchunk境界の実動作を証明しない。
実際に保存された最新の`nearby_sampled`で、可視対照・床下・壁裏・不可視entity・壁除去後を確認する。
snapshotも同じproducerを使う。
この確認は通常の`pnpm verify`やMod buildには含まれない。chunk非ロード・FOV・性能の実測でもない。

新しい使い捨てのcreative worldと、空の専用data directoryで`--bridge-only`のCLIとModを起動する。
他のentityが少ない場所で次を実行し、chatを閉じて20 ticks以上進める。ウィンドウを切り替える場合はpauseしない設定にする。

```mcfunction
/gamemode creative
/fill -4 99 -4 4 99 4 minecraft:stone
/setblock 0 98 0 minecraft:diamond_block
/setblock -2 101 0 minecraft:gold_block
/setblock 3 101 2 minecraft:netherite_block
/fill 2 100 -4 2 104 4 minecraft:stone
/summon minecraft:armor_stand -2.5 100 2.5 {NoGravity:1b}
/summon minecraft:armor_stand 4.5 100 -2.5 {NoGravity:1b}
/summon minecraft:armor_stand 0.5 100 -2.5 {NoGravity:1b,Invisible:1b}
/tp @s 0.5 100 0.5
```

専用data directoryの最新sampleを読み、`observed_at`が更新されたことと、次の期待値を確認する。

```sh
sqlite3 -readonly "${DATA:?}/eventLog.sqlite" \
  "SELECT observed_at, observation_json FROM events WHERE event='nearby_sampled' ORDER BY id DESC LIMIT 1;"
```

ゲーム内で`/fill 2 100 -4 2 104 4 minecraft:air`を実行し、さらに20 ticks以上進めて再確認する。
`visibility`は`unobstructed`。配列の期待値は以下のとおりで、空配列だけでは合格にしない。

| 対象 | 壁あり | 壁除去後 |
| --- | --- | --- |
| gold block `(-2, 101, 0)` | 含む | 含む |
| 可視armor stand `(-2.5, 100, 2.5)` | 含む | 含む |
| 床下diamond block `(0, 98, 0)` | 含まない | 含まない |
| netherite block `(3, 101, 2)` | 含まない | 含む |
| 壁裏armor stand `(4.5, 100, -2.5)` | 含まない | 含む |
| 不可視armor stand `(0.5, 100, -2.5)` | 含まない | 含まない |
