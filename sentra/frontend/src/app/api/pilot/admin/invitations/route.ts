/**
 * Operator route: issue codes, see usage, revoke (#163).
 *
 * Authorization is an explicit allowlist (`PILOT_OPERATOR_USER_IDS`), the same
 * shape as `RESEARCH_EXPORT_USER_IDS` on the export route and for the same
 * reason: an empty allowlist means nobody, so a deployment that has not decided
 * who runs the study cannot issue codes for it.
 *
 * The asymmetry worth naming: `POST` returns clear-text codes and they are
 * returned exactly once. Nothing stores them — `pilot_invitations` holds only
 * the HMAC — so a code that is lost is reissued and never recovered. That is
 * the property that makes a leaked database useless, and it is also the reason
 * this response must not be logged or cached.
 *
 * `GET` deliberately cannot see codes either. An operator screen needs "how
 * many of batch 3-B are left", and answering that with hashes in the browser
 * would put them in a place the threat model does not want them.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";
import { invitationUsage, issueInvitations, loadStudyBySlug, revokeInvitations } from "@/lib/server/pilotStore";
import { inviteHashingConfigured } from "@/lib/server/inviteCodes";

export const runtime = "nodejs";

/** Bounded so a mis-typed count cannot mint ten thousand codes. */
const MAX_BATCH = 200;

export async function GET(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  const slug = request.nextUrl.searchParams.get("study");
  if (!slug) return jsonError("study is required.", 422);

  const study = await loadStudyBySlug(operator.service, slug);
  if (!study) return jsonError("Study was not found.", 404);

  const usage = await invitationUsage(operator.service, study.id);

  return NextResponse.json({
    study: {
      slug: study.slug,
      title: study.title,
      status: study.status,
      protocol_version: study.protocol_version,
      is_dry_run: study.is_dry_run,
    },
    invitations: usage,
    totals: {
      issued: usage.length,
      redeemed: usage.filter((row) => row.redeemed > 0).length,
      revoked: usage.filter((row) => row.revoked).length,
      available: usage.filter((row) => !row.revoked && row.redeemed < row.max).length,
    },
  });
}

type IssueBody = {
  study?: string;
  count?: number;
  cohort?: string;
  /**
   * Whether the participants these codes are for need guardian verification.
   * Set here, by the coordinator handing out the codes, because the alternative
   * was asking the participant — and a minor who picks "18歳以上" on the join
   * screen skips the guardian step entirely. Omitted, the code carries no
   * answer and redemption falls back to the redeemer's own statement, which is
   * the pre-20260909 behaviour and the weaker one.
   */
  is_minor?: boolean;
  max_redemptions?: number;
  expires_at?: string | null;
  note?: string | null;
};

export async function POST(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  if (!inviteHashingConfigured()) {
    return jsonError("PILOT_INVITE_HMAC_KEY is not configured; codes cannot be issued.", 503);
  }

  let body: IssueBody;
  try {
    body = (await request.json()) as IssueBody;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const slug = typeof body.study === "string" ? body.study : "";
  if (!slug) return jsonError("study is required.", 422);

  const count = Number(body.count ?? 0);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    return jsonError(`count must be an integer between 1 and ${MAX_BATCH}.`, 422);
  }

  const study = await loadStudyBySlug(operator.service, slug);
  if (!study) return jsonError("Study was not found.", 404);

  const result = await issueInvitations(operator.service, {
    studyId: study.id,
    count,
    cohort: typeof body.cohort === "string" ? body.cohort : undefined,
    isMinor: typeof body.is_minor === "boolean" ? body.is_minor : undefined,
    maxRedemptions: Number.isInteger(body.max_redemptions) ? Number(body.max_redemptions) : undefined,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
    note: typeof body.note === "string" ? body.note.slice(0, 200) : null,
  });

  if (result.error) return jsonError(result.error, 502);

  // Returned once, stored nowhere. `no-store` is not decoration: a cached copy
  // of this response is a list of live invitation codes.
  return NextResponse.json(
    {
      status: "issued",
      study: study.slug,
      codes: result.issued,
      warning: "These codes are shown once and cannot be recovered. Distribute them now.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

type RevokeBody = { study?: string; prefix?: string };

export async function DELETE(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  let body: RevokeBody;
  try {
    body = (await request.json()) as RevokeBody;
  } catch {
    return jsonError("Request body must be JSON.", 400);
  }

  const slug = typeof body.study === "string" ? body.study : "";
  const prefix = typeof body.prefix === "string" ? body.prefix.trim() : "";
  if (!slug || !prefix) return jsonError("study and prefix are required.", 422);

  const study = await loadStudyBySlug(operator.service, slug);
  if (!study) return jsonError("Study was not found.", 404);

  const result = await revokeInvitations(operator.service, { studyId: study.id, prefix });
  if (result.error) return jsonError(result.error, 502);

  return NextResponse.json({ status: "revoked", count: result.revoked, prefix: prefix.toUpperCase() });
}
