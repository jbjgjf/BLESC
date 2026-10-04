/**
 * A stalled model call cannot cost a student their journal (#264).
 *
 * `POST /api/entries` calls OpenAI (one extraction, three embeddings) before
 * it writes anything, with bare `fetch`es. A slow or half-open upstream ran
 * the handler into its 60 s `maxDuration`, and the platform killed it before
 * `writeEntryResult`: no entry, no `submission_failures` row, and no
 * escalation for a crisis the lexicon had already flagged. The extraction
 * already degraded to the deterministic extractor on any error — it was only
 * missing the error.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import {
  DeadlineExceeded,
  ENTRY_EMBEDDING_CALLS,
  ENTRY_ROUTE_MAX_DURATION_MS,
  ENTRY_WRITE_RESERVE_MS,
  EXTRACTION_TIMEOUT_MAX_MS,
  EMBEDDING_TIMEOUT_MAX_MS,
  TRANSCRIPTION_TIMEOUT_MAX_MS,
  entryModelTimeouts,
  timeoutFromEnv,
  transcriptionTimeoutMs,
  withDeadline,
} from "../src/lib/server/modelDeadline.ts";
import { fallbackExtraction } from "../src/lib/extraction.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const entriesRoute = read("../src/app/api/entries/route.ts");
const transcriptionRoute = read("../src/app/api/audio/transcriptions/route.ts");

describe("withDeadline gives up on time", () => {
  it("returns what the call returns when it is in time", async () => {
    assert.equal(await withDeadline(1_000, async () => "done"), "done");
  });

  it("passes a call's own failure through untouched", async () => {
    await assert.rejects(
      withDeadline(1_000, async () => {
        throw new Error("bad json");
      }),
      (err) => !(err instanceof DeadlineExceeded) && /bad json/.test(err.message),
    );
  });

  it("rejects with DeadlineExceeded even when the call ignores its signal", async () => {
    const started = Date.now();
    await assert.rejects(withDeadline(50, () => new Promise(() => {})), DeadlineExceeded);
    assert.ok(Date.now() - started < 1_000, "the deadline did not bound the wait");
  });

  it("aborts the signal it handed out, so the request itself is cancelled", async () => {
    let seen;
    await assert.rejects(
      withDeadline(50, (signal) => {
        seen = signal;
        return new Promise(() => {});
      }),
      DeadlineExceeded,
    );
    assert.equal(seen.aborted, true);
  });
});

/*
 * Against a real socket, because the failure is a network shape: an upstream
 * that never answers, and one that sends its headers and then stalls the body.
 * `fetchWithTimeout` in api.ts clears its timer once the headers arrive, so it
 * covers the first and not the second — which is why the entries route does
 * not use it.
 */
describe("a stalled upstream, over a real connection", () => {
  let server;
  let base;

  before(async () => {
    server = createServer((request, response) => {
      if (request.url === "/headers-then-stall") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"output_text":');
        return; // never ends
      }
      // "/silent": never answers at all.
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("gives up on an upstream that never answers", async () => {
    await assert.rejects(
      withDeadline(200, (signal) => fetch(`${base}/silent`, { signal }).then((r) => r.json())),
      DeadlineExceeded,
    );
  });

  it("gives up on an upstream that sends headers and then stalls the body", async () => {
    await assert.rejects(
      withDeadline(200, (signal) => fetch(`${base}/headers-then-stall`, { signal }).then((r) => r.json())),
      DeadlineExceeded,
    );
  });
});

describe("the budget leaves time to write the entry", () => {
  it("fits the worst case inside maxDuration, with the write's reserve left over", () => {
    // Even if the three embeddings ran one after another — they run in
    // parallel — the model calls end in time for the write, the failure
    // record and the escalation.
    const worst = EXTRACTION_TIMEOUT_MAX_MS + ENTRY_EMBEDDING_CALLS * EMBEDDING_TIMEOUT_MAX_MS;
    assert.ok(
      worst + ENTRY_WRITE_RESERVE_MS <= ENTRY_ROUTE_MAX_DURATION_MS,
      `${worst} ms of model calls + ${ENTRY_WRITE_RESERVE_MS} ms reserve exceeds ${ENTRY_ROUTE_MAX_DURATION_MS} ms`,
    );
  });

  it("is budgeted against the route's actual maxDuration", () => {
    const declared = entriesRoute.match(/export const maxDuration = (\d+);/);
    assert.ok(declared, "entries/route.ts no longer declares maxDuration");
    assert.equal(Number(declared[1]) * 1000, ENTRY_ROUTE_MAX_DURATION_MS);
  });

  it("uses the defaults when nothing is configured", () => {
    const { extractionMs, embeddingMs } = entryModelTimeouts({});
    assert.ok(extractionMs > 0 && extractionMs <= EXTRACTION_TIMEOUT_MAX_MS);
    assert.ok(embeddingMs > 0 && embeddingMs <= EMBEDDING_TIMEOUT_MAX_MS);
  });

  it("lets an override shorten a limit", () => {
    const { extractionMs, embeddingMs } = entryModelTimeouts({
      OPENAI_EXTRACTION_TIMEOUT_MS: "10000",
      OPENAI_EMBEDDING_TIMEOUT_MS: "1500",
    });
    assert.equal(extractionMs, 10_000);
    assert.equal(embeddingMs, 1_500);
  });

  it("does not let an override spend the write's reserve", () => {
    const { extractionMs, embeddingMs } = entryModelTimeouts({
      OPENAI_EXTRACTION_TIMEOUT_MS: "120000",
      OPENAI_EMBEDDING_TIMEOUT_MS: "60000",
    });
    assert.equal(extractionMs, EXTRACTION_TIMEOUT_MAX_MS);
    assert.equal(embeddingMs, EMBEDDING_TIMEOUT_MAX_MS);
  });

  it("ignores a value that is not a positive number of milliseconds", () => {
    for (const value of ["", "abc", "-5", "0", "NaN"]) {
      assert.equal(timeoutFromEnv(value, 7_000, 1_000, 9_000), 7_000, `accepted ${JSON.stringify(value)}`);
    }
  });

  it("keeps the transcription deadline inside its route's maxDuration", () => {
    const declared = transcriptionRoute.match(/export const maxDuration = (\d+);/);
    assert.ok(declared);
    assert.ok(TRANSCRIPTION_TIMEOUT_MAX_MS < Number(declared[1]) * 1000);
    assert.equal(transcriptionTimeoutMs({ OPENAI_TRANSCRIPTION_TIMEOUT_MS: "999999" }), TRANSCRIPTION_TIMEOUT_MAX_MS);
  });
});

describe("the entries route degrades instead of dying", () => {
  const source = code(entriesRoute);

  it("sends no model request without a deadline", () => {
    // The raw source: stripping `//` comments would also eat the URLs.
    const calls = entriesRoute.split('fetch("https://api.openai.com/').length - 1;
    assert.equal(calls, 2, "expected the extraction and the embedding call");
    // Every call sits inside a withDeadline callback that hands it the signal.
    const guarded = entriesRoute.match(/withDeadline\(MODEL_TIMEOUTS\.\w+, async \(signal\) => \{\s*const response = await fetch\("https:\/\/api\.openai\.com\/[^"]+", \{\s*signal,/g) ?? [];
    assert.equal(guarded.length, calls);
  });

  it("records a timeout as a timeout, not as a malformed answer", () => {
    assert.match(source, /err instanceof DeadlineExceeded \? "timeout" : "fallback"/);
    assert.match(source, /err instanceof DeadlineExceeded \? "embedding_timeout" : "embedding_failed"/);
    // And the status is what operators read back.
    assert.match(source, /uncertainty: \{ extraction_status: status,/);
  });

  it("falls back to the deterministic extraction, so there is still an entry to write", () => {
    assert.match(source, /status = err instanceof DeadlineExceeded[\s\S]{0,80}return \{ extraction: fallbackExtraction\(entryText\)/);
    const extraction = fallbackExtraction("Journal entry:\n今日は疲れた。テストが近い。");
    assert.ok(extraction.nodes.length > 0);
  });

  it("writes, and escalates, whatever the extraction status was", () => {
    // Nothing between the model calls and the write may branch on the
    // extraction's outcome: a timed-out extraction is saved exactly like a
    // completed one, and the crisis check never depended on the model.
    const extract = source.indexOf("await extractWithOpenAI(");
    const assess = source.indexOf("assessSafety(entryText)");
    const write = source.indexOf("await writeEntryResult(");
    const escalation = source.indexOf("await escalate(service");
    assert.ok(extract !== -1 && assess > extract && write > assess && escalation > write);
    const between = source.slice(extract, write);
    assert.doesNotMatch(between, /status\s*===|status\s*!==|"timeout"/);
    assert.doesNotMatch(between, /return (NextResponse|jsonError)/);
  });

  it("the transcription route answers a timeout instead of hanging", () => {
    const transcription = code(transcriptionRoute);
    assert.match(transcriptionRoute, /withDeadline\(transcriptionTimeoutMs\(\), async \(signal\) => \{\s*const response = await fetch\("https:\/\/api\.openai\.com\/v1\/audio\/transcriptions", \{\s*signal,/);
    assert.match(transcription, /err instanceof DeadlineExceeded[\s\S]{0,160}status: 504/);
  });
});
