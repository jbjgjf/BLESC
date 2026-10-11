/**
 * Guardian verification storage: 72 hours, single use, superseded on re-request (#383).
 *
 * These are the three properties the consent documents describe to a guardian
 * (#325 checks the wording against them by hand). Here they are behaviour:
 * the store is called against an in-memory client and a clock that is moved.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { GUARDIAN_TOKEN_TTL_HOURS } from "../src/lib/guardianVerification.ts";
import {
  claimVerification,
  issueVerification,
  latestVerification,
  peekVerification,
  recordDecision,
  releaseClaim,
  requestVerification,
} from "../src/lib/server/guardianStore.ts";
import { hashGuardianToken } from "../src/lib/server/guardianTokens.ts";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const TABLE = "pilot_guardian_verifications";
const T0 = Date.parse("2026-10-10T00:00:00Z");
const HOUR = 3600 * 1000;
const GRANTS = {
  anonymized_export: true,
  raw_text_retention: false,
  model_training_use: false,
  document_version: "research-consent-doc-v1",
};

let warn;
let client;

beforeEach(() => {
  process.env.PILOT_GUARDIAN_HMAC_KEY = Buffer.alloc(32, 3).toString("base64");
  mock.timers.enable({ apis: ["Date"], now: T0 });
  warn = console.warn;
  console.warn = () => {};
  client = fakeSupabase({
    defaults: {
      // Ids and timestamps the database would assign. `created_at` advances
      // with the row count so "newest" is well defined at one frozen instant.
      [TABLE]: (count) => ({ id: `verification-${count + 1}`, created_at: new Date(T0 + count).toISOString() }),
    },
  });
});
afterEach(() => {
  mock.timers.reset();
  console.warn = warn;
  delete process.env.PILOT_GUARDIAN_HMAC_KEY;
});

const request = (grants = GRANTS) =>
  requestVerification(client, { enrollmentId: "enrollment-1", ownerUserId: "user-alice", requestedGrants: grants });

/** A requested and issued verification: `{ token, record }`. */
async function issued() {
  const { record } = await request();
  return issueVerification(client, { verificationId: record.id, issuedBy: "operator-1" });
}

const stored = (id) => client.tables[TABLE].find((row) => row.id === id);

describe("requesting and issuing", () => {
  it("a request carries no token; issuing returns one once and stores only its hash", async () => {
    const { record: requested } = await request();
    assert.equal(requested.token_prefix, null);
    assert.equal(stored(requested.id).token_hash, undefined);

    const { token, record } = await issueVerification(client, { verificationId: requested.id, issuedBy: "operator-1" });
    const row = stored(requested.id);
    assert.equal(row.token_hash, hashGuardianToken(token));
    assert.equal(row.issued_by, "operator-1");
    assert.equal(record.token_prefix, token.slice(0, 6));
    assert.ok(!JSON.stringify(client.tables).includes(token), "the clear-text token was stored");
    assert.ok(!("token_hash" in record), "the hash is returned to a caller that answers a browser");
  });

  it("issues nothing without the key", async () => {
    const { record } = await request();
    delete process.env.PILOT_GUARDIAN_HMAC_KEY;
    assert.deepEqual(await issueVerification(client, { verificationId: record.id, issuedBy: "operator-1" }), {
      error: "unconfigured",
    });
    assert.equal(stored(record.id).expires_at, undefined);
  });

  it("does not issue a link for a request that was answered or revoked", async () => {
    const { record } = await issued();
    await recordDecision(client, record.id, "declined");
    assert.deepEqual(await issueVerification(client, { verificationId: record.id, issuedBy: "operator-1" }), {
      error: "not_issuable",
    });
  });
});

describe("72 hours", () => {
  it("a link expires 72 hours after it is issued", async () => {
    assert.equal(GUARDIAN_TOKEN_TTL_HOURS, 72);
    const { record } = await issued();
    assert.equal(Date.parse(record.expires_at), T0 + 72 * HOUR);
  });

  it("is accepted one second before the deadline", async () => {
    const { token } = await issued();
    mock.timers.setTime(T0 + 72 * HOUR - 1000);
    assert.equal((await claimVerification(client, token)).outcome, "claimed");
  });

  it("is refused at the deadline, as expired, and is not spent", async () => {
    const { token, record } = await issued();
    mock.timers.setTime(T0 + 72 * HOUR);
    assert.equal((await claimVerification(client, token)).outcome, "expired");
    assert.equal(stored(record.id).claimed_at, undefined);
  });
});

describe("single use", () => {
  it("the second presentation of a link is told it was already answered", async () => {
    const { token } = await issued();
    assert.equal((await claimVerification(client, token)).outcome, "claimed");
    assert.equal((await claimVerification(client, token)).outcome, "already_decided");
  });

  it("two simultaneous presentations produce exactly one claim", async () => {
    const { token } = await issued();
    const outcomes = (await Promise.all([claimVerification(client, token), claimVerification(client, token)])).map(
      (result) => result.outcome,
    );
    assert.deepEqual(outcomes.sort(), ["already_decided", "claimed"]);
  });

  it("a decided link stays decided and its decision is not overwritten", async () => {
    const { token, record } = await issued();
    await claimVerification(client, token);
    assert.equal(await recordDecision(client, record.id, "declined"), true);
    // Not an error to the database, and not a second record either (#298).
    assert.equal(await recordDecision(client, record.id, "confirmed"), false);

    assert.equal(stored(record.id).decision, "declined");
    assert.equal((await claimVerification(client, token)).outcome, "already_decided");
  });

  it("says nothing was recorded when there is no such verification, or the write fails", async () => {
    const { record } = await issued();
    assert.equal(await recordDecision(client, "verification-that-does-not-exist", "declined"), false);
    client.failNext(TABLE);
    assert.equal(await recordDecision(client, record.id, "declined"), false);
    assert.equal(stored(record.id).decision, undefined);
  });

  it("a claim that could not be completed is released and can be presented again", async () => {
    const { token, record } = await issued();
    await claimVerification(client, token);
    assert.equal(await releaseClaim(client, record.id), true);
    assert.equal((await claimVerification(client, token)).outcome, "claimed");
  });

  it("releasing does not reopen a link that was answered", async () => {
    const { token, record } = await issued();
    await claimVerification(client, token);
    await recordDecision(client, record.id, "confirmed");
    assert.equal(await releaseClaim(client, record.id), false, "a decided link was reported as released");
    assert.equal((await claimVerification(client, token)).outcome, "already_decided");
  });

  it("a token nobody issued, and any token without the key, claim nothing", async () => {
    const { token } = await issued();
    assert.equal((await claimVerification(client, "x".repeat(43))).outcome, "not_found");
    assert.equal((await claimVerification(client, token.toLowerCase())).outcome, "not_found");

    delete process.env.PILOT_GUARDIAN_HMAC_KEY;
    assert.equal((await claimVerification(client, token)).outcome, "unconfigured");
    assert.equal(await peekVerification(client, token), null);
  });

  it("a failed read claims nothing", async () => {
    const { token, record } = await issued();
    client.failNext(TABLE);
    assert.equal((await claimVerification(client, token)).outcome, "error");
    assert.equal(stored(record.id).claimed_at, undefined);
  });
});

describe("re-requesting", () => {
  it("before a link exists, changes the outstanding request instead of adding a second", async () => {
    const { record: first } = await request();
    const { record: second } = await request({ ...GRANTS, raw_text_retention: true });

    assert.equal(second.id, first.id);
    assert.equal(client.tables[TABLE].length, 1);
    assert.equal(stored(first.id).requested_grants.raw_text_retention, true);
  });

  it("after a link was issued, revokes that link and starts a request with no token", async () => {
    const { token, record: old } = await issued();
    const { record: fresh } = await request({ ...GRANTS, raw_text_retention: true });

    assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.token_prefix, null);
    assert.ok(stored(old.id).revoked_at, "the superseded link was not revoked");

    // The link already handed to the guardian describes the old question.
    assert.equal((await claimVerification(client, token)).outcome, "not_found");
    assert.equal(await peekVerification(client, token), null);
    assert.equal((await latestVerification(client, "enrollment-1")).id, fresh.id);
  });

  it("the re-issued link works and the old one still does not", async () => {
    const { token: oldToken } = await issued();
    const { token: newToken } = await issued();

    assert.notEqual(newToken, oldToken);
    assert.equal((await claimVerification(client, oldToken)).outcome, "not_found");
    assert.equal((await claimVerification(client, newToken)).outcome, "claimed");
  });

  it("after a decision, a new request leaves the decided row as it was", async () => {
    const { token, record: decided } = await issued();
    await claimVerification(client, token);
    await recordDecision(client, decided.id, "declined");

    const { record: fresh } = await request();
    assert.notEqual(fresh.id, decided.id);
    assert.equal(stored(decided.id).decision, "declined");
    assert.equal(stored(decided.id).revoked_at, undefined);
  });

  it("reports a failed supersede instead of leaving two live requests", async () => {
    await issued();
    client.failNext(TABLE, null); // the read of the outstanding row succeeds
    client.failNext(TABLE); // the revoke fails
    assert.deepEqual(await request(), { error: "error" });
    assert.equal(client.tables[TABLE].length, 1);
  });
});

describe("peeking", () => {
  it("shows the row without spending the link", async () => {
    const { token, record } = await issued();
    assert.equal((await peekVerification(client, token)).id, record.id);
    assert.equal(stored(record.id).claimed_at, undefined);
    assert.equal((await claimVerification(client, token)).outcome, "claimed");
  });
});
