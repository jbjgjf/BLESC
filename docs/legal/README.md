# 利用・個人情報・研究の書類（確認用草案）

2026-09-14作成。未施行・未承認。既存の `research-consent-doc-v1` を変更せず、同意の取得・募集開始・本番公開の承認とはしない。

全文の正本は [legalDocuments.ts](../../sentra/frontend/src/lib/legalDocuments.ts)。アプリの `/legal` で、利用規約、プライバシーポリシー、研究参加説明、保護者説明の4文書をログインなしで閲覧できる。ログイン、研究同意、パイロット参加、保護者確認、メニューからリンクする。草案の閲覧を同意として記録しない。

一般文書版 `legal-review-2026-09-14-v1`、研究説明版 `research-consent-doc-v2-draft`。正式化時には承認済み文書の版と本文を対応させ、必要な再同意・保存・監査を実装する。現行の研究計画・承認欄は [pilot](../pilot/README.md) にあり、未承認のまま。

## 指定された情報

- 運営：Blesc株式会社／代表者：田雨竜
- 問い合わせ：blesc.jp@gmail.com／研究責任者：王謙蘊
- Web本文には住所を掲載しない。ただし、個人情報保護法上必要な住所情報は、本人の求めに応じて遅滞なく回答できる体制を施行前に整える。実住所は未確認であり、住所の開示を全面的に拒否する運用にはしない。

## 採用する運用案と実装状況

[運用案](operations-proposal.md) に保存期間、保護者本人確認、撤回受付、危機対応と正式化条件を整理した。[サービス調査](service-inventory.md) はコードと接続先の読み取り確認結果。委託契約・実際の当番・倫理承認は推測で完了扱いにしない。

今回の実装は全文表示と導線、および新規研究原文の保持期限設定を標準・上限90日にする変更まで。既存データの期限修正、定期削除、他データの期限管理、保護者の項目別同意、運用承認、本番デプロイは未完了。草案はこれらを達成済みの約束として表示しない。

## 判断に用いた公式資料

- [個人情報保護委員会・通則編](https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/)：保有個人データに関する公表等、要配慮個人情報、利用目的・安全管理。
- [外国事業者のクラウド利用に関するFAQ](https://www.ppc.go.jp/all_faq_index/faq1-q12-4/)：外国提供の該当性はアクセス・契約等の実態による。
- [漏えい等報告・本人通知](https://www.ppc.go.jp/files/pdf/roueihoukoku_leaflet_2023.pdf)：法定対象時の速報・確報・本人通知。
- [OpenAI Enterprise privacy](https://openai.com/enterprise-privacy/)：APIの標準的な学習利用・保持。`store:false` は全ログのゼロ保持ではない。
- [Supabaseのリージョン](https://supabase.com/docs/guides/platform/regions)：接続先リージョンの確認。
- [文科省・2026年倫理指針改正](https://www.mext.go.jp/b_menu/houdou/mext_01679.html)：2026-12-01施行。該当性と実施時点の適用指針は研究機関・倫理審査側で確認する。
