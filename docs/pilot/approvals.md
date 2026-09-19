# 承認欄

> 2026-09-18監査: **開始条件未充足・募集不可**。
> [監査記録と残作業](readiness-audit-2026-09-18.md)を参照。未決定事項や署名は担当者自身が記録する。

> この文書一式は、下の3つの承認がすべて揃うまで **`draft`** である。
> 承認がない状態で `pilot_studies.status` を `recruiting` にしない。

## 承認

| 役割 | 氏名 | 承認した版 | 日付 | 署名／記録 |
| --- | --- | --- | --- | --- |
| 研究倫理責任者 | | | | |
| 学校責任者 | | | | |
| データ管理責任者 | | | | |

承認した版は、protocol（`pilot-protocol-v1`）と同意文書（`research-consent-doc-v1`）の**両方**を書く。片方だけ承認された状態は存在しない。

## 承認の前に埋まっている必要がある未決定事項

| # | 事項 | 決定者 | 出典 | 状態 |
| --- | --- | --- | --- | --- |
| D1 | 支援を受けている生徒の除外可否 | 研究倫理責任者・学校責任者 | [protocol §2](protocol.md) | 未決定 |
| D2 | 相談接触の項目を入れるか | 研究倫理責任者 | [protocol §4.1](protocol.md) | 未決定 |
| D3 | リマインダー通知の有無と頻度 | 研究責任者・学校責任者 | [protocol §4.2](protocol.md) | 未決定 |
| D4 | 危機的記述のレビュー頻度と体制 | 学校責任者・研究責任者 | [protocol §4.4](protocol.md) | 未決定 |
| D5 | データ保持期間と削除の証跡 | データ管理責任者・研究倫理責任者 | [protocol §8](protocol.md) | 未決定 |
| D6 | 謝礼の有無と形式 | 学校責任者・研究責任者 | [protocol §9](protocol.md) | 未決定 |
| D7 | 研究終了後の結果共有の方法 | 研究責任者 | [protocol §7.3](protocol.md) | 未決定 |
| C1 | 問い合わせ先 | 研究責任者・学校責任者 | [consent-pack §A/§C](consent-pack.md)、2026-09-18 owner指定 | 部分決定: blesc.jp@gmail.com。担当受諾・受付時間・学校確認待ち |
| C2 | 本文の保持期間 | データ管理責任者 | [consent-pack §A/§C](consent-pack.md) | 未決定 |
| C3 | 保護者確認の方法 | 学校責任者 | [consent-pack §D](consent-pack.md) | 未決定 |
| C4 | 保護者からの撤回・削除の受付経路 | 学校責任者・データ管理責任者 | [consent-pack §E/§F](consent-pack.md) | 未決定 |
| C5 | 削除完了までの目標日数 | データ管理責任者 | [consent-pack §F](consent-pack.md) | 未決定 |
| C6 | 謝礼を説明文へ記載するか | 学校責任者・研究責任者 | [consent-pack §A](consent-pack.md) | 未決定 |
| I1 | 連絡体制（4役割＋校内相談体制の連絡先） | 研究責任者・学校責任者 | [incident-runbook §1](incident-runbook.md) | 未決定 |

**この表に「未決定」が1つでも残っている限り、承認欄に署名しない。** 空欄のまま承認すると、実装側は空欄を推測で埋めるしかなくなり、推測が仕様になる。

## 実装がまだ揃っていない項目

承認とは別に、次はコードが未実装である（[field-mapping.md](field-mapping.md) と [data-dictionary.json](data-dictionary.json) の `implementation` を参照）。

- `support_contact`（誰かに相談できたか）。**これは「作っていない」ではなく「採用するか決めていない」。**
  質問すること自体が相談を促す介入になりうるため、採用の可否が先。決定者は研究倫理責任者。
- `compose_duration_ms`（書くのにかかった時間）。**この名前のものはコードに存在しない。**
  近いのは `total_duration_ms`（画面を開いてから提出までの経過）だが、これは入力時間ではなく
  「開いたまま放置した時間」を含む。同じものとして扱うか別に測るかが先。
- `field_order`（入力した順番）。収集面（生徒の `/journal`）では出していない。
  研究コンソールだけが出しており、パイロットが集めるのは前者。収集面にも要るかが先。

**未実装のまま募集を開始しない。** 承認済みのprotocolと、実装されている収集項目が食い違っている状態は、同意した内容と実際に集めるものが違うということである。

### 解消済み（2026-09-18 に実装を確認）

この節は以前、次の3件を未実装として挙げていた。いずれも実際には実装済みで、
**承認者が読む文書のほうが現状より遅れていた。** 最後のものは、
「どの参加者のデータも学習に使えない」と書いていた点で危険な向きに誤っていた。

| 項目 | 実体 |
| --- | --- |
| 日次固定自己評定の5項目 | 実装済み。`public.pilot_self_reports`（migration `20260909020000`）と `src/lib/pilotSelfReport.ts`。尺度のCHECK制約もDB側にある |
| 相対日のexport変換 | 実装済み。export上の名前は `day_index`。**ただし定義がずれていた** — 辞書は「登録日を0とした相対日」としていたが、実装は収集期間の初日を1とする1起点。辞書側を実装に合わせた |
| study phase のexport変換 | **今回実装した。** `ResearchRow.study_phase`。境界は `pilot_studies.baseline_days` / `observation_days` から導出する |
| 学習利用の別opt-in | 実装済み。ただし**DBの列名は `future_fine_tuning`** で、辞書の `model_training_use` と一致していない（下記） |

### DECISION REQUIRED: 学習利用フラグの名前

同じものが2つの名前を持っている。

- DB・UI・export: `future_fine_tuning`（`public.consent_records.future_fine_tuning`、17ファイル）
- データ辞書: `model_training_use`（この文書と `data-dictionary.json` のみ）

**同意画面が生徒に見せている文言は「将来のモデルの学習に使うことに同意します」**であり、
fine-tuning という特定の手法には一言も触れていない。つまり `future_fine_tuning` は
**実際に取った同意より狭い名前**で、列名を同意の範囲だと読んだ人は範囲を取り違える。
名前としては `model_training_use` が正しい。

一方で改名は `consent_records`（＝人が下した決定の記録）の列名変更と、
`pilot_guardian_verifications.requested_grants` に入っているJSONのキー書き換えを伴う。
**募集開始後にやると、同意記録を書き換えることになる。やるなら募集前。**

**決定者: 研究倫理責任者。**
