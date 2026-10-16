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

[実TCPテスト](<../tests/rpcPeer.test.ts>)で次を確認した。CLI・Pi・Modの接続試験ではない。

- 双方向要求、順序が入れ替わる応答、通知の受信順。
- TCPで分割されたUTF-8、多フレーム同時受信、壊れたJSONへの明示エラー。
- 切断・timeoutでの未完了要求の失敗、副作用の自動再送がないこと。
- 途中EOF、フレーム上限、要求数上限、不明response ID、不正UTF-8の拒否。
- 不正notificationの後で後続観測を続行しないこと。
- 結果未返却や結果上限超過を空データの成功扱いにしないこと。

### Fabricビルド

Minecraft 1.21.11 / Loader 0.19.5 / Fabric API 0.141.6+1.21.11を固定し、
Java 21 / Loom 1.17.21 / Gradle 9.7.1で`build`を確認した。
配布JARのclient-only metadata、entrypoint、Java 21 class formatも確認した。

これは空のクライアント初期化処理を持つ基盤のビルド確認で、Java側のテストやゲーム起動確認ではない。
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

## 接続実装で確定する事項

- アイテム破棄・入手、コンテナ閲覧などの正確な取得方法と必要最小限のMixin。
- 発見の記録基準、Mod環境の取得範囲、OS上の読取Toolの権限。
- `get_game_state`のquery形式、Modが実際に広告するイベント部分集合。
- データ保存先、接続情報ファイルの配置、ワールドUUIDの保存方法。
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
