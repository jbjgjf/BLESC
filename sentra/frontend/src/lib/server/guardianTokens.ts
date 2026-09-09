/**
 * Guardian verification tokens: generation and the keyed hash (#164).
 *
 * Same three properties as `inviteCodes.ts`, for the same reasons, with one
 * difference that matters:
 *
 *   1. **The database never holds a token.** It holds
 *      HMAC-SHA256(token) under `PILOT_GUARDIAN_HMAC_KEY`.
 *
 *   2. **Fail closed.** No key configured means `hashGuardianToken` returns
 *      null and the confirm route refuses every token — a deployment that
 *      forgot the key verifies nobody, rather than verifying everybody under a
 *      constant.
 *
 *   3. **This one is not typed by a human.** An invitation code is read off
 *      paper by a student, so it is 100 bits of Crockford base32 formatted in
 *      groups. A guardian token arrives as a link, so it is 256 bits of
 *      base64url and is never normalised, never case-folded, and never
 *      "corrected" — the confusions `normalizeInviteCode` absorbs are exactly
 *      the mutations that must not be absorbed here. A token that does not
 *      match byte for byte is not a token with a typo.
 *
 * A separate key from `PILOT_INVITE_HMAC_KEY`, so that a leak of one does not
 * let the holder forge the other, and so the guardian path can be re-keyed
 * (invalidating every outstanding link) without invalidating the invitations
 * that schools have already been handed.
 */

import { createHmac, randomBytes } from "node:crypto";

/** 32 bytes. Not read aloud, not typed, so length costs nothing. */
const TOKEN_BYTES = 32;

export const TOKEN_ENTROPY_BITS = TOKEN_BYTES * 8;

/**
 * The clear-text prefix stored beside the hash, so an operator can match a
 * support call to a row and a participant can be told which of two links is
 * live. Six base64url characters is 36 bits — enough to name a token, nowhere
 * near enough to present one.
 */
export const TOKEN_PREFIX_LENGTH = 6;

export function generateGuardianToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Whether a string could be one of our tokens.
 *
 * Shape only. It exists so that a malformed request is answered without an
 * HMAC computation and without a database round trip, not as a security
 * boundary — the boundary is the hash lookup.
 */
export function looksLikeGuardianToken(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{40,64}$/.test(raw);
}

export function guardianTokenPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LENGTH);
}

/** The configured HMAC key, or null when the deployment has none. */
export function guardianHmacKey(): Buffer | null {
  const configured = process.env.PILOT_GUARDIAN_HMAC_KEY;
  if (!configured) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(configured, "base64");
  } catch {
    console.warn("[pilot-guardian] PILOT_GUARDIAN_HMAC_KEY is not valid base64; no verification can complete");
    return null;
  }
  if (bytes.length < 32) {
    console.warn("[pilot-guardian] PILOT_GUARDIAN_HMAC_KEY must decode to at least 32 bytes; no verification can complete");
    return null;
  }
  return bytes;
}

export function guardianHashingConfigured(): boolean {
  return guardianHmacKey() !== null;
}

/** The value stored in `pilot_guardian_verifications.token_hash`, or null. */
export function hashGuardianToken(raw: string): string | null {
  if (!looksLikeGuardianToken(raw)) return null;

  const key = guardianHmacKey();
  if (!key) return null;

  return createHmac("sha256", key).update(raw, "utf8").digest("hex");
}

/**
 * The link handed to the guardian.
 *
 * Built server-side from `NEXT_PUBLIC_SITE_URL` rather than from the request's
 * Host header: the header is attacker-controlled, and a verification link
 * pointing at a host of someone else's choosing is a phishing page with a valid
 * token in it. With no site URL configured this returns a path, which still
 * works when the participant is handing their own device over and fails
 * visibly when they are not.
 */
export function guardianVerificationUrl(token: string): string {
  const path = `/pilot/guardian/${encodeURIComponent(token)}`;
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  return origin ? `${origin}${path}` : path;
}
