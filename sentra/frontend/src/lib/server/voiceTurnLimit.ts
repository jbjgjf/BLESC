/**
 * The attempt limit on `POST /api/voice/turn` (#369), and the one thing it
 * must not limit.
 *
 * A voice turn writes a `chat_sessions` row, a `safety_audits` row and one or
 * two `chat_messages` rows from text the client supplies, and nothing counted
 * how often. Past the limit the route writes none of them.
 *
 * **A crisis is not one of the things the limit drops.** The limit exists to
 * stop rows piling up, and "nobody was told" is not an acceptable way to stop
 * them. So an over-limit turn is still read by the deterministic floor — this
 * turn's own words, no database read, no model — and a turn that assesses as
 * notifiable is handed to `escalateFloor`. That cannot be used to ring anyone
 * repeatedly: `safety_escalations` already holds one row per participant,
 * level, surface and hour (`dedupeKey`), so the most an over-limit caller adds
 * is the single alert that hour would have carried anyway.
 *
 * Kept out of the route file so it can be run without a Next runtime, for the
 * same reason `safetyEscalation.ts` is.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { assessSafety } from "../safety-assessment.ts";
import { RULES, consumeRateLimit, rateLimitHeaders, type RateLimitRule } from "./rateLimit.ts";
import { notifiableLevel, type EscalationLevel } from "./safetyEscalation.ts";

export const VOICE_TURN_LIMITED_MESSAGE = "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";

/**
 * Null when the turn may proceed; otherwise the 429 to return, after which the
 * caller writes nothing.
 */
export async function limitVoiceTurn(
  service: SupabaseClient | null,
  input: {
    /** From `rateLimitSubject`: the signed-in user. */
    subject: string;
    /** The student's utterance, as posted. */
    message: string;
    /** Records the escalation for an over-limit turn the floor reads as notifiable. */
    escalateFloor: (level: EscalationLevel, reasons: string[]) => Promise<void>;
    rule?: RateLimitRule;
    now?: Date;
  },
): Promise<Response | null> {
  const limited = await consumeRateLimit(service, input.rule ?? RULES.authenticatedWrite, input.subject, { now: input.now });
  if (limited.allowed) return null;

  const floor = assessSafety(input.message);
  const level = notifiableLevel(floor.risk_level);
  if (level) await input.escalateFloor(level, floor.reasons);

  return Response.json({ detail: VOICE_TURN_LIMITED_MESSAGE }, { status: 429, headers: rateLimitHeaders(limited) });
}
