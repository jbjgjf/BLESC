/**
 * The operator console calls the operator routes, and does not become a way to
 * hand a student their own guardian's consent (#B2).
 *
 * The console exists because the alternative was `curl` with a bearer token for
 * 50 invitation codes and 50 guardian links. Three properties have to hold, and
 * two of them are about what the screen must NOT do.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const page = read("../src/app/pilot/ops/page.tsx");
const client = read("../src/lib/pilotOpsClient.ts");

/** Comments explain the rules, so a naive grep finds the rule in its own rationale. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const pageCode = code(page);

describe("the console reaches every operator route", () => {
  const routes = [
    "/pilot/admin/invitations",
    "/pilot/guardian/issue",
    "/pilot/admin/enrollment",
  ];

  for (const route of routes) {
    it(`calls ${route}`, () => {
      assert.ok(
        client.includes(route),
        `${route} had no caller before this console; it must have one now`,
      );
    });
  }

  it("goes through ApiClient, so the operator's own session authorizes it", () => {
    // Not a service key in the browser, and not a token pasted into a field:
    // the allowlist is checked server-side against the signed-in user.
    assert.match(client, /from "@\/api\/client"/);
    assert.doesNotMatch(client, /SERVICE_ROLE/);
  });
});

describe("what the console must not do", () => {
  it("never offers to re-display an invitation code", () => {
    // The database holds an HMAC. A button that promises to show the codes
    // again is a button that cannot work, and the operator will trust it.
    assert.doesNotMatch(pageCode, /再表示|もう一度表示|reveal/i);
  });

  it("makes closing the code panel a deliberate act", () => {
    assert.match(
      pageCode,
      /window\.confirm\(/,
      "closing the only copy of 50 codes must not be a stray click",
    );
  });

  it("says out loud that the guardian link is not for the student", () => {
    assert.match(
      page,
      /生徒には渡さないでください/,
      "anyone holding the link can complete the confirmation (PR #170)",
    );
  });

  it("does not let the operator withdraw a participant", () => {
    // Withdrawal is the participant's own decision. The server refuses it on
    // this route; the screen must not offer it either.
    assert.doesNotMatch(pageCode, /"withdrawn"/);
  });
});

describe("the batch result is readable as an operator reads it", () => {
  it("treats consent_missing as a wait, not a failure", () => {
    // Shown as an error, this is what makes someone re-run the batch on the
    // morning of day 0.
    assert.match(pageCode, /consent_missing/);
    assert.match(page, /正常な待ち|通常の状態/);
  });

  it("derives the action buttons from the shared transition list", () => {
    assert.match(page, /OPERATOR_TRANSITIONS/);
    assert.match(page, /from "@\/lib\/pilotEnrollment"/);
  });
});

describe("issuing decides the age band on the operator's side", () => {
  it("sends is_minor with the batch", () => {
    // Asking the participant is how a minor who picks "18歳以上" skips the
    // guardian step entirely.
    assert.match(pageCode, /is_minor/);
    assert.match(page, /配る側が決めます/);
  });
});
