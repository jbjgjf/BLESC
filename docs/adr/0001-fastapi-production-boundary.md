# ADR 0001: FastAPI を本番に出すか ── 抽出の正本、認証境界、移行の条件

| 項目 | 内容 |
| --- | --- |
| 状態 | **提案**（チームの承認待ち） |
| 日付 | 2026-09-27 |
| 起案 | @tmaumezawa-alt |
| 関連 | #259（FastAPI の無認証エンドポイント）、#166（パイロット専用インフラ）、#168（dry run）、feature-inventory §7.3（越境移転の説明） |

## 1. 何を決めるか

当初の計画は「段階的に FastAPI を本番の計算サービスにする」だった。一方で #259 が示したとおり、今の FastAPI には本番に出せる認証境界が無かった。37 本の経路のうち、身元を確かめていたのは 1 本だけである。これに AWS への移行案と、データの保管場所の説明責任（Supabase はシンガポール、OpenAI は米国）が重なる。

この3つは別々に決めると互いを壊す。そこで1つの判断として、次の3点を決める。

1. 抽出ロジックの正本をどちらに置くか
2. 認証境界をどこで切るか
3. 移行するなら、いつ、何を条件に移るか

## 2. 現状（2026-09-27 時点の事実）

| 事実 | 根拠 |
| --- | --- |
| 本番の書き込みは全て Next.js のルートハンドラ → Supabase。**FastAPI は本番で呼ばれていない**（`NEXT_PUBLIC_API_URL` 未設定） | `sentra/docs/production_baseline_path.md` |
| 抽出は2つ実装がある。TS（`frontend/src/lib/extraction.ts`、本番で動く方）と Python（`backend/app/services/llm_adapter.py`、研究パイプライン）。**抽出には適合性の契約が無い**（baseline と temporal diff には `shared/*_conformance.json` がある） | `sentra/shared/` |
| パイロット期間中は収集専用モードで、抽出は外部 AI に送らない（`withheld_collection_only`）。protocol §6 は「抽出モデルが期中に更新されると比較できなくなる」ことを理由に挙げている | `docs/pilot/protocol.md` §6、`collectionMode.ts` |
| FastAPI は SQLite を持ち、Postgres ドライバを持たない。SQLModel のテーブルは Supabase の migration とは別スキーマで、RLS も無い | `production_baseline_path.md`「A port, not an integration」 |
| #259 の修正（このブランチ）で、FastAPI の参加者経路は全て Supabase のアクセストークンを Supabase に問い合わせて検証するようになった。開いたままの経路は `OPEN_ROUTES` に明示され、漏れはテストが落とす。無認証の抜け道は Supabase が設定されたプロセスでは無視される | `backend/app/authz.py`、`tests/test_endpoint_authorization.py` |
| `deployment_vercel.md` は FastAPI を Render / Railway / Heroku に常時起動で置くことを推奨している | 同ファイル §バックエンド |
| Supabase はシンガポール（`ap-southeast-1`）。説明文書はこれを前提に国外取扱いを書いている | `docs/pilot/consent-pack.md` 4.7、`docs/legal/service-inventory.md` |
| OpenAI は米国。DPA・ZDR・学習除外はいずれも**未締結／未申請／未確認** | `sentra/docs/ai_provider_data_handling.md` §2 |
| AWS への移行案は、リポジトリの文書にはまだ書かれていない | — |

ここから分かることは2つある。

- **「FastAPI を本番に出す」は、今の本番を変えない話ではない。** FastAPI は今、本番の外にいる。出すなら、参加者データを持つ3つ目の処理系（Supabase、Vercel、FastAPI のホスト）が増える。
- **データの所在を決めるのは、計算がどこで動くかよりも、データがどこに保存され、誰に送られるかである。** 計算だけを AWS 東京に移しても、日記は Supabase（シンガポール）にあり、抽出を有効にすれば本文は OpenAI（米国）に送られる。移転先が1つ増えるだけで、説明はむしろ長くなる。

## 3. 決定（提案）

### 3.1 抽出ロジックの正本 → **Next.js（TypeScript）に置く**

- 本番で参加者の入力を処理する抽出の正本は `frontend/src/lib/extraction.ts` とする。本番で実際に動いているのはこちらで、同意ゲート・収集専用モード・AI 送信先の目録テスト（`ai-provider-inventory.test.mjs`）がこの経路に掛かっている。
- Python 側（`llm_adapter.py`、`research_engine/`）は**研究・評価用の実装**とし、参加者の本番データを直接受け取らない。研究で使うときの入力は、研究エクスポート（撤回除外・仮名化済み）とする。
- 2つの実装が食い違わないよう、抽出にも baseline と同じ形の適合性契約（`shared/extraction_conformance.json`）を置く。これは移行の前提条件でもある（§3.3）。
- パイロット期間中は抽出自体が止まっている（収集専用モード）。そのため、この決定がパイロットの計測を変えることはない。

**採らなかった案:** Python を正本にし、Next.js から FastAPI を呼ぶ案。研究エンジンと同じ言語になる利点はある。しかし参加者データを扱う処理系が1つ増え、FastAPI 側に同意ゲート・収集専用モード・送信先目録を移植し直す必要がある。未成年のデータを扱う期間に境界を増やす理由が、今は無い。

### 3.2 認証境界 → **身元は Supabase Auth だけが発行し、各サービスが自分で検証する。ネットワークは境界にしない**

- 身元の発行者は Supabase Auth の1つだけとする。どのサービスも、リクエストのボディやクエリにある `user_id` / `participant_code` を身元として扱わない（#259 の `resolve_identity` の原則を全経路に広げたもの）。
- 境界は**各サービスの入口**で切る。
  - Next.js: ページは `src/proxy.ts`（#229）、API はルートハンドラの `requireUser` / `requireOperator`、データは RLS。
  - FastAPI: `app/authz.py` がトークンを Supabase に問い合わせて検証する。「内部ネットワークにあるから信頼する」はしない。
- **FastAPI をブラウザから直接呼べる公開ホストに置かない。** 本番で使う場合は Next.js のサーバーからだけ呼ぶ。そのときも利用者のトークンを転送し、FastAPI 側で検証する（二重の確認）。`deployment_vercel.md` の「Render / Railway に常時起動で置く」推奨は、参加者データを持つ配備については取り下げる。
- 参加者データを持つ配備では、`NEXT_PUBLIC_API_URL` を未設定のままにする。ブラウザからの呼び出しは同一オリジンの Next.js に向かう。

**採らなかった案:** FastAPI を API ゲートウェイの後ろに置き、ゲートウェイで認証する案。検証が1か所に集まる利点はある。しかしゲートウェイを迂回できる経路（直接の URL、設定ミス）が1つあれば #259 と同じ状態に戻る。サービス自身が検証する方が、壊れ方が局所的で済む。

### 3.3 移行 → **パイロットの収集が終わるまでは移らない。移るなら次の条件を全て満たしてから**

**いつ:** パイロットの収集終了（protocol の Day 29 以降。#315 で28日に変更）と dry run（#168）の Go 判定の後の、最初の設計レビュー。収集期間中に処理系を変えない理由は protocol §6 と同じで、途中で処理が変わると1週目と4週目が比較できなくなるからである。

**何を条件に（全て必須）:**

| # | 条件 | 確かめ方 |
| --- | --- | --- |
| C1 | FastAPI が参加者データを**自前の別ストアに持たない**。Supabase（または移行後の単一の DB）を読み書きし、同じ RLS 相当の検査を通る | 設計レビュー。SQLite に参加者の行が無いこと |
| C2 | 抽出の適合性契約（§3.1）が両実装で緑。もしくは TS 側を削除して正本を1つにしている | CI |
| C3 | FastAPI の全経路が認証テストと「許可リスト漏れ」テストで緑（#259 のテスト） | `backend/tests/test_endpoint_authorization.py` |
| C4 | 新しいホスト（AWS 等）の所在国・DPA・サブプロセッサが確認済みで、`consent-pack.md` 4.7 と `service-inventory.md` に反映され、倫理審査・学校の承認を受けている | 文書と承認記録 |
| C5 | **DB と計算を同じ地域に置く。** AWS に移るなら DB も同じリージョン（日本国内なら `ap-northeast-1`）に移し、移転先を増やさない。計算だけを移して移転先が増える形は採らない | 構成図 |
| C6 | 撤回の手続き（`withdraw_from_research`、#263）と保持期限の削除が、新しい構成でも1か所で動く | `supabase/tests/withdrawal.test.sql` 相当の検証 |
| C7 | RLS の掃き出しテスト（#261）が新しい DB でも緑 | `supabase/tests/rls_coverage.test.sql` |

C4 と C5 は技術の判断ではなく、説明責任の判断である。**「計算を日本に置いた」ことは「データが日本にある」ことを意味しない。** 参加者への説明は、保存場所と送信先で書く。

### 3.4 移行に関係なく、今やること

- OpenAI の DPA・ZDR・学習除外（`ai_provider_data_handling.md` §2）。抽出や音声を収集専用モードの外で有効にする前提条件であり、FastAPI をどうするかとは独立している。
- 抽出の適合性契約（C2）。移行しない場合でも、2つの実装が黙って食い違うことを防ぐ。

## 4. 結果

**良くなること**

- パイロット期間中、参加者データを扱う処理系は Supabase と Vercel（Next.js）の2つに留まる。説明文書の「国外取扱い」の範囲が今のまま保たれる。
- 認証の考え方が1つになる（Supabase が発行し、各サービスが検証する）。FastAPI をいつ本番に出しても、境界を作り直す必要が無い。
- 移行するかどうかを、条件の充足で機械的に判断できる。

**払うもの**

- 抽出が2実装のまま残る期間がある（C2 の契約で保守を有限にする）。
- 研究エンジン（Python）は本番データを直接読めず、研究エクスポートを経由する。研究の反復は遅くなるが、撤回除外・仮名化を必ず通ることと引き換えである。
- `deployment_vercel.md` の推奨構成を改める必要がある。

## 5. 承認されたらやること

- [ ] `sentra/docs/deployment_vercel.md` §バックエンド: 参加者データを持つ配備で FastAPI を公開ホストに置く推奨を取り下げ、本 ADR へのリンクに置き換える
- [ ] `docs/pilot/infrastructure-runbook.md` §3.3: パイロットでは FastAPI を動かさないことを明記する
- [ ] `sentra/shared/extraction_conformance.json` と両実装のテストを追加する（C2）
- [ ] `docs/rollout/feature-inventory.md` §7.3 に、本 ADR の C4・C5 を公表用記載の前提として追記する
- [ ] 移行の判断をするレビューの日付を、パイロットの収集終了日から決めて入れる
