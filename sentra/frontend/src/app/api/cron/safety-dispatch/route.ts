/**
 * The schedule that makes crisis-notification retries actually happen (#179).
 *
 * `/api/safety/dispatch` was written as the retry path and documented with a
 * `vercel.json` snippet to paste. Nothing pasted it. Worse, the `vercel.json`
 * that did exist sat at the repository root while the Vercel project's root
 * directory is `sentra/frontend` — Vercel reads the manifest from the project
 * root, so that file was never read by anything, and the two cron entries in it
 * pointed at paths that did not exist.
 *
 * The result: an escalation whose first delivery attempt failed stayed
 * `pending` forever. The module that records it promises its failure mode is
 * "late, never never", and without a schedule that promise was false.
 *
 * This route exists rather than pointing the schedule at `/api/safety/dispatch`
 * because Vercel Cron issues a bare `GET` with `Authorization: Bearer
 * $CRON_SECRET`, and that endpoint is a `POST` behind `SAFETY_DISPATCH_TOKEN`.
 * Both now call the same `dispatchPendingEscalations`.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizedCron } from "@/lib/server/cronAuth";
import { dispatchPendingEscalations } from "@/lib/server/safetyDispatch";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!authorizedCron(request)) {
    return NextResponse.json({ detail: "forbidden" }, { status: 403 });
  }

  const service = serviceRoleClient();
  if (!service) {
    console.error("[cron:safety-dispatch] Supabase is not configured; escalations are not being retried");
    return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });
  }

  const result = await dispatchPendingEscalations(service);
  if ("error" in result) return NextResponse.json({ detail: result.error }, { status: 502 });
  return NextResponse.json(result);
}
