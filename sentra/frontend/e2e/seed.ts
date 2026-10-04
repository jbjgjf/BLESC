/**
 * The fixture the enrollment end-to-end tests run against (#164).
 *
 * Everything here is created through the service role against the *local*
 * stack. The seed refuses to run against anything else — a fixture that
 * deletes users is exactly the script that must not be pointed at a real
 * project by a stray environment variable.
 *
 * What it does not do is drive the UI. The states a participant reaches by
 * clicking (information read, assent, consent) are produced by the tests
 * themselves, because the clicking is what those tests are for. Only the
 * starting conditions — a study, some invitations, some accounts, and one
 * enrollment already collecting — are set up here.
 */

import { createHash, createHmac } from "node:crypto";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

import {
  INVITE_HMAC_KEY,
  RUN_ID,
  STUDY_SLUG,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./env";

export const PASSWORD = "e2e-password-1234";

/**
 * Fixed codes, 20 Crockford symbols each, shown to a participant in groups of
 * five the way `generateInviteCode` formats them.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A code for this run, derived from the run id so that the seed and the tests
 * — which evaluate this module in different processes — produce the same one.
 *
 * Derived rather than constant because `pilot_invitations.code_hash` is
 * unique: a fixed code can be inserted once, and the second run of the suite
 * would fail on the constraint rather than on anything it meant to test.
 *
 * Each participant gets their own code because `max_redemptions` defaults to
 * 1; sharing one would fail the second redemption for a reason unrelated to
 * what that test is checking.
 */
function codeFor(role: string): string {
  const digest = createHash("sha256").update(`${RUN_ID}:${role}`).digest();
  const symbols = Array.from(digest.subarray(0, 20), (byte) => ALPHABET[byte % ALPHABET.length]);
  return [0, 5, 10, 15].map((at) => symbols.slice(at, at + 5).join("")).join("-");
}

export const CODES = {
  adult: codeFor("adult"),
  minor: codeFor("minor"),
  expired: codeFor("expired"),
  decliner: codeFor("decliner"),
};

export const USERS = {
  /** Redeems, consents, reaches collection. 18 or over: no guardian step. */
  adult: `e2e-adult-${RUN_ID}@example.test`,
  /** Redeems as a minor and is held at the guardian step. */
  minor: `e2e-minor-${RUN_ID}@example.test`,
  /** Declines at the assent step. */
  decliner: `e2e-decline-${RUN_ID}@example.test`,
  /** Already collecting; withdraws from /pilot/join during the test. */
  withdrawer: `e2e-withdraw-${RUN_ID}@example.test`,
  /** Already collecting with research consent; withdraws from /consent (#263). */
  consentWithdrawer: `e2e-consent-withdraw-${RUN_ID}@example.test`,
  /** Has an account and nothing else. Used for the direct-URL check. */
  stranger: `e2e-stranger-${RUN_ID}@example.test`,
};

function normalize(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s\-–—_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

function hash(code: string): string {
  return createHmac("sha256", Buffer.from(INVITE_HMAC_KEY, "base64"))
    .update(normalize(code), "utf8")
    .digest("hex");
}

export function admin() {
  if (!/127\.0\.0\.1|localhost/.test(SUPABASE_URL)) {
    throw new Error(
      `Refusing to seed: ${SUPABASE_URL} is not a local Supabase stack. ` +
        "This script deletes users and studies.",
    );
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function createUser(client: SupabaseClient, email: string) {
  // No delete-then-create: the address carries the run id, so it is new every
  // time. Deleting an account that had enrolled would cascade into
  // `pilot_enrollment_events`, which refuses to be deleted.
  const created = await client.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw new Error(`could not create ${email}: ${created.error.message}`);
  return created.data.user;
}

/**
 * A participant already in `collecting`, with the research consent that
 * `enrolled` required. The consent row matters for the `/consent` path: a
 * withdrawal that only has a revocation to write, and nothing to revoke, would
 * pass for the wrong reason.
 */
async function seedCollecting(
  client: SupabaseClient,
  studyId: string,
  ownerUserId: string,
  researchCode: string,
  since: string,
) {
  const participant = await client
    .from("participants")
    .insert({
      owner_user_id: ownerUserId,
      code: "research_user_01",
      display_name: "E2E 撤回テスト",
    })
    .select("id")
    .single();
  if (participant.error) {
    throw new Error(`could not create the participant: ${participant.error.message}`);
  }

  const consent = await client.from("consent_records").insert({
    owner_user_id: ownerUserId,
    participant_id: participant.data.id,
    app_use: true,
    research_analysis: true,
    raw_text_retention: true,
    minor_assent: true,
    granted_at: since,
  });
  if (consent.error) throw new Error(`could not record consent: ${consent.error.message}`);

  const enrollment = await client.from("pilot_enrollments").insert({
    study_id: studyId,
    owner_user_id: ownerUserId,
    participant_id: participant.data.id,
    research_code: researchCode,
    cohort: "adult",
    state: "collecting",
    // Adult, so the guardian constraint does not apply to this fixture.
    is_minor: false,
    information_read_at: since,
    assented_at: since,
    enrolled_at: since,
    collection_started_at: since,
  });
  if (enrollment.error) {
    throw new Error(`could not create the enrollment: ${enrollment.error.message}`);
  }
}

export async function seed() {
  const client = admin();

  const study = await client
    .from("pilot_studies")
    .insert({
      slug: STUDY_SLUG,
      title: "E2E 参加登録テスト",
      status: "recruiting",
      observation_days: 7,
      baseline_days: 14,
    })
    .select("id")
    .single();
  if (study.error) throw new Error(`could not create the study: ${study.error.message}`);
  const studyId = study.data.id;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const invitations = await client.from("pilot_invitations").insert([
    { study_id: studyId, code_hash: hash(CODES.adult), code_prefix: normalize(CODES.adult).slice(0, 4), cohort: "adult" },
    { study_id: studyId, code_hash: hash(CODES.minor), code_prefix: normalize(CODES.minor).slice(0, 4), cohort: "minor" },
    { study_id: studyId, code_hash: hash(CODES.decliner), code_prefix: normalize(CODES.decliner).slice(0, 4), cohort: "adult" },
    {
      study_id: studyId,
      code_hash: hash(CODES.expired),
      code_prefix: normalize(CODES.expired).slice(0, 4),
      cohort: "expired",
      expires_at: yesterday,
    },
  ]);
  if (invitations.error) throw new Error(`could not create invitations: ${invitations.error.message}`);

  const users: Record<string, User> = {};
  for (const [role, email] of Object.entries(USERS)) {
    users[role] = await createUser(client, email);
  }

  // Both withdrawers start already collecting, because withdrawing from a
  // study you have not joined is not the case worth testing. There are two
  // because there are two doors, `/pilot/join` and `/consent`, and #263 was
  // that each door did half the job.
  await seedCollecting(client, studyId, users.withdrawer.id, "P-E2E-W1", yesterday);
  await seedCollecting(client, studyId, users.consentWithdrawer.id, "P-E2E-W2", yesterday);

  return { studyId, users };
}

export default async function globalSetup() {
  await seed();
}
