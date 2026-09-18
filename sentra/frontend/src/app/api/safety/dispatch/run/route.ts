/**
 * The door a scheduler can actually open.
 *
 * `/api/safety/dispatch` does the retry on `POST` and answers a health probe on
 * `GET`. That split is right for a human operator and wrong for the one caller
 * that matters most: **a Vercel cron job issues `GET` and nothing else.**
 *
 * So the configuration this repository told operators to use —
 *
 *     { "crons": [{ "path": "/api/safety/dispatch", "schedule": "*\/5 * * * *" }] }
 *
 * — hit the health probe every five minutes, returned 200, showed green on the
 * cron dashboard, and retried nothing. A crisis escalation whose first delivery
 * failed stayed in the queue until someone thought to look. #179.
 *
 * This route exists so that the scheduler's verb and the work's verb do not
 * have to be the same verb. It accepts `GET` (for Vercel and anything else that
 * only schedules reads) and `POST` (for a scheduler that can choose), and both
 * run the identical dispatch. There is no probe here, so there is no way to
 * configure a cron against this path and have it silently do nothing.
 *
 * Yes, a `GET` that sends mail is not a safe method. The alternative was a
 * scheduler that cannot reach the code that pages a school at 02:00, and
 * between a pedantic verb and a student nobody is told about, this is not a
 * close call. Nothing else may call this: the shared secret is checked first.
 */

import { NextRequest, NextResponse } from "next/server";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { dispatchAuthorized, runSafetyDispatch } from "@/lib/server/safetyDispatch";

export const runtime = "nodejs";
export const maxDuration = 60;

async function dispatch(request: NextRequest) {
  if (!dispatchAuthorized(request.headers.get("authorization"))) {
    // Logged, because the most likely cause is a scheduler configured against a
    // secret this deployment does not hold — which looks, from the cron
    // dashboard, exactly like a job that is running fine.
    console.error(
      "[safety-dispatch] a scheduled dispatch was refused. " +
        "Set CRON_SECRET (Vercel cron) or SAFETY_DISPATCH_TOKEN, and make the scheduler present it " +
        "as `Authorization: Bearer <secret>`. While this is refused, nothing is retrying crisis escalations.",
    );
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });

  try {
    return NextResponse.json(await runSafetyDispatch(service));
  } catch (error) {
    return NextResponse.json(
      { detail: error instanceof Error ? error.message : "dispatch failed" },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return dispatch(request);
}

export async function POST(request: NextRequest) {
  return dispatch(request);
}
