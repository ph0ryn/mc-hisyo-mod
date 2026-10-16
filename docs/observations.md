# ゲームの観測

## この段階の範囲

[ServerObservations](<../mod/src/main/java/io/github/ph0ryn/mchisyo/observation/ServerObservations.java>)は、
統合サーバーのcallbackとtick snapshotから13種類のイベントを作る。
[定義](<../src/protocol/gameEvent.ts>)にはpayload schema、観測の確度、filter対象のscalarフィールドを宣言する。
現在はライブラリの実装段階で、client initializerへの登録、TCP送信、実ゲームでの発火確認はまだ行っていない。

観測対象は、ブロック破壊、inventory slot・体力・空腹・経験値・手持ち・位置の変化、
dimension移動、死亡・respawn・接続状態、damage処理、entityへのuse試行。
対応一覧は`ServerObservations.supportedEvents()`で取得する。
この一覧をschemaの全定義や、実際に送信できたイベント数と混同しない。

## 登録とスレッドの契約

client initializerから一度だけ登録する。接続のたびにcallbackを重複登録しない。

```java
var observations = ServerObservations.register(isScopedPlayer, sink);
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
- 接続の`leaving`は退出処理の開始で、プレイヤー除去の完了を意味しない。

## ゲームを起動しない検証

[共有fixture](<../tests/fixtures/protocol/observerEvents.json>)を
[TypeScriptテスト](<../tests/eventDefinitions.test.ts>)と
[純Javaチェック](<../mod/src/test/observerJava/io/github/ph0ryn/mchisyo/observation/ObserverChecks.java>)の両方で読む。
Java側はsnapshot差分、プレイヤー別baseline、sample、reset、不変DTO、明示nullを検証する。

`mod`ディレクトリで実行する。

```bash
GRADLE_USER_HOME="$PWD/run/gradle-user-home" ./gradlew --offline observerTest
```

`--offline`は必要な依存がcache済みの場合に使う。通常の`build`もこのcheckを実行する。
Minecraft / Fabricをテスト実行classpathへ入れず、ゲーム起動・EULA同意・ワールド変更は行わない。
コンパイルとfixtureの整合確認は、ゲーム内callbackの発火を保証するものではない。
