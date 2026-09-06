/**
 * Collection-only mode: the one place that decides whether a submission may
 * leave this server (#165).
 *
 * While a participant's collection window is open, their journal text is not
 * sent to OpenAI or to any other external service. Not "the graph screen is
 * hidden" — the request is never made. Three reasons, in the order they matter:
 *
 *   1. **Reactivity.** A participant who is shown an AI reading of yesterday's
 *      entry writes today's entry differently. The study is measuring how
 *      people write; feeding an interpretation back into the thing being
 *      measured changes it, and there is no way to subtract that afterwards.
 *
 *   2. **What was consented to.** The consent document describes a journal that
 *      is collected. A participant who agreed to that did not agree to their
 *      text being sent to a third party for inference.
 *
 *   3. **Reproducibility.** An extraction model that is updated mid-study makes
 *      week 1 and week 3 incomparable. Extraction happens afterwards, in one
 *      batch, under one pinned model version — which is also the only way to
 *      re-run it when the model changes.
 *
 * The five external send points this gate covers, all of which consult
 * `collectionOnlyForParticipant` before making a request:
 *
 *   - `api/entries`      POST https://api.openai.com/v1/responses   (extraction)
 *   - `api/entries`      POST https://api.openai.com/v1/embeddings
 *   - `api/chat`         POST https://api.openai.com/v1/responses
 *   - `api/audio/transcriptions`  POST .../v1/audio/transcriptions
 *   - `api/voice/realtime-session` POST .../v1/realtime/client_secrets
 *
 * Anything added to that list has to consult this module too. The test in
 * `tests/collection-mode.test.mjs` scans `src/app/api` for `api.openai.com` and
 * fails on a route that reaches it without importing this file, so a sixth send
 * point cannot be added quietly.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractionPayload } from "@/lib/extraction";

/**
 * Whether this participant is inside an open collection window.
 *
 * Reads `pilot_collection_open`, the same SQL predicate the enrollment routes
 * and the export use, so a participant cannot be "collecting" for one of them
 * and not the other.
 *
 * **Fails closed toward collection-only.** A database error returns true, which
 * means the submission is stored without external inference. The cost of that
 * is a missing graph on a non-pilot user's screen during an outage; the cost of
 * the other direction is a pilot participant's journal text leaving the system
 * during the study. Those are not comparable, so the check does not treat them
 * as a tie.
 */
export async function collectionOnlyForParticipant(
  client: SupabaseClient | null,
  participantId: string | null,
): Promise<boolean> {
  // No participant and no service client means no enrollment can exist, so
  // there is nothing to protect. This is the ordinary non-pilot path.
  if (!client || !participantId) return false;

  const result = await client.rpc("pilot_collection_open", { target_participant: participantId });
  if (result.error) {
    console.warn("[collection-mode] gate check failed; withholding external calls", result.error.message);
    return true;
  }
  return result.data === true;
}

/**
 * The same question, asked of a signed-in user rather than a participant.
 *
 * The voice and transcription routes never resolve a participant — they take
 * audio and a session and nothing else — so they cannot use the predicate
 * above. This one asks whether the *account* has any enrollment in an open
 * window, which is the right granularity for them: a participant with a live
 * enrollment must not have their voice recording transcribed by a third party,
 * whichever participant record the request would have been filed under.
 *
 * Fails closed the same way, for the same reason.
 */
export async function collectionOnlyForUser(
  client: SupabaseClient | null,
  ownerUserId: string | null,
): Promise<boolean> {
  if (!client || !ownerUserId) return false;

  const result = await client
    .from("pilot_enrollments")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("state", "collecting")
    .limit(1);

  if (result.error) {
    console.warn("[collection-mode] user gate check failed; withholding external calls", result.error.message);
    return true;
  }
  return (result.data ?? []).length > 0;
}

/**
 * The extraction stored for a submission collected in this mode.
 *
 * Deliberately empty, and deliberately NOT `fallbackExtraction`. That function
 * matches English keywords (`anxious|stress|tired|deadline|...`) against text
 * that is Japanese, so on this study's data it returns close to the same three
 * generic nodes every time. Storing that would put a fabricated, constant graph
 * into the research record where a reader would take it for an extraction that
 * ran — which is worse than storing nothing, because nothing is legible as
 * nothing.
 *
 * `summary` says what happened in the participant's own language, since it is
 * the one field a screen might render.
 */
export function collectionOnlyExtraction(): ExtractionPayload {
  return {
    nodes: [],
    relations: [],
    temporal_summary: "",
    summary: "研究期間中は、記録の保存のみを行います。",
    evidence_summaries: [],
  };
}

/** What `model_runs` and the API response report for a withheld call. */
export const COLLECTION_ONLY_STATUS = "withheld_collection_only";
export const COLLECTION_ONLY_PROVIDER = "none";

/**
 * The message an AI surface returns to a participant inside the window.
 *
 * Phrased as a property of the study period, not as an error or a restriction
 * placed on them. A student who reads "利用できません" during a research they
 * volunteered for should understand it as part of the design.
 */
export const COLLECTION_ONLY_MESSAGE =
  "研究期間中は、AIの応答機能を停止しています。日記の記録はこれまでどおり保存されます。";
