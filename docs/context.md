# コンテキストと記憶

## 毎回渡すコンテキスト

LLMの各呼び出し前に、Pi拡張の`context`イベントから最新情報を取得して注入する。
Tool実行後の再判断も対象とし、過去のスナップショットを毎回会話履歴へ積み続けない。

- 位置、ディメンション、バイオーム、周辺情報。
- ゲーム内時刻。生の`dayTime`に加え、Pi拡張が24時間表記の`dayTimeClock`（`HH:mm`）を添える。
- 体力。
- インベントリ。
- 最近のAIの発言。
- 起動理由。プレイヤーの入力、定期ポーリング、発火したhookとイベント内容。

現在の目標・方針はPiの会話と合わせて参照する。
位置は座標だけでなく、周辺の地形、ブロック、エンティティなど判断に必要な情報を含める。
状態には取得時点のtickや時刻を付け、現在値と過去の観測を区別する。
bridgeは[必須snapshot](<gameState.md>)のschemaを検証する。範囲外・未ロード・打切りと、field自体の欠損を混同しない。
[Pi拡張](<../src/pi/directorBridge.ts>)は毎回`game.state.get`を待ち、`CURRENT_GAME_STATE`として直近の判断入力の直前へ一時注入する。
Tool結果の後ろへ新しいuser messageを追加しない。状態更新は背景情報であり、新たな発言要求ではない。
この必須snapshotは会話へ永続化せず、Tool呼出し後の再判断でも取得し直す。
`dayTimeClock`は`get_game_state`の結果にも添えるAI向けの派生値で、Modとのwire schemaは変えない。
24,000 ticksで一周、0 ticksが06:00、6,000 ticksが12:00。負値も正規化する。
現在の時刻は最新の状態を優先し、過去の会話やイベントから推測しない。時計は局所の明るさや他dimensionの昼夜を保証しない。
必須snapshotの欠損・不正・切断・timeoutはbinding破棄、同期abort、接続の引退で判断を止める。
ただしhostが先に無効化した**同じrun**の取消通知と、厳密なbinding付き`-32005`は通常の取消であり、拡張を引退させない。
不正・別runのエラーを取消扱いにしない。詳細は[取消の順序](<protocol.md#native側が先にrunを無効化した場合>)を参照。
CLIは開始・poll・入力・hookの理由を判断前に記録して渡す。最近のHUD発言は検索可能な履歴にあり、別の常時注入fieldはない。

## AI用の定期活動記憶

通常モードでは、プレイ中の累積1分ごとに[独立worker](<../src/runtime/historyWorker.ts>)が未要約の観測を古い順に処理する。
主判断とは独立して経過時間・取消・single-flightを管理し、Toolや新しいPi sessionは起動しない。人向け履歴UIも追加しない。
モデルは主判断と同じ`openai/gpt-6-luna`、要約の思考量は`reasoningEffort: low`とする。主判断の`medium`は変えない。
Fastは[公式の互換名](https://developers.openai.com/api/docs/guides/fast-mode.md)である`serviceTier: priority`で要求する。
隔離した実Piで成功を確認したが、応答の実提供tierは未取得。別tier・別モデルへ自動fallbackしない。

- [前処理](<../src/events/compactHistory.ts>)でraw JSONを短い観測テキストへ変える。
  同一操作の連続を数え、移動・周辺sampleは件数、観測した種類、最初／最後のsampleなどへ集約する。
  到着順、既知のsequence欠損、省略、観測の限界を残す。座標は0.1 block単位、既定の`minecraft:`名前空間は省略し、対応する`beforeX` / `afterX`は`x=前->後`（同じscalar値なら`x=値`）にする。
  構造物sample、空かつ未打切りの効果sample、レシピ実績通知、完了済みのcriterion通知は入力から除く。
  `entityPosition`・`hand`・`remainingCount`・手の装備注記とpickupの`infiniteMaterials=false`を省くが、slot別の数量、他の装備部位、移動の`@`は残す。
  `container_opened`のdataは`menuType`だけを残し、イベント共通の`@`位置注記は維持する。
  周辺sampleの`not FOV/lighting/full sight, empty != absence`注記は付けない。
  `e`番号は入力ごとの元行順で1から振り直す。保存ID・session・時刻はメタデータに維持し、session・観測時刻範囲は入力へ書かない。
- 1回の対象は同じsource sessionの連続prefix、最大500行。system指示と入力は合計12,000 UTF-8 bytes以内。
  応答は日本語の事実を最大3項目、1,200 bytes以内とする。完全な記録ではなく、詳細はraw履歴を検索する。
- [保存先](<../src/storage/historySummaries.ts>)はraw履歴の`history.sqlite`とは別の`summaries.sqlite`にある`history_summaries`。
  world / playerごとに元のID範囲・session・時刻・加工入力・要約・モデル・要求tierを保持する。
  正常な要約の保存とcursorの進行は要約DB内の同一transaction。rawイベントやhookは変更しない。
  入力元はMod由来の観測だけ。プレイヤーのチャット、AIのHUD発言、CLI内部活動、hook設定は別の`activities.sqlite`へ保存し、要約へ混ぜない。
  旧DBからの自動移行・要約コピーは行わない。
- pause中は定期実行までの経過時間を数えず、新しい要約を開始しない。進行中の要約は完了・保存まで続ける。
  ゲーム内時刻の取得を止める意味ではない。
  退出・終了では先に結果を無効化して取消し、遅い完了を保存せず、終了時の追加要約もしない。
  空の差分では呼び出さず、重なった周期を後から連打しない。取消・失敗時はcursorを進めず、失敗は通常のruntime faultとして扱う。
- 再接続後も同じworld / playerのcursorから継続し、以前のsessionも古い順に読む。
  件数・入力上限を超える量が続けば遅れるため、最新状態と同一視しない。

主判断は毎回、最新4件・最大6,000 bytesの保存済み要約を取得し、必須snapshotと同じ一時的な背景情報へ入れる。
以前のsessionを含み得る不確かな過去情報であり、新しい発言要求や指示ではない。現在の状態は最新snapshotを優先する。
未要約の新しい観測や、表示範囲外の古い要約があればその旨を添える。要約自体を次の要約入力へ再帰的に混ぜない。

## Toolで参照するイベント履歴

現在の[観測範囲と限界](<observations.md>)に基づく履歴の利用例。
Modが観測した事実を共通イベント形式でCLIへ送り、CLI側で保存・検索する。
種類ごとの記憶tableや専用Toolは作らず、イベント定義とobserverを追加する。

| 種類 | 内容 |
| --- | --- |
| 周辺履歴 | 遮蔽を除いた範囲限定のentity / block、移動sampleのbiome、loadedな包含構造物metadata。完全な視認・発見の証明ではない |
| チェスト履歴 | 開けたチェストの位置、中身、最終確認時刻 |
| 死亡履歴 | 死亡した位置、ディメンション、時刻 |

チェスト履歴は最終確認時点の中身として扱い、現在も同じ内容であると断定しない。
menu初期snapshot・slot listener・実際のcloseを記録するが、全transientや現在のチェスト内容は保証しない。
位置は実際にクリックしたblock等の根拠がある場合のみ。近傍のチェストを推定したり、double chestの両側を捏造したりしない。

## 生データとネタバレ

実行中の状態はbounded snapshot、過去は履歴、静的情報は[3つの読取Tool](<tools.md#静的ゲームファイルの境界>)へ分ける。
レシピ専用機構や一般OS Toolは提供しない。技術的な取得範囲とは別に、次のネタバレ方針をLLMへ指示する。

- AIが知っていても、プレイヤーがまだ知り得ないワールド固有の情報は明かさない。
- 未発見の鉱石・構造物などの位置を直接教えたり、その情報を使って露骨に誘導したりしない。
- 発見済みの情報は記憶を検索して案内できる。
- レシピや必要資材などの一般知識は相談に利用する。

周辺のblock/entityは[遮蔽判定](<gameState.md#nearby>)をproducerで行い、snapshotと20 ticksごとの履歴に共用する。
旧`nearby_sampled`に`visibility`がない場合、履歴参照時に配列を空にし、`blocksComplete: false`・`entitiesTruncated: true`で不明を示す。
元の履歴行・ID・sequenceは変更しない。新しいlive sampleはmarkerが必須で、snapshotはversion 2のみを受け付けるためCLIとModを一緒に更新する。

古い会話に残る位置情報を再利用しないよう、Piは同じworld/player scope・同じ所有lockの下で新しい会話ファイルを使う。
旧会話ファイルは保存するがresumeしない。以前の会話の文脈は引き継がず、イベント履歴とhookは維持する。
更新後の会話は従来どおり再接続で継続する。既存hookの条件や理由に記載済みの情報までは消去しない。

画面の向き・明るさや、包含構造物metadataなどは別の境界であり、ネタバレを完全に防ぐ技術的な保証ではない。

## 一次資料

- [Pi拡張仕様](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

## 関連資料

- [コンセプトと基本方針](concept.md)
- [Tool一覧と呼び出し](tools.md)
