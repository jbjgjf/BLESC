# 契約fixture（v0）

C1〜C5の**valid**な例と、拒否されなければならない**invalid**な例を置く。6チームが同じ
ファイルを読んで開発を並行させるための共有物であり、`test_t0a_contracts.py` が
valid側は必ず読み込めること、invalid側は必ず指定のcodeで拒否されることを検査する。

| ファイル | 契約 | 期待 |
| --- | --- | --- |
| `observation_bundle_valid.json` | C1 | 読み込める |
| `observation_bundle_invalid_mask.json` | C1 | `mask_value_mismatch` |
| `observation_bundle_invalid_duplicate_event.json` | C1 | `duplicate_event_id` |
| `observation_bundle_invalid_feature_schema.json` | C1 | `feature_schema_mismatch` |
| `encoded_sequence_valid.json` | C2 | 読み込める |
| `encoded_sequence_invalid_future.json` | C2 | `future_leakage` |
| `encoded_sequence_invalid_dim.json` | C2 | `dimension_mismatch` |
| `forecast_bundle_valid.json` | C3 | 読み込める |
| `forecast_bundle_invalid_target_not_future.json` | C3 | `target_not_in_future` |
| `forecast_bundle_invalid_status_payload.json` | C3 | `status_payload_mismatch` |
| `forecast_bundle_invalid_deterministic_scale.json` | C3 | `uncertainty_without_method` |
| `explanation_bundle_valid.json` | C4 | 読み込める |
| `explanation_bundle_invalid_interaction_order.json` | C4 | `shape_mismatch` |
| `evaluation_report_valid.json` | C5 | 読み込める |
| `evaluation_report_invalid_missing_hash.json` | C5 | `missing_field` |

invalid fixtureは「1箇所だけ壊れている」ことを保つ。2箇所壊すと、どちらの検査が
効いているのか判別できないテストになる。
