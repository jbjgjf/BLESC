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
// Relative, with the extension, so the node test runner can import this module
// without the `@/` alias — the same form `crisisTriage.ts` uses.
import {
  CONSENT_DOCUMENT_VERSION,
  CONSENT_VERSION,
  NO_CONSENT,
  consentSnapshot,
  normalizeConsent,
  type ConsentState,
} from "../consent.ts";

const CONSENT_COLUMNS =
  "app_use, research_analysis, anonymized_export, raw_text_retention, model_training_use, " +
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
  const read = await readConsentState(client, ownerUserId, participantId);
  if ("error" in read) {
    console.warn("[consent] lookup failed; treating as no consent", read.error);
    return { ...NO_CONSENT };
  }
  return read.state;
}

/**
 * The read behind `loadConsentState`, keeping the one distinction that function
 * folds away: "there is no consent record" and "the consent table could not be
 * read" are different facts, even though every *gate* treats them the same.
 */
async function readConsentState(
  client: SupabaseClient,
  ownerUserId: string,
  participantId: string,
): Promise<{ state: ConsentState } | { error: string }> {
  const result = await client
    .from("consent_records")
    .select(CONSENT_COLUMNS)
    .eq("owner_user_id", ownerUserId)
    .eq("participant_id", participantId)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) return { error: result.error.message };
  if (!result.data) return { state: { ...NO_CONSENT } };
  return { state: normalizeConsent(result.data) };
}

/**
 * What a server route writes to `chat_sessions.consent_snapshot_json` (#238).
 *
 * `/api/chat` and `/api/voice/turn` wrote
 * `{ app_use: true, research_analysis: true }` on every session, whatever the
 * participant had agreed to — the defect #134 removed from the browser writer
 * and the entry writer, surviving in the two server routes. A withdrawn
 * participant's conversation was recorded as research-consented, and the
 * optional grants were never recorded at all.
 *
 * Now the snapshot is the stored record, read the same way the entry writer
 * reads it. When that record cannot be read — no service-role client on this
 * deployment, or the query failed — the snapshot says so (`status: "unknown"`)
 * rather than guessing in either direction: writing `true` is the original
 * defect, and writing `false` would be a claim about the participant that
 * nobody checked. `research_use_allowed` is still `false` there, because that
 * field is the decision, and without a record the decision is no.
 *
 * Rows written before this change carry the old two-key shape and no
 * `research_use_allowed` key. They are left as written: rewriting them from
 * today's record would be a second guess about the past. Anything reading
 * these snapshots must treat that shape as unknown, and re-derive consent from
 * the `consent_records` history at the session's `created_at` if it needs it.
 */
export async function chatSessionConsentSnapshot(
  client: SupabaseClient | null,
  ownerUserId: string,
  participantId: string,
  source: "student_ui" | "student_voice",
): Promise<Record<string, unknown>> {
  if (!client) return unknownConsentSnapshot("consent_store_unavailable", source);
  const read = await readConsentState(client, ownerUserId, participantId);
  if ("error" in read) {
    console.warn("[consent] lookup failed; recording this session's consent as unknown", read.error);
    return unknownConsentSnapshot("consent_lookup_failed", source);
  }
  return { ...consentSnapshot(read.state), source };
}

function unknownConsentSnapshot(reason: string, source: string): Record<string, unknown> {
  return { status: "unknown", unknown_reason: reason, research_use_allowed: false, source };
}

export type ConsentGrantInput = {
  app_use?: boolean;
  research_analysis?: boolean;
  anonymized_export?: boolean;
  raw_text_retention?: boolean;
  model_training_use?: boolean;
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
    model_training_use: input.model_training_use === true,
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

/*
 * `revokeConsent` stood here. It wrote a revocation row and nothing else, which
 * is how `/consent` came to revoke consent while leaving the enrollment
 * collecting (#263). Revocation is now part of the single withdrawal procedure
 * in `withdrawal.ts`. It was removed rather than left beside it, because a
 * second way to revoke is how the first split happened.
 */

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
    "model_training_use",
    "minor_assent",
    "guardian_consent",
  ] as const;
  return keys.filter((key) => client[key] === true && stored[key] !== true);
}
