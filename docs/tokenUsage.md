# トークン使用量の記録

通常runと独立summaryのモデル応答ごとに、APIが報告した使用量を自動保存する。追加の起動オプションは不要。
費用換算や集計画面は提供しない。

## 保存先と記録内容

保存先は既定のデータディレクトリにある`~/.mc-hisyo/activityLog.sqlite`。
`--data-dir PATH`を指定した場合は、そのディレクトリの`activityLog.sqlite`を使用する。
既存のactivity logの`activities`テーブルへ`hisyo.token_usage`を追加する方式で、DBの追加や既存schemaの移行は行わない。
既存レコードは残し、導入前の使用量は復元しない。

共通のactivity envelopeへ`worldId`、`playerId`、`sessionId`と、保存時のUnixミリ秒`recordedAt`を記録する。
`data`には次の項目を保存する。[要求schema](<../src/protocol/tokenUsage.ts>)を正とする。

| 項目 | 内容 |
| --- | --- |
| `source` | 通常判断は`run`、独立要約は`summary` |
| `requestId` | runでは元の`runId`、summaryでは独立要求のID。同じrun内の複数応答は別のactivity行になる |
| `provider` / `model` / `api` | 使用provider、応答model（分かる場合）とphysical API |
| `stopReason` | SDKのモデル応答が返した完了・打切り・エラー・取消などの理由 |
| `input` / `output` | providerが報告した入力・出力トークン数 |
| `cacheRead` / `cacheWrite` | providerが報告したキャッシュ読込・書込トークン数 |
| `total` | providerが報告した合計トークン数。未報告なら`null` |

カウンターは0以上の安全な整数、未報告の項目は`null`とする。報告された`0`と、未報告の`null`を区別する。
SDKの正規化済み`usage`は欠損を0で補うため使わず、[TokenUsageTracker](<../src/pi/tokenUsage.ts>)と
mainとsummaryで共有する[trackModelRequest](<../src/runtime/trackModelRequest.ts>)の`onProviderStreamEvent`で、生のproviderイベントから必要な数値だけを保持する。
文字数からの推計や、欠損した合計の補完は行わない。

入力のキャッシュ計上方法はproviderの定義を維持する。OpenAIの`input_tokens` / `prompt_tokens`はキャッシュ分を含むため、
`input + output + cacheRead + cacheWrite`を合計として足し直さない。Anthropicの入力はキャッシュ分を含まない。
Anthropicは合計fieldを報告しないため`total`は`null`になる。出力に含まれるreasoning分も二重加算しない。

## 記録のタイミングと限界

- mainはtrackedなモデル呼出しの`finally`で1件保存する。Tool後の再判断は別の応答であり、別行になる。
  conversation再openで保存済み履歴を再集計しない。mainのgeneration retryと自動compactionは無効にしている。
- summaryも同じtracked経路を通り、本文の検証・取消判定より先にusageを保存する。
  打切り・不正本文・取消でsummaryを採用しなくても、取得済みの使用量は残す。
- hostの`beginModelRequest` / `recordUsage` / `finishModelRequest`はsource・元session・request IDを照合する。
  取消・detach後も進行中要求の所有権を保持し、新しいsessionへusageを付け替えない。
- tracked経路に入った後のAPI失敗でusageが得られなければ未知項目を`null`にする。
  必須context取得など、その経路より前に拒否した要求にはusage行がない。どちらも送信や課金の証明ではない。
- 記録単位はSDKの論理的なモデル呼出しであり、provider内部のHTTP試行ごとの課金台帳ではない。
  crashや保存失敗で記録に到達しない呼出しもあり、provider請求明細との完全一致やexactly-onceを保証しない。
- 通常終了ではモデル処理と遅いusage記録を待ってからbridge・activity DBを閉じる。
  要求の取消には最大5分のモデル期限があるが、取消を無視する外部処理などでcloseが直ちに終わる保証はない。
- 保存失敗はfatalとして扱い、成功扱いにせずruntimeを止める。自動再送はしない。
- このusageレコードへプロンプト、応答本文、生のstreamイベント、エラーメッセージ、認証情報は保存しない。
  同じactivity logの別イベントには、従来どおりチャット入力などが含まれる。

## SQLiteで確認する

次の例はDBをread-onlyで開き、直近20件を表示する。保存先を変更している場合はpathを置き換える。

```bash
sqlite3 -readonly -header -column "$HOME/.mc-hisyo/activityLog.sqlite" <<'SQL'
SELECT id,
       datetime(recorded_at / 1000.0, 'unixepoch') AS recorded_at_utc,
       world_id, player_id, session_id,
       json_extract(activity_json, '$.data.source') AS source,
       json_extract(activity_json, '$.data.model') AS model,
       json_extract(activity_json, '$.data.input') AS input_tokens,
       json_extract(activity_json, '$.data.output') AS output_tokens,
       json_extract(activity_json, '$.data.cacheRead') AS cache_read_tokens,
       json_extract(activity_json, '$.data.cacheWrite') AS cache_write_tokens,
       json_extract(activity_json, '$.data.total') AS total_tokens
FROM activities
WHERE event = 'hisyo.token_usage'
ORDER BY id DESC LIMIT 20;
SQL
```

SQLite CLIの通常表示ではSQLの`NULL`は空欄になる。0への置換はしない。
既存の`search_events` Toolでも`event: "hisyo.token_usage"`を明示すると、現在のworld / playerの記録を検索できる。
たとえば`filter: { source: "summary", total: null }`で、summaryの合計未報告レコードを取得する。
usageはCLIの事実であり、hook対象にはできない。

## 検証範囲

[bridgeテスト](<../src/bridge/bridgeServer.test.ts>)は直接host API、取消後の所有権、要求scope、保存失敗を確認する。
[DurableAgentテスト](<../src/runtime/durableAgent.test.ts>)は実SDK / fake provider / temp SQLiteと、実TCP bridgeを組み合わせた取消後の遅いusage保存を確認する。
[summary runtimeテスト](<../src/runtime/summaryRuntime.test.ts>)は単発API生成と実TCP bridge / SQLiteで、切断後の元scopeへのusage保存と、終了時にモデル・DBを閉じる前の完了待ちを確認する。
[storageテスト](<../src/storage/activityLog.test.ts>)はin-memory SQLiteで保存・検索・既存レコードとschema versionを確認する。
[抽出テスト](<../src/pi/tokenUsage.test.ts>)は3種類のphysical API、欠損と明示0、累積counterと不正値を確認する。
本体のモデルは固定OpenAIで、抽出処理の他API対応をモデル選択機能と混同しない。
実ゲーム・実providerの課金明細との照合は未実施。

## 一次資料

- [Pi AI 1.3.0のprovider stream観測](<https://github.com/earendil-works/pi/blob/v1.3.0/packages/ai/README.md#observing-provider-stream-events>)
