# チーム間の受け渡し仕様

[入口](README.md) / 版 `research-plan-v1`。以下は**提案するv0契約**。型定義、CLI、APIはまだ存在しない。T0がH6までに実行可能なschemaとfixtureとして固定する。

## 共通の約束

- モデルの学習処理は `sentra/backend/research_engine/` に新設予定。既存 `app/temporal` 等を再実装しない。
- 共通型とschemaはT0だけが `research_engine/contracts/` に書く。他チームは変更案を契約Issueへ返す。
- JSONのNaN/Infinityは禁止。欠測はnullとmaskで表す。配列には名前・順序・単位のschemaを必須とする。
- schema・特徴量・モデル・抽出器の版が合わなければ拒否する。次元が同じだけでは互換と判断しない。
- 時刻はtimezone付きISO 8601 UTC。日付を表示するときは元のtimezoneを使う。経過時間の単位はdays、1日は86,400秒。
- `occurred_at` は出来事の時刻、`recorded_at` は記録時刻、`available_at` は処理系で利用可能になった時刻。未知の出来事時刻はnull。オンライン入力は `available_at <= cutoff_at` のみ。
- 実参加者の本文・認証情報・再識別キーをGitHub、ログ、公開fixtureへ置かない。モデルの内部ベクトルも実データ由来ならアクセス制御対象。

## C1：T1 → 全チーム / ObservationBundle

保管単位はdataset manifestと行指向の観測ファイル。`event_id` は再取込しても同一、参加者はdataset内の不透明なキーで表す。

```json
{
  "schema_version": "observation-v0",
  "dataset_id": "synthetic-dev-v0",
  "participant_key": "synthetic-001",
  "event_id": "synthetic-001-event-01",
  "occurred_at": null,
  "recorded_at": "2026-09-01T12:00:00Z",
  "available_at": "2026-09-01T12:00:01Z",
  "timezone": "Asia/Tokyo",
  "feature_schema_id": "synthetic-features-v0",
  "feature_names": ["x1", "x2"],
  "units": ["simulation_unit", "simulation_unit"],
  "values": [0.2, null],
  "observed_mask": [true, false],
  "source_kind": "synthetic",
  "source_refs": ["generator-v0/seed-11/event-01"],
  "extractor_version": null,
  "consent_snapshot_id": null,
  "permitted_uses": ["synthetic_training", "synthetic_evaluation"]
}
```

`source_kind` は `synthetic | participant_observation | derived_extraction`。derivedの場合は抽出器版と元観測参照を必須とする。`observed_mask=false` の数値はnullを要求する。ある日記で言及されない概念を、本人に存在しないものへ変換しない。

manifest必須: `dataset_id, schema_version, feature_schema_id, file_hashes, split_id, split_assignment_ref, generation_or_collection_protocol, permitted_uses, created_at`。正規化の係数はtrainだけでfitし、`normalizer_id` とfit対象hashを保存する。

実データの `permitted_uses` はクライアントの自己申告を信用しない。取込・学習開始・結果アクセス時にT0の許可検証境界で照会する。Day 3は実データを拒否する。PR #138の未マージ機能が使えると仮定しない。

T1の予定関数: `load_observations(manifest, cutoff_at)`、`make_sequences(observations, split_manifest)`。重複eventを数え直さない。入力順を変えても同じ正規化済み系列を返す。

## C2：T2 → T3/T4 / EncodedSequence

必須フィールド: `dataset_id, split_id, participant_key, encoder_id, feature_schema_id, normalizer_id, cutoff_at, event_ids, available_times, delta_days, latent_dim, h_values, sequence_mask, quality_flags`。
`h_values` の形は `[time, latent_dim]`。空系列は空として扱い、ゼロベクトルの観測を捏造しない。`h_values` は時点ごとの履歴だけで作る。未来を使う別出力は `inference_mode=smoothing` としてオンライン予測から排除する。

予定関数: `fit_encoder(train, validation, config) -> EncoderArtifact`、`encode(bundle, artifact) -> EncodedSequence`。CLIから再読込できるcheckpoint、設定、入力schema、訓練データhash、使用seed、依存環境を同梱する。未学習encoderは `training_status=untrained`。

T2が合成の真の潜在状態を学習入力へ混ぜることは禁止する。生成器の真値はT5の評価領域に保持する。実測の補助回答を教師に使うときは、その用途と観測時点を宣言する。

## C3：T3 → T4/T5 / ForecastBundle

必須フィールド: `run_id, model_id, encoder_id, dataset_id, split_id, participant_key, cutoff_at, target_times, target_names, target_units, distribution_method, means, scales_or_samples, inference_mode, source_event_ids, capability_flags, status, reasons`。
`means` は `[horizon, target]`。`distribution_method` は `deterministic | gaussian_diag | empirical_samples` をv0で扱う。deterministicなら不確実性の数値を作らずnull。gaussian_diagなら同形の非負標準偏差を要求する。samplesなら `[sample, horizon, target]`。

予定関数: `fit_dynamics(encoded_train, targets_train, validation, config)`、`forecast(prefix, artifact, target_times)`、`rollout(state, interventions, seed)`。rolloutのinterventionsはモデル内操作で、現実の介入効果を表す型とは分ける。未知の操作名は拒否する。

`status`: `ok | not_enough_data | unsupported | incompatible_artifact | failed`。ok以外は計算していない数値を返さない。`reasons` は機械可読コードと日本語説明を保持する。

## C4：T4 → T5/T6 / ExplanationBundle

必須フィールド: `run_id, forecast_id, abstraction_id, node_schema_id, states, candidate_edges, residual_summary, fidelity_metrics, source_refs, assumptions, capability_flags, status`。
nodeは `id, label, semantic_status, unit, value, uncertainty`。`semantic_status=synthetic_axis | anchored_measure | unvalidated_latent`。未検証の軸を臨床尺度や病名で表示しない。
edgeは `source_ids, target_id, lag_days, interaction_order, coefficient, uncertainty_method, uncertainty, model_id, evidence_scope, source_refs`。`source_ids` は複数可。係数の単位・基準化・相互作用の関数名をnode schemaとモデル仕様へ記録する。
`evidence_scope=model_candidate` を初期値とし、観測された記述やcuratedの文献根拠とは別に表示する。bootstrapの出現割合は `uncertainty_method=bootstrap_frequency`。Bayesian posteriorと表示しない。

予定関数: `fit_abstraction(frozen_dynamics, train, validation, config)`、`explain(forecast, artifact)`、`score_fidelity(paired_rollouts)`。出典が不明な要素は未知と返し、既存の文献を自動で根拠として付けない。

## C5：T5 → T0/T6 / EvaluationReport

必須フィールド: `report_version, run_id, artifact_hashes, dataset_id, split_id, seed_list, baselines, metrics, metrics_by_scenario, unsupported_metrics, leakage_checks, predictions_ref, limitations, measured_usage, reproducibility_command, status`。
各metricに `name, target, value, unit, n_participants, n_predictions, uncertainty_method, interval, status`。不適切なmetricはnullと理由。構造の正解が無い実データでedge-F1を算出しない。
利用量は `provider_calls, input_tokens, output_tokens, cached_tokens, elapsed_seconds, compute_environment`。取得不能はnull、APIを使わなかった事実は0。料金を推定するなら価格取得日・単価・通貨を添える。学習計算とAPI費用を合算してトークンだけで表さない。

予測台帳は `prediction_id, run_id, cutoff_at, issued_at, target_times, model_hash, input_hash, payload_hash, evaluation_mode` を追記保存。`evaluation_mode=historical_simulation | prospective`。合成・過去データの再生を事前の実参加者予測と呼ばない。hashは内容の一致確認であり、単独で改ざん不能を保証しない。保存権限と追記処理も検証する。

## C6：T0 → T6 / 研究結果API

以下はFastAPI側に新設予定。ブラウザへservice-role keyやモデルcheckpointを送らない。

| Method / path | 認可と要求 | 応答 |
| --- | --- | --- |
| `POST /api/research/world-model/runs` | 研究者権限、許可されたsynthetic dataset_id・config_id・idempotency_key | 202とrun_id。重い学習をHTTP要求内で同期実行しない |
| `GET /api/research/world-model/runs/{run_id}` | 研究者権限とrunの対象範囲 | queued/running/succeeded/failed、artifactの版と進行状態 |
| `GET /api/research/world-model/runs/{run_id}/report` | 同上 | 完了時200、未完成409、無権限403、欠落404 |
| `GET /api/research/world-model/runs/{run_id}/explanations` | 同上 | ExplanationBundle。未対応なら明示したstatus |

```json
{
  "dataset_id": "synthetic-dev-v0",
  "config_id": "research-smoke-v0",
  "idempotency_key": "synthetic-smoke-seed-11"
}
```

同一keyで異なる要求は409、同じ要求なら同じrunを返す。runの所有範囲はサーバーで決める。パスのparticipant_idやクライアントのroleだけで認可しない。Day 3の実行は研究用環境に限定する。

## 予定CLIと能力宣言

```bash
# T0が実装して初めて使える予定コマンド（現在は存在しない）
cd sentra/backend
python -m research_engine.cli smoke --config research_engine/configs/smoke.json --out /tmp/blesc-research-smoke
python -m research_engine.cli evaluate --run /tmp/blesc-research-smoke --split heldout
```

smokeは合成生成→分割→実際の小型学習→checkpoint再読込→予測→説明→評価JSONまで実行する。ネットワーク不要を既定にする。LLMが必要な実験は別configとし、実測利用量を記録する。
`capability_flags` は `trained_encoder, trained_dynamics, calibrated_uncertainty, model_interventions, real_world_causal_effects, active_questioning` を持つ。未実装をfalseとし、falseの機能をUIで有効化しない。Day 3の `real_world_causal_effects` と `active_questioning` はfalse。

## 契約変更

変更理由・影響するproducer/consumer・fixture差分を契約Issueへ提出し、T0が互換性を判定する。破壊的変更はversionを上げる。新旧混在を黙って補正しない。H36以降は統合を壊す変更を次段階へ送り、実装済みの範囲を記録する。
