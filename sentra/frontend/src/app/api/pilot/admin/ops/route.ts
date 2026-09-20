/**
 * The route two other files already promised (#194).
 *
 * `cronAuth.ts` says "`/api/pilot/admin/ops` reports whether the jobs have
 * actually been running", and `cron/retention-purge/route.ts` says it "reports
 * `overdue`, and it should read zero the morning after this is scheduled".
 * Neither was true: nothing served that path. The comments described the
 * safety net that made failing closed acceptable, and the safety net did not
 * exist — which is the exact failure the 2026-09-18 audit ran into when it
 * could only say four settings "might" be unset.
 *
 * ## Two answers, and the second is the one to believe
 *
 * `config` reports what is set. `observed` reports what happened. They can
 * disagree, and when they do the second is right: `CRON_SECRET` present with
 * `retention.overdue` at 340 means the secret is set and the schedule still is
 * not draining anything — a wrong value, a project whose root directory does
 * not carry `vercel.json`, a deployment that never picked the manifest up.
 * A configuration check alone would have called that deployment healthy.
 *
 * ## What it will not say
 *
 * No value of any secret, no participant identifier, no text. Booleans, counts
 * and ages. `tests/pilot-ops-config.test.mjs` fails if a secret's value can
 * reach the response.
 *
 * ## Who may ask
 *
 * A study coordinator (`PILOT_OPERATOR_USER_IDS`), or a caller bearing
 * `CRON_SECRET` so an uptime check can poll it without an account. The second
 * is what makes this alertable: `ready: false` is a page-worthy condition and
 * nothing that pages anybody can be behind a browser session.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizedCron } from "@/lib/server/cronAuth";
import { requireOperator } from "@/lib/server/pilotOperator";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import {
  DISPATCH_STALE_MINUTES,
  blockingGaps,
  configChecks,
  oldestOwedMinutes,
} from "@/lib/server/opsConfig";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // Only try the shared secret when a bearer token was actually presented:
  // `authorizedCron` logs loudly on a missing `CRON_SECRET`, and an operator
  // signing in should not generate that line on every page load.
  const presentedBearer = (request.headers.get("authorization") ?? "").startsWith("Bearer ");
  const viaCronSecret = presentedBearer && authorizedCron(request);

  let service = viaCronSecret ? serviceRoleClient() : null;
  if (!viaCronSecret) {
    const operator = await requireOperator(request);
    if ("error" in operator) return operator.error;
    service = operator.service;
  }
  if (!service) {
    return NextResponse.json({ detail: "supabase_not_configured" }, { status: 503 });
  }

  const checks = configChecks();
  const now = new Date();
  const nowIso = now.toISOString();

  const [owedResult, noRecipientResult, overdueResult, retainedResult] = await Promise.all([
    // Small by construction — an escalation queue with enough rows for this to
    // be expensive is itself the emergency.
    service
      .from("safety_escalations")
      .select("created_at")
      .in("status", ["pending", "failed"]),
    service
      .from("safety_escalations")
      .select("id", { count: "exact", head: true })
      .eq("status", "no_recipient"),
    // Retained text whose expiry has passed and which is still there. This is
    // the purge's report card: the participant was told 90 days, and every row
    // counted here is a day past that.
    service
      .from("entries")
      .select("id", { count: "exact", head: true })
      .not("raw_text_ciphertext", "is", null)
      .lt("raw_text_expires_at", nowIso),
    service
      .from("entries")
      .select("id", { count: "exact", head: true })
      .not("raw_text_ciphertext", "is", null),
  ]);

  // A read that failed is reported as a failed read, not as a zero. A dashboard
  // that turns "could not ask" into "nothing is wrong" is how an outage becomes
  // an all-clear.
  const readErrors = [owedResult, noRecipientResult, overdueResult, retainedResult]
    .map((result) => result.error?.message)
    .filter((message): message is string => Boolean(message));

  const owedRows = (owedResult.data ?? []) as Array<{ created_at: string | null }>;
  const oldestOwed = oldestOwedMinutes(
    owedRows.map((row) => row.created_at),
    now,
  );
  const dispatchStale = oldestOwed !== null && oldestOwed > DISPATCH_STALE_MINUTES;
  const overdue = overdueResult.count ?? 0;

  const gaps = blockingGaps(checks);

  return NextResponse.json({
    generated_at: nowIso,
    // False whenever something a participant was promised is not happening.
    // Deliberately one flag: an alert rule should not have to know the list.
    ready: gaps.length === 0 && !dispatchStale && overdue === 0 && readErrors.length === 0,
    config: {
      ok: gaps.length === 0,
      // Full list, not just the failures: an operator confirming a fix wants to
      // see the row turn true, and a row that vanishes when satisfied cannot.
      checks,
      blocking: gaps.map((gap) => gap.name),
    },
    observed: {
      read_errors: readErrors,
      safety_dispatch: {
        owed: owedRows.length,
        oldest_owed_minutes: oldestOwed,
        stale_after_minutes: DISPATCH_STALE_MINUTES,
        // True means undelivered crisis notifications are sitting in a queue
        // that nothing is draining, whatever `config` says.
        stale: dispatchStale,
        no_recipient: noRecipientResult.count ?? 0,
      },
      retention_purge: {
        retained_rows: retainedResult.count ?? 0,
        overdue,
        // The first run after scheduling clears a backlog; a non-zero value the
        // morning after that is the schedule not running.
        healthy: overdue === 0,
      },
    },
    // Repository secrets are not visible from here. Saying so is better than a
    // report that looks complete and silently omits half the wiring.
    not_checked_here: {
      github_secrets: ["PILOT_BASE_URL", "SAFETY_DISPATCH_TOKEN"],
      how: "scripts/pilot/check-ops-config.mjs (gh secret list)",
    },
  });
}
