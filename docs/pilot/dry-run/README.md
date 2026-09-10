# Dry run: 10テストアカウント×3日

> [#168](https://github.com/jbjgjf/BLESC/issues/168) / 版 `dry-run-v1`
> **実在の高校生は使わない。** 訓練された成人スタッフと合成本文だけで全導線を通す。

## 3日という期間に意味がある

1日に圧縮しない。日を跨ぐことでしか出ない失敗を見るための3日である。

- 前日の記録の持ち越し、日付の切り替わり
- 欠測（書かない日）が欠測として扱われるか
- 連続提出と、その間の状態遷移
- 運用の引き継ぎ（担当者が変わっても手順が通るか）

## 使うもの

| ファイル | 役割 |
| --- | --- |
| [scenario-matrix.json](scenario-matrix.json) | 10アカウントの割当。**正本** |
| [`sentra/supabase/seed/pilot_dry_run.seed.sql`](../../../sentra/supabase/seed/pilot_dry_run.seed.sql) | study・招待・アカウント・合成本文の投入 |
| [`sentra/frontend/scripts/dry-run-smoke.mjs`](../../../sentra/frontend/scripts/dry-run-smoke.mjs) | matrixの検証と実行計画の出力 |
| [`sentra/supabase/scripts/dry_run_reconciliation.sql`](../../../sentra/supabase/scripts/dry_run_reconciliation.sql) | 13本の照合クエリ |
| [evidence-template.md](evidence-template.md) | 記録の様式。**Discussion #137 へ貼る** |

matrix・seed・runnerが食い違わないことは `sentra/frontend/tests/dry-run-matrix.test.mjs` が検査する。

## 手順

### 準備（day 0 の前）

```bash
# 1. matrixが実行可能であることを確認（環境不要）
cd sentra/frontend && node scripts/dry-run-smoke.mjs --plan

# 2. migrationとRLSの検査
cd ../.. && cd sentra && ./supabase/scripts/migration_smoke.sh

# 3. dry-run用のデータを投入（パイロット環境またはlocal）
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seed/pilot_dry_run.seed.sql
```

**deployment SHAを固定して記録する。** 途中でデプロイしない。デプロイしたら、その時点でdry runは最初からやり直す。

### day 0

code発行、登録、説明、assent/consent、権限分離。matrixの `expected_terminal_state` に到達したかを確認する。

### day 1

正常提出と固定自己評定。**AI endpointへの呼び出しが0であること**を、アプリのログではなく外部通信の記録で確認する。DB件数を照合クエリ1で突き合わせる。

### day 2

offline / retry / duplicate / 別userアクセス / 撤回 / 欠測。照合クエリ2〜8。

### day 3

export、PII review、retention/purge、backup/restore、incident tabletop、復旧。照合クエリ9〜13。

## 招待コード

seedはコードをhashで保存する（本番と同じ規則）。平文は行番号から導ける。

```
DRYRUN-0001 .. DRYRUN-0010
```

3番は**期限切れ**、4番は `max_redemptions=1` で二重利用を試す。

## 自動化しないと決めたこと

| 項目 | 理由 |
| --- | --- |
| 3日を1プロセスに圧縮すること | 日跨ぎこそが検証対象。圧縮すると別のものを試すことになる |
| 危機的記述への対応（10番 day 2） | 提出は自動化できるが、その先は人の手順である。所要時間を測ることが目的 |
| Go/No-Goの署名 | 研究責任者・データ管理責任者・運用責任者の3名が人として署名する |
| セッションの作成 | runnerは資格情報を持たない。実行者自身のsign-inから渡す |

`dry-run-smoke.mjs` は `--base-url` を渡しても、`DRY_RUN_ACCESS_TOKENS` なしでは実行を拒否して終了する。**動くように見えて何もしないより、拒否して止まるほうがよい。**

## 失敗したとき

[#168](https://github.com/jbjgjf/BLESC/issues/168) を閉じない。再現手順つきの修正Issueを作り、No-Goとして記録する。

**実在の高校生で失敗箇所を試さない。** 直してから、dry runをやり直す。
