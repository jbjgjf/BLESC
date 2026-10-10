/**
 * A guardian's "no" is recorded, or they are told it was not (#298).
 *
 * `recordDecision` used to answer true whenever the database reported no
 * error — including when the update matched no row. The decline path trusted
 * that, so a guardian could be shown 「記録しました」 over a verification that
 * still had no decision and a link that was already spent. The route is called
 * here, against an in-memory database in which the row changes underneath it.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient } from "./helpers/route-loader.mjs";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const { NextRequest } = await import("next/server.js");
const { generateGuardianToken, hashGuardianToken } = await import("../src/lib/server/guardianTokens.ts");
const { POST } = await import("../src/app/api/pilot/guardian/confirm/route.ts");

const TABLE = "pilot_guardian_verifications";

let warn;
let warnings;
let service;
let token;
let row;

beforeEach(() => {
  process.env.PILOT_GUARDIAN_HMAC_KEY = Buffer.alloc(32, 3).toString("base64");
  warn = console.warn;
  warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  token = generateGuardianToken();
  row = {
    id: "verification-1",
    enrollment_id: "enrollment-1",
    token_hash: hashGuardianToken(token),
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    claimed_at: null,
    decision: null,
    decided_at: null,
    revoked_at: null,
  };
  service = fakeSupabase({
    tables: { [TABLE]: [row] },
    rpc: { bump_rate_limit: () => ({ data: 1, error: null }) },
  });
  setServiceClient(service);
});
afterEach(() => {
  console.warn = warn;
  setServiceClient(null);
  delete process.env.PILOT_GUARDIAN_HMAC_KEY;
});

const decline = () =>
  POST(
    new NextRequest("http://localhost/api/pilot/guardian/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify({ token, decision: "declined" }),
    }),
  );

/** Run `change` just before the route's nth operation on the verifications table. */
function beforeTableCall(n, change) {
  const from = service.from.bind(service);
  let calls = 0;
  service.from = (table) => {
    if (table === TABLE && (calls += 1) === n) change();
    return from(table);
  };
}

describe("declining", () => {
  it("is recorded, and the guardian is told so", async () => {
    const response = await decline();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "recorded", decision: "declined" });
    assert.equal(row.decision, "declined");
    assert.ok(row.decided_at);
  });

  it("is not reported as recorded when the verification vanished before the answer was written", async () => {
    // Lookup, claim, then the decision: the third operation finds no row.
    beforeTableCall(3, () => service.tables[TABLE].splice(0, 1));

    const response = await decline();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.notEqual(body.status, "recorded");
    assert.match(body.detail, /記録できませんでした/);
  });

  it("is not reported as recorded when another request decided first, and does not overwrite that decision", async () => {
    beforeTableCall(3, () => Object.assign(row, { decision: "confirmed", decided_at: "2026-10-10T00:00:00Z" }));

    const response = await decline();
    assert.equal(response.status, 502);
    assert.notEqual((await response.json()).status, "recorded");
    assert.equal(row.decision, "confirmed", "a decline replaced a decision that had been recorded");
  });

  it("gives the link back when the write fails, so the guardian can answer again", async () => {
    beforeTableCall(3, () => service.failNext(TABLE, { message: "connection reset" }));

    const failed = await decline();
    assert.equal(failed.status, 502);
    assert.equal(row.claimed_at, null, "the link stayed claimed after a failed write");
    assert.equal(row.decision, null);

    const retried = await decline();
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { status: "recorded", decision: "declined" });
  });

  it("says in the log when the link could not be given back", async () => {
    // The row is gone: nothing to record on and nothing to release.
    beforeTableCall(3, () => service.tables[TABLE].splice(0, 1));
    await decline();
    assert.ok(
      warnings.some((line) => line.includes("could not be released") && line.includes("verification-1")),
      `no warning names the stuck link: ${JSON.stringify(warnings)}`,
    );
  });
});
