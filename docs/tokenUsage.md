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
| `stopReason` | Piが返した完了・打切り・エラー・取消などの理由 |
| `input` / `output` | providerが報告した入力・出力トークン数 |
| `cacheRead` / `cacheWrite` | providerが報告したキャッシュ読込・書込トークン数 |
| `total` | providerが報告した合計トークン数。未報告なら`null` |

カウンターは0以上の安全な整数、未報告の項目は`null`とする。報告された`0`と、未報告の`null`を区別する。
Piの正規化済み`usage`は欠損を0で補うため使わず、[API応答の抽出処理](<../src/pi/tokenUsage.ts>)で生のstreamイベントから必要な数値だけを保持する。
文字数からの推計や、欠損した合計の補完は行わない。

入力のキャッシュ計上方法はproviderの定義を維持する。OpenAIの`input_tokens` / `prompt_tokens`はキャッシュ分を含むため、
`input + output + cacheRead + cacheWrite`を合計として足し直さない。Anthropicの入力はキャッシュ分を含まない。
Anthropicは合計fieldを報告しないため`total`は`null`になる。出力に含まれるreasoning分も二重加算しない。

## 記録のタイミングと限界

- runはassistantの`message_end`で1件保存する。Tool後の再判断やPiの再試行は、それぞれ別の応答として記録する。
  `turn_end`・`agent_end`やconversation再開時の履歴を再集計しない。
- summaryは独立したモデル呼出しの完了時に、本文の検証・取消判定より先に保存する。
  打切り・不正な本文・取消によってsummary自体を採用しなくても、取得済みの使用量は残す。
- 取消後も元の要求slotが残っている間は、そのworld / player / sessionへ記録する。新しいsessionへ付け替えない。
- APIがusageを返さない失敗やモデル呼出し前の失敗では、未知の項目を`null`で記録する。
  その行だけで、providerへの送信や課金が発生したとは断定できない。
- 記録単位はPiの論理的なモデル応答であり、provider内部のHTTPリトライ1回ごとの課金台帳ではない。
  切断・強制終了などで応答や保存に到達しなかった呼出しは記録できない。providerの請求明細との完全一致は保証しない。
- 通常の退出・CLI終了ではsummaryへ取消を通知し、使用量の保存応答まで待ってからPi接続を閉じる。
  providerが取消に応答しない場合は、モデル要求の既存期限（最大5分）まで終了を待つことがある。
- 保存失敗はfatalとして扱い、保存成功のACKを返さずPi拡張を停止する。自動再送はしない。
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

[bridgeテスト](<../src/bridge/bridgeServer.test.ts>)で拡張からhostへの呼出し、取消・失敗・要求scope・保存失敗を検証する。
[storageテスト](<../src/storage/activityLog.test.ts>)はin-memory SQLiteで保存・検索・既存レコードとschema versionの維持を確認する。
[抽出テスト](<../src/pi/tokenUsage.test.ts>)は3種類のphysical API、欠損と明示0、累積カウンターと不正値を確認する。
実ゲーム・実providerの課金明細との照合は未実施。
