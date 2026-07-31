import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessSafety, routesToRealPerson } from "../src/lib/safety-assessment.ts";

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
