/**
 * Bearer-token authorization for the endpoints a scheduler calls (#B3).
 *
 * Not a user session: the caller is a cron job, and there is no person to sign
 * in. Each endpoint names its own environment variable so that handing a
 * scheduler the retention token does not also let it send mail, and so that
 * rotating one does not silently disable the other.
 *
 * **Unset means refuse everything.** A scheduled endpoint anyone on the
 * internet can trigger is a way to make this deployment send mail on command,
 * or to run a destructive purge at a moment of someone else's choosing. The
 * safe direction for a missing secret is closed.
 *
 * Lifted out of `api/safety/dispatch/route.ts` when the retention purge needed
 * the same comparison. Two copies of a constant-time compare is one copy too
 * many: the second is where `timingSafeEqual` gets called on buffers of
 * different lengths and throws instead of returning false.
 */

import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

export function bearerAuthorized(request: NextRequest, envVar: string): boolean {
  const expected = process.env[envVar];
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // `timingSafeEqual` throws on a length mismatch, which is itself a leak of
  // the length, so the lengths are compared first and the result is fixed.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
