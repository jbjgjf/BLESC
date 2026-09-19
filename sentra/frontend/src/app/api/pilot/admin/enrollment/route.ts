/**
 * Opening and closing a cohort's collection window (#B1).
 *
 * The two transitions a participant must not make for themselves —
 * `enrolled → collecting` and `collecting → completed` — had no caller at all.
 * The participant route refuses them by design and says so in its header; the
 * operator side it points at was never built. Consent could be completed and
 * the journal stayed locked forever, because `pilotGate` admits `collecting`
 * and nothing could reach it.
 *
 * Three properties, in the order they matter:
 *
 *   1. **The cohort is the unit.** The protocol fixes a date for a cohort, not
 *      for a person, and an operator opening 50 windows one at a time will get
 *      a different answer for somebody. `enrollment_ids` narrows it when a
 *      single participant genuinely needs a different answer — a late joiner,
 *      a device that failed on day 0 — and that is the exception, spelled out
 *      in the request rather than reached by clicking 50 times.
 *
 *   2. **Refusals are per row and never fatal.** A cohort where three people
 *      have not finished consent is the ordinary case on opening morning, not
 *      an error: those three come back as `consent_missing` and the other 47
 *      open. Returning 4xx for the batch would make the operator's next move
 *      "retry and hope", which is how a window gets opened twice.
 *
 *   3. **The transition table is still the database's.** This route decides
 *      *who* may ask; `advance_pilot_enrollment` decides whether the step is
 *      legal, under a row lock, and re-checks consent for `enrolled`. Nothing
 *      here writes `state` directly.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import {
  advanceEnrollment,
  loadEnrollmentsForStudy,
  loadStudyBySlug,
  type TransitionOutcome,
} from "@/lib/server/pilotStore";
import { OPERATOR_TRANSITIONS, canTransition, type PilotState } from "@/lib/pilotEnrollment";

export const runtime = "nodejs";

/** How many rows one request may advance. A 50-person study fits; a typo does not. */
const MAX_BATCH = 200;

type Body = {
  study?: string;
  cohort?: string;
  to?: string;
  enrollment_ids?: string[];
  reason?: string;
};

type RowOutcome = {
  enrollment_id: string;
  research_code: string;
  from: PilotState;
  outcome: TransitionOutcome;
  state?: PilotState;
};

export async function POST(request: NextRequest) {
  const auth = await requireOperator(request);
  if ("error" in auth) return auth.error;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const slug = typeof body.study === "string" ? body.study.trim() : "";
  const to = typeof body.to === "string" ? (body.to as PilotState) : null;
  if (!slug || !to) return jsonError("study and to are required.", 422);

  // The allowlist is this route's whole purpose, so it is checked before
  // anything is read. `withdrawn` lands here too: it is a participant's own
  // decision and is absent from OPERATOR_TRANSITIONS deliberately.
  if (!OPERATOR_TRANSITIONS.includes(to)) {
    return jsonError(
      `この操作は運営からは実行できません。運営が指定できるのは ${OPERATOR_TRANSITIONS.join(", ")} です。`,
      403,
    );
  }

  const study = await loadStudyBySlug(auth.service, slug);
  if (!study) return jsonError("研究が見つかりません。", 404);

  const cohort = typeof body.cohort === "string" && body.cohort.trim() ? body.cohort.trim() : undefined;
  const all = await loadEnrollmentsForStudy(auth.service, study.id, cohort);

  const requested = Array.isArray(body.enrollment_ids)
    ? new Set(body.enrollment_ids.filter((id) => typeof id === "string"))
    : null;
  if (requested && requested.size === 0) {
    return jsonError("enrollment_ids was given but empty.", 422);
  }

  const scoped = requested ? all.filter((row) => requested.has(row.id)) : all;

  // Named ids that the study/cohort scope does not contain are reported rather
  // than skipped. An operator who pasted an id from the wrong cohort should be
  // told, not left to infer it from a count that came back one short.
  const missing = requested
    ? Array.from(requested).filter((id) => !scoped.some((row) => row.id === id))
    : [];

  if (scoped.length > MAX_BATCH) {
    return jsonError(`対象が${scoped.length}件あります。${MAX_BATCH}件以下に絞ってください。`, 422);
  }

  const reason = typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined;
  const results: RowOutcome[] = [];

  // Sequential. `advance_pilot_enrollment` takes a row lock per enrollment, and
  // a cohort of 50 is not worth the contention or the harder-to-read failure
  // mode that a parallel batch produces halfway through.
  for (const row of scoped) {
    // Asked locally first so that a row already in the target state is reported
    // as `illegal_transition` without a round trip. The SQL re-derives the same
    // answer under the lock and its verdict is the one recorded.
    if (!canTransition(row, to)) {
      results.push({
        enrollment_id: row.id,
        research_code: row.research_code,
        from: row.state,
        outcome: "illegal_transition",
        state: row.state,
      });
      continue;
    }

    const result = await advanceEnrollment(auth.service, {
      enrollmentId: row.id,
      ownerUserId: row.owner_user_id,
      to,
      actor: "operator",
      reason,
    });

    results.push({
      enrollment_id: row.id,
      research_code: row.research_code,
      from: row.state,
      outcome: result.outcome,
      state: result.state,
    });
  }

  const counts = results.reduce<Record<string, number>>((acc, row) => {
    acc[row.outcome] = (acc[row.outcome] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    study: slug,
    cohort: cohort ?? null,
    to,
    considered: scoped.length,
    counts,
    results,
    ...(missing.length ? { not_in_scope: missing } : {}),
  });
}

/**
 * What a cohort looks like before the operator decides anything.
 *
 * Deliberately the same scoping as POST, so "who would this open" and "open it"
 * cannot disagree about which rows are in the cohort.
 */
export async function GET(request: NextRequest) {
  const auth = await requireOperator(request);
  if ("error" in auth) return auth.error;

  const slug = request.nextUrl.searchParams.get("study")?.trim();
  if (!slug) return jsonError("study is required.", 422);

  const study = await loadStudyBySlug(auth.service, slug);
  if (!study) return jsonError("研究が見つかりません。", 404);

  const cohort = request.nextUrl.searchParams.get("cohort")?.trim() || undefined;
  const rows = await loadEnrollmentsForStudy(auth.service, study.id, cohort);

  const byState = rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.state] = (acc[row.state] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    study: slug,
    cohort: cohort ?? null,
    total: rows.length,
    by_state: byState,
    // Not the owner id: an operator planning a window needs to know how many
    // and which pseudonyms, never which account.
    enrollments: rows.map((row) => ({
      enrollment_id: row.id,
      research_code: row.research_code,
      cohort: row.cohort,
      state: row.state,
      is_minor: row.is_minor,
      collection_started_at: row.collection_started_at,
      completed_at: row.completed_at,
      ready_for: OPERATOR_TRANSITIONS.filter((target) => canTransition(row, target)),
    })),
  });
}
