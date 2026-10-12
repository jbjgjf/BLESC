/**
 * What the dispatcher reports, and what the five-minute workflow does with it
 * (#453).
 *
 * `safety-dispatch.test.mjs` covers which escalations a run picks up. This
 * covers the sentence a human ends up reading afterwards, which went wrong in
 * two places at once:
 *
 *   - `GET /api/safety/dispatch` answered `owed: count ?? 0` without looking at
 *     `error`, so a failed query told whatever polls it that nothing was owed.
 *   - the workflow read `stuck` with `.get("stuck", 0)`, which substitutes for
 *     a *missing* key and not for a JSON `null`, so an unreadable count raised
 *     the warning for the other condition and `stuck_error` was never printed.
 *
 * The workflow's reporter is not read as text here. It is extracted from the
 * manifest, run under `python3` against fixed JSON, and its annotations are
 * asserted on — the three states observed rather than inferred from the shape
 * of the file (#288).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient } from "./helpers/route-loader.mjs";

const { NextRequest } = await import("next/server.js");
const { dispatchAttention, readCount } = await import("../src/lib/server/safetyDispatch.ts");
const dispatch = await import("../src/app/api/safety/dispatch/route.ts");

const TOKEN = "dispatch-token-for-tests";

/** A result as `dispatchPendingEscalations` returns one, with nothing to report. */
const quiet = {
  attempted: 2,
  delivered: 2,
  failed: 0,
  no_recipient: 0,
  pending: 0,
  stuck: 0,
};

describe("readCount", () => {
  it("is the count when the read worked", () => {
    assert.equal(readCount({ count: 0, error: null }), 0);
    assert.equal(readCount({ count: 7, error: null }), 7);
  });

  it("is unknown — never 0 — for everything else", () => {
    // Each of these reached the caller as `count ?? 0` before #453, and
    // `Number(true)` is 1, which is why a boolean is not a count either.
    for (const result of [
      { count: 5, error: { message: "connection reset" } },
      { count: null, error: null },
      { error: null },
      { count: true, error: null },
      { count: -1, error: null },
      { count: 1.5, error: null },
      { count: Number.NaN, error: null },
    ]) {
      assert.equal(readCount(result), null, `${JSON.stringify(result)} was read as a count`);
    }
  });
});

describe("what a dispatch run says has to be acted on", () => {
  it("says nothing when there is nothing to act on", () => {
    assert.deepEqual(dispatchAttention(quiet), []);
  });

  it("names the standing failures when there are some", () => {
    const lines = dispatchAttention({ ...quiet, stuck: 4 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^4 件/);
    assert.match(lines[0], /SAFETY_ALERT_WEBHOOK_URL/);
  });

  it("says the count is unknown, with the reason, and never that retries were exhausted", () => {
    const lines = dispatchAttention({ ...quiet, stuck: null, stuck_error: "statement timeout" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /読めませんでした/);
    assert.match(lines[0], /statement timeout/);
    assert.match(lines[0], /不明/);
    assert.match(lines[0], /0件ではありません/);
    // The claim the old shell test made for this state: that there *are*
    // escalations nobody was told about. Nothing is known about them.
    assert.doesNotMatch(lines[0], /誰にも届いていません/);
    assert.deepEqual(dispatchAttention({ ...quiet, stuck: 4 }).length, 1);
  });

  it("still says something when the reason was not recorded", () => {
    const lines = dispatchAttention({ ...quiet, stuck: null });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /読めませんでした/);
  });

  it("reports queued rows separately from exhausted ones", () => {
    // `pending` never becomes `stuck`: those rows deliberately do not consume
    // an attempt, so the two conditions have to be said separately (#203).
    const lines = dispatchAttention({ ...quiet, pending: 3, stuck: 2 });
    assert.equal(lines.length, 2);
    assert.match(lines[0], /使い切/);
    assert.match(lines[1], /待ち行列/);
  });
});

/**
 * A client that answers only the two counting reads `GET` makes.
 *
 * `.eq("status", "no_recipient")` is the terminal one and `.in("status", …)` is
 * what is still owed, which is how the two are told apart here.
 */
function countingClient({ owed = 0, noRecipient = 0, owedError = null, noRecipientError = null } = {}) {
  function builder() {
    let terminal = false;
    const chain = {
      select: () => chain,
      in: () => chain,
      eq: () => {
        terminal = true;
        return chain;
      },
      then(onFulfilled) {
        const error = terminal ? noRecipientError : owedError;
        const count = terminal ? noRecipient : owed;
        return Promise.resolve({
          count: error ? null : count,
          error: error ? { message: error } : null,
        }).then(onFulfilled);
      },
    };
    return chain;
  }
  return { from: builder };
}

const ask = () =>
  dispatch.GET(
    new NextRequest("http://localhost/api/safety/dispatch", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );

describe("GET /api/safety/dispatch", () => {
  let error;
  beforeEach(() => {
    error = console.error;
    console.error = () => {};
    process.env.SAFETY_DISPATCH_TOKEN = TOKEN;
    process.env.SAFETY_ALERT_WEBHOOK_URL = "https://example.test/hook";
  });
  afterEach(() => {
    console.error = error;
    setServiceClient(null);
    for (const key of ["SAFETY_DISPATCH_TOKEN", "SAFETY_ALERT_WEBHOOK_URL"]) delete process.env[key];
  });

  it("refuses a caller without the shared secret", async () => {
    setServiceClient(countingClient());
    const response = await dispatch.GET(new NextRequest("http://localhost/api/safety/dispatch"));
    assert.equal(response.status, 403);
  });

  it("reports the counts when both reads worked", async () => {
    setServiceClient(countingClient({ owed: 3, noRecipient: 1 }));
    const response = await ask();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      channels: true,
      owed: 3,
      no_recipient: 1,
      attention: [],
    });
  });

  it("reports zero as zero", async () => {
    setServiceClient(countingClient());
    const response = await ask();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.owed, 0);
    assert.deepEqual(body.attention, []);
  });

  it("does not answer 200 with owed: 0 when the count could not be read", async () => {
    setServiceClient(countingClient({ owed: 3, owedError: "connection reset" }));
    const response = await ask();

    // The whole defect: a monitor that reads only the status code has to see
    // this as the dispatcher failing to answer.
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.owed, null);
    assert.notEqual(body.owed, 0);
    assert.equal(body.owed_error, "connection reset");
    assert.match(body.attention[0], /0件ではありません/);
    // The count that did read is still reported, and so is the channel.
    assert.equal(body.no_recipient, 0);
    assert.equal(body.channels, true);
  });

  it("reports each unreadable count on its own", async () => {
    setServiceClient(countingClient({ noRecipientError: "statement timeout" }));
    const response = await ask();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.owed, 0);
    assert.equal(body.no_recipient, null);
    assert.equal(body.no_recipient_error, "statement timeout");
    assert.equal(body.owed_error, undefined);
    assert.equal(body.attention.length, 1);
  });

  it("says there is no channel when none is configured", async () => {
    delete process.env.SAFETY_ALERT_WEBHOOK_URL;
    setServiceClient(countingClient());
    const body = await (await ask()).json();
    assert.equal(body.channels, false);
  });

  it("answers 503 when there is no service-role client", async () => {
    setServiceClient(null);
    const response = await ask();
    assert.equal(response.status, 503);
  });
});

/**
 * The workflow's reporter, run.
 *
 * The step has no checkout — the job holds `SAFETY_DISPATCH_TOKEN` and is given
 * `permissions: {}` for that reason (#208) — so the script cannot live in
 * `scripts/ci/` and be invoked. It is a heredoc in the manifest instead, and
 * this lifts it out and executes it, so the three branches are observed.
 */
describe("the workflow prints what the dispatcher handed it", () => {
  const manifest = readFileSync(
    resolve(import.meta.dirname, "../../../.github/workflows/safety-dispatch.yml"),
    "utf8",
  );
  const heredoc = /<<'REPORT'\n([\s\S]*?)\n\s*REPORT/.exec(manifest);
  const workdir = mkdtempSync(join(tmpdir(), "dispatch-report-"));
  // The manifest indents the step body; `run: |` is dedented by that much
  // before the shell sees it, which is what puts `REPORT` in column 0.
  const script = join(workdir, "report.py");
  if (heredoc) {
    writeFileSync(script, heredoc[1].replace(/^ {10}/gm, ""));
  }

  /** The annotations the step would print for this response body. */
  function annotations(body) {
    const file = join(workdir, "response.json");
    writeFileSync(file, JSON.stringify(body));
    return execFileSync("python3", ["-I", script, file], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  }

  it("still has a reporter to run", () => {
    assert.ok(heredoc, "the REPORT heredoc is gone from the manifest");
  });

  it("no longer reads the counts itself", () => {
    // `.get(name, 0)` is the call that turned a JSON `null` into "not 0" and
    // then described it as the wrong condition.
    assert.doesNotMatch(manifest, /\.get\('stuck'/);
    assert.doesNotMatch(manifest, /\.get\('pending'/);
  });

  it("is silent on a run with nothing to act on", () => {
    assert.deepEqual(annotations({ ...quiet, attention: [] }), []);
  });

  it("prints one warning per line it was given", () => {
    const lines = annotations({ ...quiet, stuck: 2, pending: 1, attention: ["まず", "つぎ"] });
    assert.deepEqual(lines, [
      "::warning title=Crisis notifications::まず",
      "::warning title=Crisis notifications::つぎ",
    ]);
  });

  it("warns rather than passing silently when the response carries no report", () => {
    // A deployment older than #453. A green run that checked nothing is the
    // one outcome this step must not produce.
    const lines = annotations({ ...quiet, stuck: null });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /No attention report/);
  });
});
