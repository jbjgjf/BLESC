/**
 * Invitation codes: generation, normalisation and the keyed hash (#163).
 *
 * Three properties, in the order they matter:
 *
 *   1. **The database never holds a code.** What it holds is
 *      HMAC-SHA256(code) under `PILOT_INVITE_HMAC_KEY`, which lives in the
 *      environment and not in Postgres. A dump of `pilot_invitations` is a
 *      list of hashes nobody can redeem. A plain SHA-256 would not do this:
 *      the code space is small enough (100 bits, but drawn from a known
 *      alphabet and format) that an attacker with the table could confirm
 *      guesses offline. The key is what makes offline guessing useless.
 *
 *   2. **Fail closed.** With no key configured, `hashInviteCode` returns null
 *      and the redeem route refuses every code. A deployment that forgot the
 *      key rejects everyone, rather than accepting everyone under a constant.
 *
 *   3. **A human has to read it off paper and type it.** The alphabet is
 *      Crockford base32 — no I, L, O or U — and `normalizeInviteCode` maps the
 *      confusions people actually make (`O`→`0`, `I`/`l`→`1`) rather than
 *      rejecting them. A code that fails because the student read a zero as an
 *      O is a support call, and support calls during a 3-day dry run are the
 *      thing being tested.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Crockford base32: 32 symbols, minus I, L, O, U. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const GROUPS = 4;
const GROUP_LENGTH = 5;

/** 4 groups × 5 symbols × 5 bits = 100 bits. */
export const CODE_ENTROPY_BITS = GROUPS * GROUP_LENGTH * Math.log2(ALPHABET.length);

/**
 * The clear-text prefix stored alongside the hash so an operator can tell two
 * batches apart. Four symbols is 20 bits — enough to name a code, nowhere near
 * enough to redeem one.
 */
export const CODE_PREFIX_LENGTH = 4;

/**
 * A fresh code, formatted for reading aloud: `A1B2C-D3E4F-G5H6J-K7M8N`.
 *
 * `randomBytes`, not `Math.random`. Rejection sampling on each byte keeps the
 * distribution uniform: taking `byte % 32` would be uniform here only because
 * 256 is a multiple of 32, and relying on that silently breaks the day someone
 * shortens the alphabet.
 */
export function generateInviteCode(): string {
  const symbols: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);

  while (symbols.length < GROUPS * GROUP_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue;
      symbols.push(ALPHABET[byte % ALPHABET.length]);
      if (symbols.length === GROUPS * GROUP_LENGTH) break;
    }
  }

  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i += 1) {
    groups.push(symbols.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(""));
  }
  return groups.join("-");
}

/**
 * The canonical form of whatever the participant typed, or null if it cannot be
 * one of our codes.
 *
 * Case, spaces, hyphens and the four classic misreadings are all absorbed. What
 * is not absorbed is a wrong length: a 19-symbol string is not a code with a
 * typo, it is a different string, and accepting it would mean hashing something
 * we know cannot match.
 */
export function normalizeInviteCode(raw: string): string | null {
  if (typeof raw !== "string") return null;

  // `O`→`0` and `I`/`L`→`1` are Crockford's own decoding rules. `U`→`V` is
  // ours: U is excluded from the alphabet, and a typed U is far more likely to
  // be a misread V than a mistake worth rejecting the whole code over.
  //
  // `Q` is NOT mapped. It looks like it should pair with `O`, and an earlier
  // version of this function folded both into `0` — which silently corrupted
  // every valid code containing a Q, since Q is a real symbol in this alphabet
  // and O is not.
  const mapped = raw
    .toUpperCase()
    .replace(/[\s\-–—_]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");

  if (mapped.length !== GROUPS * GROUP_LENGTH) return null;
  for (const symbol of mapped) {
    if (!ALPHABET.includes(symbol)) return null;
  }
  return mapped;
}

/** The clear-text prefix for an already-normalised code. */
export function inviteCodePrefix(normalized: string): string {
  return normalized.slice(0, CODE_PREFIX_LENGTH);
}

/** The configured HMAC key, or null when the deployment has none. */
export function inviteHmacKey(): Buffer | null {
  const configured = process.env.PILOT_INVITE_HMAC_KEY;
  if (!configured) return null;

  let bytes: Buffer;
  try {
    bytes = Buffer.from(configured, "base64");
  } catch {
    console.warn("[pilot-invite] PILOT_INVITE_HMAC_KEY is not valid base64; no code can be redeemed");
    return null;
  }
  if (bytes.length < 32) {
    console.warn("[pilot-invite] PILOT_INVITE_HMAC_KEY must decode to at least 32 bytes; no code can be redeemed");
    return null;
  }
  return bytes;
}

export function inviteHashingConfigured(): boolean {
  return inviteHmacKey() !== null;
}

/**
 * The value stored in `pilot_invitations.code_hash`, or null when unconfigured.
 *
 * Takes the raw string and normalises internally so that no caller can hash an
 * un-normalised code by accident — a code hashed in its typed form would never
 * match the one hashed at issue time.
 */
export function hashInviteCode(raw: string): string | null {
  const normalized = normalizeInviteCode(raw);
  if (!normalized) return null;

  const key = inviteHmacKey();
  if (!key) return null;

  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hashes.
 *
 * The redeem path looks codes up by an indexed equality in Postgres, which is
 * not constant time and does not need to be — the value being compared is
 * already a keyed hash, so timing reveals nothing about the code. This exists
 * for the places that compare two hashes in the process (tests, and the
 * operator tool checking whether a batch was already issued).
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * A pseudonymous research id: `P-` plus six symbols.
 *
 * Short, because it is read aloud in a debrief and written on paper alongside
 * a consent form. Not unique by construction — 30 bits over a 50-participant
 * study collides with probability ~1e-6, which is small but not zero, so
 * `pilot_enrollments` carries a unique index on (study_id, research_code) and
 * the caller retries on conflict. Uniqueness is the database's job; this only
 * has to be unguessable enough that a research code is not a participant name.
 */
export function generateResearchCode(): string {
  const symbols: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (symbols.length < 6) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      symbols.push(ALPHABET[byte % ALPHABET.length]);
      if (symbols.length === 6) break;
    }
  }
  return `P-${symbols.join("")}`;
}
