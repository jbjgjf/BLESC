import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { assessSafety } from "../src/lib/safety-assessment.ts";

/**
 * `/recall` の危機語判定が `/api/chat` を迂回していた件（#343）の回帰テスト。
 *
 * 壊れていたのは語彙ではなく経路である。画面が自分で危機語を判定し、一致した
 * 回だけサーバーを呼ばずに定型文を返していたので、最も明示的な自傷・自殺の表現
 * だけが `safety_audits` にも `safety_escalations` にも残らなかった。
 *
 * だからここで押さえるのは2点。
 *
 *   1. 送信経路に「サーバーを呼ばない」分岐が無いこと
 *   2. 危機語彙が `lib/safety-assessment.ts` の1か所しか無いこと
 *
 * 1 はソースを読んで確かめる。この画面はブラウザのフォーム送信とReactの状態に
 * 依存していて、node から呼べる関数として切り出されていない。#288 が「grep する
 * だけのテスト」を問題として挙げているので、ここで見るのは文字列の有無ではなく
 * **構造**にした — 危機語のリテラルが残っていないこと、`createChat` の呼び出しが
 * 条件分岐の中に無いこと、そして `assessSafety` が catch 節からしか呼ばれて
 * いないこと。
 */

const RECALL_PAGE = new URL("../src/app/recall/page.tsx", import.meta.url);

/** #343 以前、画面が自分で持っていた10語。 */
const FORMER_LOCAL_TERMS = [
  "自殺",
  "死にたい",
  "消えたい",
  "殺したい",
  "傷つけたい",
  "suicide",
  "kill myself",
  "want to die",
  "self-harm",
  "hurt myself",
];

const source = await readFile(RECALL_PAGE, "utf8");

describe("recall workspace: the send path always reaches the server (#343)", () => {
  it("carries no crisis lexicon of its own", () => {
    const found = FORMER_LOCAL_TERMS.filter((term) => source.includes(term));
    assert.deepEqual(
      found,
      [],
      `app/recall/page.tsx must not hold crisis terms. The only lexicon is ` +
        `src/lib/safety-assessment.ts; a second copy is what #343 was. Found: ${found.join(", ")}`,
    );
  });

  it("has no local crisis predicate left", () => {
    assert.ok(
      !/hasCrisisLanguage|crisisTerms/.test(source),
      "hasCrisisLanguage/crisisTerms decided whether the server was called at all (#343)",
    );
  });

  it("calls createChat unconditionally on the success path", () => {
    assert.ok(source.includes("ApiClient.createChat"), "the send path still posts to /api/chat");

    // The call must not sit inside an `if`/`else` that another branch can take
    // instead: that branch is where the escalation went missing. Read the lines
    // between the start of `handleSubmit` and the call, and assert that none of
    // them opens a conditional.
    const submitAt = source.indexOf("const handleSubmit");
    const callAt = source.indexOf("ApiClient.createChat", submitAt);
    assert.ok(submitAt >= 0 && callAt > submitAt, "handleSubmit still contains the call");

    const between = source.slice(submitAt, callAt);
    const conditionals = between
      .split("\n")
      .map((line, index) => [index, line.trim()])
      .filter(([, line]) => /^(if|else|\}\s*else)\b/.test(line))
      // `if (!canSend) return;` is the guard on an empty form, and
      // `if (!userId) ...` style early returns leave the function rather than
      // choosing a different answer. Only a branch that continues is a problem.
      .filter(([, line]) => !/\breturn\b/.test(line));

    assert.deepEqual(
      conditionals.map(([, line]) => line),
      [],
      "no branch may stand between handleSubmit and createChat: that is where #343 lived",
    );
  });

  it("uses assessSafety only as the fallback for a failed send", () => {
    assert.ok(source.includes("assessSafety"), "the catch path still shows the safety text");

    const catchAt = source.indexOf("} catch (err) {", source.indexOf("const handleSubmit"));
    const assessAt = source.indexOf("assessSafety(content)");
    assert.ok(catchAt >= 0, "handleSubmit still has a catch");
    assert.ok(
      assessAt > catchAt,
      "assessSafety must be called after the send failed, never before it — calling it first " +
        "would re-create the bypass with a different lexicon",
    );
  });

  it("does not append the guided question when the server escalated", () => {
    assert.ok(
      source.includes("escalation_required"),
      "the next guided question is suppressed on the same line the reflection card is (#311)",
    );
  });
});

describe("the surviving lexicon answers for the former local terms (#343)", () => {
  /**
   * 何が変わり、何が変わらないかを数字で残しておく。
   *
   * `assessSafety` は画面のローカル判定より広いが、同じではない。10語のうち
   * 8語は risk を立てる。残る2語（`殺したい` `傷つけたい`）は、どちらも
   * 対象が書かれていないと自傷とも他害とも読めないため、サーバーの語彙では
   * `none` になる。この表はその差を固定するためのもので、差を是とするもの
   * ではない — 語彙に足すかどうかは #290 の判断である。
   */
  const EXPECTED = {
    自殺: "crisis",
    死にたい: "crisis",
    消えたい: "elevated",
    殺したい: "none",
    傷つけたい: "none",
    suicide: "crisis",
    "kill myself": "crisis",
    "want to die": "crisis",
    "self-harm": "elevated",
    "hurt myself": "elevated",
  };

  it("records the risk level for each one", () => {
    const actual = Object.fromEntries(
      Object.keys(EXPECTED).map((term) => [term, assessSafety(term).risk_level]),
    );
    assert.deepEqual(actual, EXPECTED);
  });

  it("gives every term that raises a risk level a safe response to show", () => {
    for (const [term, level] of Object.entries(EXPECTED)) {
      if (level === "none") continue;
      assert.notEqual(
        assessSafety(term).safe_response,
        "",
        `${term} is ${level} and must carry the text the fallback shows`,
      );
    }
  });

  it("marks only the crisis terms as notifiable", () => {
    // `escalation_required` is what `notifiableLevel()` turns into an
    // escalation row, and what the recall screen now uses to stop the
    // interview. elevated earns support without a notification.
    for (const [term, level] of Object.entries(EXPECTED)) {
      assert.equal(
        assessSafety(term).escalation_required,
        level === "crisis",
        `${term} (${level})`,
      );
    }
  });

  it("keeps the self-directed form of the two unmatched terms detectable", () => {
    // The loss above is narrow on purpose: the self-directed phrasing still
    // matches, because `自分を傷つけ` is in the lexicon.
    assert.notEqual(assessSafety("自分を傷つけたい").risk_level, "none");
    assert.notEqual(assessSafety("あいつを殺したい").risk_level, "none");
  });
});
