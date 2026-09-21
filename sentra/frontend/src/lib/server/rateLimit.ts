/**
 * Attempt limits for the routes where unlimited attempts cost something (#234).
 *
 * Nothing in this app counted anything. The catalogue has had
 * 「試行回数が多すぎます」 in it for months with no code path that could produce
 * it, which is the shape of a limit somebody intended and nobody built.
 *
 * ## What this is and is not protecting
 *
 * **Not the invite codes.** Those are 100 bits behind an HMAC and fail closed
 * without the key (`inviteCodes.ts`); guessing one is not a thing a limit
 * needs to prevent. What is unbounded without this is *cost and capacity*:
 * rows in Supabase, guardian-verification links, and — once collection-only
 * mode is lifted — OpenAI calls that someone else pays for.
 *
 * ## Fail open, deliberately, and not everywhere
 *
 * `cronAuth.ts` fails closed: no secret, no run. This does the opposite when
 * the counter cannot be read, and the asymmetry is the point. A cron that does
 * not run is a job delayed; a limiter that refuses when its store is
 * unreachable locks fifty students out of a study they are enrolled in, to
 * prevent an abuse that may not be happening. The failure we accept is "an
 * attacker gets through during a Supabase outage". The failure we refuse is
 * "participants cannot take part because a counter table was slow".
 *
 * That trade is only right because nothing here is an authorisation check. The
 * gates that decide who may do what — `requireUser`, `requireOperator`,
 * `collectionRefusal`, the RLS policies — are elsewhere and all fail closed. If
 * a limit ever becomes the only thing standing between someone and an action,
 * this default is wrong for that call site and it should pass `failClosed`.
 */

import type { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export type RateLimitRule = {
  /** Namespace for the counter. Appears in the bucket key. */
  route: string;
  /** Attempts allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  /** How many attempts have been made in this window, including this one. */
  count: number;
  limit: number;
  /** Seconds until the window rolls over. For `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * Defaults, overridable per deployment.
 *
 * Chosen to be far above what a participant doing the thing normally would hit,
 * because the cost of a limit that catches real use is that somebody turns it
 * off. A student typing an invite code from a printed sheet gets it wrong once
 * or twice; twenty attempts an hour is not that person.
 */
export const RULES = {
  /** Checking whether an invite code is real, before an account exists. */
  inviteCheck: rule("invite-check", "PILOT_INVITE_CHECK_LIMIT", 20, 3600),
  /** Actually redeeming one. Lower: a successful redemption ends the flow. */
  inviteRedeem: rule("invite-redeem", "PILOT_INVITE_REDEEM_LIMIT", 10, 3600),
  /** Issuing or re-sending a guardian verification link. */
  guardianIssue: rule("guardian-issue", "PILOT_GUARDIAN_ISSUE_LIMIT", 20, 3600),
  /** Routes that call OpenAI and therefore spend money. */
  externalModel: rule("external-model", "EXTERNAL_MODEL_LIMIT", 60, 3600),
} as const;

function rule(route: string, envVar: string, fallback: number, windowSeconds: number): RateLimitRule {
  const configured = Number(process.env[envVar]);
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
  return { route, limit, windowSeconds };
}

/**
 * Who is being counted.
 *
 * A signed-in user is counted by id, which survives a changing address and
 * cannot be spoofed by a header. Before sign-in there is only the address, and
 * `x-forwarded-for` is attacker-controlled in general — behind Vercel the
 * left-most entry is the client as Vercel saw it, which is the best available
 * and still not proof. It is hashed so the counter table never holds an IP:
 * this is abuse accounting, not a visitor log, and an unhashed address here
 * would be personal data collected for no stated purpose.
 */
export function rateLimitSubject(request: NextRequest, userId?: string | null): string {
  if (userId) return `u:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const address = forwarded.split(",")[0]?.trim() || "unknown";
  return `a:${createHash("sha256").update(address).digest("hex").slice(0, 24)}`;
}

function windowStart(windowSeconds: number, now: Date): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Count one attempt and say whether it is allowed.
 *
 * `failClosed` flips the behaviour when the store cannot be reached. Default
 * false — see the header. Pass true only where the limit is itself the control,
 * which is not the case for anything in `RULES` today.
 */
export async function consumeRateLimit(
  service: SupabaseClient | null,
  rule: RateLimitRule,
  subject: string,
  options: { failClosed?: boolean; now?: Date } = {},
): Promise<RateLimitResult> {
  const now = options.now ?? new Date();
  const start = windowStart(rule.windowSeconds, now);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((start.getTime() + rule.windowSeconds * 1000 - now.getTime()) / 1000),
  );

  const openResult = (count: number): RateLimitResult => ({
    allowed: !options.failClosed,
    count,
    limit: rule.limit,
    retryAfterSeconds,
  });

  if (!service) {
    console.warn(`[rate-limit] no Supabase client for ${rule.route}; not counting`);
    return openResult(0);
  }

  const { data, error } = await service.rpc("bump_rate_limit", {
    p_bucket: `${rule.route}:${subject}`,
    p_window_start: start.toISOString(),
  });

  if (error) {
    // Loud, because a limiter that silently stops limiting is indistinguishable
    // from one that is working.
    console.error(`[rate-limit] counter unavailable for ${rule.route}; allowing`, error.message);
    return openResult(0);
  }

  const count = typeof data === "number" ? data : 0;
  return { allowed: count <= rule.limit, count, limit: rule.limit, retryAfterSeconds };
}

/** The headers a 429 should carry so a client can behave. */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "retry-after": String(result.retryAfterSeconds),
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(Math.max(0, result.limit - result.count)),
  };
}
