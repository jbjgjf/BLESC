# 日本語の危機表現コーパス（合成）

危機の検知器が、生徒が実際に打ちそうな書き方をどれだけ拾い、危機ではない文をどれだけ誤って拾うかを、区分ごとに測るための物差しです。

- 語彙・閾値・判定ロジックは**変えません**。検知器の公開関数を呼んで結果を記録するだけです。
- 語彙そのものの修正は #388（Next 側と FastAPI 側の `assessSafety` / `assess_safety`）と #392（`memory_objects.has_crisis_language`）で進んでいます。このコーパスは、その修正の効果と副作用を測るためにあります。

## まず読むこと：期待判定は未レビューです

**すべての項目は `reviewed: false` です。** 期待判定（`expected`）は、文を書いたのと同じモデル（`author: "model:claude-opus-5.5"`）が付けた草案です。

- 人のレビュー（できれば臨床側の協力者による）が済むまで、このコーパスで「危機表現を網羅した」「検知率が◯％だから十分」とは言いません。
- ここで出る数字は「草案の判定との一致率」であり、検知の網羅性の証拠ではありません。
- 判定が割れそうな項目には `review_note` を付けています。レビューはそこから始めてください。
- 区分の選び方そのもの（どんな書き方を入れるべきか）もレビューの対象です。モデルが思いつかない書き方は、このコーパスには入っていません。

## 合成であること

すべての文は、このファイルのために書いたものです。実在の生徒の文章、実在の SNS 投稿、およびそれらを書き換えたものは入っていません。追加する場合も同じ条件を守ってください（`corpus.json` の `privacy_boundary`）。

手段の詳細や、危険な行為の方法は書いていません。検知に必要なのは「開示の言い回し」であり、方法の情報ではないためです。

## ファイル

| ファイル | 中身 |
| :-- | :-- |
| `corpus.json` | 項目の本体。区分・話題・期待判定の定義もここにある |
| `baseline.json` | 検知器ごとの、測定時点の既知の漏れ・判定不足・偽陽性の一覧 |
| `README.md` | この文書 |

### 項目の形

```json
{"id": "hi-001", "text": "しにたい", "category": "hiragana", "topic": "self_harm",
 "expected": "crisis", "rationale": "…", "author": "model:claude-opus-5.5", "reviewed": false}
```

- `expected`: `crisis`（危機）／`caution`（要注意）／`none`（該当なし）。定義は `corpus.json` の `verdicts`
- `category`: 下の区分のどれか
- `topic`: `self_harm` / `passive_ideation` / `abuse` / `violence_to_others` / `cannot_stay_safe` / `none`
- `reviewed`: レビュー済みにするときは `true` にし、`reviewed_by`（役割。例: 「臨床協力者」）と `reviewed_on`（日付）も書く。両方が無い `true` はテストが拒否する

### 区分

| 区分 | 内容 | 陽性 | 陰性 |
| :-- | :-- | --: | --: |
| `kanji_control` | 漢字表記（対照群）。いまの語彙が書かれている表記そのもの。後退の検出に使う | 14 | 0 |
| `hiragana` | かな書き（「しにたい」） | 14 | 4 |
| `katakana` | カタカナ（「シニタイ」「死ニタイ」） | 8 | 2 |
| `width_mixed` | 全角・半角の混在（半角カナ、字間の空白） | 8 | 2 |
| `masked` | 伏せ字・当て字（「死○たい」「4にたい」「氏にたい」） | 8 | 1 |
| `slang` | 俗語・ネットスラング（「タヒにたい」「リスカ」「OD」） | 12 | 3 |
| `euphemism` | 婉曲表現（「楽になりたい」「目が覚めなければいい」） | 14 | 0 |
| `negation` | 否定（「死にたいとは思わない」） | 2 | 7 |
| `hypothetical` | 仮定（「死んだら楽になれるのかな」） | 5 | 3 |
| `quotation` | 引用・伝聞（「映画で『死にたい』という台詞が」） | 3 | 6 |
| `confusable` | 紛らわしい文。危機ではないのに語彙が当たりうる文（偽陽性の検査） | 0 | 20 |
| 計 | | 88 | 48 |

陽性 = `expected` が `crisis` か `caution`。陰性 = `none`。

## 測っている検知器

| 名前 | 呼んでいるもの | 判定の段階 |
| :-- | :-- | :-- |
| `frontend.assessSafety` | `sentra/frontend/src/lib/safety-assessment.ts` の `assessSafety(text)` | あり |
| `backend.assess_safety` | `sentra/backend/app/services/safety.py` の `assess_safety(...)` | あり |
| `backend.has_crisis_language` | `sentra/backend/app/analytics/memory_objects.py` の `has_crisis_language(text)` | なし（真偽のみ） |

検知器の `risk_level` は次のように読み替えます。`low` は「危険の合図のない苦痛」で、介入を起こさないので「拾った」とは数えません。

| `risk_level` | コーパスの判定 |
| :-- | :-- |
| `crisis` | `crisis` |
| `elevated` | `caution` |
| `low` / `none` | `none` |

- **検知**: 陽性の項目で、検知器が `caution` 以上（`has_crisis_language` は真）を返したもの
- **危機と判定**: `expected: crisis` の項目で、検知器が `crisis` を返したもの。`escalation_required` が立ち、教職員への通知が起きるのはこの段階だけです
- **偽陽性**: 陰性の項目で、検知器が `caution` 以上を返したもの

## テストの設計（A の修正を CI で邪魔しないこと）

テストは CI がすでに走らせている場所にあります。ワークフローの変更は要りません。

- frontend: `sentra/frontend/tests/safety-corpus.test.mjs`（`npm test`）
- backend: `sentra/backend/tests/test_safety_corpus.py`（`pytest tests`）

どちらも同じ `baseline.json` を読み、同じ規則で比べます（`sentra/backend/app/evaluation/safety_corpus.py` の `compare` と、frontend テスト内の `compare`）。

### 落ちるのは、悪くなったときだけ

| 変化 | 扱い |
| :-- | :-- |
| 測定時点で拾えていた陽性の項目が、拾えなくなった（`regressions`） | **失敗** |
| 測定時点で `crisis` と判定していた危機の項目が、`crisis` でなくなった（`lost_crisis_grade`） | **失敗**。`escalation_required` が消えるため |
| 測定時点で偽陽性でなかった陰性の項目が、偽陽性になった（`new_false_positives`） | **失敗** |
| 記録済みの偽陽性が、より重い段階になった（`escalated_false_positives`） | **失敗** |
| 既知の漏れが拾えるようになった（`closed_gaps`） | 通知だけ |
| 判定不足だった項目が `crisis` になった（`regained_crisis_grade`） | 通知だけ |
| 記録済みの偽陽性が消えた（`cleared_false_positives`） | 通知だけ |

**既知の漏れ（`known_gaps`）は、拾えなくても失敗しません。** #388 / #392 の修正が入って漏れが拾えるようになると、テストは通ったまま通知を出します。通知の出し方は次のとおりです。

- frontend: テストの出力に `NOTICE frontend.assessSafety improved: …` と、更新後の `baseline.json` の該当部分を出す
- backend: `SafetyCorpusNotice` 警告として、pytest の warnings summary に同じ内容を出す

この性質はテストで固定しています。「既知の漏れをすべて拾い、偽陽性をすべて消した観測」を作って比べ、失敗が0件で、通知だけが出ることを確かめるテストです（両側の `closing every known gap …`）。

### 既知の漏れ一覧と Issue

`baseline.json` の各項目には、どこで追跡しているかを `issue` に書いています。

| `issue` | 意味 |
| :-- | :-- |
| `#388` | 表記ゆれ（かな・カタカナ・全角・半角カナ）の漏れ。`assessSafety` / `assess_safety` 側 |
| `#392` | 同じ漏れの `memory_objects.has_crisis_language` 側 |
| `#374` | Next 側は拾うが FastAPI 側は拾わない（FastAPI 側に曖昧な撤退表現の段が無い） |
| `unfiled` | まだどの Issue でも追跡されていない（伏せ字、俗語、婉曲表現、字間の空白、否定・引用による偽陽性など） |

`#388` / `#392` の割り当ては推測ではありません。2026-10-10 時点で開いている A の修正ブランチ（PR #397 と、その上に積まれた #399）の検知器を、作業用の一時ディレクトリに写してこのコーパスに通し、**そのブランチで拾えるようになる項目**にだけ付けました。`#374` は、修正後の Next 側は拾うが修正後の FastAPI 側は拾わない項目です。

`unfiled` の項目は Issue が起票されたら番号に置き換えてください。置き換えに使える値は、テスト（`TRACKING_REFS`）が持っています。新しい Issue 番号を使うときは、両側の `TRACKING_REFS` に足してください。

### A の修正（#397 / #399）が入ったときに起きること

上と同じ方法で、A のブランチをこのコーパスに通した結果です。

- 既知の漏れのうち、`frontend.assessSafety` で 27件、`backend.assess_safety` で 24件、`backend.has_crisis_language` で 13件が拾えるようになる。**どれも失敗せず、通知になる。**
- `hi-009`（「こんや、じぶんをきずつけそう」）と `hi-014`（「きょう、あいつをころしてやりたい」）は、拾えるようになるが `caution` 止まりになる。A が #290 を理由に、時期の語（今夜・今日）には読みを与えていないためです。通知の中の更新後の一覧では、この2件は `known_under_graded` に移ります。
- **偽陽性が4件増える。** `hi-n03`「じさつてん」、`ka-n02`「ジサツテン」、`wd-n02`「ｼﾞｻﾂﾃﾝ」（自殺点＝オウンゴール）と、`hi-n04`「ぎゃくたいぼうし」（虐待防止）です（`has_crisis_language` では `hi-n04` を除く3件）。漢字表記の `cf-n02`「自殺点」と `cf-n04`「虐待防止」は、今日すでに偽陽性です。同じ誤りがかな表記にも広がる、ということです。

最後の点は、規則どおり**失敗**になります。偽陽性の増加は、生徒への誤った介入と教職員への誤った通知の増加だからです。順序によって対応が変わります。

- **A の PR が先に入る場合（推奨）**: このコーパスの PR を main に載せ直し、`baseline.json` を測り直してから出す。A の CI は一度も落ちない。
- **このコーパスの PR が先に入る場合**: A の PR で、上の4件（3件）を `known_false_positives` に `{"issue": "#388", "observed": "crisis"}` として足すか、誤りそのものを直す。どちらにするかは A とレビュアーの判断です。

## 更新の手順

### 通知が出たとき

改善の記録です。一覧を片付けてください。

- backend: `cd sentra/backend && python scripts/report_safety_corpus.py --prune` が、backend の2つの検知器の項目から、通知に出たものを取り除きます。**取り除くだけで、足すことはしません。**
- frontend: テストの出力に出る `Update detectors["frontend.assessSafety"] … to: {…}` の内容で、`baseline.json` の該当部分を置き換えます。

### 失敗したとき

悪くなっています。まず直すことを考えてください。

意図した変化として受け入れる場合（たとえば、偽陽性が増えても漏れが大きく減るので受け入れる、と判断した場合）は、**同じ PR の中で `baseline.json` を手で編集し**、PR の本文に理由を書きます。自動で足す手段は用意していません。後退を受け入れるのは人の判断だからです。

### 項目を足すとき

- 合成の文だけを足す。`id` は区分の接頭辞と連番（陰性は `-n` を付ける）
- `reviewed: false`、`author` に書いた人（またはモデル）を入れる
- 足した項目が今の検知器で拾えない場合は、同じ PR で `known_gaps` に足す（足さないとテストが `regressions` として落ちる）

### 期待判定をレビューするとき

1. `review_note` の付いた項目、`negation` / `quotation` / `confusable` の項目から見る
2. 判定を変える場合は `expected` と `rationale` を書き換える
3. `reviewed: true`、`reviewed_by`（役割）、`reviewed_on`（日付）を書く
4. 判定を変えた項目は、陽性と陰性が入れ替わることがあるので、`baseline.json` の該当項目も移す（テストが場所の誤りを報告する）

## 2026-10-10 時点の実測

`origin/main`（2fadb92）の検知器の値です。最新の値は、テストの出力（frontend）と `python scripts/report_safety_corpus.py`（backend）で見てください。**期待判定は未レビューの草案との比較です。**

| 検知器 | 検知（陽性 88件） | うち危機と判定（危機の期待 61件） | 偽陽性（陰性 48件） |
| :-- | --: | --: | --: |
| `frontend.assessSafety` | 23（26%） | 13（21%） | 17（35%） |
| `backend.assess_safety` | 20（23%） | 13（21%） | 17（35%） |
| `backend.has_crisis_language` | 11（12%） | — | 9（19%） |

漢字表記の対照群は `frontend.assessSafety` で 14/14 を拾います。かな・カタカナ・半角カナ・伏せ字・俗語は、ほぼ 0 です。偽陽性は否定（7件中5件）と引用（6件中4件）に集中しています。
