# パイロット研究の文書一式（50名×21日）

> 状態: **草案**。研究倫理責任者・学校責任者・データ管理責任者の承認前。
> 版: protocol `pilot-protocol-v1` / 同意文書 `research-consent-doc-v1`
> 親Epic [#161](https://github.com/jbjgjf/BLESC/issues/161) / 本文書は [#162](https://github.com/jbjgjf/BLESC/issues/162)

| 文書 | 内容 |
| --- | --- |
| [protocol.md](protocol.md) | 対象・期間・収集項目・中止条件・解析計画 |
| [data-dictionary.md](data-dictionary.md) | 収集項目の一覧（人が読む版） |
| [data-dictionary.json](data-dictionary.json) | 同じ内容の機械可読版。実装とexportが参照する正本 |
| [field-mapping.md](field-mapping.md) | protocolの項目と、コード上の保存先の対応表 |
| [consent-pack.md](consent-pack.md) | 本人説明・保護者説明・assent/consent・撤回・削除依頼の文面 |
| [incident-runbook.md](incident-runbook.md) | 事故・危機記述・障害への対応手順 |
| [infrastructure-runbook.md](infrastructure-runbook.md) | 専用Vercel/Supabaseの構築、環境変数の目録、反映の順序、検証（[#166](https://github.com/jbjgjf/BLESC/issues/166)） |
| [approvals.md](approvals.md) | 承認欄。人間が署名するまで `approved` にしない |
| [dry-run/](dry-run/README.md) | 10テストアカウント×3日の実施手順・scenario matrix・記録様式（[#168](https://github.com/jbjgjf/BLESC/issues/168)） |

## この一式の使い方

**版が正本。** アプリの `consent_records.document_version` と `pilot_studies.protocol_version` は、この配下の版文字列を指す。文書を変えたら版を上げ、[approvals.md](approvals.md) に再承認を記録する。版を上げずに文面を変えない。

**未決定は空欄にしない。** 決まっていない事項は `DECISION REQUIRED` と書き、誰が決めるかを添える。推測で埋めた値は、承認者から見て「決まった値」と区別がつかない。

**この文書だけでは募集を開始しない。** 実在の高校生の募集には3つが揃う必要がある: (1) 実装の完了、(2) 研究・学校側の承認、(3) 10名×3日のdry run（[#168](https://github.com/jbjgjf/BLESC/issues/168)）の合格。
