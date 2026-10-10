/**
 * The enrollment store, called (#382).
 *
 * `pilotStore.ts` is where an invitation becomes an enrollment and where an
 * enrollment changes state, under a service-role client that row-level
 * security does not restrain. Nothing called it: the neighbouring suites cover
 * the code format, the client-side screen logic and the guardian rules. These
 * call the functions and check what they return and what they asked of the
 * database.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { hashInviteCode, normalizeInviteCode } from "../src/lib/server/inviteCodes.ts";
import {
  advanceEnrollment,
  collectionOpen,
  invitationUsage,
  issueInvitations,
  loadEnrollment,
  loadEnrollmentByParticipant,
  redeemInvitation,
  revokeInvitations,
} from "../src/lib/server/pilotStore.ts";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const CODE = "A1B2C-D3E4F-G5H6J-K7M8N";
const ALICE = "user-alice";
const BOB = "user-bob";

let warn;
beforeEach(() => {
  process.env.PILOT_INVITE_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
  // The store logs each failure it absorbs; the failures here are deliberate.
  warn = console.warn;
  console.warn = () => {};
});
afterEach(() => {
  delete process.env.PILOT_INVITE_HMAC_KEY;
  console.warn = warn;
});

const redeem = (client, overrides = {}) =>
  redeemInvitation(client, {
    rawCode: CODE,
    ownerUserId: ALICE,
    participantId: "participant-alice",
    isMinor: true,
    ...overrides,
  });

const enrolledRow = {
  outcome: "enrolled",
  enrollment_id: "enrollment-1",
  study_slug: "pilot-2026",
  state: "account_bound",
  cohort: "3-B",
};
const collision = { code: "23505", message: "duplicate key value violates unique constraint" };

describe("redeemInvitation", () => {
  it("rejects a string that cannot be a code without asking the database", async () => {
    const client = fakeSupabase();
    assert.deepEqual(await redeem(client, { rawCode: "DRYRUN-0001" }), { outcome: "rejected" });
    assert.equal(client.rpcCalls.length, 0);
  });

  it("refuses every code when the HMAC key is missing", async () => {
    delete process.env.PILOT_INVITE_HMAC_KEY;
    const client = fakeSupabase();
    assert.deepEqual(await redeem(client), { outcome: "unconfigured" });
    assert.equal(client.rpcCalls.length, 0);
  });

  it("sends the keyed hash and the session's identity, never the code", async () => {
    const client = fakeSupabase({
      rpc: { redeem_pilot_invitation: () => ({ data: [enrolledRow], error: null }) },
    });
    const result = await redeem(client, { rawCode: "a1b2c d3e4f g5h6j k7m8n" });

    assert.deepEqual(result, {
      outcome: "enrolled",
      enrollment_id: "enrollment-1",
      study_slug: "pilot-2026",
      state: "account_bound",
      cohort: "3-B",
    });
    const { args } = client.rpcCalls[0];
    assert.equal(args.p_code_hash, hashInviteCode(CODE));
    assert.equal(args.p_owner_user_id, ALICE);
    assert.equal(args.p_participant_id, "participant-alice");
    assert.equal(args.p_is_minor, true);
    assert.ok(!JSON.stringify(args).includes(normalizeInviteCode(CODE)), "the code itself was sent");
  });

  it("retries a research-code collision with a fresh code each time", async () => {
    const client = fakeSupabase({
      rpc: {
        redeem_pilot_invitation: (_args, call) =>
          call < 2 ? { data: null, error: collision } : { data: [enrolledRow], error: null },
      },
    });
    assert.equal((await redeem(client)).outcome, "enrolled");

    const codes = client.rpcCalls.map((call) => call.args.p_research_code);
    assert.equal(codes.length, 3);
    assert.equal(new Set(codes).size, 3, `the same research code was retried: ${codes.join(", ")}`);
  });

  it("gives up after three collisions", async () => {
    const client = fakeSupabase({
      rpc: { redeem_pilot_invitation: () => ({ data: null, error: collision }) },
    });
    assert.deepEqual(await redeem(client), { outcome: "error" });
    assert.equal(client.rpcCalls.length, 3);
  });

  it("does not retry any other failure", async () => {
    const client = fakeSupabase({
      rpc: { redeem_pilot_invitation: () => ({ data: null, error: { code: "57014", message: "timeout" } }) },
    });
    assert.deepEqual(await redeem(client), { outcome: "error" });
    assert.equal(client.rpcCalls.length, 1);
  });

  it("passes the SQL function's verdict through", async () => {
    for (const outcome of ["rejected", "already_enrolled"]) {
      const client = fakeSupabase({
        rpc: {
          redeem_pilot_invitation: () => ({
            data: [{ outcome, enrollment_id: null, study_slug: null, state: null, cohort: null }],
            error: null,
          }),
        },
      });
      assert.deepEqual(await redeem(client), {
        outcome,
        enrollment_id: undefined,
        study_slug: undefined,
        state: undefined,
        cohort: undefined,
      });
    }
  });

  it("treats an empty answer as an error rather than as success", async () => {
    const client = fakeSupabase({ rpc: { redeem_pilot_invitation: () => ({ data: [], error: null }) } });
    assert.deepEqual(await redeem(client), { outcome: "error" });
  });
});

describe("advanceEnrollment", () => {
  const enrollments = () => ({
    pilot_enrollments: [{ id: "enrollment-1", owner_user_id: ALICE, state: "account_bound" }],
  });
  const advanced = { advance_pilot_enrollment: () => ({ data: [{ outcome: "ok", state: "information_read" }], error: null }) };
  const advance = (client, overrides = {}) =>
    advanceEnrollment(client, {
      enrollmentId: "enrollment-1",
      ownerUserId: ALICE,
      to: "information_read",
      actor: "participant",
      ...overrides,
    });

  it("does not advance a row that belongs to someone else", async () => {
    // The SQL function takes no owner and the client is service-role: this
    // read is the only thing between a session and another person's enrollment.
    const client = fakeSupabase({ tables: enrollments(), rpc: advanced });
    assert.deepEqual(await advance(client, { ownerUserId: BOB }), { outcome: "not_found" });
    assert.equal(client.rpcCalls.length, 0, "the transition ran for a non-owner");
  });

  it("does not advance when the ownership read fails", async () => {
    const client = fakeSupabase({ tables: enrollments(), rpc: advanced });
    client.failNext("pilot_enrollments");
    assert.deepEqual(await advance(client), { outcome: "error" });
    assert.equal(client.rpcCalls.length, 0);
  });

  it("advances the owner's row and records who acted", async () => {
    for (const actor of ["participant", "operator", "system", "guardian"]) {
      const client = fakeSupabase({ tables: enrollments(), rpc: advanced });
      assert.deepEqual(await advance(client, { actor }), { outcome: "ok", state: "information_read" });
      assert.deepEqual(client.rpcCalls[0].args, {
        p_enrollment_id: "enrollment-1",
        p_to_state: "information_read",
        p_actor: actor,
        p_reason: null,
      });
    }
  });

  it("passes a refusal through and reports a failed call as an error", async () => {
    const refused = fakeSupabase({
      tables: enrollments(),
      rpc: { advance_pilot_enrollment: () => ({ data: [{ outcome: "consent_missing", state: "participant_assented" }], error: null }) },
    });
    assert.deepEqual(await advance(refused, { to: "enrolled", reason: "from the join screen" }), {
      outcome: "consent_missing",
      state: "participant_assented",
    });
    assert.equal(refused.rpcCalls[0].args.p_reason, "from the join screen");

    const failed = fakeSupabase({
      tables: enrollments(),
      rpc: { advance_pilot_enrollment: () => ({ data: null, error: { message: "boom" } }) },
    });
    assert.deepEqual(await advance(failed), { outcome: "error" });
  });
});

describe("collectionOpen", () => {
  const withAnswer = (answer) => fakeSupabase({ rpc: { pilot_collection_open: () => answer } });

  it("is open only when the database says true", async () => {
    assert.equal(await collectionOpen(withAnswer({ data: true, error: null }), "p-1"), true);
    assert.equal(await collectionOpen(withAnswer({ data: false, error: null }), "p-1"), false);
    assert.equal(await collectionOpen(withAnswer({ data: null, error: null }), "p-1"), false);
    assert.equal(await collectionOpen(withAnswer({ data: "true", error: null }), "p-1"), false);
  });

  it("is closed when the check itself fails", async () => {
    const client = withAnswer({ data: true, error: { message: "timeout" } });
    assert.equal(await collectionOpen(client, "p-1"), false);
    assert.deepEqual(client.rpcCalls[0].args, { target_participant: "p-1" });
  });
});

describe("issueInvitations", () => {
  it("returns each code once and stores only its hash", async () => {
    const client = fakeSupabase();
    const { issued, error } = await issueInvitations(client, { studyId: "study-1", count: 3, cohort: "3-B" });

    assert.equal(error, undefined);
    assert.equal(issued.length, 3);
    assert.equal(new Set(issued.map((item) => item.code)).size, 3);

    const stored = client.tables.pilot_invitations;
    assert.equal(stored.length, 3);
    const storedText = JSON.stringify(stored);
    issued.forEach((item, index) => {
      assert.ok(!storedText.includes(item.code), "a clear-text code was stored");
      assert.ok(!storedText.includes(normalizeInviteCode(item.code)), "a clear-text code was stored");
      assert.equal(stored[index].code_hash, hashInviteCode(item.code));
      assert.equal(stored[index].code_prefix, item.prefix);
      assert.equal(stored[index].study_id, "study-1");
      assert.equal(stored[index].cohort, "3-B");
      assert.equal(stored[index].max_redemptions, 1);
    });
  });

  it("leaves the age band unset unless the coordinator answered", async () => {
    const client = fakeSupabase();
    await issueInvitations(client, { studyId: "study-1", count: 1 });
    await issueInvitations(client, { studyId: "study-1", count: 1, isMinor: false });
    assert.deepEqual(client.tables.pilot_invitations.map((row) => row.is_minor), [null, false]);
  });

  it("issues nothing without the key", async () => {
    delete process.env.PILOT_INVITE_HMAC_KEY;
    const client = fakeSupabase();
    const result = await issueInvitations(client, { studyId: "study-1", count: 2 });
    assert.deepEqual(result.issued, []);
    assert.match(result.error, /PILOT_INVITE_HMAC_KEY/);
    assert.equal(client.calls.length, 0);
  });

  it("hands out no code that was not stored", async () => {
    const client = fakeSupabase();
    client.failNext("pilot_invitations", { message: "insert failed" });
    assert.deepEqual(await issueInvitations(client, { studyId: "study-1", count: 2 }), {
      issued: [],
      error: "insert failed",
    });
  });
});

describe("invitationUsage and revokeInvitations", () => {
  const invitations = () => ({
    pilot_invitations: [
      { id: 1, study_id: "study-1", code_hash: "hash-1", code_prefix: "A1B2", cohort: "3-B", redeemed_count: 1, max_redemptions: 1, revoked_at: null, expires_at: null, note: null, created_at: "2026-10-01" },
      { id: 2, study_id: "study-1", code_hash: "hash-2", code_prefix: "A1B2", cohort: "3-B", redeemed_count: 0, max_redemptions: 1, revoked_at: "2026-10-02T00:00:00Z", expires_at: null, note: "lost", created_at: "2026-10-02" },
      { id: 3, study_id: "study-1", code_hash: "hash-3", code_prefix: "ZZZZ", cohort: "3-C", redeemed_count: 0, max_redemptions: 1, revoked_at: null, expires_at: null, note: null, created_at: "2026-10-03" },
      { id: 4, study_id: "study-2", code_hash: "hash-4", code_prefix: "A1B2", cohort: "x", redeemed_count: 0, max_redemptions: 1, revoked_at: null, expires_at: null, note: null, created_at: "2026-10-04" },
    ],
  });

  it("reports usage for one study, newest first, without the hashes", async () => {
    const usage = await invitationUsage(fakeSupabase({ tables: invitations() }), "study-1");
    assert.deepEqual(usage.map((row) => [row.prefix, row.redeemed, row.max, row.revoked]), [
      ["ZZZZ", 0, 1, false],
      ["A1B2", 0, 1, true],
      ["A1B2", 1, 1, false],
    ]);
    assert.ok(!JSON.stringify(usage).includes("hash-"), "a code hash reached the operator screen");
  });

  it("revokes every live invitation with the prefix, in that study only", async () => {
    const client = fakeSupabase({ tables: invitations() });
    assert.deepEqual(await revokeInvitations(client, { studyId: "study-1", prefix: "a1b2" }), { revoked: 1 });

    const rows = client.tables.pilot_invitations;
    assert.ok(rows[0].revoked_at, "the live invitation was not revoked");
    assert.equal(rows[1].revoked_at, "2026-10-02T00:00:00Z", "an earlier revocation was re-stamped");
    assert.equal(rows[2].revoked_at, null, "another prefix was revoked");
    assert.equal(rows[3].revoked_at, null, "another study's invitation was revoked");
  });

  it("reports a failed revocation as zero revoked", async () => {
    const client = fakeSupabase({ tables: invitations() });
    client.failNext("pilot_invitations", { message: "nope" });
    assert.deepEqual(await revokeInvitations(client, { studyId: "study-1", prefix: "A1B2" }), {
      revoked: 0,
      error: "nope",
    });
  });
});

describe("loading enrollments", () => {
  const row = (id, state, created_at, extra = {}) => ({
    id,
    study_id: "study-1",
    owner_user_id: ALICE,
    participant_id: "participant-alice",
    state,
    created_at,
    ...extra,
  });

  it("returns the newest enrollment that is neither withdrawn nor completed", async () => {
    const client = fakeSupabase({
      tables: {
        pilot_enrollments: [
          row("old-live", "collecting", "2026-09-01"),
          row("new-live", "participant_assented", "2026-10-01"),
          row("newer-withdrawn", "withdrawn", "2026-10-05"),
          row("newest-completed", "completed", "2026-10-06"),
          row("bobs", "collecting", "2026-10-07", { owner_user_id: BOB }),
          row("other-participant", "collecting", "2026-10-08", { participant_id: "participant-other" }),
        ],
      },
    });
    const found = await loadEnrollmentByParticipant(client, ALICE, "participant-alice");
    assert.equal(found.id, "new-live");
    assert.equal(found.owner_user_id, undefined, "the owner id is returned to callers that send rows to a browser");
  });

  it("returns null when every enrollment has ended, and when the read fails", async () => {
    const client = fakeSupabase({ tables: { pilot_enrollments: [row("gone", "withdrawn", "2026-10-01")] } });
    assert.equal(await loadEnrollmentByParticipant(client, ALICE, "participant-alice"), null);

    client.failNext("pilot_enrollments");
    assert.equal(await loadEnrollment(client, ALICE, "study-1"), null);
  });

  it("finds an enrollment only for its owner", async () => {
    const client = fakeSupabase({ tables: { pilot_enrollments: [row("e-1", "collecting", "2026-10-01")] } });
    assert.equal((await loadEnrollment(client, ALICE, "study-1")).id, "e-1");
    assert.equal(await loadEnrollment(client, BOB, "study-1"), null);
  });
});
