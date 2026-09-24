/**
 * The operator side of protocol §4.4's manual review (#225).
 *
 * `GET`  the queue — metadata only, no journal text, no read logged.
 * `POST` one decision, or one text read (`action: "read"`).
 *
 * Reading is a POST even though it returns data, because it writes: the row in
 * `pilot_crisis_review_reads` saying who opened a student's journal. Making it
 * a GET would put "read twelve journals" one refresh away from "open the
 * console", and would let a prefetch do it.
 *
 * Authorisation is `requireOperator` — the same `PILOT_OPERATOR_USER_IDS`
 * allowlist as invitation issuing, and 404 rather than 403 so a signed-in
 * student learns nothing by probing.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import { SAFETY_ASSESSMENT_VERSION } from "@/lib/safety-assessment";
import {
  countPending,
  enqueuePendingReviews,
  loadQueue,
  readEntryText,
  recordDecision,
  slotFor,
  type ReviewStatus,
} from "@/lib/server/crisisTriage";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Which lexicon scored the queue, taken from the scorer itself rather than
 * restated here. A second copy of a version string is a version string that
 * stops matching the thing it versions.
 */
const ASSESSOR_VERSION = SAFETY_ASSESSMENT_VERSION;

type Decision = Exclude<ReviewStatus, "pending">;
const DECISIONS: readonly Decision[] = ["no_concern", "escalated", "unreadable"];

function asDecision(value: unknown): Decision | null {
  return typeof value === "string" && (DECISIONS as readonly string[]).includes(value)
    ? (value as Decision)
    : null;
}

export async function GET(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const includeDecided = request.nextUrl.searchParams.get("include_decided") === "1";

  try {
    // Building the queue is part of opening it. An entry written since the last
    // review that never got a row is an entry nobody was ever going to look at.
    const enqueued = await enqueuePendingReviews(operator.service, ASSESSOR_VERSION);
    const queue = await loadQueue(operator.service, { includeDecided });
    const pendingTotal = await countPending(operator.service);

    const pending = queue.filter((row) => row.status === "pending");
    return NextResponse.json({
      slot: slotFor(new Date()),
      enqueued: enqueued.enqueued,
      // What this call did not get to (#247). A queue that quietly stops at a
      // cap is the failure this console exists to rule out, so the leftovers
      // are reported rather than left to be inferred from a page that looks
      // full. `scan_complete: false` means `deferred` is a lower bound.
      deferred: enqueued.deferred,
      scan_complete: enqueued.scanComplete,
      counts: {
        pending: pending.length,
        // Every row waiting, not just the ones on this page. The screen shows
        // at most 200; a reviewer deciding whether the slot is finished needs
        // the other number.
        pending_total: pendingTotal,
        crisis: pending.filter((row) => row.assessed_risk === "crisis").length,
        elevated: pending.filter((row) => row.assessed_risk === "elevated").length,
        // Entries whose text is gone — purged on withdrawal, or past its
        // retention window. They still need a decision, and the decision is
        // `unreadable`, recorded rather than assumed.
        no_text: pending.filter((row) => !row.text_available).length,
      },
      queue,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "レビュー待ちを読み込めませんでした。", 502);
  }
}

type Body = {
  action?: "read" | "decide";
  review_id?: string;
  status?: string;
  note?: string;
};

export async function POST(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const reviewId = typeof body.review_id === "string" ? body.review_id : "";
  if (!reviewId) return jsonError("review_id is required.", 422);

  if (body.action === "read") {
    try {
      const result = await readEntryText(operator.service, reviewId, operator.userId);
      if (result.reason === "no_review") return jsonError("レビュー対象が見つかりません。", 404);
      return NextResponse.json({ text: result.text, reason: result.reason ?? null });
    } catch (err) {
      // Includes the deliberate refusal when the read could not be logged.
      return jsonError(err instanceof Error ? err.message : "本文を読み出せませんでした。", 502);
    }
  }

  const status = asDecision(body.status);
  if (!status) {
    return jsonError(
      `status must be one of ${DECISIONS.join(", ")}. "pending" は判断ではありません。`,
      422,
    );
  }

  try {
    await recordDecision(operator.service, {
      reviewId,
      reviewerUserId: operator.userId,
      status,
      note: typeof body.note === "string" ? body.note : undefined,
    });
    return NextResponse.json({ status: "recorded", review_id: reviewId, decision: status });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : "判断を記録できませんでした。", 502);
  }
}
