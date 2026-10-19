# コンテキストと記憶

## 毎回渡すコンテキスト

run内の各モデル要求のdispatch直前に、[DurableAgent](<../src/runtime/durableAgent.ts>)が最新game stateと保存済みsummaryを取得して注入する。
Tool実行後の再判断も対象とし、過去のgame stateを毎回conversationへ積み続けない。

- 位置、ディメンション、バイオーム、周辺情報。
- ゲーム内時刻。生の`dayTime`に加え、DurableAgentが24時間表記の`dayTimeClock`（`HH:mm`）を添える。
- 体力、インベントリ。
- 最新のsummary。

run requestはready済みsessionの初回、poll、プレイヤー入力、実績解除、一致hookと観測を渡す。
現在の目標・方針とプレイヤー・hisyo・Toolのやり取りはconversationを参照する。
最近のHUD発言はactivity logから検索できるが、別の常時注入fieldはない。
位置は座標だけでなく、周辺の地形、ブロック、エンティティなど判断に必要な情報を含める。
game stateには取得時点のtickや時刻を付け、現在値と過去の観測を区別する。
bridgeは[game state](<gameState.md>)のschemaを検証する。範囲外・未ロード・打切りと、field自体の欠損を混同しない。
DurableAgentは毎回hostの`getGameState()`を待ち、`CURRENT_GAME_STATE`として直近のrun入力の直前へ一時注入する。
Tool結果の後ろへ新しいuser messageを追加しない。状態更新は背景情報であり、新たな発言要求ではない。
この背景情報はconversationへ永続化せず、Tool呼出し後と保留generationの再開時にも取得し直す。
明示的な`get_game_state`のTool結果は通常のTool履歴として残るため、現在値と混同しない。
`dayTimeClock`はこのTool結果にも添えるhisyo向けの派生値で、Modとのwire schemaは変えない。
24,000 ticksで一周、0 ticksが06:00、6,000 ticksが12:00。負値も正規化する。
現在の時刻は最新game stateを優先し、過去のconversationやevent logから推測しない。時計は局所の明るさや他dimensionの昼夜を保証しない。

必須game stateの欠損・不正・切断・timeout、summary contextの取得失敗はprovider呼出しへ進めずrunを失敗にする。
[released 1.3.0のhook例外](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md#errors>)は報告後にskipされ得るため、
例外を投げるcontext hookだけでは安全性を保証しない。実装はModelsのdispatch wrapper内で取得・検証・binding再確認を完了してからproviderを呼ぶ。
[実SDKの境界テスト](<../src/runtime/durableAgent.test.ts>)はTool後のcontext失敗でも次のprovider要求が発生しないことを確認する。
取消とnative-firstの詳細は[通信契約](<protocol.md#native側が先にrunを無効化した場合>)を参照。
CLIはrun requestの理由を実行依頼前にactivity logへ記録するが、その記録をprovider実行成功とは扱わない。

## summary

通常モードでは、[summaryScheduler](<../src/runtime/summaryScheduler.ts>)がevent logをUnix時刻の分境界で区切り、終了済みの1分間`[start, start + 60_000)`を対象にする。
未要約の観測がある最も新しい分を優先し、保存直後に現在時刻で選び直す。最新分が済んでいれば、過去の未要約分を新しい順に遡る。
生成中に新しい分が確定しても中断せず、完了・保存後の選択で優先する。同時実行は1本だけである。
CLIと同じプロセス内のschedulerであり、別worker threadや別CLIプロセスではない。
runとは独立して取消・single-flightを管理し、[generateSummary](<../src/runtime/generateSummary.ts>)から共有のModelsへ単発のAPI要求を行う。
DurableAgentやRunSchedulerを経由せず、mainの起動完了・conversation・Durable保存領域に依存しない。
渡すcontextは固定の要約指示と今回の対象ログだけで、Tool・会話履歴・前回のsummaryを含めない。
summary用の会話sessionは作成・保存・復元せず、prompt cacheも`cacheRetention: none`とする。
現在のgame SessionBindingはusageの帰属と結果の有効性のために使い、mainのrun bindingは取得しない。
モデルはrunと同じ`openai/gpt-6-luna`、summaryの思考量は`reasoningEffort: low`とする。runの`medium`は変えない。
Fastは`serviceTier: priority`で要求する。これは要求値であり、実providerでの提供tier・応答時間・料金を検証した結果ではない。
別tier・別モデルへ自動fallbackしない。

- [summaryInput](<../src/events/summaryInput.ts>)の`prepareSummaryInput`でevent logのJSONを短い観測テキストへ変える。
  同一操作の連続を数え、移動・周辺sampleは件数、観測した種類、最初／最後のsampleなどへ集約する。
  到着順、既知のsequence欠損、省略、観測の限界を残す。座標は0.1 block単位、既定の`minecraft:`名前空間は省略し、対応する`beforeX` / `afterX`は`x=前->後`（同じscalar値なら`x=値`）にする。
  構造物sample、空かつ未打切りの効果sample、レシピ実績通知、完了済みのcriterion通知は入力から除く。
  `entityPosition`・`hand`・`remainingCount`・手の装備注記とpickupの`infiniteMaterials=false`を省くが、slot別の数量、他の装備部位、移動の`@`は残す。
  `container_opened`のdataは`menuType`だけを残し、イベント共通の`@`位置注記は維持する。
  周辺sampleの`not FOV/lighting/full sight, empty != absence`注記は付けない。
  `e`番号は入力ごとの元行順で1から振り直す。保存ID・session・時刻はメタデータに維持し、session・観測時刻範囲は入力へ書かない。
- 1回の対象は同じ1分間・source sessionの未要約観測を到着順に最大500行。system指示と入力は合計12,000 UTF-8 bytes以内。
  sessionが複数ある分や件数・入力上限を超える分は複数の要求に分け、毎回最新分を選び直す。区間外の到着行をまたいで操作を集約しない。
  応答の形式は指定せず、上限は1,200 bytesとする。完全な記録ではなく、詳細はevent logを検索する。
- [summaryStore](<../src/storage/summaryStore.ts>)はevent logの`eventLog.sqlite`とは別の`summary.sqlite`にある`summaries`へ保存する。
  world / playerごとに元のID範囲・session・時刻・加工入力・summary・モデル・要求tierを保持する。
  新規の`source_json`は`minuteStart`と正確な`eventIds`を対で持ち、到着順と観測時刻が異なっても他の分の観測を要約済みにしない。
  両fieldを持たない既存記録は従来の`(after, through]`全体を要約済みとして扱い、書き換えない。DB schemaはversion 1のままで、移行は行わない。
  summary本文と要約済みIDは同じinsertで確定し、重複・重なりを拒否する。event logやhookは変更しない。
  入力元はMod由来の観測だけ。プレイヤー入力、hisyoのHUD発言、hook変更、run要求などのCLI事実は`activityLog.sqlite`へ保存し、summaryへ混ぜない。
- pause中も選択・生成・完了・保存を続ける。runのpause制御とは独立する。
  仕事がなければ待機し、runtimeの1秒ごとのpollで再確認する。空・要約済み・終了前の分はAPIへ送らない。
  ChatGPT OAuth利用時は各要求のSDK認証解決が元の共有storeで必要なrefreshを行う。認証のためにmain runのslotを取らない。
  退出・終了では先に結果を無効化して取消し、遅い完了を保存せず、終了時の追加summaryもしない。
  取消・失敗時は要約済み範囲を増やさず、失敗は通常のruntime faultとして扱う。遅いusageの帰属と完了待ちは維持する。
- 再接続後も同じworld / playerの要約済み範囲を使い、以前のsessionを含む未要約分を最新優先で選び直す。
  生成中の完了待ちや入力の分割で遅れることがあるため、最新game stateと同一視しない。

run内では毎回、元観測時刻が新しい4件・最大6,000 bytesの保存済みsummaryを古いものから並べ、game stateと同じ一時的な背景情報へ入れる。
保存順では選ばず、後から作った過去分が最新分を押し出すことはない。
以前のsessionを含み得る不確かな過去情報であり、新しい発言要求や指示ではない。現在の状態は最新game stateを優先する。
未要約の観測や表示範囲外の古いsummaryがあればその旨を添える。summary自体を次のsummary入力へ再帰的に混ぜない。

## Toolで参照するevent log

現在の[観測範囲と限界](<observations.md>)に基づくevent logの利用例。
Modが観測した事実を共通イベント形式でCLIへ送り、CLI側で保存・検索する。
種類ごとの記憶tableや専用Toolは作らず、イベント定義と観測処理を追加する。

| 種類 | 内容 |
| --- | --- |
| 周辺の観測 | 遮蔽を除いた範囲限定のentity / block、移動sampleのbiome、loadedな包含構造物metadata。完全な視認・発見の証明ではない |
| チェストの観測 | 開けたチェストの位置、中身、最終確認時刻 |
| 死亡の観測 | 死亡した位置、ディメンション、時刻 |

チェストの観測は最終確認時点の中身として扱い、現在も同じ内容であると断定しない。
menu初期snapshot・slot listener・実際のcloseを記録するが、全transientや現在のチェスト内容は保証しない。
位置は実際にクリックしたblock等の根拠がある場合のみ。近傍のチェストを推定したり、double chestの両側を捏造したりしない。

## 生データとネタバレ

現在の情報はgame state、過去の観測はevent log、やり取りはconversation、CLI事実はactivity log、観測の派生記憶はsummary、静的資料はreferenceへ分ける。
referenceは[3つの読取Tool](<tools.md#静的ゲームファイルの境界>)で取得し、レシピ専用機構や一般OS Toolは提供しない。
技術的な取得範囲とは別に、次のネタバレ方針をhisyoへ指示する。

- hisyoが知っていても、プレイヤーがまだ知り得ないワールド固有の情報は明かさない。
- 未発見の鉱石・構造物などの位置を直接教えたり、その情報を使って露骨に誘導したりしない。
- 発見済みの情報はevent logを検索して案内できる。
- レシピや必要資材などの一般知識は相談に利用する。

周辺のblock/entityは[遮蔽判定](<gameState.md#nearby>)をproducerで行い、game stateと20 ticksごとのevent logに共用する。
`nearby_sampled`は`visibility: "unobstructed"`が必須で、game stateはversion 2のみを受け付ける。
画面の向き・明るさや、包含構造物metadataなどは別の境界であり、ネタバレを完全に防ぐ技術的な保証ではない。

## 一次資料

- [Pi Durable 1.3.0](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/README.md>)
- [Pi AI 1.3.0のprovider-specific options](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md#provider-specific-options-streamcomplete>)

## 関連資料

- [用語と命名](<naming.md>)
- [コンセプトと基本方針](<concept.md>)
- [Tool一覧と呼び出し](<tools.md>)
