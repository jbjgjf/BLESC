/**
 * Is this invite code real? — asked before an account exists (#223).
 *
 * `protocol.md` §2 says participation is by invitation only and that nobody
 * joins through public signup. The screen did not enforce that: `/login` called
 * `supabase.auth.signUp` with no code anywhere near it, so any passer-by could
 * create an account in the project that holds the study. The collection gate
 * kept their data out of the research, so nothing was contaminated — but the
 * account count grew without bound and the product said one thing while doing
 * another.
 *
 * Fixing it needed a decision, because `/pilot/join` requires a session before
 * a code can be typed: deleting signup would sever the participant route
 * entirely. The order chosen is **code → account → enrolment**, which keeps the
 * flow self-service. The alternative — coordinators creating fifty accounts and
 * handing out passwords — puts a password nobody chose into a channel we do not
 * control, and makes recovery worse rather than better.
 *
 * ## This endpoint does not consume anything
 *
 * It answers one boolean. Redemption still happens in `/api/pilot/redeem`,
 * after the account exists, through `redeem_pilot_invitation` — so a code
 * checked here and then abandoned is still usable, and a check cannot burn
 * somebody's invitation.
 *
 * ## Every rejection looks the same
 *
 * No such code, expired, revoked, already fully redeemed, study not recruiting:
 * all answer `{ valid: false }`. Distinguishing them would let a caller map the
 * code space one probe at a time — "expired" confirms a code existed. This
 * mirrors `redeemInvitation`, which collapses the same five outcomes for the
 * same reason. The operator can still tell them apart, from the admin route.
 *
 * ## Why a limit matters here and not for guessing
 *
 * The code is 100 bits behind an HMAC; nobody is guessing it. The limit exists
 * because this endpoint is a free database round trip that anyone can call.
 */

import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/server/api";
import { hashInviteCode, inviteHashingConfigured } from "@/lib/server/inviteCodes";
import { RULES, consumeRateLimit, rateLimitHeaders, rateLimitSubject } from "@/lib/server/rateLimit";
import { serviceRoleClient } from "@/lib/server/supabaseWriter";
import { pilotStudySlug } from "@/lib/server/pilotGate";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const service = serviceRoleClient();

  // Counted before the code is even parsed, so a malformed-input loop costs the
  // same as a well-formed one.
  const limited = await consumeRateLimit(service, RULES.inviteCheck, rateLimitSubject(request));
  if (!limited.allowed) {
    return NextResponse.json(
      { detail: "試行回数が多すぎます。しばらく待ってからもう一度お試しください。" },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  let body: { code?: string };
  try {
    body = (await request.json()) as { code?: string };
  } catch {
    return jsonError("A JSON body is required.", 422);
  }

  const code = body.code?.trim();
  if (!code) return jsonError("code is required.", 422);

  // 503, not "invalid". A deployment with no HMAC key cannot tell a real code
  // from a fake one, and answering `false` would tell a participant holding a
  // perfectly good code that it is wrong.
  if (!inviteHashingConfigured()) {
    console.error("[invite-check] PILOT_INVITE_HMAC_KEY is not configured; no code can be checked");
    return jsonError("この環境では招待コードを確認できません。運営に連絡してください。", 503);
  }
  if (!service) return jsonError("Supabase is not configured.", 503);

  const slug = pilotStudySlug();
  if (!slug) return jsonError("Not found.", 404);

  const codeHash = hashInviteCode(code);
  if (!codeHash) return NextResponse.json({ valid: false });

  const invitation = await service
    .from("pilot_invitations")
    .select("expires_at, revoked_at, redeemed_count, max_redemptions, pilot_studies!inner(slug, status)")
    .eq("code_hash", codeHash)
    .maybeSingle();

  if (invitation.error) {
    console.warn("[invite-check] lookup failed", invitation.error.message);
    return jsonError("確認できませんでした。時間をおいてもう一度お試しください。", 502);
  }

  const row = invitation.data as
    | {
        expires_at: string | null;
        revoked_at: string | null;
        redeemed_count: number;
        max_redemptions: number;
        pilot_studies: { slug: string; status: string } | { slug: string; status: string }[];
      }
    | null;

  const study = Array.isArray(row?.pilot_studies) ? row?.pilot_studies[0] : row?.pilot_studies;
  const now = Date.now();

  const valid = Boolean(
    row &&
      study?.slug === slug &&
      study?.status === "recruiting" &&
      row.revoked_at === null &&
      (row.expires_at === null || Date.parse(row.expires_at) > now) &&
      row.redeemed_count < row.max_redemptions,
  );

  return NextResponse.json({ valid });
}
