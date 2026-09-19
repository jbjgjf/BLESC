# 承認欄

> 2026-09-18監査: **開始条件未充足・募集不可**。
> [監査記録と残作業](readiness-audit-2026-09-18.md)を参照。未決定事項や署名は担当者自身が記録する。

> 2026-09-19: ownerは[D1–D7、C1–C6、I1の方針](decisions-2026-09-19.md)を採用した。以下の「未決定」は2026-09-18時点の履歴であり、方針判断は解消した。ただし担当受諾、学校の合意、当番、実装・文書の版整合、演習、承認署名は未了。現在のv2改訂案を承認済み・配布可能と扱わない。

> この文書一式は、下の3つの承認がすべて揃うまで **`draft`** である。
> 承認がない状態で `pilot_studies.status` を `recruiting` にしない。

## 承認

| 役割 | 氏名 | 承認した版 | 日付 | 署名／記録 |
| --- | --- | --- | --- | --- |
| 研究倫理責任者 | | | | |
| 学校責任者 | | | | |
| データ管理責任者 | | | | |

承認した版は、protocolと同意文書の**両方**を書く。現在の改訂案はそれぞれ `pilot-protocol-v2` と `research-consent-doc-v2`。現行アプリの版はv1であり、実装との整合後に担当者自身が記録する。片方だけ承認された状態は存在しない。

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

**上表は2026-09-18時点の監査履歴。** 方針は2026-09-19にownerが採用した。実在する担当受諾・学校確認・連絡先・当番・実装検証・演習が揃うまで、承認欄に署名しない。

## 実装がまだ揃っていない項目

承認とは別に、次はコードが未実装である（[field-mapping.md](field-mapping.md) と [data-dictionary.json](data-dictionary.json) の `implementation` を参照）。

- 日次固定自己評定の5項目（`mood` / `stress` / `sleep_quality` / `sleep_hours` / `event_intensity`）
- 相対日と study phase のexport変換
- 学習利用の別opt-in（`model_training_use`）

**未実装のまま募集を開始しない。** 承認済みのprotocolと、実装されている収集項目が食い違っている状態は、同意した内容と実際に集めるものが違うということである。
