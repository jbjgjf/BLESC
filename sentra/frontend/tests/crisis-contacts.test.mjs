/**
 * The child SOS line reaches the student on every surface a crisis arrives on
 * (#465): the chat reply, the journal, and the spoken voice reply.
 *
 * The text itself is tested in `safety-assessment.test.mjs`. This file checks
 * the three places that decide whether that text is shown.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CHILD_SOS_DIAL, CRISIS_CONTACTS_PROVENANCE } from "../src/lib/crisisContacts.ts";

const read = (path) => readFileSync(path, "utf8");
const code = (path) => read(path).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

describe("where the support response is shown (#465)", () => {
  it("chat appends it unless the reply already gives a person and the number", () => {
    const chat = code("src/app/api/chat/route.ts");
    assert.match(chat, /replyCoversSafeResponse\(answer\)/);
    assert.ok(!chat.includes("routesToRealPerson("), "a person alone must not stand in for the number");
  });

  it("voice speaks it on the same rule", () => {
    const voice = code("src/components/VoiceMode.tsx");
    assert.match(voice, /replyCoversSafeResponse\(reply\)/);
    assert.ok(!voice.includes("routesToRealPerson("));
  });

  it("the journal receives it from the server and shows it after saving", () => {
    assert.match(code("src/app/api/entries/route.ts"), /safe_response: safetyAssessment\.safe_response/);
    const journal = code("src/app/journal/page.tsx");
    assert.match(journal, /setSupportMessage\(result\.safe_response/);
    // On the completion screen and while follow-up questions are asked.
    assert.match(journal, /<DoneScreen[^>]*supportMessage=\{supportMessage\}/);
    assert.match(journal, /phase === "followup" && <SupportNotice message=\{supportMessage\} \/>/);
  });

  it("the notice offers each number as a tel: link", () => {
    const notice = code("src/components/SupportNotice.tsx");
    assert.match(notice, /href=\{contact\.tel\}/);
    assert.match(notice, /CHILD_SOS_DIAL/);
    assert.match(notice, /EMERGENCY_NUMBERS\.ambulance/);
    assert.match(notice, /EMERGENCY_NUMBERS\.police/);
  });
});

describe("the contact record (#465)", () => {
  it("keeps the format the website's check reads", () => {
    // blesc.jp's CI fetches this file and compares it with `SOS_DIAL` in its
    // `src/lib/trust.ts` (BLESC-website `scripts/check-sos-dial.mjs`). It reads
    // these three lines by pattern, so they stay literal.
    const source = read("src/lib/crisisContacts.ts");
    assert.ok(source.includes(`name: "${CHILD_SOS_DIAL.name}"`));
    assert.ok(source.includes(`number: "${CHILD_SOS_DIAL.number}"`));
    assert.ok(source.includes(`tel: "${CHILD_SOS_DIAL.tel}"`));
  });

  it("says where the numbers come from and when they were last checked", () => {
    assert.match(CRISIS_CONTACTS_PROVENANCE.source, /^https:\/\/www\.mext\.go\.jp\//);
    assert.match(CRISIS_CONTACTS_PROVENANCE.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  });
});
