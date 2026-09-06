/**
 * Recording that a submission did not land (#132).
 *
 * A failed write leaves no row, so without this a lost entry is
 * indistinguishable from a day the student did not write — in the database, in
 * the research export, and in the educator view. The only trace was a
 * `console.error` on a server nobody tails.
 *
 * No entry content is recorded. A row here says a submission was lost and what
 * the database said about it, not what the student wrote.
 */

import { serviceRoleClient } from "@/lib/server/supabaseWriter";

export type SubmissionFailure = {
  ownerUserId?: string | null;
  participantId?: string | null;
  clientSubmissionId?: string | null;
  outcome: "failed" | "skipped" | "partial";
  reason?: string | null;
  warnings?: string[];
  observationType?: string;
};

/**
 * Never throws and never blocks the response. The point is to make failures
 * countable; a failure to record one must not turn into a second failure the
 * student sees.
 */
export async function recordSubmissionFailure(failure: SubmissionFailure): Promise<void> {
  try {
    const client = serviceRoleClient();
    if (!client) return;
    const { error } = await client.from("submission_failures").insert({
      owner_user_id: failure.ownerUserId ?? null,
      participant_id: failure.participantId ?? null,
      client_submission_id: failure.clientSubmissionId ?? null,
      outcome: failure.outcome,
      reason: failure.reason?.slice(0, 2000) ?? null,
      warnings_json: failure.warnings ?? [],
      observation_type: failure.observationType ?? null,
    });
    if (error) console.warn("[submission-failure] could not record failure", error.message);
  } catch (err) {
    console.warn("[submission-failure] could not record failure", err);
  }
}
