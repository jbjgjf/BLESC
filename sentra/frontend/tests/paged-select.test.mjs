import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ROWS, PAGE_SIZE, fetchAllRows } from "../src/lib/server/pagedSelect.ts";
import {
  expectedDays,
  reconcileParticipant,
  retentionStatus,
  studyDaysElapsed,
  totalsFor,
} from "../src/lib/pilotOps.ts";

/**
 * Reading past `db-max-rows` (#275).
 *
 * The bug this module exists for is not an error anybody can catch: PostgREST
 * caps the response, reports success, and the caller counts a short array. So
 * the fake below behaves the way the real thing does — it serves a range, it
 * never refuses one for being large, and it silently gives back fewer rows than
 * were asked for whenever its own cap is the smaller number.
 *
 * The 1,050 in these tests is not a round number picked for a test. It is 50
 * participants x 21 days, the pilot's design scale, and it is the smallest
 * quantity at which the old code was wrong.
 */

/**
 * @param {number} total rows the table holds
 * @param {{cap?: number, count?: boolean}} options `cap` is the server's own
 *   per-response ceiling (`db-max-rows`); `count` false serves no exact count.
 */
function table(total, options = {}) {
  const cap = options.cap ?? 1000;
  const serveCount = options.count !== false;
  const calls = [];
  const rows = Array.from({ length: total }, (_, index) => ({ id: index }));

  const read = (from, to) => {
    calls.push([from, to]);
    const requested = Math.max(0, to - from + 1);
    const slice = rows.slice(from, from + Math.min(requested, cap));
    return Promise.resolve({ data: slice, error: null, count: serveCount ? total : null });
  };

  return { read, calls, rows };
}

describe("fetchAllRows", () => {
  it("reads every row of a table larger than one response", async () => {
    const { read, calls } = table(1050);
    const result = await fetchAllRows(read);

    assert.ok("rows" in result, "expected rows, got an error");
    assert.equal(result.rows.length, 1050);
    // Every row exactly once, in order: paging that overlaps or skips would
    // show up here before it showed up as a wrong compliance table.
    assert.deepEqual(
      result.rows.map((row) => row.id),
      Array.from({ length: 1050 }, (_, index) => index),
    );
    assert.equal(calls.length, Math.ceil(1050 / PAGE_SIZE));
  });

  it("does not stop at the server's cap when the cap is below the page size", async () => {
    // A deployment with `db-max-rows` smaller than PAGE_SIZE makes every page
    // short. A pager that treats "short page" as "end of table" would stop at
    // the first one and reintroduce exactly the silent truncation it replaced.
    const { read } = table(1050, { cap: 100 });
    const result = await fetchAllRows(read);

    assert.ok("rows" in result);
    assert.equal(result.rows.length, 1050);
  });

  it("reports a read it could not finish instead of returning a shorter list", async () => {
    // The table says it holds 1,050 rows and then serves nothing. Returning the
    // 500 already in hand would be a dashboard that says half the pilot did not
    // write anything.
    let served = 0;
    const read = (from, to) => {
      const requested = to - from + 1;
      if (served >= 500) return Promise.resolve({ data: [], error: null, count: 1050 });
      served += requested;
      return Promise.resolve({
        data: Array.from({ length: requested }, (_, index) => ({ id: from + index })),
        error: null,
        count: 1050,
      });
    };

    const result = await fetchAllRows(read);
    assert.ok("error" in result, "a partial read must not come back as rows");
    assert.match(result.error, /1050/);
  });

  it("passes a read failure through rather than reporting an empty table", async () => {
    const result = await fetchAllRows(() =>
      Promise.resolve({ data: null, error: { message: "connection reset" }, count: null }),
    );
    assert.ok("error" in result);
    assert.equal(result.error, "connection reset");
  });

  it("falls back to the short-page signal when no count is served", async () => {
    const { read } = table(1050, { count: false });
    const result = await fetchAllRows(read);

    assert.ok("rows" in result);
    assert.equal(result.rows.length, 1050);
  });

  it("returns a single page whole, and asks only once", async () => {
    const { read, calls } = table(12);
    const result = await fetchAllRows(read);

    assert.ok("rows" in result);
    assert.equal(result.rows.length, 12);
    assert.equal(calls.length, 1);
  });

  it("handles an empty table without a second request", async () => {
    const { read, calls } = table(0);
    const result = await fetchAllRows(read);

    assert.ok("rows" in result);
    assert.deepEqual(result.rows, []);
    assert.equal(calls.length, 1);
  });

  it("refuses rather than paging forever", async () => {
    // No count, always a full page: the shape of an unscoped query. The ceiling
    // is far above the pilot, so reaching it is a bug worth a message.
    const read = (from, to) =>
      Promise.resolve({
        data: Array.from({ length: to - from + 1 }, (_, index) => ({ id: from + index })),
        error: null,
        count: null,
      });

    const result = await fetchAllRows(read, { maxRows: 2000 });
    assert.ok("error" in result);
    assert.match(result.error, /2000/);
  });

  it("keeps the ceiling above the pilot's design scale", () => {
    assert.ok(MAX_ROWS > 50 * 21, "a 50x21 pilot must not be able to reach the ceiling");
    assert.ok(PAGE_SIZE <= 1000, "a page larger than db-max-rows is served short");
  });
});

/**
 * The dashboard's own arithmetic at the pilot's design scale (#275).
 *
 * The tests above show the pager returns every row. This one shows why that
 * matters: the same 1,050 entries, read once the way the old handler read them
 * and once through `fetchAllRows`, then reconciled with the functions the
 * route calls. Truncated, every participant loses their last day and the
 * overdue rows on the far side of the cap vanish; paged, both are exact.
 */
describe("the dashboard at 50 participants x 21 days", () => {
  const PARTICIPANTS = 50;
  const DAYS = 21;
  // 09:00 JST on 2026-09-01, the opening day.
  const STARTED_AT = "2026-09-01T00:00:00.000Z";
  // After the 21-day window has closed.
  const NOW = "2026-09-23T03:00:00.000Z";
  const OVERDUE = 30;

  // Sorted the way the route orders `entries`: `created_at`, then `id`.
  const entries = [];
  for (let day = 0; day < DAYS; day += 1) {
    for (let participant = 0; participant < PARTICIPANTS; participant += 1) {
      entries.push({
        id: `e-${String(day).padStart(2, "0")}-${String(participant).padStart(2, "0")}`,
        participant_id: `p-${participant}`,
        created_at: new Date(Date.parse(STARTED_AT) + day * 86_400_000 + participant * 1000).toISOString(),
        raw_text_ciphertext: "ciphertext",
        raw_text_expires_at: "2026-12-01T00:00:00.000Z",
      });
    }
  }
  // Text past its expiry and still stored, on the far side of row 1,000.
  for (let index = entries.length - OVERDUE; index < entries.length; index += 1) {
    entries[index].raw_text_expires_at = "2026-09-10T00:00:00.000Z";
  }
  const selfReports = entries.map((entry) => ({ entry_id: entry.id, participant_id: entry.participant_id }));

  /** PostgREST with a stock `db-max-rows`: serves a range, capped, no error. */
  const served = (rows) => (from, to) =>
    Promise.resolve({
      data: rows.slice(from, from + Math.min(to - from + 1, 1000)),
      error: null,
      count: rows.length,
    });

  function dashboard(entryRows, selfReportRows) {
    const reported = new Set(selfReportRows.map((row) => row.entry_id));
    const participants = Array.from({ length: PARTICIPANTS }, (_, participant) => {
      const own = entryRows.filter((entry) => entry.participant_id === `p-${participant}`);
      return reconcileParticipant({
        research_code: `R-${participant}`,
        cohort: "pilot",
        state: "completed",
        expected_days: expectedDays({
          collectionStartedAt: STARTED_AT,
          baselineDays: 7,
          observationDays: 14,
          now: NOW,
        }),
        submittedDayNumbers: own.map((entry) => studyDaysElapsed(STARTED_AT, entry.created_at)),
        failed_submissions: 0,
        entries_without_self_report: own.filter((entry) => !reported.has(entry.id)).length,
      });
    });
    return {
      totals: totalsFor(participants),
      missingSelfReports: entryRows.filter((entry) => !reported.has(entry.id)).length,
      retention: retentionStatus(
        entryRows.filter((entry) => entry.raw_text_ciphertext !== null).map((entry) => entry.raw_text_expires_at),
        NOW,
      ),
    };
  }

  it("was wrong when each table was read in one request", async () => {
    const truncatedEntries = (await served(entries)(0, entries.length - 1)).data;
    const truncatedReports = (await served(selfReports)(0, selfReports.length - 1)).data;
    const result = dashboard(truncatedEntries, truncatedReports);

    assert.equal(truncatedEntries.length, 1000);
    assert.equal(result.totals.missing_submissions, PARTICIPANTS, "every participant loses their last day");
    assert.equal(result.retention.overdue, 0, "the overdue rows are the ones cut off");
  });

  it("is exact when every read is paged", async () => {
    const pagedEntries = await fetchAllRows(served(entries));
    const pagedReports = await fetchAllRows(served(selfReports));
    assert.ok("rows" in pagedEntries && "rows" in pagedReports);

    const result = dashboard(pagedEntries.rows, pagedReports.rows);
    assert.equal(result.totals.expected_submissions, PARTICIPANTS * DAYS);
    assert.equal(result.totals.stored_submissions, PARTICIPANTS * DAYS);
    assert.equal(result.totals.missing_submissions, 0);
    assert.equal(result.totals.participants_with_gaps, 0);
    assert.equal(result.missingSelfReports, 0);
    assert.deepEqual(result.retention, {
      retained: PARTICIPANTS * DAYS,
      expiring_within_7_days: 0,
      overdue: OVERDUE,
    });
  });
});
