# ゲームの観測

## 観測範囲

[ServerObservations](<../mod/src/main/java/io/github/ph0ryn/mchisyo/observation/ServerObservations.java>)は、
統合サーバーのcallback・Mixin・tick snapshotから32種類のイベントを作る。
[定義](<../src/protocol/gameEvent.ts>)にはpayload schema、観測の確度、filter対象のscalarフィールドを宣言する。
[client](<../mod/src/client/java/io/github/ph0ryn/mchisyo/DirectorClient.java>)への一度だけの登録とTCP送信は接続済み。
実ゲームでの発火、native Mixin適用、配送の受入確認は未実施。

観測対象は、ブロック破壊、inventory slot・体力・空腹・経験値・手持ち・位置の変化、
dimension移動、死亡・respawn・接続状態、damage処理、entityへのuse試行。
状態・周辺、操作、menuの観測は次表のとおり。対応一覧は`ServerObservations.supportedEvents()`、payload / scalar filterは上記schemaを正とする。

| 分類 | 観測内容 | 断定しないこと |
| --- | --- | --- |
| 状態・周辺（9） | effects baseline / 変化、装備、周辺、包含構造物、天候、半日phase、進捗criterion / 完了 | baselineを獲得・発見としない。視認・全世界の完全観測ではない |
| 操作（7） | 設置、拾得、drop、grid / furnace結果取得、block / item use試行 | net増加、全recipe・全modded経路、操作試行の成功は保証しない |
| menu（3） | open、slot変更、close | 全transient・cursor / data変更、現在の内容の保証ではない |

この一覧をschemaの全定義や、実際に送信できたイベント数と混同しない。

## 登録とスレッドの契約

client initializerから一度だけ登録する。接続のたびにcallbackを重複登録しない。

```java
var observations = ServerObservations.register(isScopedPlayer, sink); // 最小の登録例
```

- `isScopedPlayer`は、今回の統合サーバー・プレイヤーに絞るpredicate。scope外の変化は送らない。
- predicateとsinkはserver threadで呼ばれる。sinkは不変DTOを非blockingで送信queueへ渡す。
- `ObservedEvent`は名前、dimension、座標、tick、観測時刻、dataだけを持つ。
  world / player / session / seqの付与と、その寿命の検証は接続側の責務。
- attach・detach・session交換時は、server threadで`observations.clearBaselines()`を呼ぶ。
  UUIDが同じでも旧sessionのsnapshotを新しいsessionへ持ち越さない。
- JSONの**明示的なnullを保持する**。Gsonを使う場合は`GsonBuilder.serializeNulls()`を指定する。
  不明なdamage source entity、off-handのslot、hit位置、未登録biomeのIDはnullになり得る。

## 事実として言える範囲

- ブロック破壊は完了callbackから記録する。
- inventory・体力・空腹・経験値・手持ちはtick間の差分。初回snapshotを取得イベントとして捏造しない。
  ID / countだけを比較し、item componentだけの変化やtick内で相殺された変化は捕捉しない。
  slot差分から拾得・破棄・クラフトの原因を断定しない。
- 位置は既定で20 ticksごとにsampleし、最後に記録した位置から3次元で1 block以上の変位、
  またはbiome変更を記録する。軌跡や歩行距離ではない。payloadにはsample設定と経過tickを含める。
  `MovementSampling`で変更でき、dimension変更・respawn・scope変更でbaselineを作り直す。
- damageはFabricの非致死`AFTER_DAMAGE`。amountはcallbackの値で、最終的なhealth減少量ではない。
  致死damageはこのcallbackの対象外で、プレイヤーの死亡を別callbackで記録する。
- entity useはvanillaの後続検証より前の**試行**。交易・手懐け・騎乗・menu表示の成功とは扱わない。
  callbackは`PASS`を返し、通常の操作を横取りしない。
- effectsの初回sampleはbaseline。無期限durationは`-1`、装備はID / countのみでcomponent変化を捕捉しない。
- 周辺sampleは20 ticksごと、block半径4（最大729座標）、entity半径16（最大64件、65件目で打切り）。
  未ロードchunkを要求せず、視認・近い順・完全な世界観測ではない。
- 包含構造物はloaded chunkのbounded metadataだけで、coverageは常に不完全。locate・生成・遠方座標探索をしない。
- 天候はraw rain / thunder、半日phaseはraw day time由来で、明るさや体感の天候ではない。
- advancementは元のawardを一度だけ呼び、その成功と前後の完了状態を観測する。進捗の再演や過去分の再送はしない。
- 設置は成功したnative placement経路。拾得はitem entityから消費された個数で、inventory net増加とは限らない。
  dropはentity追加が`true`だった場合。grid / furnaceはnativeがcreditした結果個数で、全recipeやmodded経路を保証しない。
- block / item useはserverへ到達した試行で、全packetや成功操作の全件ではない。callbackは常に`PASS`。
- 接続の`leaving`は退出処理の開始で、プレイヤー除去の完了を意味しない。終端イベントは配送できないことがある。

### menuと接続初期の境界

menuは共通`initMenu`の**引数**から取得する。通常の`containerMenu`代入順に依存せず、horse / nautilusもこの経路で扱う。
初期slot baselineと自身のlistenerを使い、callbackがcoalesceした変化、同tick内の全transient、cursor / dataを完全には記録しない。
closeは実際の`doCloseContainer`完了後のpost-removal状態であり、最後の表示snapshotではない。
外すのは自身のlistenerだけで、追加のsyncを発生させない。
Chest / Ender Chest位置は実際にクリックしたblockから取り、取得できない位置を最寄り候補で補わない。double chestの両側も推定しない。

本物の初回JOINはready predicateより前に不変metadataをcaptureし、同じserver / player identityが保たれた場合だけ、
検証済み`game.ready` ACK後・baseline開始前に一度だけ送る。送信直後にもownerを再検証する。
ready前のrespawn等で元のplayer identityが消えた場合は破棄し、後着snapshotからJOINを捏造しない。
CLI attach / detachの内部履歴はnative JOIN / LEAVEの代用ではない。接続前・終端・切断中のcoverageはunknownのまま。

## ゲームを起動しない検証

[共有fixture](<../src/protocol/fixtures/observerEvents.json>)を
[TypeScriptテスト](<../src/protocol/gameEvent.test.ts>)と
[純Javaチェック](<../mod/src/test/observerJava/io/github/ph0ryn/mchisyo/observation/ObserverChecks.java>)の両方で読む。
Java側はsnapshot差分、プレイヤー別baseline、sample、reset、不変DTO、明示nullを検証する。

`mod`ディレクトリで実行する。

```bash
GRADLE_USER_HOME="$PWD/run/gradle-user-home" ./gradlew --offline observerTest
```

`--offline`は必要な依存がcache済みの場合に使う。通常の`build`もこのcheckを実行する。
Minecraft / Fabricをテスト実行classpathへ入れず、ゲーム起動・EULA同意・ワールド変更は行わない。
コンパイルとfixtureの整合確認は、ゲーム内callbackの発火を保証するものではない。
