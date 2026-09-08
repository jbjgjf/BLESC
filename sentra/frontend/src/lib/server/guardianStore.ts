/**
 * Database access for guardian verification (#164).
 *
 * Every function takes a service-role client, for the reason given at length in
 * `pilotStore.ts`: `pilot_guardian_verifications` has no grant to `anon` or
 * `authenticated` at all. The guardian's own request carries no session, so the
 * route handler holding the service-role key is necessarily the only place a
 * verification can be claimed — which is what keeps "confirm my own guardian
 * consent" from being a fetch a signed-in participant can write.
 *
 * The invariant these functions exist to keep: **a token is claimed exactly
 * once, by whoever presents it first, and a claim that does not finish is
 * released rather than left spent.**
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GUARDIAN_TOKEN_TTL_HOURS,
  type RequestedGrants,
  normalizeRequestedGrants,
} from "@/lib/guardianVerification";
import { generateGuardianToken, guardianTokenPrefix, hashGuardianToken } from "./guardianTokens";

export type GuardianVerificationRecord = {
  id: string;
  enrollment_id: string;
  owner_user_id: string;
  token_prefix: string;
  requested_grants: RequestedGrants;
  channel: string;
  expires_at: string;
  claimed_at: string | null;
  decision: "confirmed" | "declined" | null;
  decided_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

/**
 * Never includes `token_hash`.
 *
 * Not because a hash in a server process is dangerous on its own, but because
 * the status route returns rows from here to a browser, and a column that is
 * never selected cannot be accidentally serialised into one.
 */
const COLUMNS =
  "id, enrollment_id, owner_user_id, token_prefix, requested_grants, channel, expires_at, " +
  "claimed_at, decision, decided_at, revoked_at, created_at";

function expiryFrom(now: Date = new Date()): string {
  return new Date(now.getTime() + GUARDIAN_TOKEN_TTL_HOURS * 3600 * 1000).toISOString();
}

/** The newest verification for an enrollment, whatever state it is in. */
export async function latestVerification(
  client: SupabaseClient,
  enrollmentId: string,
): Promise<GuardianVerificationRecord | null> {
  const result = await client
    .from("pilot_guardian_verifications")
    .select(COLUMNS)
    .eq("enrollment_id", enrollmentId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot-guardian] verification lookup failed", result.error.message);
    return null;
  }
  return (result.data as unknown as GuardianVerificationRecord) ?? null;
}

/**
 * Issue a link.
 *
 * Outstanding requests for the same enrollment are revoked first, so that only
 * the newest link works. Two live links for one enrollment is a support problem
 * ("which one did I send?") before it is a security one, and revoking is
 * cheaper than explaining.
 *
 * Returns the clear-text token **once**. It is not stored and cannot be
 * recovered: a lost link is reissued, never looked up.
 */
export async function issueVerification(
  client: SupabaseClient,
  params: {
    enrollmentId: string;
    ownerUserId: string;
    requestedGrants: RequestedGrants;
    channel?: string;
  },
): Promise<{ token: string; record: GuardianVerificationRecord } | { error: string }> {
  const token = generateGuardianToken();
  const hash = hashGuardianToken(token);
  if (!hash) return { error: "unconfigured" };

  const revoked = await client
    .from("pilot_guardian_verifications")
    .update({ revoked_at: new Date().toISOString() })
    .eq("enrollment_id", params.enrollmentId)
    .is("decision", null)
    .is("revoked_at", null);
  if (revoked.error) {
    console.warn("[pilot-guardian] superseding earlier verifications failed", revoked.error.message);
    return { error: "error" };
  }

  const result = await client
    .from("pilot_guardian_verifications")
    .insert({
      enrollment_id: params.enrollmentId,
      owner_user_id: params.ownerUserId,
      token_hash: hash,
      token_prefix: guardianTokenPrefix(token),
      requested_grants: params.requestedGrants,
      channel: params.channel ?? "link",
      expires_at: expiryFrom(),
    })
    .select(COLUMNS)
    .single();

  if (result.error) {
    console.warn("[pilot-guardian] issuing verification failed", result.error.message);
    return { error: "error" };
  }

  return { token, record: result.data as unknown as GuardianVerificationRecord };
}

export type ClaimOutcome = "claimed" | "not_found" | "already_decided" | "expired" | "unconfigured" | "error";

/**
 * Take a token out of circulation, atomically, and return what it was issued
 * for.
 *
 * The `is("claimed_at", null)` in the filter is the whole mechanism: two
 * simultaneous presentations of the same link both run this UPDATE, exactly one
 * of them matches a row, and the other gets zero rows and is told the
 * verification was already answered. Doing the check as a SELECT followed by an
 * UPDATE would leave a window in which both succeed, and the losing request
 * would write a second consent record for a decision that was made once.
 *
 * Expiry is not part of the filter. A token that expired should say so rather
 * than reporting "no such token", and separating the two costs one read on a
 * path that runs at most a few hundred times in the whole study.
 */
export async function claimVerification(
  client: SupabaseClient,
  rawToken: string,
): Promise<{ outcome: ClaimOutcome; record?: GuardianVerificationRecord }> {
  const hash = hashGuardianToken(rawToken);
  if (!hash) return { outcome: "unconfigured" };

  const existing = await client
    .from("pilot_guardian_verifications")
    .select(COLUMNS)
    .eq("token_hash", hash)
    .maybeSingle();

  if (existing.error) {
    console.warn("[pilot-guardian] claim lookup failed", existing.error.message);
    return { outcome: "error" };
  }

  const row = (existing.data as unknown as GuardianVerificationRecord) ?? null;
  if (!row || row.revoked_at) return { outcome: "not_found" };
  if (row.decision) return { outcome: "already_decided", record: row };
  if (Date.parse(row.expires_at) <= Date.now()) return { outcome: "expired", record: row };

  const claimed = await client
    .from("pilot_guardian_verifications")
    .update({ claimed_at: new Date().toISOString() })
    .eq("id", row.id)
    .is("claimed_at", null)
    .is("decision", null)
    .is("revoked_at", null)
    .select(COLUMNS)
    .maybeSingle();

  if (claimed.error) {
    console.warn("[pilot-guardian] claim failed", claimed.error.message);
    return { outcome: "error" };
  }
  if (!claimed.data) return { outcome: "already_decided", record: row };

  return { outcome: "claimed", record: claimed.data as unknown as GuardianVerificationRecord };
}

/**
 * Read a token without spending it, for the screen the guardian sees before
 * they decide.
 *
 * Returns the row and nothing derived from it: what the guardian may be shown
 * is decided by the route, which has the study and the enrollment to hand.
 */
export async function peekVerification(
  client: SupabaseClient,
  rawToken: string,
): Promise<GuardianVerificationRecord | null> {
  const hash = hashGuardianToken(rawToken);
  if (!hash) return null;

  const result = await client
    .from("pilot_guardian_verifications")
    .select(COLUMNS)
    .eq("token_hash", hash)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot-guardian] peek failed", result.error.message);
    return null;
  }
  const row = (result.data as unknown as GuardianVerificationRecord) ?? null;
  return row && !row.revoked_at ? row : null;
}

/** Record the answer on a claimed row. */
export async function recordDecision(
  client: SupabaseClient,
  verificationId: string,
  decision: "confirmed" | "declined",
): Promise<boolean> {
  const result = await client
    .from("pilot_guardian_verifications")
    .update({ decision, decided_at: new Date().toISOString() })
    .eq("id", verificationId)
    .is("decision", null);

  if (result.error) {
    console.warn("[pilot-guardian] recording the decision failed", result.error.message);
    return false;
  }
  return true;
}

/**
 * Put a claimed token back.
 *
 * Called when the consent write or the state transition after a claim fails.
 * Without it, a guardian who hit a database error would be holding a link that
 * reports "already answered" for a decision that was never recorded, and the
 * only way forward would be an operator reissuing one. Releasing is safe
 * because the decision is what makes a row terminal, and this only runs on rows
 * that have none.
 */
export async function releaseClaim(client: SupabaseClient, verificationId: string): Promise<void> {
  const result = await client
    .from("pilot_guardian_verifications")
    .update({ claimed_at: null })
    .eq("id", verificationId)
    .is("decision", null);
  if (result.error) {
    console.warn("[pilot-guardian] releasing the claim failed", result.error.message);
  }
}

/** Normalise whatever the row carried, against the study's current document. */
export function requestedGrantsOf(
  record: GuardianVerificationRecord,
  documentVersion: string,
): RequestedGrants {
  return normalizeRequestedGrants(record.requested_grants, documentVersion);
}
