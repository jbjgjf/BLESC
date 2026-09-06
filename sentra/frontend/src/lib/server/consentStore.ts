/**
 * The stored consent record is the authority (#134).
 *
 * The browser can say anything. It used to say nothing at all — the journal
 * screen sent no consent object, so the writer's defaults decided, and the
 * defaults said yes. Replacing those defaults with a checkbox would move the
 * decision from the server's default to the client's claim, which is no better:
 * research use has to be gated on a record that exists in the database and can
 * be shown to a review board.
 *
 * So every gate in the write path calls `loadConsentState`, and a client-sent
 * consent object is only ever used to detect disagreement (`consentMismatch`),
 * never to grant.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CONSENT_DOCUMENT_VERSION,
  CONSENT_VERSION,
  NO_CONSENT,
  normalizeConsent,
  type ConsentState,
} from "@/lib/consent";

const CONSENT_COLUMNS =
  "app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, " +
  "minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at";

/**
 * The participant's current consent, or no consent at all.
 *
 * "The newest row wins" rather than "the newest active row wins": a revocation
 * is a newer row (or the same row updated to `revoked`), and picking the newest
 * *active* one would step back to the grant it revoked.
 *
 * A query failure returns `NO_CONSENT`. Falling back to "not consented" when
 * the consent table cannot be read is the only safe direction — the cost is a
 * submission stored without research mirrors, which is recoverable; the cost of
 * the other direction is research data collected without consent, which is not.
 */
export async function loadConsentState(
  client: SupabaseClient,
  ownerUserId: string,
  participantId: string,
): Promise<ConsentState> {
  const result = await client
    .from("consent_records")
    .select(CONSENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .eq("participant_id", participantId)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    console.warn("[consent] lookup failed; treating as no consent", result.error.message);
    return { ...NO_CONSENT };
  }
  if (!result.data) return { ...NO_CONSENT };
  return normalizeConsent(result.data);
}

export type ConsentGrantInput = {
  app_use?: boolean;
  research_analysis?: boolean;
  anonymized_export?: boolean;
  raw_text_retention?: boolean;
  future_fine_tuning?: boolean;
  minor_assent?: boolean;
  guardian_consent?: boolean;
  document_version?: string;
};

/**
 * Write a new consent record. Consent history is append-only: a change of mind
 * is a new row, so "what had they agreed to on the day this entry was written"
 * stays answerable.
 */
export async function recordConsent(
  client: SupabaseClient,
  ownerUserId: string,
  participantId: string,
  input: ConsentGrantInput,
  source = "student_ui",
): Promise<ConsentState> {
  const row = {
    owner_user_id: ownerUserId,
    participant_id: participantId,
    app_use: input.app_use === true,
    research_analysis: input.research_analysis === true,
    anonymized_export: input.anonymized_export === true,
    raw_text_retention: input.raw_text_retention === true,
    future_fine_tuning: input.future_fine_tuning === true,
    minor_assent: input.minor_assent === true,
    guardian_consent: input.guardian_consent === true,
    consent_version: CONSENT_VERSION,
    document_version: input.document_version || CONSENT_DOCUMENT_VERSION,
    status: "active",
    granted_at: new Date().toISOString(),
    source,
  };
  const result = await client.from("consent_records").insert(row).select(CONSENT_COLUMNS).single();
  if (result.error) throw new Error(`consent_records insert: ${result.error.message}`);
  return normalizeConsent(result.data);
}

/**
 * Revoke. A revocation row carries the grants set to false so that reading the
 * newest row is enough to know the answer — no consumer has to walk the
 * history to discover that an earlier `true` was withdrawn.
 *
 * Deleting the retained journal text is the caller's next step
 * (`purge_raw_text_for_participant`); this function only records the decision.
 */
export async function revokeConsent(
  client: SupabaseClient,
  ownerUserId: string,
  participantId: string,
  source = "student_ui",
): Promise<ConsentState> {
  const now = new Date().toISOString();
  const result = await client
    .from("consent_records")
    .insert({
      owner_user_id: ownerUserId,
      participant_id: participantId,
      app_use: true,
      research_analysis: false,
      anonymized_export: false,
      raw_text_retention: false,
      future_fine_tuning: false,
      minor_assent: false,
      guardian_consent: false,
      consent_version: CONSENT_VERSION,
      document_version: CONSENT_DOCUMENT_VERSION,
      status: "revoked",
      granted_at: now,
      revoked_at: now,
      source,
    })
    .select(CONSENT_COLUMNS)
    .single();
  if (result.error) throw new Error(`consent_records revoke: ${result.error.message}`);
  return normalizeConsent(result.data);
}

/**
 * Names the grants the client claimed to hold that the stored record does not.
 *
 * Never used to allow anything — it exists so that a UI that has drifted out of
 * sync with the database (a stale tab, a consent screen that failed to save)
 * shows up in `warnings` instead of silently doing nothing.
 */
export function consentMismatch(claimed: unknown, stored: ConsentState): string[] {
  if (!claimed || typeof claimed !== "object") return [];
  const client = normalizeConsent(claimed);
  const keys = [
    "research_analysis",
    "anonymized_export",
    "raw_text_retention",
    "future_fine_tuning",
    "minor_assent",
    "guardian_consent",
  ] as const;
  return keys.filter((key) => client[key] === true && stored[key] !== true);
}
