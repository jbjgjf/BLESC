/**
 * A coordinator recovers an account the mail could not reach.
 *
 * ## Why self-service is not enough here
 *
 * `/login` sends a reset link with `resetPasswordForEmail`, and for most people
 * that is the whole feature. Three things make it unreliable for this pilot:
 *
 *   - **No production SMTP.** `supabase/config.toml` leaves `[auth.email.smtp]`
 *     commented out, so mail goes through the built-in sender, which is rate
 *     limited hard enough that a cohort hitting it on the same morning will not
 *     all get through. `[auth.rate_limit] email_sent = 2` per hour locally.
 *   - **The address may not be the student's.** School-issued accounts are
 *     often created on an address the student does not read, or cannot reach
 *     from their phone.
 *   - **PKCE is per-browser.** A link requested on a school laptop and opened on
 *     a phone cannot be redeemed. `/reset-password` says so plainly, and then
 *     the student needs somewhere to go.
 *
 * ## The shape, which is deliberately the guardian-link shape
 *
 * `/api/pilot/guardian/issue` already solves "a link must reach a person the
 * product cannot email": the coordinator on `PILOT_OPERATOR_USER_IDS` receives
 * it and hands it over through the school's own channel. This does the same,
 * for the same reason, and the reasoning is worth restating: the product does
 * not know how to reach this person, and the school does.
 *
 * **The link is never mailed by us and never returned to the student.** It is
 * returned to the coordinator, who is expected to give it to the student in
 * person or over a channel the school already trusts. A recovery link is a
 * sign-in, so handing it to the wrong person hands over the account.
 *
 * ## What is recorded
 *
 * Every attempt writes a `pilot_password_resets` row — the successes, the
 * addresses that matched nothing, and the failures. Resetting a student's
 * password is an administrative action on a minor's account, and an unlogged
 * one is indistinguishable from an account takeover after the fact. The route
 * refuses to return a link it could not record.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { jsonError } from "@/lib/server/api";
import { requireOperator } from "@/lib/server/pilotOperator";

export const runtime = "nodejs";

type Body = {
  /** The account to recover. Either this or `research_code`. */
  email?: string;
  /** The pseudonym, for a coordinator working from a roster rather than a mailbox. */
  research_code?: string;
};

export async function POST(request: NextRequest) {
  const operator = await requireOperator(request);
  if ("error" in operator) return operator.error;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return jsonError("A JSON body is required.", 422);
  }

  const researchCode = body.research_code?.trim();
  let email = body.email?.trim();
  let participantId: string | null = null;
  let ownerUserId: string | null = null;

  /*
   * A coordinator holding the roster knows the research code, not the address —
   * the roster is pseudonymous by design (#167). Resolving it here means they
   * never have to go looking for the student's email, which is the identifier
   * the rest of this product works to keep out of their hands.
   */
  if (researchCode) {
    const enrollment = await operator.service
      .from("pilot_enrollments")
      .select("participant_id, owner_user_id")
      .eq("research_code", researchCode)
      .maybeSingle();
    if (enrollment.error) return jsonError(enrollment.error.message, 502);
    if (!enrollment.data) return jsonError("Not found.", 404);

    participantId = enrollment.data.participant_id as string;
    ownerUserId = enrollment.data.owner_user_id as string;

    const { data, error } = await operator.service.auth.admin.getUserById(ownerUserId);
    if (error || !data.user?.email) return jsonError("Not found.", 404);
    email = data.user.email;
  }

  if (!email) return jsonError("email or research_code is required.", 422);

  /*
   * `generateLink` rather than `resetPasswordForEmail`.
   *
   * The second one sends mail, which is the thing that did not work. This
   * returns the link without sending anything, and — because it is generated
   * server-side rather than requested by a browser — it carries no PKCE
   * verifier, so it opens on whatever device the student actually has.
   */
  const generated = await operator.service.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${siteUrl()}/reset-password` },
  });

  const audit = async (outcome: "issued" | "not_found" | "failed", targetUserId: string | null) =>
    operator.service.from("pilot_password_resets").insert({
      issued_by: operator.userId,
      target_user_id: targetUserId,
      participant_id: participantId,
      research_code: researchCode ?? null,
      target_email_hash: createHash("sha256").update(email!.toLowerCase()).digest("hex").slice(0, 32),
      outcome,
    });

  if (generated.error) {
    await audit("not_found", ownerUserId);
    // Not echoed to the caller. The provider distinguishes "no such user" from
    // "rate limited", and an operator surface that repeated that would let a
    // coordinator — or anyone who obtained a coordinator's session — test
    // addresses against the roster.
    console.warn("[password-reset] link generation failed", generated.error.message);
    return jsonError("Not found.", 404);
  }

  const link = generated.data.properties?.action_link;
  if (!link) {
    await audit("failed", ownerUserId ?? generated.data.user?.id ?? null);
    return jsonError("The recovery link could not be generated.", 502);
  }

  const logged = await audit("issued", ownerUserId ?? generated.data.user?.id ?? null);
  if (logged.error) {
    // Refused rather than proceeding. An unlogged administrative reset on a
    // minor's account is exactly what an account takeover looks like afterwards,
    // and this row is the only thing that tells them apart. The link is already
    // valid at this point, so this leaves an issued-but-unlogged link in
    // existence — which is why it is reported as an error the operator sees
    // rather than swallowed.
    console.error("[password-reset] audit row not written; refusing to return the link", logged.error.message);
    return jsonError("The reset could not be recorded, so no link was issued.", 502);
  }

  return NextResponse.json({
    action_link: link,
    // Echoed so the coordinator can confirm they are recovering the account they
    // meant to, without having to look the address up elsewhere.
    research_code: researchCode ?? null,
    /** A reminder in the payload, where whoever is about to paste it will see it. */
    handling:
      "このリンクはログインと同じ強さを持ちます。本人であることを確認したうえで、学校の連絡経路で直接渡してください。メールやチャットに転送しないでください。",
  });
}

function siteUrl(): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/$/, "");
}
