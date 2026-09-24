/**
 * The review queue at the size the pilot is designed for (#247).
 *
 * `crisis-triage.test.mjs` covers the restraints — the classifier must not
 * become the decision, listing must not become reading. This covers whether
 * the queue still works once there is a study's worth of rows in it, which is
 * a different question and had a different answer.
 *
 * The pilot is 50 students × 21 days, up to 1,050 entries. Three bounds in the
 * first version of this code sat inside that number:
 *
 *   1. the set of already-reviewed entries was read in one unbounded request,
 *      so past Supabase's `db-max-rows` it came back **silently truncated**,
 *      reviewed entries looked new, and the insert hit the unique constraint
 *      on `entry_id`. One `insert()` is all-or-nothing, so the whole batch
 *      failed and the route turned it into a 502: the console stopped opening,
 *      and could not enqueue its way out of it;
 *   2. only the newest 500 entries were scanned, so anything that fell out of
 *      that window before being enqueued stayed out forever;
 *   3. the queue asked for the oldest 200 rows and *then* sorted by risk in
 *      JavaScript, so once more than 200 were pending a crisis row written
 *      today was cut before the sort could see it.
 *
 * Every test here fails against that version. The double below models the one
 * behaviour those bugs turned on — a gateway row cap that truncates without
 * saying so — because a test that cannot reproduce the truncation cannot show
 * that paging fixed it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  countPending,
  enqueuePendingReviews,
  loadQueue,
} from "../src/lib/server/crisisTriage.ts";

const ASSESSOR = "test-assessor";

/**
 * An in-memory Supabase double.
 *
 * `maxRows` is the part that matters: PostgREST caps a response at
 * `db-max-rows` (1,000 on Supabase by default) and reports nothing when it
 * does. Code that reads a table in one request cannot tell a complete answer
 * from a truncated one, and that is the whole of bug 1.
 */
function fakeDb({ entries = [], reviews = [], enrollments = [], maxRows = 1000 } = {}) {
  const tables = {
    entries: entries.map((row) => ({ ...row })),
    pilot_crisis_reviews: reviews.map((row) => ({ ...row })),
    pilot_enrollments: enrollments.map((row) => ({ ...row })),
  };
  const queries = [];
  let nextId = 1;

  function run(state) {
    if (state.op === "upsert") {
      const table = tables[state.table];
      const onConflict = state.options.onConflict;
      const inserted = [];
      for (const row of state.rows) {
        const clash =
          onConflict && table.some((existing) => existing[onConflict] === row[onConflict]);
        if (clash) {
          if (state.options.ignoreDuplicates) continue;
          // What the real unique index does, and what took the old batch down.
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
        const stored = { id: `review-${nextId++}`, ...row };
        table.push(stored);
        inserted.push({ id: stored.id });
      }
      return { data: inserted, error: null };
    }

    let rows = tables[state.table].filter((row) => state.filters.every((match) => match(row)));

    if (state.order) {
      const { column, ascending } = state.order;
      rows = [...rows].sort((a, b) =>
        a[column] === b[column] ? 0 : (a[column] < b[column] ? -1 : 1) * (ascending ? 1 : -1),
      );
    }

    if (state.head) return { data: null, count: rows.length, error: null };

    if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
    if (state.limit !== null) rows = rows.slice(0, state.limit);

    // The silent truncation. No error, no flag — just fewer rows.
    return { data: rows.slice(0, maxRows), error: null };
  }

  function from(table) {
    const state = {
      table,
      op: "select",
      filters: [],
      order: null,
      limit: null,
      range: null,
      head: false,
      rows: [],
      options: {},
    };
    queries.push(state);

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
        assert.ok(values.length <= 100, `in.(…) given ${values.length} ids; the URL has a length`);
        const wanted = new Set(values);
        state.filters.push((row) => wanted.has(row[column]));
        return chain;
      },
      not(column, operator, value) {
        assert.equal(operator, "is");
        assert.equal(value, null);
        state.filters.push((row) => row[column] !== null && row[column] !== undefined);
        return chain;
      },
      order(column, options = {}) {
        state.order = { column, ascending: options.ascending !== false };
        return chain;
      },
      limit(value) {
        state.limit = value;
        return chain;
      },
      range(from_, to) {
        state.range = [from_, to];
        return chain;
      },
      upsert(rows, options = {}) {
        state.op = "upsert";
        state.rows = rows;
        state.options = options;
        return chain;
      },
      insert(rows) {
        state.op = "upsert";
        state.rows = rows;
        state.options = {};
        return chain;
      },
      then(onFulfilled) {
        return Promise.resolve(run(state)).then(onFulfilled);
      },
    };
    return chain;
  }

  return { from, queries, tables };
}

/** `count` entries, oldest first, all with retained text. */
function seedEntries(count, { from = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${String(from + i).padStart(5, "0")}`,
    owner_user_id: `user-${(from + i) % 50}`,
    participant_id: `participant-${(from + i) % 50}`,
    raw_text_ciphertext: `cipher-${from + i}`,
    created_at: new Date(Date.UTC(2026, 0, 1) + (from + i) * 3600_000).toISOString(),
  }));
}

function reviewsFor(entries, overrides = () => ({})) {
  return entries.map((entry, i) => ({
    id: `seeded-${i}`,
    owner_user_id: entry.owner_user_id,
    participant_id: entry.participant_id,
    entry_id: entry.id,
    assessed_risk: "none",
    assessed_reasons: [],
    assessor_version: ASSESSOR,
    status: "pending",
    reviewed_at: null,
    review_slot: null,
    created_at: entry.created_at,
    ...overrides(entry, i),
  }));
}

describe("the queue survives the gateway's row cap", () => {
  it("does not re-enqueue entries whose review rows fell past db-max-rows", async () => {
    // 1,200 entries, every one already reviewed, against a 1,000-row cap.
    //
    // Read in one request, the reviewed set comes back holding 1,000 of the
    // 1,200 — so 200 reviewed entries look new, the insert collides with the
    // unique index on `entry_id`, and the whole batch dies. Read in ranges,
    // all 1,200 are seen and there is nothing to insert.
    const entries = seedEntries(1200);
    const db = fakeDb({ entries, reviews: reviewsFor(entries), maxRows: 1000 });

    const result = await enqueuePendingReviews(db, ASSESSOR);

    assert.equal(result.enqueued, 0);
    assert.equal(result.skipped, 1200, "every entry should have been recognised as already reviewed");
    assert.equal(result.deferred, 0);
    assert.equal(result.scanComplete, true);
  });

  it("reads both tables through explicit ranges rather than one request", async () => {
    const entries = seedEntries(1200);
    const db = fakeDb({ entries, reviews: reviewsFor(entries), maxRows: 1000 });
    await enqueuePendingReviews(db, ASSESSOR);

    for (const table of ["pilot_crisis_reviews", "entries"]) {
      const scans = db.queries.filter((q) => q.table === table && q.op === "select" && !q.head);
      assert.ok(
        scans.some((q) => q.range !== null),
        `${table} was read without a range; one request cannot tell a full answer from a truncated one`,
      );
    }
  });

  it("asks for fewer rows per request than the cap", async () => {
    const entries = seedEntries(1200);
    const db = fakeDb({ entries, reviews: reviewsFor(entries), maxRows: 1000 });
    await enqueuePendingReviews(db, ASSESSOR);

    for (const query of db.queries) {
      if (!query.range) continue;
      const size = query.range[1] - query.range[0] + 1;
      assert.ok(size < 1000, `a page of ${size} is not below Supabase's default db-max-rows`);
    }
  });
});

describe("nothing ages out of the backlog", () => {
  it("enqueues the oldest entries first, and reaches all of them", async () => {
    // 600 unreviewed entries. The old code scanned the newest 500 and left the
    // oldest 100 unreachable no matter how often the console was opened.
    const entries = seedEntries(600);
    const db = fakeDb({ entries, maxRows: 1000 });

    const first = await enqueuePendingReviews(db, ASSESSOR);
    assert.equal(first.enqueued, 300, "one open does a bounded amount of decryption");
    assert.equal(first.deferred, 300, "and says what it did not get to");

    // Oldest first: the rows in danger of ageing out are the ones taken.
    const enqueuedIds = db.tables.pilot_crisis_reviews.map((row) => row.entry_id).sort();
    assert.equal(enqueuedIds[0], entries[0].id);
    assert.equal(enqueuedIds.at(-1), entries[299].id);

    const second = await enqueuePendingReviews(db, ASSESSOR);
    assert.equal(second.enqueued, 300);
    assert.equal(second.deferred, 0, "the backlog drains");
    assert.equal(db.tables.pilot_crisis_reviews.length, 600);
  });

  it("leaves no entry permanently out of reach", async () => {
    const entries = seedEntries(1050); // the pilot's own maximum
    const db = fakeDb({ entries, maxRows: 1000 });

    for (let open = 0; open < 10; open += 1) {
      const result = await enqueuePendingReviews(db, ASSESSOR);
      if (result.deferred === 0) break;
    }

    const queued = new Set(db.tables.pilot_crisis_reviews.map((row) => row.entry_id));
    const stranded = entries.filter((entry) => !queued.has(entry.id));
    assert.deepEqual(stranded, [], "every retained entry must be reachable by the queue");
  });
});

describe("two reviewers opening the console at once", () => {
  it("treats a duplicate as the ordinary outcome, not a failed batch", async () => {
    const entries = seedEntries(10);
    const db = fakeDb({ entries, maxRows: 1000 });
    await enqueuePendingReviews(db, ASSESSOR);

    const writes = db.queries.filter((q) => q.op === "upsert");
    assert.ok(writes.length > 0, "nothing was written");
    for (const write of writes) {
      assert.equal(write.options.onConflict, "entry_id");
      assert.equal(write.options.ignoreDuplicates, true);
      // §4.4 has two slots and more than one authorised person; a plain
      // insert() makes one of them able to break the queue for the other.
      assert.ok(write.rows.length <= 100, "batches stay small enough to bound the damage");
    }
  });

  it("a row written between the read and the write does not throw", async () => {
    const entries = seedEntries(5);
    const db = fakeDb({ entries, maxRows: 1000 });

    // Stand in for the other console: the row appears after the scan has run.
    const realFrom = db.from;
    let scanned = false;
    const racing = {
      ...db,
      from(table) {
        if (table === "entries" && scanned === false) {
          scanned = true;
          db.tables.pilot_crisis_reviews.push({ id: "other", entry_id: entries[0].id });
        }
        return realFrom(table);
      },
    };

    const result = await enqueuePendingReviews(racing, ASSESSOR);
    assert.ok(result.enqueued >= 4, "the rest of the batch still went in");
  });
});

describe("worst first means worst first", () => {
  it("shows a crisis row written today, behind 250 older pending ones", async () => {
    // Ordered by created_at and cut at 200, this row is not on the page at all,
    // and a sort applied afterwards cannot put back what the cut removed.
    const entries = seedEntries(251);
    const older = reviewsFor(entries.slice(0, 250));
    const newest = reviewsFor(entries.slice(250), () => ({ assessed_risk: "crisis" }));

    const db = fakeDb({
      entries,
      reviews: [...older, ...newest],
      enrollments: entries.map((entry) => ({
        participant_id: entry.participant_id,
        research_code: `P-${entry.participant_id}`,
      })),
      maxRows: 1000,
    });

    const queue = await loadQueue(db);

    assert.equal(queue.length, 200);
    assert.equal(queue[0].assessed_risk, "crisis", "the worst row must be first, and must be present");
    assert.equal(queue[0].entry_id, entries[250].id);
  });

  it("orders bands worst first and, inside a band, oldest first", async () => {
    const entries = seedEntries(4);
    const risks = ["none", "crisis", "low", "crisis"];
    const db = fakeDb({
      entries,
      reviews: reviewsFor(entries, (_entry, i) => ({ assessed_risk: risks[i] })),
      enrollments: entries.map((entry) => ({
        participant_id: entry.participant_id,
        research_code: `P-${entry.participant_id}`,
      })),
    });

    const queue = await loadQueue(db);

    assert.deepEqual(
      queue.map((row) => row.assessed_risk),
      ["crisis", "crisis", "low", "none"],
    );
    // Of two rows the machine scored the same, the one waiting longer is the
    // one §4.4 is later on.
    assert.equal(queue[0].entry_id, entries[1].id);
    assert.equal(queue[1].entry_id, entries[3].id);
  });

  it("still carries no journal text", async () => {
    const entries = seedEntries(3);
    const db = fakeDb({
      entries,
      reviews: reviewsFor(entries),
      enrollments: entries.map((entry) => ({
        participant_id: entry.participant_id,
        research_code: `P-${entry.participant_id}`,
      })),
    });

    const queue = await loadQueue(db);
    for (const row of queue) {
      assert.equal(Object.hasOwn(row, "raw_text_ciphertext"), false);
      assert.equal(Object.hasOwn(row, "text"), false);
      assert.equal(row.text_available, true);
      // The reviewer works in the study's pseudonyms, not database ids.
      assert.match(row.research_code, /^P-/);
    }
  });
});

describe("the screen is told how much it is not showing", () => {
  it("counts every pending row, not just the page", async () => {
    const entries = seedEntries(1050);
    const db = fakeDb({ entries, reviews: reviewsFor(entries), maxRows: 1000 });

    // The count must not be capped by the gateway either.
    assert.equal(await countPending(db), 1050);
  });

  it("does not count rows that have been decided", async () => {
    const entries = seedEntries(10);
    const db = fakeDb({
      entries,
      reviews: reviewsFor(entries, (_entry, i) => (i < 4 ? { status: "no_concern" } : {})),
    });

    assert.equal(await countPending(db), 6);
  });
});
