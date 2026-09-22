/**
 * The queue behind protocol §4.4's twice-daily manual review (#225).
 *
 * §4.4 says an authorised person looks at retained journal text at 10:00 and
 * 16:00 JST on weekdays, because collection-only mode sends nothing to an
 * external model and the crisis judgement is therefore a human one. The rule
 * existed; the queue did not. This is the queue.
 *
 * Two things it deliberately does not do:
 *
 *   1. **It does not decide.** `assessed_risk` comes from the local lexicon in
 *      `safety-assessment.ts` and is a sort order, not a verdict. Entries the
 *      classifier scored `none` stay in the queue, because a crisis written in
 *      words the lexicon does not carry scores `none`, and a queue that hides
 *      those is a queue that quietly narrows §4.4 to "review what the regex
 *      found".
 *
 *   2. **It does not hand out text as a side effect of listing.** Building the
 *      queue reads metadata. Reading a student's journal is a separate call
 *      that writes a row saying who read it. Collapsing the two would make
 *      "open the console" and "read twelve journals" the same action.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { assessSafety } from "../safety-assessment.ts";
import { decryptRawText } from "./rawTextCrypto.ts";

export type ReviewStatus = "pending" | "no_concern" | "escalated" | "unreadable";
export type ReviewSlot = "morning" | "afternoon" | "ad_hoc";

/** Matches the CHECK on `assessed_risk`, worst first. */
const RISK_ORDER = ["crisis", "elevated", "low", "none"] as const;
export type AssessedRisk = (typeof RISK_ORDER)[number];

/** Which of §4.4's two slots the wall clock is in, in JST. */
export function slotFor(instant: Date): ReviewSlot {
  const jst = new Date(instant.getTime() + 9 * 60 * 60 * 1000);
  const hour = jst.getUTCHours();
  if (hour >= 9 && hour < 12) return "morning";
  if (hour >= 15 && hour < 18) return "afternoon";
  // Outside the protocol's slots. Recorded as such rather than rounded into the
  // nearer one: §4.4 promises two reviews a day and does not promise watching
  // at 02:00, so a review done then is a fact about the operator, not evidence
  // the schedule was kept.
  return "ad_hoc";
}

type EntryRow = {
  id: string;
  owner_user_id: string;
  participant_id: string;
  raw_text_ciphertext: string | null;
  created_at: string;
};

/**
 * Put every retained entry that has never been looked at into the queue.
 *
 * Run when the console opens rather than on the write path. An entry that fails
 * to enqueue must not be able to fail a student's submission, and doing it here
 * also backfills everything written before this existed.
 *
 * The text is decrypted to score it and is **not returned or stored**. The score
 * is a risk band and a list of reason codes; neither carries the journal.
 */
export async function enqueuePendingReviews(
  service: SupabaseClient,
  assessorVersion: string,
): Promise<{ enqueued: number; skipped: number }> {
  const existing = await service.from("pilot_crisis_reviews").select("entry_id");
  if (existing.error) throw new Error(existing.error.message);
  const reviewed = new Set((existing.data ?? []).map((row) => String(row.entry_id)));

  const entries = await service
    .from("entries")
    .select("id, owner_user_id, participant_id, raw_text_ciphertext, created_at")
    .not("raw_text_ciphertext", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (entries.error) throw new Error(entries.error.message);

  const rows: Array<Record<string, unknown>> = [];
  let skipped = 0;

  for (const entry of (entries.data ?? []) as EntryRow[]) {
    if (reviewed.has(entry.id)) {
      skipped += 1;
      continue;
    }
    const text = entry.raw_text_ciphertext ? await decryptRawText(entry.raw_text_ciphertext) : null;

    // Undecryptable text still enters the queue, as `unreadable` would be a
    // decision nobody made. It enters as `pending` with a `none` score so that
    // a reviewer sees it and records why it could not be read — a row that
    // silently never appears is indistinguishable from a day nobody wrote.
    const assessment = text ? assessSafety(text) : null;

    rows.push({
      owner_user_id: entry.owner_user_id,
      participant_id: entry.participant_id,
      entry_id: entry.id,
      assessed_risk: assessment?.risk_level ?? "none",
      assessed_reasons: assessment?.reasons ?? [],
      assessor_version: assessorVersion,
      status: "pending",
    });
  }

  if (rows.length === 0) return { enqueued: 0, skipped };

  const inserted = await service.from("pilot_crisis_reviews").insert(rows);
  if (inserted.error) throw new Error(inserted.error.message);
  return { enqueued: rows.length, skipped };
}

export type QueueRow = {
  review_id: string;
  entry_id: string;
  research_code: string | null;
  assessed_risk: AssessedRisk;
  assessed_reasons: string[];
  status: ReviewStatus;
  reviewed_at: string | null;
  review_slot: ReviewSlot | null;
  created_at: string;
  /** Whether the text is still there to be read, without reading it. */
  text_available: boolean;
};

/**
 * The queue, worst first, without any journal text.
 *
 * `research_code` and not a participant id: the reviewer works in the same
 * pseudonyms as the rest of the study, and an operator screen that prints
 * database ids is one screenshot away from being an identity map.
 */
export async function loadQueue(
  service: SupabaseClient,
  options: { includeDecided?: boolean; limit?: number } = {},
): Promise<QueueRow[]> {
  let query = service
    .from("pilot_crisis_reviews")
    .select(
      "id, entry_id, participant_id, assessed_risk, assessed_reasons, status, reviewed_at, review_slot, created_at",
    );
  if (!options.includeDecided) query = query.eq("status", "pending");

  const reviews = await query.order("created_at", { ascending: true }).limit(options.limit ?? 200);
  if (reviews.error) throw new Error(reviews.error.message);

  type Row = {
    id: string;
    entry_id: string;
    participant_id: string;
    assessed_risk: AssessedRisk;
    assessed_reasons: string[];
    status: ReviewStatus;
    reviewed_at: string | null;
    review_slot: ReviewSlot | null;
    created_at: string;
  };
  const rows = (reviews.data ?? []) as Row[];
  if (rows.length === 0) return [];

  const codes = new Map<string, string>();
  const enrollments = await service
    .from("pilot_enrollments")
    .select("participant_id, research_code")
    .in("participant_id", Array.from(new Set(rows.map((row) => row.participant_id))));
  for (const row of (enrollments.data ?? []) as Array<{ participant_id: string; research_code: string }>) {
    codes.set(row.participant_id, row.research_code);
  }

  const present = new Set<string>();
  const entries = await service
    .from("entries")
    .select("id")
    .in("id", rows.map((row) => row.entry_id))
    .not("raw_text_ciphertext", "is", null);
  for (const row of (entries.data ?? []) as Array<{ id: string }>) present.add(row.id);

  return rows
    .map((row) => ({
      review_id: row.id,
      entry_id: row.entry_id,
      research_code: codes.get(row.participant_id) ?? null,
      assessed_risk: row.assessed_risk,
      assessed_reasons: row.assessed_reasons ?? [],
      status: row.status,
      reviewed_at: row.reviewed_at,
      review_slot: row.review_slot,
      created_at: row.created_at,
      text_available: present.has(row.entry_id),
    }))
    .sort((a, b) => RISK_ORDER.indexOf(a.assessed_risk) - RISK_ORDER.indexOf(b.assessed_risk));
}

/**
 * Read one entry's text, and record that it was read.
 *
 * The read row is written **before** the text is returned. A read that is
 * logged only on success is a read that vanishes whenever the response fails,
 * and the log exists precisely for the case where something went wrong.
 */
export async function readEntryText(
  service: SupabaseClient,
  reviewId: string,
  readerUserId: string,
): Promise<{ text: string | null; reason?: "no_review" | "no_text" | "undecryptable" }> {
  const review = await service
    .from("pilot_crisis_reviews")
    .select("id, entry_id")
    .eq("id", reviewId)
    .maybeSingle();
  if (review.error) throw new Error(review.error.message);
  if (!review.data) return { text: null, reason: "no_review" };

  const entryId = String((review.data as { entry_id: string }).entry_id);

  const entry = await service
    .from("entries")
    .select("id, raw_text_ciphertext")
    .eq("id", entryId)
    .maybeSingle();
  if (entry.error) throw new Error(entry.error.message);

  const ciphertext = (entry.data as { raw_text_ciphertext: string | null } | null)?.raw_text_ciphertext ?? null;

  const logged = await service.from("pilot_crisis_review_reads").insert({
    review_id: reviewId,
    entry_id: entryId,
    read_by: readerUserId,
    included_raw_text: ciphertext !== null,
  });
  if (logged.error) {
    // Refuse rather than serve an unlogged read. §4.4 tells participants their
    // text may be read; the record of who read it is the part that makes that
    // a promise rather than a disclaimer. The operator sees this message, so it
    // is written for them.
    throw new Error(
      `閲覧の記録に失敗したため、本文を表示しません（${logged.error.message}）。`,
    );
  }

  if (!ciphertext) return { text: null, reason: "no_text" };
  const text = await decryptRawText(ciphertext);
  if (text === null) return { text: null, reason: "undecryptable" };
  return { text };
}

/** Record a decision. `pending` is not a decision and is refused. */
export async function recordDecision(
  service: SupabaseClient,
  input: {
    reviewId: string;
    reviewerUserId: string;
    status: Exclude<ReviewStatus, "pending">;
    note?: string;
    at?: Date;
  },
): Promise<void> {
  const at = input.at ?? new Date();
  const result = await service
    .from("pilot_crisis_reviews")
    .update({
      status: input.status,
      reviewed_by: input.reviewerUserId,
      reviewed_at: at.toISOString(),
      review_slot: slotFor(at),
      // Truncated, not rejected: a reviewer at 16:05 on a crisis row should not
      // lose their note to a length check. The database caps it at 500 as well,
      // so this is the friendly half of the same rule.
      reviewer_note: input.note ? input.note.slice(0, 500) : null,
    })
    .eq("id", input.reviewId);
  if (result.error) throw new Error(result.error.message);
}
