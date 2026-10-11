# Stage 3 関係別アテンションの学習：事前登録（草案）

- **状態:** 草案。凍結していない。**モデルは学習していない。** 学習のコード、重みの推定、実データを読む経路は、このリポジトリに無い。
- **Issue:** #100（epic #102 の Stage 3）。依存: #95（参加者の時間グラフ）、#96（決定論的な関係別の探索）、#88（人手ラベルのベンチマーク）、#90（事前登録）、実データの充足。
- **版:** `stage3-prereg-draft-0`（`app/ontology/learning_gates.py` の `STAGE3_PREREGISTRATION.version` と一致させる）
- **判定コード:** `evaluate_stage3_entry_gate()`（同ファイル）。下の項目表と `STAGE3_PREREGISTRATION.items` は `tests/test_learning_gates.py` が突き合わせる。

## この文書が固定するもの・固定しないもの

[Stage 2 の事前登録](stage2_partial_pooling_preregistration.md) と同じ方針である。固定するのは **#100 の受入基準と #102 の不変条件がすでに決めていること**だけ。仮説、反証条件、指標、閾値は下の表に「未決定」で残す。#90 の事前登録（`docs/benchmark_preregistration.md`）が示したとおり、結果を見た後に決めた基準は事前登録にならない。

対象は HGT / R-GCN / GAT 系の、ノード型と関係型で集約が変わる異種グラフのメッセージパッシングである。Graph RAG で使っている固定の大域重み（`analytics/graph_index.DEFAULT_WEIGHTS`）とは別物であり、それを学習済みのアテンションと呼ばない。

## Entry Gate と判定コード

#100 本文の Entry Gate 3条件と依存を、判定コードの `condition` に対応させる。いま（2026-10-11）はすべて満たされておらず、ゲートは閉じている。

| Entry Gate の条件（#100 本文） | `condition` | 閉じているときのコード | 現状 |
| --- | --- | --- | --- |
| 時間グラフの契約と決定論的な関係別の基準が安定している | `deterministic_baseline_stable` | `deterministic_baseline_not_pinned`, `deterministic_baseline_changed_since_pinned` | 閉。版は存在するが、比較に固定する版を誰も宣言していない |
| 学習データの量が、文書化された充足ゲートを通る | `training_data_sufficient` | `observation_requirement_undecided`, `requirement_exceeds_design`, `no_observed_data`, `not_real_consented_data`, `too_few_participants`, `effective_sample_below_requirement`, `too_few_edges_per_relation_type` ほか | 閉。閾値は未決定、実データは無い |
| ラベルの質が、文書化された充足ゲートを通る | `label_quality_sufficient` | `label_requirement_undecided`, `too_few_human_labelled_cases`, `inter_rater_agreement_unmeasured`, `inter_rater_agreement_below_requirement` | 閉。人手ラベル 0件、一致度は未測定 |
| #90 型の事前登録が仮説と反証の結果を定めている | `hypothesis_and_falsification_preregistered` | `hypothesis_undecided`, `falsification_undecided` | 閉 |
| 実データを使うことの承認（依存「Real data sufficiency for any non-synthetic claim」） | `governance_approval` | `governance_approval_missing`, `governance_approval_out_of_scope` | 閉 |
| 上記以外の事前登録項目と凍結 | `preregistration` | `preregistration_incomplete`, `preregistration_not_frozen` | 閉 |

ゲートが閉じている間、経路を返す出力は #96 の決定論的な探索だけである（`fallback = deterministic_traversal`）。

**いまある決定論的な基準の版**（`current_baseline_versions()`）: `participant-temporal-graph-v1`、`relation-rules-v1`、`relation-aware-traversal-v1`。#95 と #96 は GitHub 上で CLOSED である。ただし「安定した」は宣言であって、閉じた Issue から自動で導けない。比較に使う版を S3-04 で固定し、コードの版がその後に変わったらゲートは `deterministic_baseline_changed_since_pinned` で閉じる。

**人手ラベルの現状**（2026-10-11、`benchmark_cases.CASE_COMPOSITION`）: 82件のうち `draft` 76件、`author` 6件、`human` **0件**。#88 は GitHub 上で CLOSED だが、ラベルそのものはまだ無い。人手ラベル付けの手順は `docs/benchmark_labelling_runbook.md` にある。

## 研究設計の前提（#315 / PR #328）

[Stage 2 の文書](stage2_partial_pooling_preregistration.md) の「研究設計の前提」と同じである。50名 × 28日、1日1件、最大 1,400件。PR #328 の内容で、main には未反映。ρ = 0.5 なら実効サンプル数は約97。

Stage 3 に特有の点:

- **関係型ごとにパラメータを持つので、関係型ごとにデータが要る。** 関係は6種（`causes`, `escalates`, `buffers`, `avoids`, `co_occurs`, `precedes`）。少ない型ほど推定が不安定になる。必要な辺の数は S3-12 で決め、`too_few_edges_per_relation_type` で判定する。
- **パイロットの日本語の記録と、ベンチマークの日英対の差。** ベンチマークは ja 41件 / en 41件である。パイロットの記録はほぼ日本語になる見込みである。言語別の報告と判定は S3-06 で決める。

## 確定事項（Issue と epic が決めていること）

1. **比較対象:** キーワード、決定論的な探索（#96）、関係を区別しない GNN、型・出所を外した ablation（#100 受入基準）。どの ablation をどう組むかは S3-05。
2. **教職員向けの出力:** 根拠の観測経路が無い出力は、教職員向けに使わない（#100 受入基準、#102）。実装は `app/ontology/educator_exposure.py`。学習した出力は、経路があっても Stage 3 のゲートが閉じている間は出さない。
3. **参加者からのオンライン学習はしない**（#100 受入基準）。
4. **生の注意重みは、検証済みの説明ではない。** モデルの内部量として調べられる形で残す（#100 受入基準、#102）。帰属の質は、人手ラベルの根拠経路に対して別に評価する（S3-11）。
5. **モデルの入力はノード型・関係型・方向・時刻・出所を保つ**（#100 受入基準）。`TemporalNode` / `TemporalEdge` にすべてある。
6. **報告するもの:** held-out の性能、較正、seed による分散、言語別の結果、失敗ファミリー（#100 受入基準）。基準は S3-03、S3-06〜S3-10 で決める。
7. **データの閾値と、なぜいまのリポジトリが満たさないかを文書に書く**（#100 受入基準）。この文書の「Entry Gate と判定コード」と「ゲートが開くために揃う必要があるもの」がそれである。
8. **ゲートが開くまで学習しない。**

## 事前登録の項目

`key` は `STAGE3_PREREGISTRATION.items` の `key` と一致する。

| ID | `key` | 項目 | 状態 |
| --- | --- | --- | --- |
| S3-01 | `hypothesis` | 仮説 | 未決定 |
| S3-02 | `falsification` | 反証条件 | 未決定 |
| S3-03 | `primary_metric` | 主要評価指標 | 未決定 |
| S3-04 | `baseline_versions` | 比較に固定する決定論的基準の版 | 未決定 |
| S3-05 | `ablations` | ablation の組 | 未決定 |
| S3-06 | `per_language_reporting` | 言語別の報告と判定 | 未決定 |
| S3-07 | `train_split` | 版付きの学習分割 | 未決定 |
| S3-08 | `seeds` | seed の数と分散の報告 | 未決定 |
| S3-09 | `calibration` | 較正の基準 | 未決定 |
| S3-10 | `failure_families` | 失敗ファミリー | 未決定 |
| S3-11 | `attribution_evaluation` | 帰属の評価 | 未決定 |
| S3-12 | `required_observations` | 必要な観測量 | 未決定 |
| S3-13 | `label_requirement` | 人手ラベルの量と一致度 | 未決定 |
| S3-14 | `consent_scope` | 必要な同意の範囲 | 未決定 |
| S3-15 | `governance_body` | 承認の主体と記録の置き場所 | 未決定 |
| S3-16 | `comparators` | 比較対象 | 決定済み: キーワード、#96 の決定論的探索、関係を区別しない GNN、型・出所の ablation（#100 受入基準） |
| S3-17 | `educator_exposure` | 教職員向けの出力 | 決定済み: 根拠の観測経路が無い出力は出さない（#100 受入基準、#102） |
| S3-18 | `online_learning` | 参加者からのオンライン学習 | 決定済み: しない（#100 受入基準） |
| S3-19 | `attention_as_explanation` | 注意重みの扱い | 決定済み: 内部量であり、検証済みの説明ではない（#100 受入基準、#102） |

### 各項目で決めること

問いであって、答えではない。

- **S3-01 仮説。** 関係型ごとの学習が、何に対して、何を、どれだけ改善すると主張するか。#90 の仮説（「キュレーションした概念グラフをたどる検索は、複数日にまたがる根拠を語彙一致の検索より正確に拾い、その差は日本語と英語の両方で出る」）との関係。
- **S3-02 反証条件。** 何が出たら仮説を棄却するか。数値で書く。例えば「#96 の決定論的探索を、主要指標の区間の下限で上回らない」をどう定義するか。言語ごとに成り立つ必要があるか。
- **S3-03 主要評価指標。** nDCG@k などの指標と k。副次指標の扱い。
- **S3-04 比較に固定する決定論的基準の版。** `name=version` を `;` で区切った文字列で `STAGE3_PREREGISTRATION` に書く（`learning_gates._baseline_reasons` の書式）。
- **S3-05 ablation の組。** 型、関係、方向、時刻、出所のどれを外した版を作るか。
- **S3-06 言語別の報告と判定。** ja / en を別に報告するのは確定。合否も言語ごとに出すか。パイロットのデータが日本語に偏ることをどう扱うか。
- **S3-07 版付きの学習分割。** 参加者単位で分けること。ベンチマークの `split` と実データの分割の関係。
- **S3-08 seed。** 数と、分散の報告の仕方。
- **S3-09 較正。** 何を較正するか（スコア、確信度）と基準。標準誤差は実効サンプル数で計算する。
- **S3-10 失敗ファミリー。** ベンチマークのファミリー（`two_hop`, `vocab_disjoint`, `low_frequency`, `heavy_decoy`）を使うか、追加するか。
- **S3-11 帰属の評価。** 人手ラベルの根拠経路と、モデルが示す経路の一致をどう測るか。注意重みの大きさではなく、経路として評価する。
- **S3-12 必要な観測量。** 参加者数、1人あたりの日数、実効サンプル数、**関係型ごとの観測辺の数**の下限。`learning_gates.STAGE3_OBSERVATION_REQUIREMENT` に入れ、`decided_in` にこの文書の版を書く。
- **S3-13 人手ラベルの量と一致度。** 人手ラベルの付いたケースの下限、評価者間一致の統計量（kappa、alpha など）とその下限。`learning_gates.STAGE3_LABEL_REQUIREMENT` に入れる。#88 はケース数を 60〜100 とした。そのうち何件に人手ラベルが要るかは決まっていない。
- **S3-14 必要な同意の範囲。** 学習に使うなら `model_training_use` の同意が要るか。撤回の扱い。
- **S3-15 承認の主体と記録の置き場所。** Stage 2 と同じ問い。Stage 2 の承認は Stage 3 の承認にならない（段階と版で判定する）。

## ゲートが開くために揃う必要があるもの

| 必要なもの | 誰が用意するか | いまの状態 |
| --- | --- | --- |
| S3-01〜S3-15 の決定と、この文書のレビュー | 研究責任者、owner | 未着手 |
| 比較に固定する基準の版の宣言（S3-04） | 研究責任者 | 未宣言 |
| 人手ラベル（S3-13 の件数以上）と、評価者間一致の実測値 | 評価者（2名以上）、ラベル付けの担当 | 人手ラベル 0件、一致度は未測定 |
| `STAGE3_OBSERVATION_REQUIREMENT` と `STAGE3_LABEL_REQUIREMENT` の値 | 研究責任者（レビューを経た変更として） | 未決定 |
| この文書の凍結（実データを見る前） | 研究責任者 | 未凍結 |
| 分析の承認記録（段階 `stage3_relation_attention`、版を明記） | 倫理・ガバナンスの担当（S3-15） | 無い |
| 同意を得た参加者の、件数だけの集計（日数、関係型ごとの辺数、ρ の区間の上端） | 実データに正当にアクセスできる人 | 無い。パイロットは開始前 |

## 凍結記録

未記入。

## 改訂

- 2026-10-11 草案 `stage3-prereg-draft-0`。項目の構成と確定事項だけを書いた。値はすべて未決定。
