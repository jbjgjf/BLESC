# 滞留している作業の棚卸し（2026-11-15 時点）

このファイルは定期実行の出力であり、リポジトリの成果物ではない。コミットしていない。

## 要約

`main` は **2026-10-19 以降 27 日間 1 コミットも進んでいない**（HEAD = `85a25dc`、#475）。
その間に完成した作業は溜まり続けており、**不足しているのは課題でも実装でもなくレビューとマージである。**

| | 件数 |
| :-- | --: |
| open Issue | 214 |
| open PR | 14（うち dependabot 4、レビュー待ちの実作業 10） |
| リモートブランチ | 170 |
| **`main` と同位置で完成済み・PR が一度も立っていないブランチ** | **23** |
| 上記が対象とする open Issue | 15 件 |
| **PR がどこにも無い open Issue** | **9 件** |

## 1. PR が一度も立っていない完成済みブランチ（`main` と同位置・そのまま PR 可）

`+N -0` = main の先端に乗っており、リベース不要。

| Issue | ブランチ | 最終コミット | 備考 |
| :-- | :-- | :-- | :-- |
| **#514** | `claude/busy-lamport-cbl4qt` (+2) | 2026-10-29 | **P0**。参加者が PostgREST から日記行を DELETE でき、危機レビュー待ち行列が cascade で消える。migration + `supabase/tests` 付き |
| #553 | `claude/busy-lamport-49wxrg` (+1) | 2026-11-13 | high-priority。`OPENAI_EXTRACTION_TIMEOUT_MS` の envNumber 迂回 |
| #548 | `claude/busy-lamport-adn0sd` (+1) | 2026-11-12 | high-priority。リーク検査 `available_at_le_cutoff` |
| #545 | `claude/busy-lamport-so6ky3` (+1) | 2026-11-11 | 参加登録ゲート E2E のレポート/trace |
| #534 | `claude/busy-lamport-e81xyc` (+1) | 2026-11-05 | 日本語UIガードの `;` 規則 |
| #529 | `claude/busy-lamport-t0e76z` (+1) | 2026-11-01 | high-priority。危機の画面間引き継ぎ |
| #479 | `claude/busy-lamport-ly8y44` (+1) | 2026-10-21 | high-priority。CI が本番 Supabase ref を placeholder として渡す |
| #476 | `claude/busy-lamport-jepnvx` (+1) | 2026-10-20 | high-priority。記憶オブジェクトの tone_intensity が日本語で必ず 0 |
| #460 | `claude/busy-lamport-xjevp9` (+1) | 2026-11-07 | FastAPI の `@app.on_event("startup")` → lifespan |

以下は同じ修正が別ブランチで PR になっているため、ブランチは重複（削除候補）。

| Issue | PR | PR の無い重複ブランチ |
| :-- | :-- | :-- |
| #486 | #533 | `claude/busy-lamport-h76hr7` |
| #488 | #506 | `claude/busy-lamport-0seug8`, `claude/busy-lamport-9o63ud` |
| #494 | #507 | `claude/busy-lamport-m6g6j1` |
| #503 | #508 | `claude/busy-lamport-b6cx6w` |
| #521 | #527 | `claude/busy-lamport-ui4eoq` |
| #498 | #563 | `claude/issue-498`, `busy-lamport-w0bc9r`, `hpa1wv`, `3zkneg`, `nwy88g`, `wdpss9`, `iir88d`, `l7u6ir` |

### #498 は 8 回作り直されている

`next` の未認証 RCE（critical）を塞ぐ同じ依存関係の更新が、10-26 から 11-14 のあいだに
**8 本の独立したブランチ**で書かれ、9 本目でようやく PR（#563）になった。
Issue が open のままだから次の実行が同じ作業を拾う、という #464 のループがそのまま計測できている。

## 2. レビュー待ちの PR

| PR | Issue | 作成日 | 待ち日数 |
| :-- | :-- | :-- | --: |
| #474 | #465 #290 #344 #239 #240 #245 #246 #249 #253 #339（P0 安全3件を含む） | 10-19 | **27** |
| #506 | #488 | 10-27 | 19 |
| #507 | #494 | 10-27 | 19 |
| #508 | #503 | 10-27 | 19 |
| #513 | #509 | 10-28 | 18 |
| #527 | #521 | 10-31 | 15 |
| #533 | #486 | 11-03 | 12 |
| #543 | #540 | 11-10 | 5 |
| #563 | #498 #562 | 11-14 | 1 |
| #565 | #564 | 11-14 | 1 |

dependabot: #353 #357 #358 #449（#358 は eslint 10 で、#502 の固定解除に関係する）

## 3. 推奨する順番

1. **#474 をレビューするか分割する** — 1,331 行・45 ファイルで規約（§2 の ~400 行）の 3 倍超。
   27 日止まっており、P0 の安全修正 3 件を抱えている。#493 がこれを起票済み。
2. **#514 の `cbl4qt` を PR にする** — P0。現状どこにも PR が無い。
3. **#563 / #565 をマージして critical advisory を閉じる** — #498 の 8 本はその後削除。
4. 残り 8 本（#553 #548 #545 #534 #529 #479 #476 #460）を PR にする。
5. 重複ブランチ 14 本を削除する。
6. **起票を一旦止める** — #559 が「起票だけが日次で増えている」と既に指摘している。

## 4. この棚卸しを再現する方法

前回の実行が `scripts/ci/unlanded-work.mjs` を書いていたが、それ自体が PR にならず
`claude/busy-lamport-ss15d9` に取り残されていた。今回 `claude/busy-lamport-2wr0j7` に
cherry-pick してある（単体テスト 19 件すべて green）。

```bash
node scripts/ci/unlanded-work.mjs
```

`main` から何コミット進んでいるかではなく、「open な Issue を閉じると宣言しており、
かつ PR が無い」ブランチを数える。squash merge の残骸（`-48` などと大きく behind
しているもの）はそのやり方でなければ分離できない。
