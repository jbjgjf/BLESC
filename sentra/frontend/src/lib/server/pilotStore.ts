/**
 * Database access for pilot enrollment (#163).
 *
 * Every function here takes a service-role client. That is not a convenience:
 * `pilot_invitations` has no policy and no grant to `authenticated` at all, and
 * `pilot_enrollments` grants SELECT only, so a participant's own session cannot
 * perform a redemption or a transition even on their own row. The route
 * handlers hold the service-role key and are therefore the only place a
 * transition can originate — which is the point, since the browser is where an
 * attacker would otherwise set their own state to `collecting`.
 *
 * The rule this file exists to keep: **the caller's identity comes from the
 * session, never from the request body.** Every function takes `ownerUserId`
 * as a parameter and every route derives it from `requireUser`. A body-supplied
 * user id under a service-role client is a full account takeover.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { generateResearchCode, hashInviteCode, inviteCodePrefix, normalizeInviteCode } from "./inviteCodes";
import type { PilotState } from "@/lib/pilotEnrollment";

export type PilotStudy = {
  id: string;
  slug: string;
  title: string;
  status: string;
  protocol_version: string;
  consent_document_version: string;
  baseline_days: number;
  observation_days: number;
  is_dry_run: boolean;
};

export type PilotEnrollmentRow = {
  id: string;
  study_id: string;
  research_code: string;
  cohort: string;
  state: PilotState;
  is_minor: boolean;
  information_read_at: string | null;
  assented_at: string | null;
  guardian_verified_at: string | null;
  enrolled_at: string | null;
  collection_started_at: string | null;
  collection_ends_at: string | null;
  withdrawn_at: string | null;
  completed_at: string | null;
};

const ENROLLMENT_COLUMNS =
  "id, study_id, research_code, cohort, state, is_minor, information_read_at, assented_at, " +
  "guardian_verified_at, enrolled_at, collection_started_at, collection_ends_at, withdrawn_at, completed_at";

/**
 * Why a redemption did not produce an enrollment.
 *
 * `rejected` covers "no such code", "expired", "revoked", "already used" and
 * "study is not recruiting" as one outcome, and the SQL function collapses them
 * the same way. Telling a caller which one it was lets them probe the code
 * space: "expired" confirms a code existed. The operator can still tell the
 * difference — from `pilot_invitations`, through the admin route.
 */
export type RedeemOutcome = "enrolled" | "already_enrolled" | "rejected" | "unconfigured" | "error";

export type RedeemResult = {
  outcome: RedeemOutcome;
  enrollment_id?: string;
  study_slug?: string;
  state?: PilotState;
  cohort?: string;
};

export async function loadStudyBySlug(client: SupabaseClient, slug: string): Promise<PilotStudy | null> {
  const result = await client
    .from("pilot_studies")
    .select("id, slug, title, status, protocol_version, consent_document_version, baseline_days, observation_days, is_dry_run")
    .eq("slug", slug)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot] study lookup failed", result.error.message);
    return null;
  }
  return (result.data as PilotStudy) ?? null;
}

/** A study by id. The join screen has an enrollment and needs its study. */
export async function loadStudyById(client: SupabaseClient, studyId: string): Promise<PilotStudy | null> {
  const result = await client
    .from("pilot_studies")
    .select("id, slug, title, status, protocol_version, consent_document_version, baseline_days, observation_days, is_dry_run")
    .eq("id", studyId)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot] study lookup by id failed", result.error.message);
    return null;
  }
  return (result.data as PilotStudy) ?? null;
}

/** The caller's enrollment in a study, or null. */
export async function loadEnrollment(
  client: SupabaseClient,
  ownerUserId: string,
  studyId: string,
): Promise<PilotEnrollmentRow | null> {
  const result = await client
    .from("pilot_enrollments")
    .select(ENROLLMENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .eq("study_id", studyId)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot] enrollment lookup failed", result.error.message);
    return null;
  }
  return (result.data as unknown as PilotEnrollmentRow) ?? null;
}

/**
 * One enrollment by id, including the two identifiers `ENROLLMENT_COLUMNS`
 * leaves out.
 *
 * `owner_user_id` and `participant_id` are not in the shared column list
 * because everything that returns an enrollment to a browser uses that list,
 * and neither identifier belongs in one. The guardian confirmation path needs
 * both — it writes a consent record for the participant and has only a token to
 * start from — so it asks for them explicitly, on the server, and does not
 * return them.
 */
export async function loadEnrollmentById(
  client: SupabaseClient,
  enrollmentId: string,
): Promise<(PilotEnrollmentRow & { owner_user_id: string; participant_id: string }) | null> {
  const result = await client
    .from("pilot_enrollments")
    .select(`${ENROLLMENT_COLUMNS}, owner_user_id, participant_id`)
    .eq("id", enrollmentId)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot] enrollment lookup by id failed", result.error.message);
    return null;
  }
  return (result.data as unknown as (PilotEnrollmentRow & { owner_user_id: string; participant_id: string })) ?? null;
}

/**
 * The live enrollment for a participant record, if there is one.
 *
 * "Live" excludes `withdrawn` and `completed`: the consent route asks this to
 * decide whether a guardian is required, and a study someone has left should
 * not be what decides that for the study they are in now. Newest first, so a
 * second enrollment supersedes an older one.
 */
export async function loadEnrollmentByParticipant(
  client: SupabaseClient,
  ownerUserId: string,
  participantId: string,
): Promise<PilotEnrollmentRow | null> {
  const result = await client
    .from("pilot_enrollments")
    .select(ENROLLMENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .eq("participant_id", participantId)
    .not("state", "in", "(withdrawn,completed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    console.warn("[pilot] enrollment lookup by participant failed", result.error.message);
    return null;
  }
  return (result.data as unknown as PilotEnrollmentRow) ?? null;
}

/** Every enrollment the caller holds, newest first. Used by the join screen. */
export async function loadEnrollmentsForUser(
  client: SupabaseClient,
  ownerUserId: string,
): Promise<PilotEnrollmentRow[]> {
  const result = await client
    .from("pilot_enrollments")
    .select(ENROLLMENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: false });

  if (result.error) {
    console.warn("[pilot] enrollment list failed", result.error.message);
    return [];
  }
  return (result.data as unknown as PilotEnrollmentRow[]) ?? [];
}

/**
 * Redeem a typed code.
 *
 * The retry loop is for `research_code` collisions only — six base32 symbols
 * over a 50-person study collide about once in a million runs, and a
 * participant meeting that once in a million should get a different code, not
 * an error. Three attempts puts the failure probability past any scale this
 * study reaches. Every other failure returns immediately.
 */
export async function redeemInvitation(
  client: SupabaseClient,
  params: {
    rawCode: string;
    ownerUserId: string;
    participantId: string;
    isMinor: boolean;
  },
): Promise<RedeemResult> {
  const normalized = normalizeInviteCode(params.rawCode);
  if (!normalized) return { outcome: "rejected" };

  const codeHash = hashInviteCode(normalized);
  if (!codeHash) {
    // No HMAC key. Refusing every code is the only safe direction: the
    // alternative is hashing under a constant, which makes every issued code
    // forgeable by anyone who reads this file.
    console.warn("[pilot] PILOT_INVITE_HMAC_KEY is not configured; refusing redemption");
    return { outcome: "unconfigured" };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await client.rpc("redeem_pilot_invitation", {
      p_code_hash: codeHash,
      p_owner_user_id: params.ownerUserId,
      p_participant_id: params.participantId,
      p_research_code: generateResearchCode(),
      p_is_minor: params.isMinor,
    });

    if (result.error) {
      // 23505 is unique_violation — the research code collided. Anything else
      // is a real failure and must not be retried.
      if (result.error.code === "23505" && attempt < 2) continue;
      console.warn("[pilot] redemption failed", result.error.message);
      return { outcome: "error" };
    }

    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row) return { outcome: "error" };

    return {
      outcome: row.outcome as RedeemOutcome,
      enrollment_id: row.enrollment_id ?? undefined,
      study_slug: row.study_slug ?? undefined,
      state: (row.state as PilotState) ?? undefined,
      cohort: row.cohort ?? undefined,
    };
  }

  return { outcome: "error" };
}

export type TransitionOutcome =
  | "ok"
  | "not_found"
  | "terminal"
  | "illegal_transition"
  | "consent_missing"
  | "error";

/**
 * Advance an enrollment.
 *
 * `ownerUserId` is checked here even though the SQL function does not take it:
 * under the service-role client the function would happily advance anybody's
 * row, so the ownership check is this layer's responsibility. Doing it as a
 * separate read is a TOCTOU window in principle — but the only thing that can
 * change an enrollment's owner is deleting the user, which cascades the row
 * away, so the worst case is a transition that finds nothing.
 */
export async function advanceEnrollment(
  client: SupabaseClient,
  params: {
    enrollmentId: string;
    ownerUserId: string;
    to: PilotState;
    // 'guardian' is not decoration: the constraint on
    // `pilot_enrollment_events.actor` was widened in 20260908000000 so that a
    // guardian's confirmation is not recorded as an operator's (#164).
    actor: "participant" | "operator" | "system" | "guardian";
    reason?: string;
  },
): Promise<{ outcome: TransitionOutcome; state?: PilotState }> {
  const owned = await client
    .from("pilot_enrollments")
    .select("id")
    .eq("id", params.enrollmentId)
    .eq("owner_user_id", params.ownerUserId)
    .maybeSingle();

  if (owned.error) {
    console.warn("[pilot] ownership check failed", owned.error.message);
    return { outcome: "error" };
  }
  if (!owned.data) return { outcome: "not_found" };

  const result = await client.rpc("advance_pilot_enrollment", {
    p_enrollment_id: params.enrollmentId,
    p_to_state: params.to,
    p_actor: params.actor,
    p_reason: params.reason ?? null,
  });

  if (result.error) {
    console.warn("[pilot] transition failed", result.error.message);
    return { outcome: "error" };
  }

  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row) return { outcome: "error" };

  return { outcome: row.outcome as TransitionOutcome, state: (row.state as PilotState) ?? undefined };
}

/**
 * Whether collection is open for a participant.
 *
 * One SQL predicate, shared with the journal write path, so that the screen and
 * the writer cannot disagree about whether today's entry counts.
 */
export async function collectionOpen(client: SupabaseClient, participantId: string): Promise<boolean> {
  const result = await client.rpc("pilot_collection_open", { target_participant: participantId });
  if (result.error) {
    console.warn("[pilot] collection check failed", result.error.message);
    return false;
  }
  return result.data === true;
}

export type IssuedInvitation = {
  code: string;
  prefix: string;
  expires_at: string | null;
};

/**
 * Issue a batch of codes.
 *
 * Returns the clear-text codes **once**. They are not stored and cannot be
 * recovered: a lost code is reissued, never looked up. The caller is
 * responsible for getting them to the operator and not logging them — which is
 * why this returns them rather than writing them anywhere itself.
 */
export async function issueInvitations(
  client: SupabaseClient,
  params: {
    studyId: string;
    count: number;
    cohort?: string;
    maxRedemptions?: number;
    expiresAt?: string | null;
    note?: string | null;
    /** The coordinator's answer to "does this participant need a guardian".
     *  Undefined leaves the column null, and redemption falls back to the
     *  redeemer's own statement (20260909000000). */
    isMinor?: boolean;
  },
): Promise<{ issued: IssuedInvitation[]; error?: string }> {
  const { generateInviteCode } = await import("./inviteCodes");
  const issued: IssuedInvitation[] = [];
  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < params.count; i += 1) {
    const code = generateInviteCode();
    const hash = hashInviteCode(code);
    if (!hash) return { issued: [], error: "PILOT_INVITE_HMAC_KEY is not configured." };

    const normalized = normalizeInviteCode(code);
    if (!normalized) return { issued: [], error: "Generated an invalid code." };

    const prefix = inviteCodePrefix(normalized);
    rows.push({
      study_id: params.studyId,
      code_hash: hash,
      code_prefix: prefix,
      cohort: params.cohort ?? "default",
      max_redemptions: params.maxRedemptions ?? 1,
      expires_at: params.expiresAt ?? null,
      note: params.note ?? null,
      is_minor: params.isMinor ?? null,
    });
    issued.push({ code, prefix, expires_at: params.expiresAt ?? null });
  }

  const result = await client.from("pilot_invitations").insert(rows);
  if (result.error) {
    console.warn("[pilot] issuing invitations failed", result.error.message);
    return { issued: [], error: result.error.message };
  }
  return { issued };
}

/**
 * Usage of a study's invitations, with no way to recover a code.
 *
 * `code_hash` is deliberately not selected. An operator screen needs to answer
 * "how many are left" and "which batch", and giving it the hashes would put
 * them in a browser and in a log for no gain.
 */
export async function invitationUsage(
  client: SupabaseClient,
  studyId: string,
): Promise<{ prefix: string; cohort: string; redeemed: number; max: number; revoked: boolean; expires_at: string | null; note: string | null }[]> {
  const result = await client
    .from("pilot_invitations")
    .select("code_prefix, cohort, redeemed_count, max_redemptions, revoked_at, expires_at, note")
    .eq("study_id", studyId)
    .order("created_at", { ascending: false });

  if (result.error) {
    console.warn("[pilot] invitation usage failed", result.error.message);
    return [];
  }

  return (result.data ?? []).map((row) => ({
    prefix: row.code_prefix as string,
    cohort: row.cohort as string,
    redeemed: row.redeemed_count as number,
    max: row.max_redemptions as number,
    revoked: row.revoked_at !== null,
    expires_at: (row.expires_at as string | null) ?? null,
    note: (row.note as string | null) ?? null,
  }));
}

/**
 * Revoke by prefix.
 *
 * The operator has the prefix (it is what the admin screen shows) and not the
 * code, so revocation has to work from it. A prefix can match more than one
 * invitation, and that is intended: "revoke everything I issued to 3-B" is the
 * operation people actually need in an incident.
 */
export async function revokeInvitations(
  client: SupabaseClient,
  params: { studyId: string; prefix: string },
): Promise<{ revoked: number; error?: string }> {
  const result = await client
    .from("pilot_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("study_id", params.studyId)
    .eq("code_prefix", params.prefix.toUpperCase())
    .is("revoked_at", null)
    .select("id");

  if (result.error) {
    console.warn("[pilot] revocation failed", result.error.message);
    return { revoked: 0, error: result.error.message };
  }
  return { revoked: (result.data ?? []).length };
}
