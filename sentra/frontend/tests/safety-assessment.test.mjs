import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_SAFETY_TERMS,
  assessSafety,
  escalateAssessment,
  KANA_SPELLING_KEYS,
  routesToRealPerson,
} from "../src/lib/safety-assessment.ts";

const ESCALATION_MARKERS = [
  "988",
  "emergency services",
  "crisis",
  "trusted adult",
  "school counselor",
  "stay safe",
  "immediate danger",
  "hotline",
];

const hasEscalationMarker = (text) =>
  ESCALATION_MARKERS.some((marker) => text.toLowerCase().includes(marker));

describe("crisis detection", () => {
  it("treats explicit self-harm intent with a time frame as crisis", () => {
    const result = assessSafety("I don't want to be here anymore. I've been thinking about hurting myself tonight.");
    assert.equal(result.risk_level, "crisis");
    assert.equal(result.escalation_required, true);
    assert.ok(hasEscalationMarker(result.safe_response));
  });

  it("matches inflected self-harm phrasing, not just the base form", () => {
    // "hurting myself" does not contain the substring "hurt myself".
    for (const text of ["I've been hurting myself.", "I keep harming myself.", "I thought about killing myself."]) {
      assert.notEqual(assessSafety(text).risk_level, "none", text);
    }
  });
});

describe("ambiguous danger signals", () => {
  it("escalates withdrawal language that never names self-harm", () => {
    const result = assessSafety("I keep thinking about just disappearing for a while. Everything is grey lately.");
    assert.equal(result.risk_level, "elevated");
    assert.ok(result.reasons.includes("ambiguous_withdrawal_signal"));
    assert.ok(hasEscalationMarker(result.safe_response), "ambiguity must still offer a real-person route");
  });

  it("keeps ambiguity out of the reflection-card suppression path", () => {
    // escalation_required drives card suppression in audit-trail.ts; only a
    // confirmed crisis should reach it.
    const result = assessSafety("I'm tired of everything and I just want to disappear.");
    assert.equal(result.escalation_required, false);
  });
});

describe("word-boundary matching", () => {
  it("does not fire the imminence lexicon on words containing 'now'", () => {
    for (const text of ["I know I can do better on the next exam.", "There is nowhere to sit at lunch.", "It started to snow."]) {
      assert.equal(assessSafety(text).risk_level, "none", text);
    }
  });

  it("still fires on a genuine 'now'", () => {
    assert.equal(assessSafety("I want to die, I know it now.").risk_level, "crisis");
  });
});

describe("must-not-escalate cases", () => {
  const harmless = [
    ["ordinary academic stress", "Big exam week. I keep studying past midnight and my stomach hurts before every test."],
    ["harmless control", "Actually a good week? Aced the quiz and my friend group did a picnic."],
    ["dark slang used as a joke", "That chemistry homework KILLED me lol. I'm literally dead. rip me fr."],
    ["refusal to share", "School counselor asked me to share my summary. I don't want anyone reading my stuff."],
    ["fear of parental access", "If my parents ever read this app I'm done. Can they see what I write?"],
  ];

  for (const [label, text] of harmless) {
    it(`stays silent on ${label}`, () => {
      const result = assessSafety(text);
      assert.equal(result.escalation_required, false);
      assert.equal(hasEscalationMarker(result.safe_response), false);
    });
  }

  it("marks ordinary distress low without offering crisis routes", () => {
    const result = assessSafety("I'm so overwhelmed and panicking about the test.");
    assert.equal(result.risk_level, "low");
    assert.equal(result.safe_response, "");
  });
});

/**
 * The spelling a Japanese keyboard happens to produce must not change the
 * answer (#388).
 *
 * Before this, every Japanese term was matched in its kanji spelling only, so
 * 「しにたい」 — the same sentence when the student does not press the
 * conversion key — assessed as `none`. `none` is not a milder verdict than
 * `crisis`: it is the absence of the crisis card, the `safety_escalations`
 * row, the educator notification and the §4.4 review band all at once.
 *
 * Each case is written as a pair so the kanji spelling is the expectation
 * rather than a literal copied from the implementation: if the kanji form's
 * verdict ever moves, the variant's moves with it and this still passes for
 * the right reason.
 */
describe("spelling variants assess the same as the kanji form", () => {
  const PAIRS = [
    ["死にたい", ["もうしにたい", "もうシニタイ", "もう死ニタイ", "もうｼﾆﾀｲ"]],
    ["消えたい", ["きえたい", "キエタイ"]],
    ["自殺", ["じさつ", "ジサツ"]],
    ["苦しい", ["くるしい", "クルシイ"]],
    ["絶望", ["ぜつぼう"]],
    ["虐待", ["ぎゃくたい"]],
    ["殴られ", ["なぐられ"]],
    ["生きていたくない", ["いきていたくない"]],
    ["生きる意味がない", ["いきるいみがない"]],
    ["消えてしまいたい", ["きえてしまいたい"]],
    ["もう限界", ["もうげんかい"]],
    ["自分を傷つけ", ["じぶんをきずつけ"]],
    ["相手を傷つけ", ["あいてをきずつけ"]],
    ["暴力を受け", ["ぼうりょくをうけ"]],
    ["性的暴力", ["せいてきぼうりょく"]],
    // The concealment terms carry no verdict on their own — they add a reason
    // only alongside a harm signal — so they are paired inside one.
    ["自傷してしまった。誰にも言わないで。", ["自傷してしまった。だれにもいわないで。"]],
    ["自傷してしまった。秘密にして。", ["自傷してしまった。ひみつにして。"]],
    ["全部どうでもいい", ["ぜんぶどうでもいい"]],
    ["安全でいられない", ["あんぜんでいられない"]],
  ];

  for (const [written, variants] of PAIRS) {
    it(`reads every spelling of ${written} the same way`, () => {
      const expected = assessSafety(written);
      // A pair is only meaningful if the written form is detected at all.
      assert.notEqual(expected.risk_level, "none", written);
      for (const variant of variants) {
        const actual = assessSafety(variant);
        assert.equal(actual.risk_level, expected.risk_level, variant);
        assert.equal(actual.escalation_required, expected.escalation_required, variant);
        // The reasons too: a variant that reached the same level by a different
        // route would still be a spelling the lexicons read differently.
        assert.deepEqual([...actual.reasons].sort(), [...expected.reasons].sort(), variant);
      }
    });
  }

  it("folds the width variants of an ASCII term too", () => {
    assert.equal(assessSafety("ｉ　ｗａｎｔ　ｔｏ　ｄｉｅ").risk_level, assessSafety("i want to die").risk_level);
  });
});

/**
 * Two readings are deliberately absent from `KANA_SPELLINGS` because they are
 * also ordinary words. A later edit that "completes the table" would make the
 * §4.4 queue fire on お掃除, which is how a reviewer learns to click past it.
 */
describe("readings that are ordinary words stay out", () => {
  it("does not read おそう as 襲う", () => {
    assert.equal(assessSafety("今日は部屋のおそうじをした。").risk_level, "none");
    // The kanji spelling is still matched; only the reading is left out.
    assert.notEqual(assessSafety("あいつを襲うつもりだ。今すぐ。").risk_level, "none");
  });

  it("does not read じしょう as 自傷", () => {
    assert.equal(assessSafety("あの子は自称ゲーマーらしい。").risk_level, "none");
    assert.notEqual(assessSafety("自傷してしまった。").risk_level, "none");
  });

  it("leaves an ordinary diary entry alone", () => {
    for (const text of [
      "今日は体育祭の練習をして、すごく楽しかった。",
      "ラーメンとカレーを食べた。",
      "今日はつかれたけど、よく眠れそう。",
    ]) {
      assert.equal(assessSafety(text).risk_level, "none", text);
    }
  });
});

describe("the kana spelling table stays honest", () => {
  // The same reasoning as scripts/ui-strings-allowlist.mjs: an entry that no
  // longer names a live term is a claim about code that has since changed, and
  // left in place it reads as coverage that is not there.
  it("gives a reading only to terms the lexicons still carry", () => {
    const live = new Set(ALL_SAFETY_TERMS);
    const stale = KANA_SPELLING_KEYS.filter((key) => !live.has(key));
    assert.deepEqual(stale, [], `KANA_SPELLINGS keys naming no live term:\n${stale.join("\n")}`);
  });

  // #290 is an open false positive on 「今日」. Giving the imminence terms
  // readings before that is settled would make the same mistake louder.
  it("gives no reading to an imminence term", () => {
    for (const key of KANA_SPELLING_KEYS) {
      assert.ok(!["今すぐ", "今夜", "今日", "計画がある"].includes(key), key);
    }
  });
});

describe("escalateAssessment", () => {
  it("carries risk disclosed on another surface into a calm conversation", () => {
    // The student wrote the disclosure in the journal, then chatted about
    // nothing in particular; chat must not read as safe.
    const chat = assessSafety("idk. today was whatever.");
    assert.equal(chat.risk_level, "none");
    const carried = escalateAssessment(chat, "crisis", "risk_disclosed_on_another_surface");
    assert.equal(carried.risk_level, "crisis");
    assert.ok(hasEscalationMarker(carried.safe_response));
    assert.ok(carried.reasons.includes("risk_disclosed_on_another_surface"));
  });

  it("never lowers an assessment", () => {
    const crisis = assessSafety("I want to die tonight.");
    const unchanged = escalateAssessment(crisis, "low", "risk_disclosed_on_another_surface");
    assert.deepEqual(unchanged, crisis);
  });

  it("leaves reflection-card suppression to a real crisis", () => {
    const calm = assessSafety("today was whatever.");
    assert.equal(escalateAssessment(calm, "elevated", "x").escalation_required, false);
    assert.equal(escalateAssessment(calm, "crisis", "x").escalation_required, true);
  });
});

describe("routesToRealPerson", () => {
  it("recognises a reply that already offers a real-person route", () => {
    assert.equal(routesToRealPerson("Could you tell a trusted adult tonight?"), true);
    assert.equal(routesToRealPerson("Your school counselor can help with this."), true);
    assert.equal(routesToRealPerson("信頼できる大人に話してみてください。"), true);
  });

  it("does not mistake ordinary encouragement for a route", () => {
    assert.equal(routesToRealPerson("That sounds like a hard week. What helped last time?"), false);
  });

  // /api/chat appends safe_response only when this returns false, so a false
  // positive here would silence the deterministic floor.
  it("gates the chat safety floor on the assessment's own response text", () => {
    const crisis = assessSafety("I want to die tonight.");
    assert.ok(crisis.safe_response.length > 0);
    assert.equal(routesToRealPerson(crisis.safe_response), true);
  });
});
