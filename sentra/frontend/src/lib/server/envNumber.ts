/**
 * Reading a positive integer out of the environment (#269).
 *
 * `Number(process.env.X ?? fallback)` looks like it has a default. It does not,
 * for the case that actually happens: `??` only fires when the variable is
 * *unset*. A variable that is set to something unreadable — `"25s"`, `"20_000"`,
 * a value with quotes left around it, a stray space — becomes `NaN`, and `NaN`
 * is not a number that fails loudly. It is a number that makes comparisons
 * false and `setTimeout` fire immediately:
 *
 *   setTimeout(fn, NaN)   →  runs on the next tick, so a request is aborted
 *                            before it is sent (and `fetchWithTimeout`'s
 *                            `AbortError` is then indistinguishable from an
 *                            upstream that hung)
 *   size > NaN            →  false, so a size cap silently stops capping
 *
 * Both of those were live: `/api/chat` and `/api/voice/realtime-session` passed
 * an unvalidated `Number(...)` as their timeout, and
 * `/api/audio/transcriptions` as its byte ceiling. One typo in one variable
 * turned the first two into "every model call fails, with a fallback answer
 * hiding it" and the third into "no upload limit".
 *
 * `rateLimit.ts` already had this right (`Number.isSafeInteger(configured) &&
 * configured > 0 ? configured : fallback`), so this is that rule lifted out
 * rather than a new one invented. One copy, because a validation rule that
 * exists in two places is a rule that will exist in two versions.
 *
 * **It warns when it falls back.** A deployment that set a value and had it
 * ignored has to be able to find out; silently substituting the default is how
 * a misconfiguration survives a whole pilot. Unset is not warned about — that
 * is the ordinary case and says nothing.
 */

/**
 * A positive integer from `name`, or `fallback`.
 *
 * Rejects, with a warning: anything not a safe integer (`"25s"`, `"20_000"`,
 * `"1e400"`, `"3.5"`), zero, and negatives. Accepts surrounding whitespace,
 * because that is how a value arrives when it is pasted or piped rather than
 * typed, and it is not a claim about a different number.
 *
 * Zero is refused rather than honoured. Every call site here reads a timeout or
 * a ceiling, and for both of those zero means "off" in a way nobody writes a
 * zero to ask for — a `0` in one of these variables is a truncated value.
 */
export function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const candidate = raw.trim();

  // Shape first, and not `Number()` alone. `Number` accepts several notations
  // that `int()` on the Python side rejects — `"0x20"` becomes 32, `"1e3"`
  // becomes 1000, `"+20000"` becomes 20000 — and a variable read by both
  // services must not mean one thing here and another there. `"0x20"` is the
  // one that matters: it parses to a plausible-looking number, so accepting it
  // means the two services silently run with different ceilings.
  //
  // Digits only, therefore. `int()` accepts `"20_000"` and `"+20000"`, so the
  // Python side carries the same restriction from the other direction.
  if (!/^\d+$/.test(candidate)) return rejected(name, fallback);

  const parsed = Number(candidate);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;

  return rejected(name, fallback);
}

function rejected(name: string, fallback: number): number {
  // The value is not echoed. These variables hold limits rather than secrets,
  // but the habit of printing environment values into logs is not one to keep
  // per-variable exceptions for.
  console.warn(
    `[env] ${name} is not a positive integer, so it is being ignored and ${fallback} used instead. ` +
      `Set it to a plain integer with no units, separators or quotes.`,
  );
  return fallback;
}
