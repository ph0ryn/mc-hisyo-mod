# 検証状況と未確定事項

実装範囲と通常の開発コマンドは[開発資料](<development.md>)にまとめる。

## 現在の自動テスト：unit testのみ

実TCP・HTTP・provider・子プロセス・実SQLiteを使う8 suiteを削除した。
専用の偽実行file・provider・接続harness、任意Pi用のscriptと別設定も削除し、opt-inの形では残していない。
本番の実装・容量方針・依存build承認は変更していない。

残る発見対象は[設定](<../vite.config.ts>)の`src/**/*.test.ts`に一致する次の3 suiteだけである。
実行前にfixtureと依存portを監査し、実接続・実子プロセス・実DBを使わないことを確認した。
静的な共有JSONの読込は行う。

| suite | 内容 | 今回の結果 |
| --- | --- | --- |
| [イベント契約](<../src/protocol/gameEvent.test.ts>) | 13種の共有fixture、schema/catalog、scalar filterと純粋な完全一致 | 22成功 |
| [保留キュー](<../src/runtime/judgmentQueue.test.ts>) | literalの`StoredEvent`とhookを公開APIへ渡す | 17成功 |
| [scheduler](<../src/runtime/judgmentScheduler.test.ts>) | bridgeイベント・同期受付とPi session factoryだけをstub化 | 25成功、既知RED 1件 |

依存配置済みのlocal runnerを直接使った今回の結果：

- `./node_modules/.bin/vp check`：format・型検査付きlint成功。
- `./node_modules/.bin/vp pack`：ESMビルド成功。CLIやPiは起動していない。
- `./node_modules/.bin/vp test`：**65件中64成功・1失敗**、3 suite、skipや名前filterなし。

したがって`verify`相当は未完了。失敗を削除・緩和・skipしてgreenにはしていない。
先の`pnpm install --frozen-lockfile --prefer-offline`はgenai/protobufjsの未承認buildで終了1となり、
pnpm経由のfocused testも収集前に同じ問題で停止した。その時点ではテストは実行されていない。
その後は再install・依存build承認をせず、既存local runnerだけを用いた。

### 判断理由の保留キュー

- hook一致を渡さない通常観測は判断を予約しない。開始・pollは各1予約、同文チャットも受信順に保持する。
- 入力済みhook指示とイベント本文をsnapshot化し、呼出側の後からの変更を反映しない。
- 明示的に渡した発火IDだけを保持し、欠けた連番を捏造せず、複数hookのイベント本文を重複させない。
- batch取得後の入力を分離し、別world / player / 接続sessionを拒否する。
- UTF-8・JSON escapeのbyte境界、反復発火・一括超過での継続拒否を確認する。

このunit testはhook登録・照合やDB保存を行わない。hook削除・後登録、raw履歴の保持、scope別検索の保証には読み替えない。

### Single-flight scheduler checkpoint

scheduler suiteは変更せず、ファイル・SQLite・TCP・子プロセスなしで次を確認する。

- ready前は起動せず、ready済みworldの開始理由を1回取り込む。初期pauseと設定snapshot。
- 同文チャット順序、渡された発火hookと保存ID、通常観測をpromptへ混ぜないこと。
- pause解除とsettledの順序、`not_started` batchの保持と後着入力の分離。
- 過負荷でcloseを要求してからfaultを通知し、以後の受付・自動再開を拒否すること。
- close promiseの解決まで次所有者を起動せず、旧worldの揮発入力を再送しないこと。
- 起動途中の退出・close、起動失敗、曖昧な判断失敗、cleanup失敗、同期close再入。

quote-heavy batchの通信容量回帰1件は**REDのまま**独立再現した。
受付済み約544 KBのJSONを公開codecでPi prompt envelopeへ包むだけで1 MiBを超え、
`JSONL frame exceeds byte limit`になる。これはI/Oなしの互換性回帰であり、このcleanupで容量は修正していない。
実Piの入力echoも容量評価の論点だが、今回の実行対象ではない。
タイマー、CLI / Modの配線、実Piでのscheduler受入は未実装・未実施。

## 削除したcoverage

旧suiteをunit testと呼び替えたり、case数維持のための偽TCP/Pi基盤を追加したりはしていない。
現在のunit結果は次のcoverageを代替しない。

- 実TCP codecの分割UTF-8、切断・timeout・framing・要求相関と再送拒否。
- 認証bridgeのrole・ready・両bind ACK、状態snapshotの形式・frame境界、scope隔離、チャット受付。
- ビルド済みCLIの引数・signal・終了処理、接続情報公開、POSIX mode・symlink/hardlink・差替え拒否。
- SQLiteの再open、migration拒否、履歴・hook永続化、ページング、連番欠損とscope別検索・照合。
- 実stdio偽Piのversion/metadata gate、ACK/settled/abort、EOF・timeout・SIGKILLと子の終了確認。
- 隔離sessionのprivate設定・会話再開・lease、保存先のfilesystem安全性、実取消と終了順。
- 実Pi・偽HTTP provider・偽gameでの7 Tool、context注入、driver/sessionの接続。

schema/catalogの純粋な検証は残したが、保存・検索・hook登録との結合ケースは除去した。
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
今回Gradleは実行しておらず、上のTypeScript 65件には含めない。

observerはclient initializerに未登録で、ゲーム内callbackの発火確認ではない。
Minecraftの起動、EULA同意、既存ワールドの利用も行っていない。[観測の契約と限界](<observations.md>)を参照。

## 接続実装で確定する事項

- アイテム破棄・入手、コンテナ閲覧などの正確な取得方法と必要最小限のMixin。
- 発見の記録基準、Mod環境の取得範囲、OS上の読取Toolの権限。
- Modが広告するイベント部分集合と、baseline以外の状態queryの取得範囲。
- ワールドUUIDの保存方法。Pi会話はprivateなworld / player別scopeで再開する。
- ポーリングはactive play中60秒が仮値。容量・要求timeout・frameサイズの妥当性は未確定。
  保留上限超過は明示エラーで停止し、黙示的破棄や永続inboxは導入しない。
- ランチャー環境の接続先読込と、CLI起動環境でのPiのPATH解決。

レシピ専用機構や目標管理state machineは作らない。
ゲームの静的ファイル参照と、生の状態・豊富なイベント履歴・拡張可能なhookを優先する。

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
