# 検証状況と未確定事項

実装範囲と通常の開発コマンドは[開発資料](<development.md>)にまとめる。

## 現在の自動テスト：unit testのみ

frozen source **`f559634c0b5c5f1646aa67ee3878e1a0f408e87f`**に対するleadのcomposed検証結果を以下に記録する。
今回のdocs-only変更で再実行した結果ではない。依存install・build承認・downloadはしていない。

| 検査 | leadが実行したコマンド / 範囲 | 結果 |
| --- | --- | --- |
| TypeScript検査 | `./node_modules/.bin/vp check` | 49 format / 43 TypeScript、警告なし |
| ESM build | `./node_modules/.bin/vp pack` | 12 artifacts |
| unit | `./node_modules/.bin/vp test --run` | **307 / 307成功、13ファイル** |
| 純Java + cached build | `observerTest transportTest rpcPeerTest gameSessionTest referenceTest build --rerun-tasks`、`--offline` | **749 assertions**、14 tasks再実行、BUILD SUCCESSFUL |
| 文書 / whitespace | `rumdl check docs` / `git diff --check` | 11文書で問題なし / 成功（source基点の旧docs） |

Java内訳はobserver 209、transport 181、rpcPeer 140、gameSession 173、reference 46。
通常のGradle `test`は`NO-SOURCE`であり、この5つのcustom checkと取り違えない。
実行routeは[既存cacheを使う手動コマンド](<development.md#検証コマンド>)を参照。

TypeScriptの発見対象は[設定](<../vite.config.ts>)の`src/**/*.test.ts`。
契約・queue・scheduler・clock・framingに加え、CLI parser / config / runtime / model gate、静的参照、履歴、host / 拡張の取消を含む。
依存port・手動peer・in-memory SQL adapterを使うunitであり、CLI / Piの実行や実DB・接続を行わない。
JavaもMinecraft / Fabricをruntime classpathに含めず、literal fixture・手動queue / streamを使う。
古い実TCP・HTTP・provider・子プロセス・実SQLiteの8 suiteとfake実行harnessは削除済みで、任意実行設定にも残していない。

### 最終修正の検証とその限界

- 初回JOINのcandidateは`AssertionError: check 18`でREDとなり、pending captureのtake-onceをatomicに修正した。
  これは純Javaの再現であり、未変更productionの実ゲームで発見したREDではない。
- owned context取消のfresh reviewはhost / test・Pi拡張 / test・protocolの**5ファイル**を確認して承認した。
  Pi stdio driverはこの差分では不変で、別途sourceを追跡した。`-32005`を一律に再利用可能エラーとしたのではない。
- native-firstのunitは実登録handler・拡張・schedulerを通るが、Pi ownerはmock、settledは手動、provider counterも偽物。
  実Pi owner / provider wireの証明ではない。
- 最後のadmission回帰は既存caseへ19行追加し、case数は不変、skip・弱化なし。guardを意図的に外すmutationで旧testはPASS、
  強化したtestはnative bindが期待2回に対し実際1回でRED、正確なsource復元でGREENを確認し、異なるfresh reviewerが承認した。
  これはmutationによる回帰感度であって、未変更productionのREDや実native受入れとは呼ばない。
- cached compile / remap / JARは成功したが、`remapJar`の`Cannot remap hisyo$player` / `hisyo$removeCount`
  （ResultSlot / FurnaceResultSlot）のadvisoryは残る。cached aliasやJAR生成はnative Mixinのruntime適用を保証しない。

実ゲーム・launcher・Pi / provider・SQLite・TCP / HTTP / stdio・Files / archive / resource境界の受入れは**未実施**。
unitのsuccess、source review、cached buildをその代用にしない。下の8項目も未実施のまま維持する。

## 過去のunit checkpoint（最終件数ではない）

以下は4 suite / 71件時点を含む過去のunit記録。現在の配線・件数・coverageは上記を正とする。
当時のinstallは未承認dependency buildで終了1、focused testも収集前に停止し、既存runnerでcheck・pack・71件を実行した。
再installやbuild承認はしなかった。

### 判断理由の保留キュー

- hook一致を渡さない通常観測は判断を予約しない。開始・pollは各1予約、同文チャットも受信順に保持する。
- 入力済みhook指示とイベント本文をsnapshot化し、呼出側の後からの変更を反映しない。
- 明示的に渡した発火IDだけを保持し、欠けた連番を捏造せず、複数hookのイベント本文を重複させない。
- batch取得後の入力を分離し、別world / player / 接続sessionを拒否する。
- UTF-8・JSON escapeのbyte境界、反復発火・一括超過での継続拒否を確認する。

このunit testはhook登録・照合やDB保存を行わない。hook削除・後登録、raw履歴の保持、scope別検索の保証には読み替えない。

### Single-flight scheduler checkpoint

scheduler suiteの既存入力・assertionは維持し、quote-heavyケースのcodecだけをproductionのPi専用helperへ接続した。
ファイル・SQLite・TCP・子プロセスなしで次を確認する。

- ready前は起動せず、ready済みworldの開始理由を1回取り込む。初期pauseと設定snapshot。
- 同文チャット順序、渡された発火hookと保存ID、通常観測をpromptへ混ぜないこと。
- pause解除とsettledの順序、`not_started` batchの保持と後着入力の分離。
- 過負荷でcloseを要求してからfaultを通知し、以後の受付・自動再開を拒否すること。
- close promiseの解決まで次所有者を起動せず、旧worldの揮発入力を再送しないこと。
- 起動途中の退出・close、起動失敗、曖昧な判断失敗、cleanup失敗、同期close再入。

cleanup直後のbaselineは65件中64成功・既知RED 1件で、同じ結果を再実行した。
受付済みJSON 544,215 bytesがprompt envelopeでは1,088,312 bytesとなり、従来の共通1 MiBでは拒否された。
Pi helper分離・境界test追加後も旧上限のままでは71件中66成功・5失敗となるREDを先に確認し、修正後は71件全成功となった。
元の17件のquote-heavy入力、順序、raw容量assertionを削除・緩和・skipしていない。

### Pi専用framing

- 判断messageのraw上限を既定batchと同じ1 MiBへ揃え、送受信frameだけを2 MiB + 256 bytesへ分離した。
- 上限ちょうど1 MiBの公開queue受付済みbatchで、promptとuser echoをproductionのpure codec / decoderへ通す。
- quote-heavy入力のuser start / endと、user + 小さなassistant応答の`agent_end`をdecodeし、大きな応答を含む集約frameは超過として拒否する。
- Piの改行を除くbyte上限ちょうどを許可し、1 byte超過は送信・改行あり受信・未完了frame受信のいずれも拒否する。
- raw制御文字の再escapeが上限を超える場合は明示拒否し、6 MiBへの拡大を行わない。共通codecの1 MiB超過拒否も維持する。

入力echoの形はPi 1.2.0のsourceと照合したが、実Piは今回起動していない。
任意の`maxPendingBytes`拡大、任意raw文字列、全ての集約event / Tool結果 / モデル出力の配送保証ではなく、超過は明示失敗のままである。
この時点ではタイマー・CLI / Modが未配線だった。現在は実装済みで、実Pi受入れは引き続き未実施。

## 実境界では確認していないcoverage

旧suiteをunit testと呼び替えたり、case数維持のための偽TCP/Pi基盤を追加したりはしていない。
現在のunit結果は次のcoverageを代替しない。

- 実TCP codecの分割UTF-8、切断・timeout・framing・要求相関と再送拒否。
- 認証bridgeのrole・ready・両bind ACK、状態snapshotの形式・frame境界、scope隔離、チャット受付。
- ビルド済みCLIの引数・signal・終了処理、接続情報公開、POSIX mode・symlink/hardlink・差替え拒否。
- SQLiteの再open、migration拒否、履歴・hook永続化、ページング、連番欠損とscope別検索・照合。
- 実stdio偽Piのversion/metadata gate、ACK/settled/abort、EOF・timeout・SIGKILLと子の終了確認。
- 隔離sessionのprivate設定・会話再開・lease、保存先のfilesystem安全性、実取消と終了順。
- 実Pi・偽HTTP provider・偽gameでの全10 Tool、context注入、driver/sessionの接続。

現在はhost handlerやSQL adapterのunitもあるが、実SQLite・TCPでの保存・検索・hook結合coverageは復元していない。
実装契約は[通信](<protocol.md>)、[状態](<gameState.md>)、[実行制御](<scheduling.md>)に残す。

## 過去の検証記録（今回は再実行していない）

以下はunit-only化前の設計根拠であり、現行suiteの成功数・coverageではない。

### Piのローカル境界とproduction拡張

Pi 1.2.0の3 physical APIで、独立probeは4シナリオずつ12件、production拡張・driver/sessionの接続は30件の成功記録がある。
当時は一時HOME・設定・会話・作業場所、dummy keyとloopback偽providerだけを使用した。
実モデルやMinecraftでの確認ではなく、今回再実行もしていない。

設計根拠として残す事項：

- `openai-completions`、`openai-responses`、`anthropic-messages`だけを許可し、Pi versionとprompt前metadataを検査する。
- 例外を投げるだけでは必須context取得失敗後の推論を止められず、binding無効化と同期abortが必要。
- ACK / `agent_end`をsettledと同一視せず、slot・取消・所有権を分ける。
- 各provider要求前に最新snapshotを取得し、一時contextを会話へ永続化しない。
- compaction・cache warming・自動resource探索・組込OS Toolを無効化し、既知の明示拡張だけを使う。

任意provider、差替えstream実装、別Pi version、実モデルの性能や実ゲームの保証ではない。
[Pi境界調査](<piFeasibility.md>)に当時の条件・結果と保証の限界を残す。再現scriptは廃止済み。

### Fabricビルド

Minecraft 1.21.11 / Loader 0.19.5 / Fabric API 0.141.6+1.21.11を固定し、
Java 21 / Loom 1.17.21 / Gradle 9.7.1で`build`を確認した過去の記録がある。
配布JARのclient-only metadata、entrypoint、Java 21 class formatも当時確認した。

13種類のobserverと、Minecraft / Fabricをclasspathから除外した純Java `observerTest`の**93 assertions**は過去に成功した。
共有fixtureのserialize、snapshot差分、プレイヤー別baseline、sample、reset、DTOの不変性・明示nullを対象とした。
この93 assertionsは過去値。最終sourceへのleadのJava 749 assertions / cached buildとは別の記録である。

当時observerはclient initializerに未登録だった。現在は登録済みだが、ゲーム内callbackの発火確認ではない。
Minecraftの起動、EULA同意、既存ワールドの利用も行っていない。[観測の契約と限界](<observations.md>)を参照。

## 実装済みの選択と残る限界

UUID sidecar、bounded static reference、Mod広告32イベント、baseline query `{}`、10 Tool、OS Tool無効化は確定済み。
具体的な境界は[開発資料](<development.md>)、[観測](<observations.md>)、[Tool](<tools.md>)を参照。
active play 60秒、要求timeout、frame / queue上限は実装上固定した初期値で、実ゲームでの最適性は未計測。
レシピ専用機構・目標state machine・黙示的破棄・永続inboxは導入しない。

過去のindexion reconcileは別source `166b802`で313行・21 groups / 127 symbols、vocabulary divergence 0だった。
主にexport comment候補であり、意味・source正確性や現在sourceの適合証明ではない。coverage score目的でAPI commentを増やしていない。
今回の文書更新はsource → docs（実装された公開境界の記載）とdocs → source（各現在主張の根拠）の両方向で照合した。

## 未確認の利用要件

以下は設計上の要件であり、現行自動テストや実接続の実行許可ではない。

1. `/ai`入力がPiへ渡り、`send_message`だけがローカルHUDへ表示される。
2. `get_game_state`が実際の所持数を返す。
3. 定期判断はactive play中のみで、pause・切断中は新しい判断を始めない。
4. hook登録・イベント起動・Toolからの削除が接続全体で成立する。
5. 全観測を保存し、発火理由だけを次判断へまとめる。
6. 退出後の古いbindingが新worldの状態・表示・hookを操作できない。
7. 切断・timeoutは明示失敗とし、不明な表示要求は再送しない。
8. 再起動後、同scopeのPi会話・hook・履歴を再開し、別scopeとは混ざらない。

初版はローカル1ゲーム接続のみ。遠隔・複数ゲーム・ModからのCLI自動起動・操作代行は対象外。
実モデルの料金が生じる試験や実ワールドでの受入れは、別途確認なしに行わない。

## 関連資料

- [コンセプトと基本方針](<concept.md>)
- [構成と責務](<architecture.md>)
- [ポーリングと応答hook](<scheduling.md>)
