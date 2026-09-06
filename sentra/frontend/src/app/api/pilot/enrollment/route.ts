/**
 * Reading and advancing the caller's own enrollment (#163).
 *
 * `GET` answers "where am I". `POST` asks the server to advance one step, and
 * the server decides whether that step is legal — the body names the target
 * state so a stale tab cannot advance twice, but the transition table lives in
 * `advance_pilot_enrollment` and is not negotiable from here.
 *
 * Two transitions are deliberately NOT reachable through this route:
 *
 *   - `guardian_verified`. A guardian confirming through the participant's own
 *     session is not a guardian confirmation; it is the participant clicking a
 *     button. That step belongs to the operator route (#164) and records how it
 *     was verified.
 *
 *   - `collecting`. The collection window opens for a cohort, on a date the
 *     protocol fixes. A participant who could open their own window could
 *     start collecting before the baseline period the analysis assumes.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireUser } from "@/lib/server/api";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { advanceEnrollment, loadEnrollmentsForUser, loadStudyBySlug } from "@/lib/server/pilotStore";
import { canTransition, enrollmentProgress, pendingRequirement, type PilotState } from "@/lib/pilotEnrollment";

export const runtime = "nodejs";

/** What a participant may ask for themselves. See the header for the two that are missing. */
const PARTICIPANT_TRANSITIONS: readonly PilotState[] = [
  "information_read",
  "participant_assented",
  "enrolled",
  "withdrawn",
];

export async function GET(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  const enrollments = await loadEnrollmentsForUser(service, auth.user.id);
  const slug = request.nextUrl.searchParams.get("study");

  const filtered = slug
    ? await (async () => {
        const study = await loadStudyBySlug(service, slug);
        return study ? enrollments.filter((row) => row.study_id === study.id) : [];
      })()
    : enrollments;

  return NextResponse.json({
    enrollments: filtered.map((row) => ({
      ...row,
      progress: enrollmentProgress(row),
      pending: pendingRequirement(row),
    })),
  });
}

type TransitionBody = {
  enrollment_id?: string;
  to?: string;
  reason?: string;
};

export async function POST(request: NextRequest) {
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  let body: TransitionBody;
  try {
    body = (await request.json()) as TransitionBody;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const enrollmentId = typeof body.enrollment_id === "string" ? body.enrollment_id : "";
  const to = typeof body.to === "string" ? (body.to as PilotState) : null;
  if (!enrollmentId || !to) return jsonError("enrollment_id and to are required.", 422);

  if (!PARTICIPANT_TRANSITIONS.includes(to)) {
    return jsonError("この操作は参加者からは実行できません。", 403);
  }

  const service = serviceRoleClient();
  if (!service) return jsonError("Supabase is not configured.", 503);

  // A local check before the round trip, so the common "your tab is stale"
  // case returns the current state instead of a generic failure. It does not
  // grant anything: the SQL function re-derives the same decision under a row
  // lock, and its answer is the one that counts.
  const enrollments = await loadEnrollmentsForUser(service, auth.user.id);
  const current = enrollments.find((row) => row.id === enrollmentId);
  if (!current) return jsonError("参加登録が見つかりません。", 404);

  if (!canTransition(current, to)) {
    return NextResponse.json(
      {
        status: "illegal_transition",
        state: current.state,
        pending: pendingRequirement(current),
      },
      { status: 409 },
    );
  }

  const result = await advanceEnrollment(service, {
    enrollmentId,
    ownerUserId: auth.user.id,
    to,
    actor: "participant",
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
  });

  if (result.outcome === "ok") {
    return NextResponse.json({ status: "ok", state: result.state });
  }

  if (result.outcome === "consent_missing") {
    // Not a failure to explain away. The participant has not completed the
    // consent screen, and the enrollment stays where it is until they do.
    return NextResponse.json(
      { status: "consent_missing", state: current.state, pending: "consent_record" },
      { status: 409 },
    );
  }

  const status = result.outcome === "not_found" ? 404 : result.outcome === "error" ? 502 : 409;
  return NextResponse.json({ status: result.outcome, state: result.state ?? current.state }, { status });
}
