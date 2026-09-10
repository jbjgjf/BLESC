# 承認欄

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
| C1 | 問い合わせ先 | 研究責任者・学校責任者 | [consent-pack §A/§C](consent-pack.md) | 未決定 |
| C2 | 本文の保持期間 | データ管理責任者 | [consent-pack §A/§C](consent-pack.md) | 未決定 |
| C3 | 保護者確認の方法 | 学校責任者 | [consent-pack §D](consent-pack.md) | 未決定 |
| C4 | 保護者からの撤回・削除の受付経路 | 学校責任者・データ管理責任者 | [consent-pack §E/§F](consent-pack.md) | 未決定 |
| C5 | 削除完了までの目標日数 | データ管理責任者 | [consent-pack §F](consent-pack.md) | 未決定 |
| C6 | 謝礼を説明文へ記載するか | 学校責任者・研究責任者 | [consent-pack §A](consent-pack.md) | 未決定 |
| I1 | 連絡体制（4役割＋校内相談体制の連絡先） | 研究責任者・学校責任者 | [incident-runbook §1](incident-runbook.md) | 未決定 |

**この表に「未決定」が1つでも残っている限り、承認欄に署名しない。** 空欄のまま承認すると、実装側は空欄を推測で埋めるしかなくなり、推測が仕様になる。

## 実装がまだ揃っていない項目

承認とは別に、次はコードが未実装である（[field-mapping.md](field-mapping.md) と [data-dictionary.json](data-dictionary.json) の `implementation` を参照）。

- 日次固定自己評定の5項目（`mood` / `stress` / `sleep_quality` / `sleep_hours` / `event_intensity`）
- 相対日と study phase のexport変換
- 学習利用の別opt-in（`model_training_use`）

**未実装のまま募集を開始しない。** 承認済みのprotocolと、実装されている収集項目が食い違っている状態は、同意した内容と実際に集めるものが違うということである。
