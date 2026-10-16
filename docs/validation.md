# 検証状況と未確定事項

## 検証済み事項

実装範囲と通常の開発コマンドは[開発資料](<development.md>)にまとめる。

### TypeScriptと永続化

`pnpm run verify`でformat、型検査付きlint、ESMビルド、実行境界のテストを確認した。

- ビルドしたCLIのヘルプ、未知の引数の拒否。
- hookなしでのイベント保存、SQLite再open後のイベント・hook復元。
- world / playerの隔離、hook削除と履歴保持、完全一致AND条件。
- 仮の新イベントを定義だけで追加して、保存・検索・照合する回帰テスト。
- boolean / number / null / 未設定の区別、未対応payload・filterの拒否。
- ページング上限、重複・逆順拒否、連番欠損とfilterをまたぐ欠損通知。
- 未対応のdatabase schema versionでの停止。

### ローカルTCP codec

[実TCPテスト](<../src/transport/rpcPeer.test.ts>)で次を確認した。CLI・Pi・Modの接続試験ではない。

- 双方向要求、順序が入れ替わる応答、通知の受信順。
- TCPで分割されたUTF-8、多フレーム同時受信、壊れたJSONへの明示エラー。
- 切断・timeoutでの未完了要求の失敗、副作用の自動再送がないこと。
- 途中EOF、フレーム上限、要求数上限、不明response ID、不正UTF-8の拒否。
- 不正notificationの後で後続観測を続行しないこと。
- 結果未返却や結果上限超過を空データの成功扱いにしないこと。

### 認証・binding bridge

[bridgeの実TCPテスト](<../src/bridge/directorBridge.test.ts>)で次を確認した。CLI・Mod・Piの配線試験ではない。

- token・role・version、認証前の操作、重複role、capabilityの制限。
- attach応答後の`game.ready`までrunを開始せず、game / agent両方のbind ACKを待つこと。
- raw保存後のhook照合、偽scopeの拒否、履歴・hookのscope隔離。
- pause後の即時拒否、無効化後もsettled確認までslotを保持すること。
- world交換後の遅い状態応答を破棄し、表示は`displayed: true`を要求すること。
- 起動と同時のcloseでlistenerを残さないこと。
- 16,000文字の指示を持つ70 hooksを最大8件ずつ列挙できること。

起動・終了競合と大量hook一覧は、失敗を再現してから修正した。

### 必須の現在状態snapshot

同じ[実TCPテスト](<../src/bridge/directorBridge.test.ts>)で[状態契約](<gameState.md>)を確認する。

- 空のstate、必須fieldの欠損、未対応version、不正型・件数を拒否する。
- 36 main slotと7 named equipmentを要求し、body slotの省略も許さない。
- 明示的な`biomeId: null`、不完全なblock coverage、entityの打切りflagは値を変えず返す。
- 未対応queryはModへ要求を転送する前に拒否する。
- 729 blocks / 64 entities、上限長の文字列、大きな数値を持つ応答を実TCPで返す。
  多バイト文字・JSON escape、最大長のbindingと`RpcPeer`が生成する短い10進数字列のrequest IDで1 MiB frame内と確認する。
  codec自体は任意長の文字列IDも許すが、それらを含む全応答のframe適合を保証するテストではない。

不完全なstateと未知のqueryを通してしまう**19件の失敗**を再現してから修正した。
これはschema・binding・frame境界の検証であり、Modのcollectorや実ゲームでの取得性能・正確性の検証ではない。

### bridge-only CLIの起動・終了

[packaged CLIのテスト](<../src/cli.test.ts>)はビルド成果物を実際の子プロセスとして起動する。
PiやModの代わりに、偽gameを認証付き実TCPで接続する。

- `--help`でstateを作らずPiを起動しないこと、通常起動で未実装のPiを黙って省略しないこと。
- privateな接続情報のfield、tokenの非ログ出力、`0700` / `0600`と所有UID。
- 実TCPの観測をSQLiteへ保存し、SIGINT / SIGTERM後も履歴が残ること。
- 同じ保存先の二重起動を拒否し、再起動ではtokenを更新すること。
- 既存の接続情報、directory symlink、unsafeなmode、SQLiteのsymlink・hardlinkを変更せず拒否すること。
- 接続情報をrenameまたはunlink / recreateで差し替えると、replacementを削除せずエラー終了すること。
- stdoutのpipeが起動表示前に閉じても、明示的に失敗し、接続情報とSQLiteの終了処理を行うこと。
- 未対応DB versionではversionを変えず、接続情報やtempを残さないこと。

閉じたstdout pipeの`EPIPE`がcleanupを迂回して接続情報・WAL・SHMを残す失敗を再現し、修正後の成功を確認した。
inodeを保持するfdはPOSIXの再利用規則に基づく対策で、ホスト上でのinode再利用自体は再現していない。
Windows、拡張ACL、電源断時の公開耐久性、敵対的な同UIDの操作は未検証。

### Fabricビルド

Minecraft 1.21.11 / Loader 0.19.5 / Fabric API 0.141.6+1.21.11を固定し、
Java 21 / Loom 1.17.21 / Gradle 9.7.1で`build`を確認した。
配布JARのclient-only metadata、entrypoint、Java 21 class formatも確認した。

13種類のobserverをコンパイルし、`observerTest`の純Java **93 assertions**が成功した。
共有fixtureのserialize、snapshot差分、プレイヤー別baseline、sample、reset、DTOの不変性・明示nullを確認する。
実行classpathからMinecraft / Fabricを除外していることも検証する。

observerはclient initializerに未登録で、ゲーム内callbackの発火確認ではない。
[観測の契約と限界](<observations.md>)を参照。
Minecraftを起動せず、EULAに同意せず、既存ワールドを使用していない。

### Piのローカル境界

`pnpm run verify:pi`はPATH上の実Pi **1.2.0**と、ローカルの偽providerを使う任意テスト。
3つの組込APIで4シナリオずつ、**12/12成功、全子プロセス終了コード0**を確認した。

- 明示的ESM拡張の読込、起動ACK、実行binding ACK。
- prompt前のmetadata確認、`handled` / `started`の区別、`agent_settled`までの完了待機。
- 各provider呼出し前の最新状態取得と、会話へ永続化しない注入。
- 必須状態取得に失敗した際のbinding無効化と同期abort、後続provider HTTPゼロ。
- 例外を投げるだけでは推論を止められない負例。

詳細・実行方法・保証の制限は[Pi境界検証](<piFeasibility.md>)を参照。
**production bundle、任意Pi version / provider、実モデル、実ゲームを検証したものではない。**

### Production Pi拡張

`pnpm run verify:pi:built`は、[production拡張](<../src/pi/directorBridge.ts>)をビルドして実Pi 1.2.0に読み込ませる。
[隣接するVitestテスト](<../src/pi/directorBridge.acceptance.test.mjs>)は認証付きTCP bridge、SQLite、偽game、loopback偽providerを使う。
開発依存のPiはAPI型の検査用で、実行時はPATHのPiを正確なバージョン検査後に使う。

3 physical APIすべてで7 Toolの実行、イベント検索、hook CRUD、scope注入の拒否、明示的な表示だけがgameへ届くことを確認する。
各モデル呼出しの直前にsnapshotを取得し直し、古い状態と一時contextが会話へ残らないこと、settled後の別runも検証する。
bootstrap不正と認証失敗はreadyにならず、後続promptでもモデル・gameを呼ばない。
必須状態の初回／Tool後の欠損、古いbinding、pause、detach、切断、timeoutは、abortして後続のモデル呼出し・表示を止める。
停止後に意図的に再送したpromptも、引退済み拡張は拒否する。

一時HOME・設定・会話・作業ディレクトリ、dummy keyと偽providerだけを使い、実モデルには接続しない。
これはビルドした拡張の接続検証であり、CLIのPi stdio driver・schedulerやFabric adapterの受け入れ完了ではない。

## 接続実装で確定する事項

- アイテム破棄・入手、コンテナ閲覧などの正確な取得方法と必要最小限のMixin。
- 発見の記録基準、Mod環境の取得範囲、OS上の読取Toolの権限。
- Modが実際に広告するイベント部分集合と、baseline以外の状態queryを追加する際の取得範囲。
- Pi会話の保存先・再開方法、ワールドUUIDの保存方法。履歴と接続情報の配置は確定済み。
- ポーリングはactive play中60秒を仮値とし、優先順位、要求タイムアウト、フレームサイズを接続検証で決める。
- ゲームのランチャー環境での接続先読込と、CLI起動環境でのPiのPATH解決。

レシピ専用機構や目標管理state machineは作らない。
ゲームの静的ファイル参照と、生の状態・豊富なイベント履歴・拡張可能なhookを優先する。

## 未実施の接続受入シナリオ

1. Mod接続後、`/ai`の入力がPiへ渡り、`send_message`だけがローカルHUDへ表示される。
2. `get_game_state`が実際の所持数を返す。
3. 定期判断がactive play中だけ起動し、pause・切断中は新しい判断を開始しない。
4. LLMがhookを登録し、イベントで起動し、Toolで削除できる。
5. Pi実行中の全イベントを保存し、hookの発火理由だけを次の判断へまとめられる。
6. 退出後、古いbindingの状態取得・表示・hook変更が新しいワールドへ届かない。
7. 切断・タイムアウトが明示的な失敗になり、不明な表示要求が自動再送されない。
8. 再起動後、同じworld / playerのPi会話・hook・履歴を再開し、別scopeとは混ざらない。

初版はローカルの1ゲーム接続を扱う。
遠隔接続、複数ゲーム対応、ModからのCLI自動起動、ゲーム操作の代行は含めない。
実モデルの料金が生じる試験や実ワールドでの受入れは、別途確認してから行う。

## 関連資料

- [コンセプトと基本方針](<concept.md>)
- [構成と責務](<architecture.md>)
- [ポーリングと応答hook](<scheduling.md>)
