/**
 * Draining the escalation queue.
 *
 * `safety-escalation.test.mjs` covers what happens to one escalation.
 * This covers which escalations a run picks up — the part that decides whether
 * a crisis recorded a minute ago is looked at tonight or behind twenty rows
 * that cannot be delivered.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BATCH, MAX_ATTEMPTS, dispatchPendingEscalations } from "../src/lib/server/safetyDispatch.ts";

/**
 * A Supabase double that records how the queue was asked for.
 *
 * The builder is a thenable that resolves to whatever the table was seeded
 * with, so `await`ing the chain works the way the real client's does.
 */
function fakeClient({ escalations = [], participants = [], counts = {}, errors = {} } = {}) {
  const queries = [];

  function builder(table, options = {}) {
    const record = { table, head: Boolean(options.head), filters: [], order: [], limit: null };
    queries.push(record);

    const chain = {
      select(_columns, opts = {}) {
        record.head = Boolean(opts.head);
        return chain;
      },
      in(column, values) {
        record.filters.push({ op: "in", column, values });
        return chain;
      },
      lt(column, value) {
        record.filters.push({ op: "lt", column, value });
        return chain;
      },
      gte(column, value) {
        record.filters.push({ op: "gte", column, value });
        return chain;
      },
      order(column, opts = {}) {
        record.order.push({ column, ...opts });
        return chain;
      },
      limit(value) {
        record.limit = value;
        return chain;
      },
      then(onFulfilled) {
        if (record.head) {
          const key = record.filters.some((f) => f.op === "gte") ? "exhausted" : "other";
          if (errors[key]) return Promise.resolve({ count: null, error: { message: errors[key] } }).then(onFulfilled);
          const count = key in counts ? counts[key] : 0;
          return Promise.resolve({ count, error: null }).then(onFulfilled);
        }
        if (record.table === "participants" && errors.participants) {
          return Promise.resolve({ data: null, error: { message: errors.participants } }).then(onFulfilled);
        }
        const data = record.table === "participants" ? participants : escalations;
        return Promise.resolve({ data, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }

  return {
    queries,
    from: (table) => builder(table),
    rpc: () => Promise.resolve({ data: [], error: null }),
  };
}

const queueQuery = (client) =>
  client.queries.find((q) => q.table === "safety_escalations" && !q.head);

describe("which escalations a run picks up", () => {
  it("takes only what is still owed and not yet exhausted", async () => {
    const client = fakeClient();
    await dispatchPendingEscalations(client);

    const query = queueQuery(client);
    const statuses = query.filters.find((f) => f.op === "in");
    assert.deepEqual(statuses.values, ["pending", "failed"]);
    // `delivered` is done and `no_recipient` is terminal: neither is owed.

    const attempts = query.filters.find((f) => f.op === "lt");
    assert.deepEqual(attempts, { op: "lt", column: "attempts", value: MAX_ATTEMPTS });

    assert.equal(query.limit, BATCH);
  });

  it("rotates the batch by last attempt, so blocked rows cannot monopolise it", async () => {
    /*
     * The regression this guards against, found by review on #203.
     *
     * A row that reaches nobody without attempting anything — no channel
     * configured, or consent held by educators who have no address — stays
     * `pending` and does not increment `attempts`. That is deliberate: an idle
     * misconfiguration must not burn a retry budget meant for transport
     * failures. But it also means `.lt("attempts", MAX_ATTEMPTS)` never
     * removes the row.
     *
     * Ordered by `detected_at` alone, once BATCH such rows exist they are
     * permanently the oldest BATCH rows in the queue. Every run would select
     * the same twenty, attempt nothing, and never reach a crisis recorded
     * tonight whose educator does have an address.
     *
     * `last_attempt_at` is stamped on every pass including the ones that send
     * nothing, so ordering by it rotates the queue. Nulls first so a row
     * nobody has looked at yet still goes to the front.
     */
    const client = fakeClient();
    await dispatchPendingEscalations(client);

    const { order } = queueQuery(client);
    assert.deepEqual(
      order[0],
      { column: "last_attempt_at", ascending: true, nullsFirst: true },
      "the queue must rotate, or rows that attempt nothing hold the batch forever",
    );
    assert.equal(order[1].column, "detected_at", "among equals, oldest first");
    assert.equal(order[1].ascending, true);
  });

  it("reports what it did, including rows that reached nobody", async () => {
    const client = fakeClient({ counts: { exhausted: 3 } });
    const result = await dispatchPendingEscalations(client);
    assert.deepEqual(result, {
      attempted: 0,
      delivered: 0,
      failed: 0,
      no_recipient: 0,
      pending: 0,
      stuck: 3,
    });
  });

  it("surfaces a read failure instead of reporting an empty queue", async () => {
    // An empty result and an unreadable table look the same to a caller that
    // only counts, and one of them means nothing is being retried at all.
    const client = {
      from: () => ({
        select: () => ({
          in: () => ({
            lt: () => ({
              order: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    const result = await dispatchPendingEscalations(client);
    assert.deepEqual(result, { error: "permission denied" });
  });
});

/**
 * The two lookups around the queue read (#377). Only the queue read used to be
 * checked, so a failed code lookup sent every alert in the batch naming nobody
 * and marked it delivered, and a failed count reported no standing failures.
 */
describe("when a lookup beside the queue fails", () => {
  const row = (id, participant) => ({
    id,
    owner_user_id: "owner-1",
    participant_id: participant,
    risk_level: "crisis",
    reasons: ["self_harm_or_suicide_risk"],
    surface: "chat",
    detected_at: "2026-10-08T17:14:03.000Z",
    status: "pending",
    attempts: 0,
  });

  /** Stands in for `deliverEscalation`, recording who each alert would name. */
  function recordingDeliver() {
    const sent = [];
    const deliver = async (_service, escalation, code) => {
      sent.push({ id: escalation.id, code });
      return "delivered";
    };
    return { sent, deliver };
  }

  async function quietly(run) {
    const saved = { error: console.error, warn: console.warn };
    const logged = { error: [], warn: [] };
    console.error = (...args) => logged.error.push(args.join(" "));
    console.warn = (...args) => logged.warn.push(args.map(String).join(" "));
    try {
      return { result: await run(), logged };
    } finally {
      Object.assign(console, saved);
    }
  }

  it("sends nothing when the participant codes cannot be read", async () => {
    const client = fakeClient({
      escalations: [row("esc-1", "p-1"), row("esc-2", "p-2")],
      errors: { participants: "connection reset" },
    });
    const { sent, deliver } = recordingDeliver();
    const { result, logged } = await quietly(() => dispatchPendingEscalations(client, deliver));

    assert.deepEqual(sent, [], "an alert naming nobody must not go out and be marked delivered");
    assert.deepEqual(result, { error: "connection reset" });
    assert.equal(logged.error.length, 1);
  });

  it("names each participant when the lookup works", async () => {
    const client = fakeClient({
      escalations: [row("esc-1", "p-1"), row("esc-2", "p-2")],
      participants: [{ id: "p-1", code: "BL-001" }, { id: "p-2", code: "BL-002" }],
    });
    const { sent, deliver } = recordingDeliver();
    const { result, logged } = await quietly(() => dispatchPendingEscalations(client, deliver));

    assert.deepEqual(sent, [{ id: "esc-1", code: "BL-001" }, { id: "esc-2", code: "BL-002" }]);
    assert.equal(result.delivered, 2);
    assert.deepEqual(logged.warn, []);
  });

  it("still sends a row whose participant the lookup did not return, and says so", async () => {
    const client = fakeClient({
      escalations: [row("esc-1", "p-1"), row("esc-2", "p-gone")],
      participants: [{ id: "p-1", code: "BL-001" }],
    });
    const { sent, deliver } = recordingDeliver();
    const { result, logged } = await quietly(() => dispatchPendingEscalations(client, deliver));

    assert.deepEqual(sent, [{ id: "esc-1", code: "BL-001" }, { id: "esc-2", code: null }]);
    assert.equal(result.delivered, 2);
    assert.equal(logged.warn.length, 1);
    assert.ok(logged.warn[0].includes("1 escalation(s)"));
  });

  it("does not report zero stuck when the count cannot be read", async () => {
    const client = fakeClient({
      escalations: [row("esc-1", "p-1")],
      participants: [{ id: "p-1", code: "BL-001" }],
      errors: { exhausted: "statement timeout" },
    });
    const { sent, deliver } = recordingDeliver();
    const { result, logged } = await quietly(() => dispatchPendingEscalations(client, deliver));

    // The sends happened and are reported; only the standing count is unknown.
    assert.equal(sent.length, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.stuck, null);
    assert.equal(result.stuck_error, "statement timeout");
    assert.notEqual(result.stuck, 0);
    assert.equal(logged.error.length, 1);
  });

  it("does not report zero stuck when the count comes back without a number", async () => {
    const client = fakeClient({ counts: { exhausted: null } });
    const { result } = await quietly(() => dispatchPendingEscalations(client));
    assert.equal(result.stuck, null);
    assert.ok(result.stuck_error);
  });
});
