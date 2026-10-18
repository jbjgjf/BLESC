import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { EMERGENCY_LINES, SOS_DIAL, namesSosDial } from "../src/lib/crisisContacts.ts";
import { SAFETY_CARD_TITLE, assessSafety } from "../src/lib/safety-assessment.ts";
import { safetySupportFrom } from "../src/lib/safetySupport.ts";

/**
 * #465. blesc.jp promises that a student who writes about self-harm or
 * immediate danger sees a support line on screen, naming 文部科学省
 * 「24時間子供SOSダイヤル」 0120-0-78310. The canned responses named no line and
 * no number, and carried English glosses; the journal never showed them at all.
 *
 * jbjgjf/BLESC-website's `scripts/check-crisis-contacts.mjs` holds the other
 * end: it compares the site's SOS_DIAL with `shared/crisis_contacts.json`,
 * which this file pins to `crisisContacts.ts`.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED = JSON.parse(readFileSync(resolve(HERE, "../../shared/crisis_contacts.json"), "utf8"));
const SAFETY_CONTRACT = JSON.parse(
  readFileSync(resolve(HERE, "../../shared/safety_assessment_conformance.json"), "utf8"),
);
const source = (path) => readFileSync(resolve(HERE, "..", path), "utf8");

const LEVELS = [
  ["crisis", "もう死にたい"],
  ["elevated", "もう限界"],
];

describe("crisis contacts are kept in one place", () => {
  it("matches the shared file the backend and the site read", () => {
    assert.deepEqual({ ...SOS_DIAL }, SHARED.sos_dial);
    assert.deepEqual(EMERGENCY_LINES.map((line) => ({ ...line })), SHARED.emergency);
  });

  it("dials the number it displays", () => {
    for (const line of [SOS_DIAL, ...EMERGENCY_LINES]) {
      assert.equal(line.tel, `tel:${line.number.replace(/-/g, "")}`, line.name);
    }
  });

  it("records whether the number was read off the official page", () => {
    // Not asserting `verified` — that is a person's job, not a test's. Asserting
    // the record exists, so the gap stays visible instead of being forgotten.
    assert.ok(["verified", "unverified"].includes(SHARED.verification.status));
    if (SHARED.verification.status === "verified") {
      assert.match(SHARED.verification.verified_on ?? "", /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(SHARED.verification.verified_by);
    }
  });
});

describe("every surface names the lines, at both levels", () => {
  for (const [level, text] of LEVELS) {
    const response = assessSafety(text).safe_response;

    it(`${level}: the response names the dial, its number and the emergency numbers`, () => {
      assert.equal(assessSafety(text).risk_level, level);
      assert.ok(response.includes(SOS_DIAL.name), response);
      assert.ok(response.includes(SOS_DIAL.number), response);
      for (const line of EMERGENCY_LINES) assert.ok(response.includes(line.number), line.number);
      assert.equal(response, SAFETY_CONTRACT.responses[level]);
    });

    it(`${level}: no English gloss is left in the text`, () => {
      // 「SOS」 and 「blesc」 are names; a gloss is an English word in brackets.
      assert.doesNotMatch(response, /（[A-Za-z]/);
      assert.doesNotMatch(response, /emergency|trusted|adult|service/i);
    });

    it(`${level}: chat appends it unless the reply already gave the number`, () => {
      // The floor in /api/chat steps aside on `namesSosDial`. A reply that only
      // mentions a trusted adult must not be enough, as it used to be.
      assert.equal(namesSosDial("信頼できる大人に話してみてください。"), false);
      assert.equal(namesSosDial(response), true);
    });

    it(`${level}: the journal shows it`, () => {
      const support = safetySupportFrom({ safety_assessment_json: assessSafety(text) });
      assert.deepEqual(support, { level, body: response });
    });

    it(`${level}: voice is handed it to speak`, () => {
      // /api/voice/turn returns `safety.safe_response`; VoiceMode speaks it
      // unless the reply already said the number.
      assert.match(source("src/app/api/voice/turn/route.ts"), /safe_response: safety\.safe_response/);
      assert.ok(response.includes(SOS_DIAL.number));
    });
  }

  it("shows nothing below elevated", () => {
    assert.equal(safetySupportFrom({ safety_assessment_json: assessSafety("今日は数学のテストだった") }), null);
    assert.equal(safetySupportFrom({ safety_assessment_json: assessSafety("パニックになった") }), null);
    assert.equal(safetySupportFrom(undefined), null);
  });

  it("titles the journal card in Japanese, from the shared contract", () => {
    assert.deepEqual({ ...SAFETY_CARD_TITLE }, SAFETY_CONTRACT.card_titles);
    for (const title of Object.values(SAFETY_CARD_TITLE)) assert.doesNotMatch(title, /[A-Za-z]/);
  });
});

describe("namesSosDial", () => {
  it("recognises the number however it is written", () => {
    for (const text of ["0120-0-78310", "0120078310", "０１２０－０－７８３１０", "0120 0 78310", "0120ー0ー78310"]) {
      assert.equal(namesSosDial(`電話は ${text} です`), true, text);
    }
  });

  it("does not mistake a route without the number for the number", () => {
    assert.equal(namesSosDial("24時間子供SOSダイヤルに電話してね"), false);
    assert.equal(namesSosDial("119に電話してください"), false);
  });
});

describe("the surfaces are wired to it", () => {
  it("chat and voice gate the floor on the number, not on any real-person route", () => {
    for (const path of ["src/app/api/chat/route.ts", "src/components/VoiceMode.tsx"]) {
      const text = source(path);
      assert.match(text, /namesSosDial\(/, path);
      assert.doesNotMatch(text, /routesToRealPerson\(/, path);
    }
  });

  it("the journal card carries the response at both levels", () => {
    const route = source("src/app/api/entries/route.ts");
    assert.match(route, /reflection_cards_json: safetySupportCards\(entryId, safetyAssessment\)/);
    assert.match(route, /safety\.risk_level === "elevated"/);
    assert.doesNotMatch(route, /Support first/);
  });

  it("the journal screen renders the support and does not put the follow-up script before it", () => {
    const page = source("src/app/journal/page.tsx");
    assert.match(page, /safetySupportFrom\(result\.extraction\)/);
    assert.match(page, /!supportRef\.current\)/);
    assert.match(page, /<SafetySupportPanel support=\{support\} \/>/);
  });
});
