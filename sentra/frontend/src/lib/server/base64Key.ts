/**
 * Reading a base64 key from the environment, and saying what is wrong with it
 * when it will not read (#255).
 *
 * Five places used to do this separately — `opsConfig.ts`, `rawTextCrypto.ts`,
 * `safetyEscalation.ts`, `inviteCodes.ts`, `guardianTokens.ts` — and all five
 * were wrong in the same way:
 *
 * ```ts
 * try { bytes = Buffer.from(configured, "base64"); }
 * catch { return null; }          // ← never runs
 * ```
 *
 * `Buffer.from(x, "base64")` does not throw on a value that is not base64. It
 * **silently discards every character outside the alphabet** and decodes what
 * is left, so `"not base64 at all!!!"` becomes ten bytes and the `catch` block
 * is unreachable. What was left doing the work was the length check, which
 * happens to reject most garbage and does not reject the one mistake an
 * operator actually makes.
 *
 * ## The mistake that got through
 *
 * `openssl rand -hex 32` prints 64 hex characters. Every hex character is in
 * the base64 alphabet, so the string decodes cleanly to 48 bytes:
 *
 *   - `RESEARCH_RAW_TEXT_KEY` wants exactly 32, so the key is refused and no
 *     journal text is retained — while `opsConfig.ts` asked only for 32 *or
 *     more* and reported the deployment healthy. The operator's self-check said
 *     green, retention was off, and the §4.4 review queue stayed empty, which
 *     from the console is indistinguishable from a day nobody wrote.
 *   - The `>= 32` keys accepted the 48 bytes and worked, which is worse than
 *     failing: the deployment runs on a key nobody meant to set, and the day
 *     somebody "fixes" the format every invitation code and guardian link
 *     already issued stops matching.
 *
 * So the check has to name that case rather than infer it from a length. A hex
 * string cannot be told apart from base64 by decoding — it decodes fine — so
 * the only thing left to look at is the alphabet, and that makes this a
 * heuristic. It is a safe one. A 32-byte key base64-encodes to 44 characters
 * ending in `=`, which is not a hex digit, so the correctly-sized key can never
 * be mistaken for hex at all; and for the sizes that do encode without padding,
 * the chance that every character lands in `[0-9a-f]` is 4^-n. What it will
 * refuse is a "key" with no entropy in it — `Buffer.alloc(48)` encodes to 64
 * `A`s — which is not a key, and which the message sends the operator to
 * `openssl` to replace.
 *
 * ## What comes back
 *
 * A reason code, not a boolean. "Nobody set it" and "somebody set it wrong"
 * need different instructions, and `opsConfig.ts` says in its own header that
 * telling them apart is the whole message. The codes are safe to report: none
 * of them carries the value, and none of them carries its length.
 */

/** Why a configured key could not be used. */
export type Base64KeyProblem =
  /** Not set, or set to whitespace. */
  | "absent"
  /** Characters outside the base64 alphabet, or a length no padding can fix. */
  | "not_base64"
  /** All hex digits — almost certainly `openssl rand -hex`, not base64. */
  | "looks_like_hex"
  /** Valid base64, wrong number of bytes for what reads it. */
  | "wrong_length";

/**
 * How long the key has to be. Exactly one of these — `bytes` where the
 * algorithm fixes the size (AES-256 takes 32 and nothing else), `minBytes`
 * where longer is merely longer (an HMAC key).
 */
export type Base64KeyRule = { bytes: number } | { minBytes: number };

export type Base64KeyResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; problem: Base64KeyProblem };

/**
 * The rule for each key, in one place, named by the variable it governs.
 *
 * Kept here rather than in the four modules that load these keys because the
 * defect this file exists for was a *second copy* of the rule: `opsConfig.ts`
 * restated "at least 32 bytes" for everything, `rawTextCrypto.ts` required
 * exactly 32, and the deployment self-check reported a key the loader refused
 * as healthy. A rule written twice is a rule that will disagree with itself
 * again. Both the loaders and the self-check read these.
 */
export const KEY_RULES = {
  /** AES-256-GCM. The algorithm fixes the size; 48 bytes is not a long key. */
  RESEARCH_RAW_TEXT_KEY: { bytes: 32 } as Base64KeyRule,
  /** HMAC-SHA256. Longer than the block size is pointless but harmless. */
  SAFETY_RECIPIENT_HASH_KEY: { minBytes: 32 } as Base64KeyRule,
  PILOT_INVITE_HMAC_KEY: { minBytes: 32 } as Base64KeyRule,
  PILOT_GUARDIAN_HMAC_KEY: { minBytes: 32 } as Base64KeyRule,
};

/** Hex is even-length by construction; 32 characters is 16 bytes, the shortest
 *  key anyone would plausibly have generated. */
const HEX = /^[0-9a-fA-F]+$/;

/** The standard alphabet, after base64url has been folded onto it. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decode, or say why not.
 *
 * Surrounding whitespace is forgiven — a value pasted into a dashboard field
 * arrives with a trailing newline often enough that rejecting it would be
 * answering a formatting question with a security failure. Characters *inside*
 * the value are not forgiven, because that is the bug this replaces.
 *
 * Missing padding is also forgiven: base64url is usually written without it,
 * and an unpadded string is unambiguous. A length that no padding can rescue
 * (`4n + 1`) is not base64 and is reported as such.
 */
export function readBase64Key(configured: string | undefined, rule: Base64KeyRule): Base64KeyResult {
  const raw = configured?.trim() ?? "";
  if (!raw) return { ok: false, problem: "absent" };

  if (raw.length >= 32 && raw.length % 2 === 0 && HEX.test(raw)) {
    return { ok: false, problem: "looks_like_hex" };
  }

  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!BASE64.test(padded)) return { ok: false, problem: "not_base64" };

  const bytes = Buffer.from(padded, "base64");
  const long_enough = "bytes" in rule ? bytes.length === rule.bytes : bytes.length >= rule.minBytes;
  if (!long_enough) return { ok: false, problem: "wrong_length" };

  return { ok: true, bytes };
}

/** Whether a configured value is usable, for callers that only need the verdict. */
export function base64KeyUsable(configured: string | undefined, rule: Base64KeyRule): boolean {
  return readBase64Key(configured, rule).ok;
}

/**
 * The operator-facing half of a problem code, in Japanese.
 *
 * Appended to a check's `consequence` so the ops report says what to do rather
 * than only what is broken. Never includes the value or its length.
 */
export function base64KeyAdvice(problem: Base64KeyProblem): string {
  switch (problem) {
    case "absent":
      return "未設定。";
    case "looks_like_hex":
      return "hex が入っている（`openssl rand -hex 32` の出力）。`openssl rand -base64 32` で作り直すこと。";
    case "not_base64":
      return "base64 として読めない文字が入っている。引用符や改行が混ざっていないか確認すること。";
    case "wrong_length":
      return "base64 としては読めるが、長さが合わない。";
  }
}
