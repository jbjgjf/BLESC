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
 * How many rows one request may ask PostgREST for (#247).
 *
 * Kept below Supabase's `db-max-rows`, which is 1,000 by default and truncates
 * a response **silently** — no error, no flag, just fewer rows than the table
 * holds. A `select()` with no range is therefore not "read this table", it is
 * "read as much of this table as the gateway felt like", and the difference
 * does not show up until the table crosses the ceiling. Paging with an explicit
 * range under that ceiling is what makes a full read a full read.
 */
const PAGE = 500;

/**
 * How many uuids may go into one `in.(…)` filter.
 *
 * That filter travels in the URL of a GET, so the bound here is the gateway's
 * request-line limit rather than anything about the data. 100 uuids is roughly
 * 3.7 KB of query string, comfortably inside the usual 8 KB.
 */
const ID_CHUNK = 100;

/**
 * How many entries one console open may decrypt, score and insert.
 *
 * Unlike the two above this is a real cap on work, not on a round trip: every
 * entry here is a decryption. So the queue reports what it did not get to
 * (`deferred`) instead of finishing quietly at an arbitrary line — which is
 * the failure this whole function had before, and the one a cap reintroduces
 * unless the leftovers are stated out loud.
 */
const MAX_ENQUEUE_PER_RUN = 300;

export type EnqueueResult = {
  /** Rows this call actually inserted. */
  enqueued: number;
  /** Entries scanned that already had a row. */
  skipped: number;
  /**
   * Entries still owed a row when this call returned. Zero means the queue is
   * complete. A lower bound when `scanComplete` is false.
   */
  deferred: number;
  /** Whether the scan reached the end of the entries table. */
  scanComplete: boolean;
};

/** Read a whole table through explicit ranges, rather than trusting one request. */
async function readPaged<T>(
  fetchRange: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  maxPages: number,
): Promise<{ rows: T[]; complete: boolean }> {
  const rows: T[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * PAGE;
    const result = await fetchRange(from, from + PAGE - 1);
    if (result.error) throw new Error(result.error.message);
    const batch = (result.data ?? []) as T[];
    rows.push(...batch);
    // A short page is the end of the table. A full one may or may not be, so
    // it costs one more request to find out.
    if (batch.length < PAGE) return { rows, complete: true };
  }
  return { rows, complete: false };
}

/** 100,000 entries. Far past the pilot's 1,050; a stop so this cannot spin. */
const MAX_SCAN_PAGES = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Put every retained entry that has never been looked at into the queue.
 *
 * Run when the console opens rather than on the write path. An entry that fails
 * to enqueue must not be able to fail a student's submission, and doing it here
 * also backfills everything written before this existed.
 *
 * The text is decrypted to score it and is **not returned or stored**. The score
 * is a risk band and a list of reason codes; neither carries the journal.
 *
 * ## Why this is written in pages (#247)
 *
 * The first version read both tables in one unbounded request and scanned only
 * the newest 500 entries. At the pilot's own size — 50 students × 21 days, up
 * to 1,050 entries — both bounds land inside the study:
 *
 *   - past `db-max-rows` the set of already-reviewed entries came back
 *     truncated, so reviewed entries looked new, the insert hit the `unique`
 *     constraint on `entry_id`, and because one `insert()` is all-or-nothing
 *     the whole batch failed. The route turned that into a 502, so **the
 *     console stopped opening at all** — and since nothing could be enqueued
 *     while it was shut, it did not recover on its own;
 *   - anything older than the newest 500 entries was never scanned again, so
 *     an entry that fell out of that window before being enqueued stayed out.
 *     A row that never appears and a day nobody wrote look identical on the
 *     screen, which is exactly what the header of this file says the queue
 *     must not do.
 *
 * So: ranges instead of one request, oldest first so a backlog drains from the
 * end that is in danger rather than the end that is safe, and an upsert that
 * treats a duplicate as the ordinary outcome of two reviewers opening the
 * console at once instead of as a reason to fail.
 */
export async function enqueuePendingReviews(
  service: SupabaseClient,
  assessorVersion: string,
): Promise<EnqueueResult> {
  const reviewed = await readPaged<{ entry_id: string }>(
    (from, to) => service.from("pilot_crisis_reviews").select("entry_id").range(from, to),
    MAX_SCAN_PAGES,
  );
  const seen = new Set(reviewed.rows.map((row) => String(row.entry_id)));

  // Ids only. The ciphertext is fetched below, for the handful that need it —
  // pulling every journal's ciphertext just to learn which ones already have a
  // row would make opening the console the most expensive read in the app.
  const candidates = await readPaged<{ id: string }>(
    (from, to) =>
      service
        .from("entries")
        .select("id")
        .not("raw_text_ciphertext", "is", null)
        .order("created_at", { ascending: true })
        .range(from, to),
    MAX_SCAN_PAGES,
  );

  const missing = candidates.rows.map((row) => String(row.id)).filter((id) => !seen.has(id));
  const skipped = candidates.rows.length - missing.length;
  const take = missing.slice(0, MAX_ENQUEUE_PER_RUN);

  const rows: Array<Record<string, unknown>> = [];
  for (const ids of chunk(take, ID_CHUNK)) {
    const entries = await service
      .from("entries")
      .select("id, owner_user_id, participant_id, raw_text_ciphertext, created_at")
      .in("id", ids);
    if (entries.error) throw new Error(entries.error.message);

    for (const entry of (entries.data ?? []) as EntryRow[]) {
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
  }

  let enqueued = 0;
  for (const batch of chunk(rows, ID_CHUNK)) {
    // `ignoreDuplicates`, and in batches.
    //
    // Two console opens overlapping is ordinary — §4.4 has two slots and more
    // than one authorised person. Between the read above and this write another
    // one may have inserted the same row, and `entry_id` is unique, so the
    // conflict is the correct result rather than an error. A plain `insert()`
    // took the entire batch down with it, which is how a race between two
    // reviewers became "nobody can open the queue".
    const inserted = await service
      .from("pilot_crisis_reviews")
      .upsert(batch, { onConflict: "entry_id", ignoreDuplicates: true })
      .select("id");
    if (inserted.error) throw new Error(inserted.error.message);
    enqueued += (inserted.data ?? []).length;
  }

  return {
    enqueued,
    skipped,
    deferred: missing.length - take.length,
    scanComplete: reviewed.complete && candidates.complete,
  };
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

/** How many rows the console shows at once. */
const QUEUE_LIMIT = 200;

/**
 * The queue, worst first, without any journal text.
 *
 * `research_code` and not a participant id: the reviewer works in the same
 * pseudonyms as the rest of the study, and an operator screen that prints
 * database ids is one screenshot away from being an identity map.
 *
 * ## Worst first has to happen before the cut, not after (#247)
 *
 * This used to ask the database for the oldest 200 rows and then sort those by
 * risk in JavaScript. With fewer than 200 pending rows the two are the same
 * answer, which is why it read as correct. Past 200 they are not: a `crisis`
 * entry written this morning is not in the oldest 200, so it was dropped by the
 * `limit` and the sort never saw it. The reviewer got a screen ordered worst
 * first and had no way to tell that the worst row was not on it.
 *
 * 1,050 entries is the pilot's own design size, so "past 200 pending" is a
 * normal Monday, not an edge case.
 *
 * `assessed_risk` is text, and text order (`none` > `low` > `elevated` >
 * `crisis`) is the reverse of severity, so one `order()` cannot express this.
 * One query per band, worst band first, against the existing
 * `(status, assessed_risk, created_at)` index does — and it stops as soon as
 * the budget is spent, so the usual case is one small query.
 */
export async function loadQueue(
  service: SupabaseClient,
  options: { includeDecided?: boolean; limit?: number } = {},
): Promise<QueueRow[]> {
  const limit = options.limit ?? QUEUE_LIMIT;

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

  const rows: Row[] = [];
  for (const risk of RISK_ORDER) {
    if (rows.length >= limit) break;

    let query = service
      .from("pilot_crisis_reviews")
      .select(
        "id, entry_id, participant_id, assessed_risk, assessed_reasons, status, reviewed_at, review_slot, created_at",
      )
      .eq("assessed_risk", risk);
    if (!options.includeDecided) query = query.eq("status", "pending");

    // Oldest first inside a band: of two rows the machine scored the same, the
    // one that has been waiting longer is the one §4.4 is later on.
    const band = await query.order("created_at", { ascending: true }).limit(limit - rows.length);
    if (band.error) throw new Error(band.error.message);
    rows.push(...((band.data ?? []) as Row[]));
  }

  if (rows.length === 0) return [];

  const codes = new Map<string, string>();
  for (const ids of chunk(Array.from(new Set(rows.map((row) => row.participant_id))), ID_CHUNK)) {
    const enrollments = await service
      .from("pilot_enrollments")
      .select("participant_id, research_code")
      .in("participant_id", ids);
    if (enrollments.error) throw new Error(enrollments.error.message);
    for (const row of (enrollments.data ?? []) as Array<{ participant_id: string; research_code: string }>) {
      codes.set(row.participant_id, row.research_code);
    }
  }

  const present = new Set<string>();
  for (const ids of chunk(rows.map((row) => row.entry_id), ID_CHUNK)) {
    const entries = await service
      .from("entries")
      .select("id")
      .in("id", ids)
      .not("raw_text_ciphertext", "is", null);
    if (entries.error) throw new Error(entries.error.message);
    for (const row of (entries.data ?? []) as Array<{ id: string }>) present.add(row.id);
  }

  // Already worst-first, oldest-first within a band, from the loop above. No
  // second sort here on purpose: a sort applied to a truncated list is what
  // made this wrong, and one that agrees with the query is one that can later
  // stop agreeing with it.
  return rows.map((row) => ({
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
  }));
}

/**
 * How many rows are waiting, counted rather than inferred from the page.
 *
 * The console shows at most `QUEUE_LIMIT`. Without this the screen could say
 * "200 pending" while 1,050 were — the one number a reviewer would use to
 * decide whether they are done for the slot.
 */
export async function countPending(service: SupabaseClient): Promise<number> {
  const result = await service
    .from("pilot_crisis_reviews")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");
  if (result.error) throw new Error(result.error.message);
  return result.count ?? 0;
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
