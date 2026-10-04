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

/** A millisecond setting from the environment, kept inside `[min, max]`. */
export function timeoutFromEnv(value: string | undefined, fallbackMs: number, minMs: number, maxMs: number): number {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.min(Math.max(Math.round(parsed), minMs), maxMs);
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
    extractionMs: timeoutFromEnv(
      env.OPENAI_EXTRACTION_TIMEOUT_MS,
      EXTRACTION_TIMEOUT_DEFAULT_MS,
      1_000,
      EXTRACTION_TIMEOUT_MAX_MS,
    ),
    embeddingMs: timeoutFromEnv(env.OPENAI_EMBEDDING_TIMEOUT_MS, EMBEDDING_TIMEOUT_DEFAULT_MS, 500, EMBEDDING_TIMEOUT_MAX_MS),
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
  return timeoutFromEnv(
    env.OPENAI_TRANSCRIPTION_TIMEOUT_MS,
    TRANSCRIPTION_TIMEOUT_DEFAULT_MS,
    1_000,
    TRANSCRIPTION_TIMEOUT_MAX_MS,
  );
}
