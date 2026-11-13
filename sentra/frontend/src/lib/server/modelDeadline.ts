/**
 * Time limits on the model calls a journal submission waits for (#264).
 *
 * `POST /api/entries` calls OpenAI twice before it writes anything — the
 * extraction, then three embeddings — and both used to be bare `fetch`es with
 * no deadline. A slow or half-open upstream then ran the handler into its
 * `maxDuration` and the platform killed it **before** `writeEntryResult`: the
 * journal was not stored, `submission_failures` got no row, and a crisis the
 * lexicon had already flagged was never escalated. The extraction already fell
 * back to the deterministic extractor on any error; all it was missing was an
 * error to fall back on.
 *
 * Relative imports only, so the node test runner can load this file.
 */

import { envPositiveInt } from "./envNumber.ts";

/** Thrown when a call ran out of time, so callers can say "timeout" rather than "failed". */
export class DeadlineExceeded extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`upstream did not answer within ${timeoutMs} ms`);
    this.name = "DeadlineExceeded";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Run `call` with an abort signal that fires after `timeoutMs`, and give up at
 * that moment whatever `call` does.
 *
 * Unlike `fetchWithTimeout` in `api.ts`, the deadline covers the whole call —
 * reading and parsing the body included, not just the arrival of the headers.
 * An upstream that sends its status line and then stalls is exactly the
 * half-open case, and a deadline that has been cleared by then protects
 * nothing. The race means this returns on time even if something inside
 * `call` ignores the signal.
 */
export async function withDeadline<T>(timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A millisecond setting from the environment, kept inside `[min, max]`.
 *
 * Two separate jobs, and they used to be one (#553). Reading the value is
 * `envPositiveInt` — the one copy of that rule (#269) — and this adds the
 * clamp, which is not validation: the caps below are part of the 60 s budget
 * this module exists to divide up, so an override may shorten a limit and may
 * lengthen it only as far as the budget allows.
 *
 * What the single `Number(value)` here used to do is why they are separate now.
 * `Number` accepts notations a timeout is never written in: `"0x20"` became
 * 32, `"1e3"` became 1000, `"3.5"` rounded to 4 — each then raised to `minMs`,
 * so a mistyped variable set the extraction deadline to one second. Every
 * extraction then timed out, the route saved the entry with the deterministic
 * fallback and answered 200, and nothing said the setting had been misread.
 *
 * The clamp says so too, for the same reason `envPositiveInt` warns: a value
 * somebody set and this module quietly moved is a value they will keep
 * believing in. The value itself is not echoed, matching `envNumber.ts`.
 */
function clampedTimeoutMs(
  name: string,
  fallbackMs: number,
  minMs: number,
  maxMs: number,
  env: Record<string, string | undefined>,
): number {
  const configured = envPositiveInt(name, fallbackMs, env);
  const clamped = Math.min(Math.max(configured, minMs), maxMs);
  if (clamped !== configured) {
    console.warn(
      `[env] ${name} is outside the ${minMs}-${maxMs} ms this route's budget allows, ` +
        `so ${clamped} ms is being used instead.`,
    );
  }
  return clamped;
}

/*
 * The budget for `/api/entries`.
 *
 * The route may run for 60 s (`maxDuration` there — a literal, because Next
 * reads it statically; a test pins the two together). 20 s of that is kept for
 * what has to happen after the models: the write, the failure record when the
 * write fails, and the escalation. The other 40 s is the most the model calls
 * may take **even if the three embeddings ran one after another**, which they
 * do not (they run in parallel, so the real worst case is 28 + 4 = 32 s).
 *
 * The caps are what make that a guarantee rather than a default: an override
 * can shorten a limit, and can lengthen it only up to the cap.
 */
export const ENTRY_ROUTE_MAX_DURATION_MS = 60_000;
export const ENTRY_WRITE_RESERVE_MS = 20_000;
export const ENTRY_EMBEDDING_CALLS = 3;

export const EXTRACTION_TIMEOUT_DEFAULT_MS = 25_000;
export const EXTRACTION_TIMEOUT_MAX_MS = 28_000;
export const EMBEDDING_TIMEOUT_DEFAULT_MS = 4_000;
export const EMBEDDING_TIMEOUT_MAX_MS = 4_000;

export function entryModelTimeouts(env: Record<string, string | undefined> = process.env): {
  extractionMs: number;
  embeddingMs: number;
} {
  return {
    extractionMs: clampedTimeoutMs(
      "OPENAI_EXTRACTION_TIMEOUT_MS",
      EXTRACTION_TIMEOUT_DEFAULT_MS,
      1_000,
      EXTRACTION_TIMEOUT_MAX_MS,
      env,
    ),
    embeddingMs: clampedTimeoutMs(
      "OPENAI_EMBEDDING_TIMEOUT_MS",
      EMBEDDING_TIMEOUT_DEFAULT_MS,
      500,
      EMBEDDING_TIMEOUT_MAX_MS,
      env,
    ),
  };
}

/*
 * `/api/audio/transcriptions` loses less when it stalls — the student gets no
 * transcript and can record again — but one stalled request could still hold
 * its 60 s. 45 s leaves room to answer with a timeout instead of being killed.
 */
export const TRANSCRIPTION_TIMEOUT_DEFAULT_MS = 45_000;
export const TRANSCRIPTION_TIMEOUT_MAX_MS = 50_000;

export function transcriptionTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  return clampedTimeoutMs(
    "OPENAI_TRANSCRIPTION_TIMEOUT_MS",
    TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
    1_000,
    TRANSCRIPTION_TIMEOUT_MAX_MS,
    env,
  );
}
