/**
 * protocol §4.4's manual review has somewhere to happen (#225).
 *
 * The rule existed — an authorised person looks at retained journal text at
 * 10:00 and 16:00 JST — with no screen, no queue and no record that anybody
 * ever looked. A rule with nowhere to run is a rule the Go/No-Go can be signed
 * against and never kept.
 *
 * What this locks down is mostly the restraint: the classifier must not become
 * the decision, listing must not become reading, and reading must not happen
 * without a record.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  countPending,
  enqueuePendingReviews,
  loadQueue,
  readEntryText,
  recordDecision,
  slotFor,
} from "../src/lib/server/crisisTriage.ts";
import { SAFETY_ASSESSMENT_VERSION } from "../src/lib/safety-assessment.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const lib = read("../src/lib/server/crisisTriage.ts");
const route = read("../src/app/api/pilot/triage/route.ts");
const page = read("../src/app/pilot/triage/page.tsx");
const migration = read("../../supabase/migrations/20260921030000_pilot_crisis_triage.sql");

describe("the review slots follow §4.4", () => {
  const at = (iso) => new Date(iso);

  it("10:00 JST is the morning slot", () => {
    assert.equal(slotFor(at("2026-09-21T01:00:00Z")), "morning"); // 10:00 JST
  });

  it("16:00 JST is the afternoon slot", () => {
    assert.equal(slotFor(at("2026-09-21T07:00:00Z")), "afternoon"); // 16:00 JST
  });

  it("02:00 JST is neither, and is recorded as such", () => {
    // §4.4 promises two reviews a day and promises no night watch. Rounding a
    // 02:00 review into "morning" would make the log claim a schedule was kept.
    assert.equal(slotFor(at("2026-09-20T17:00:00Z")), "ad_hoc"); // 02:00 JST
  });

  it("the screen says when the operator is outside the slots", () => {
    assert.match(page, /§4\.4 が定める枠の外/);
  });
});

describe("the classifier sorts, it does not decide", () => {
  it("keeps entries the lexicon scored none in the queue", () => {
    // A crisis written in words the lexicon does not carry scores `none`. A
    // queue that filters those has quietly narrowed §4.4 to "review what the
    // regex found".
    assert.doesNotMatch(code(lib), /assessed_risk.*neq.*none|\.neq\("assessed_risk"/);
    assert.match(lib, /'none' の行がレビュー対象から消えない|scored `none` stay in the queue/);
  });

  it("records the assessor version from the assessor", () => {
    assert.match(code(route), /ASSESSOR_VERSION = SAFETY_ASSESSMENT_VERSION/);
    assert.ok(SAFETY_ASSESSMENT_VERSION.length > 0);
  });

  it("refuses 'pending' as a decision", () => {
    assert.match(code(route), /"pending" は判断ではありません/);
  });

  it("a decided row must name who decided it", () => {
    assert.match(migration, /reviewed_by is not null and reviewed_at is not null/);
  });
});

describe("listing is not reading", () => {
  it("the queue carries no journal text", () => {
    const queueType = lib.slice(lib.indexOf("export type QueueRow"), lib.indexOf("export async function loadQueue"));
    assert.doesNotMatch(queueType, /\braw_text\b|\btext:\s*string/);
    assert.match(queueType, /text_available: boolean/);
  });

  it("reading is a POST, because it writes a read record", () => {
    assert.match(code(route), /body\.action === "read"/);
    assert.match(code(lib), /from\("pilot_crisis_review_reads"\)\.insert/);
  });

  it("refuses to return text when the read could not be logged", () => {
    // The log is what turns "your text may be read" from a disclaimer into a
    // promise, so an unlogged read is not a read that may be served.
    const body = code(lib);
    const insertAt = body.indexOf("pilot_crisis_review_reads");
    const decryptAt = body.indexOf("decryptRawText(ciphertext)");
    assert.ok(insertAt !== -1 && decryptAt > insertAt, "the read must be logged before the text is decrypted");
    assert.match(lib, /閲覧の記録に失敗したため、本文を表示しません/);
  });
});

describe("the note is a note, not a second copy of the journal", () => {
  it("is capped in the database", () => {
    assert.match(migration, /char_length\(reviewer_note\) <= 500/);
  });

  it("is capped again before the insert, so a long note is truncated not rejected", () => {
    assert.match(code(lib), /note\.slice\(0, 500\)/);
  });

  it("tells the reviewer not to quote", () => {
    assert.match(page, /日記の本文は書き写さないでください/);
  });
});

describe("rows whose text is gone still need a decision", () => {
  it("the queue counts them rather than hiding them", () => {
    // Dropping them silently makes "the text was purged" indistinguishable from
    // "nobody wrote that day".
    // The counting lives in `queueCounts()` (#380) so it can be tested with
    // the queue it counts; the route has to go through it.
    assert.match(code(lib), /no_text:/);
    assert.match(code(route), /queueCounts\(queue, pendingTotal\)/);
    assert.match(code(lib), /"unreadable"/);
  });

  it("the screen offers the decision", () => {
    assert.match(code(page), /decide\(openId, "unreadable"\)/);
  });
});

describe("only an operator gets in", () => {
  it("the route is behind the operator allowlist", () => {
    assert.match(code(route), /requireOperator\(request\)/);
  });

  it("neither table is readable by anon or authenticated", () => {
    assert.match(migration, /revoke all on public\.pilot_crisis_reviews from public, anon, authenticated/);
    assert.match(migration, /revoke all on public\.pilot_crisis_review_reads from public, anon, authenticated/);
  });

  it("row level security is on for both", () => {
    assert.match(migration, /alter table public\.pilot_crisis_reviews enable row level security/);
    assert.match(migration, /alter table public\.pilot_crisis_review_reads enable row level security/);
  });
});

describe("the screen does not overstate what this is", () => {
  it("says it is not a night watch and not an emergency service", () => {
    assert.match(page, /夜間・休日の監視を代替しません/);
    assert.match(page, /緊急対応を行いません/);
  });

  it("does not claim the escalate button notifies anyone", () => {
    assert.match(page, /このボタンは記録であって、通知は送りません/);
  });
});

/*
 * A failed read is not an empty read (#260).
 *
 * PostgREST does not throw: a failed query resolves to `{ data: null, error }`,
 * and `data ?? []` turns that into "there is nothing here". In `loadQueue` that
 * made a failed `entries` read into every row showing 本文なし — which the
 * screen answers by recording `unreadable`, taking a crisis row nobody read out
 * of the queue for good — and a failed `pilot_enrollments` read into every row
 * losing its pseudonym. Neither showed an error.
 *
 * The double below answers every query the module makes, and fails whichever
 * one it is told to. Each case asserts the function rejects rather than
 * resolving with less than it was asked for.
 */
function failingDb(shouldFail = () => false) {
  const tables = {
    pilot_crisis_reviews: [
      {
        id: "review-1",
        entry_id: "entry-1",
        participant_id: "participant-1",
        assessed_risk: "crisis",
        assessed_reasons: ["self_harm"],
        status: "pending",
        reviewed_at: null,
        review_slot: null,
        created_at: "2026-09-21T01:00:00Z",
      },
    ],
    pilot_enrollments: [{ participant_id: "participant-1", research_code: "R-001" }],
    entries: [
      {
        id: "entry-1",
        owner_user_id: "owner-1",
        participant_id: "participant-1",
        raw_text_ciphertext: "cipher-1",
        created_at: "2026-09-21T00:00:00Z",
      },
      {
        id: "entry-2",
        owner_user_id: "owner-2",
        participant_id: "participant-2",
        raw_text_ciphertext: "cipher-2",
        created_at: "2026-09-21T00:30:00Z",
      },
    ],
    pilot_crisis_review_reads: [],
  };

  function from(table) {
    const state = { table, op: "select", filters: [], single: false, head: false };

    function settle() {
      if (shouldFail(state)) return { data: null, count: null, error: { message: `${table} ${state.op} failed` } };
      if (state.op !== "select") return { data: [], error: null };
      const rows = tables[table].filter((row) => state.filters.every((match) => match(row)));
      if (state.head) return { data: null, count: rows.length, error: null };
      if (state.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    const chain = {
      select(_columns, options = {}) {
        state.head = Boolean(options.head);
        return chain;
      },
      eq(column, value) {
        state.filters.push((row) => row[column] === value);
        return chain;
      },
      in(column, values) {
        const wanted = new Set(values);
        state.filters.push((row) => wanted.has(row[column]));
        return chain;
      },
      not(column) {
        state.filters.push((row) => row[column] !== null && row[column] !== undefined);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      upsert() {
        state.op = "upsert";
        return chain;
      },
      insert() {
        state.op = "insert";
        return chain;
      },
      update() {
        state.op = "update";
        return chain;
      },
      maybeSingle() {
        state.single = true;
        return Promise.resolve(settle());
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(settle()).then(onFulfilled, onRejected);
      },
    };
    return chain;
  }

  return { from };
}

const failing = (table, op = "select") => failingDb((state) => state.table === table && state.op === op);

describe("a failed read is reported, not shown as an empty one (#260)", () => {
  it("reads the queue normally when nothing fails", async () => {
    const [row] = await loadQueue(failingDb());
    assert.equal(row.text_available, true);
    assert.equal(row.research_code, "R-001");
  });

  it("does not report 本文なし when the entries read failed", async () => {
    await assert.rejects(loadQueue(failing("entries")), /entries select failed/);
  });

  it("does not drop every pseudonym when the enrollments read failed", async () => {
    await assert.rejects(loadQueue(failing("pilot_enrollments")), /pilot_enrollments select failed/);
  });

  it("does not show an empty queue when the reviews read failed", async () => {
    await assert.rejects(loadQueue(failing("pilot_crisis_reviews")), /pilot_crisis_reviews select failed/);
  });

  const everyQuery = [
    ["enqueuePendingReviews", "pilot_crisis_reviews", "select", (db) => enqueuePendingReviews(db, "v")],
    ["enqueuePendingReviews", "entries", "select", (db) => enqueuePendingReviews(db, "v")],
    ["enqueuePendingReviews", "pilot_crisis_reviews", "upsert", (db) => enqueuePendingReviews(db, "v")],
    ["countPending", "pilot_crisis_reviews", "select", (db) => countPending(db)],
    ["readEntryText", "pilot_crisis_reviews", "select", (db) => readEntryText(db, "review-1", "reader-1")],
    ["readEntryText", "entries", "select", (db) => readEntryText(db, "review-1", "reader-1")],
    ["readEntryText", "pilot_crisis_review_reads", "insert", (db) => readEntryText(db, "review-1", "reader-1")],
    [
      "recordDecision",
      "pilot_crisis_reviews",
      "update",
      (db) => recordDecision(db, { reviewId: "review-1", reviewerUserId: "reader-1", status: "no_concern" }),
    ],
  ];

  for (const [name, table, op, call] of everyQuery) {
    it(`${name} rejects when its ${table} ${op} fails`, async () => {
      await assert.rejects(call(failing(table, op)), new RegExp(`${table} ${op} failed`));
    });
  }

  it("the route answers a failed read with 502, not a shorter 200", () => {
    assert.match(code(route), /catch \(err\)[\s\S]*?jsonError\([\s\S]*?502\)/);
  });

  it("the screen drops the previous list when a reload fails", () => {
    // After a decision the screen reloads. If that reload fails and the old
    // list stays up, the row just decided is still shown as 未確認 and the
    // reviewer works from a list that is no longer true.
    const refresh = code(page).match(/const refresh = useCallback\([\s\S]*?\}, \[includeDecided\]\);/);
    assert.ok(refresh, "refresh() moved; this check is reading nothing");
    const failureBranch = refresh[0].slice(refresh[0].indexOf("catch"));
    assert.match(failureBranch, /setData\(null\)/);
    assert.match(failureBranch, /setLoadFailed\(true\)/);
  });

  it("the screen does not say the queue is empty when it could not read it", () => {
    assert.match(page, /確認を待っている記録が無いという意味ではありません/);
    const body = code(page);
    const failed = body.indexOf("loadFailed ?");
    const empty = body.indexOf("確認を待っている記録はありません。");
    assert.ok(failed !== -1 && empty !== -1 && failed < empty, "the failure branch must be decided before the empty one");
  });
});
