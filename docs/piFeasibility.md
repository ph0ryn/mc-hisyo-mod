# Pi 1.2.0のローカル境界検証

## 目的と実行方法

PATH上の実Piを使い、明示的ESM拡張の読込と、必須の最新状態を取得できない場合の停止を確認する任意テスト。
通常の単体テストとは分離し、実モデル・有料API・Minecraftには接続しない。

プロジェクト指定のNode.jsとPi **1.2.0**を用意し、リポジトリ直下で実行する。
Piの別バージョン、未検証API、不明なシナリオは拒否する。

```bash
node tests/pi/runProbe.mjs

# APIとシナリオを限定する場合
PI_PROBE_APIS=anthropic-messages node tests/pi/runProbe.mjs abort-first abort-second
```

実行時には、OSの一時ディレクトリに`mkdtempSync`で毎回新しい領域を作る。
最後の`RESULTS`行に集約結果への絶対パスを出力し、シナリオ別に起動引数・RPC・HTTP・終了コードも残す。
証跡はリポジトリに生成せず、自動削除もしない。
Piへ渡す隣接したESM拡張の場所は`import.meta.url`から解決する。

## 隔離と前提条件

- providerは`127.0.0.1`の偽HTTP/SSEサービス、モデルとAPIキーはダミーに固定する。
- HOME・Pi設定・セッション・作業ディレクトリを一時領域に隔離し、実providerの認証環境変数を子プロセスへ渡さない。
- 自動extensions・MCP・skills・templates・themes・context filesを無効化し、空のappend promptと専用system promptを渡す。
- 公開Toolはローカルの`send_message`スタブだけ。OSコマンド実行、実ゲーム操作、実ファイル読取権限の検証は含まない。
- ユーザーの認証ファイル・通常設定を調査、変更しない。インストール済みPiも変更しない。

Director所有の隔離設定では、次を明示する。

```json
{
  "compaction": { "enabled": false },
  "cacheWarming": "off"
}
```

起動ACK後、promptを送る前に`get_state`でモデルの`api`、`medium`、`autoCompactionEnabled: false`を照合する。
対応thinking levelも取得して確認する。cache warmingは独立したprovider要求を起こし得るため、無効化が前提となる。

## 検証結果

Pi 1.2.0の`openai-completions`、`openai-responses`、`anthropic-messages`で同じ4シナリオを実行し、**12/12成功、全Pi子プロセスの終了コード0**を確認した。
下表は各APIで得た件数。

| シナリオ | 状態取得 | provider HTTP合計 | 発言スタブの副作用 | 状態取得失敗後のprovider HTTP | settled |
| --- | ---: | ---: | ---: | ---: | --- |
| 正常系 | 2 | 2 | 1 | 対象外 | `aborted: false` |
| 例外を投げるだけの負例 | 2 | 2 | 1 | 2 | `aborted: false` |
| 初回状態取得失敗＋abort | 1 | **0** | **0** | **0** | `aborted: true` |
| Tool後の状態取得失敗＋abort | 2 | 1 | 1（失敗前に完了） | **0** | `aborted: true` |

abortする試験では、失敗時にhostと拡張の実行bindingを無効化してから`ctx.abort()`する。
AbortSignalが同期的に中断され、古いbindingの副作用ガードがbridge HTTPの前で拒否することも確認する。
これは同じガードを直接呼ぶ負例であり、abort後にモデルが実際のTool呼出しを始めたという意味ではない。
既に着手・完了した表示をabortで取り消す保証はない。

開始ACK・binding ACKの順序、`handled`と`started`の区別、prompt前の完了購読、`agent_end`より後の`agent_settled`も確認する。
後続判断とqueueが残らず、最新状態は呼出しごとに更新されて会話履歴へ永続化されないことを検証する。

## 保証の境界と停止条件

**任意providerに通用する保証ではない。** 調査したPi 1.2.0では、`context`と`before_provider_request`の例外は握りつぶされる。
共通agent loopにもcontext処理後の一律abort再確認がなく、stream関数には到達し得る。
今回のゼロHTTPは、OpenAI SDKの送信前AbortSignal確認と、Anthropic実装の送信前`throwIfAborted()`を通る3 APIに限定した観測結果である。

実装側は**Pi 1.2.0と上記APIの許可リストをprompt前に照合**し、不明な値なら子プロセスを終了して停止する。黙示的なfallbackは禁止する。
既知API名でも外部拡張がstream実装を差し替えれば同じ保証にはならないため、既知の明示拡張以外は読み込ませない。
実行中のモデル変更は許さず、次の判断前にもmetadataを再確認する。

この試験は**生の明示的`.mjs`拡張**を検証するもので、production bridgeやVite生成bundleの読込確認ではない。
自動compaction・cache warmingの実動作、手動要約、OAuth・認証更新、再試行や切断の競合、実モデルの性能、Minecraftでの受入れは未検証である。
無効化・隔離・API制限を満たせない場合は、古い状態での推論を許さず、この段階で停止する。
