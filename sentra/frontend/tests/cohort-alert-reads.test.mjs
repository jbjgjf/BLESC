import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACKNOWLEDGED_ESCALATION_LIMIT,
  acknowledgedAlertKeys,
  readAlertEscalations,
} from "../src/lib/cohortAlertReads.ts";

/**
 * The reads behind the educator's alert list (#364), run against a store that
 * holds more rows than the old limits and behaves the way PostgREST does where
 * it matters here: filters and ranges are applied, at most `MAX_ROWS` come back
 * per request, and **a request with no ORDER BY returns rows in an order the
 * caller does not control** — the store reverses them on every unordered read.
 */
const MAX_ROWS = 1000;

function store(tables) {
  let flip = false;
  const requests = [];
  const value = (row, column) =>
    column.includes("->>") ? row[column.split("->>")[0]]?.[column.split("->>")[1]] : row[column];

  return {
    requests,
    from(table) {
      const query = { table, filters: [], orders: [], range: null, limit: null };
      requests.push(query);
      const chain = {
        select: () => chain,
        eq: (column, expected) => (query.filters.push((row) => value(row, column) === expected), chain),
        in: (column, list) => (query.filters.push((row) => list.includes(value(row, column))), chain),
        is: (column, expected) => (query.filters.push((row) => (value(row, column) ?? null) === expected), chain),
        not: (column, _op, expected) => (query.filters.push((row) => (value(row, column) ?? null) !== expected), chain),
        order: (column, { ascending = true } = {}) => (query.orders.push({ column, ascending }), chain),
        range: (from, to) => ((query.range = [from, to]), chain),
        limit: (count) => ((query.limit = count), chain),
        then(resolve) {
          let rows = tables[table].filter((row) => query.filters.every((keep) => keep(row)));
          if (query.orders.length === 0) {
            flip = !flip;
            if (flip) rows = [...rows].reverse();
          } else {
            rows = [...rows].sort((a, b) => {
              for (const { column, ascending } of query.orders) {
                const order = String(value(a, column)).localeCompare(String(value(b, column)));
                if (order !== 0) return ascending ? order : -order;
              }
              return 0;
            });
          }
          if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
          if (query.limit !== null) rows = rows.slice(0, query.limit);
          return Promise.resolve({ data: rows.slice(0, MAX_ROWS), error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

let sequence = 0;
const ack = (alertKey, viewType = "alert_ack") => {
  sequence += 1;
  return {
    id: `log-${String(sequence).padStart(6, "0")}`,
    view_type: viewType,
    metadata: { alert_key: alertKey },
    occurred_at: new Date(Date.UTC(2026, 8, 1) + sequence * 60_000).toISOString(),
  };
};

describe("which alerts are acknowledged", () => {
  it("does not depend on how many other acknowledgements exist", async () => {
    // The alert on the roster today was acknowledged three weeks ago, before
    // 700 acknowledgements of alerts whose keys have since changed.
    const wanted = "safety_crisis:p-1:2026-09-01T02:14:03Z";
    const log = [ack(wanted), ...Array.from({ length: 700 }, (_, i) => ack(`inactivity:p-${i}:2026-09-0${(i % 9) + 1}`))];
    const client = store({ educator_access_log: log });

    for (let load = 0; load < 4; load += 1) {
      const { acked, error } = await acknowledgedAlertKeys(client, [wanted, "inactivity:p-new:never"]);
      assert.equal(error, null);
      assert.deepEqual([...acked], [wanted], `page load ${load + 1}`);
    }
  });

  it("is not hidden by one alert acknowledged many times", async () => {
    const log = [ack("inactivity:p-2:2026-09-20"), ...Array.from({ length: 1200 }, () => ack("safety_crisis:p-1:latest"))];
    const { acked } = await acknowledgedAlertKeys(store({ educator_access_log: log }), [
      "safety_crisis:p-1:latest",
      "inactivity:p-2:2026-09-20",
    ]);
    assert.deepEqual([...acked].sort(), ["inactivity:p-2:2026-09-20", "safety_crisis:p-1:latest"]);
  });

  it("covers a roster with more keys than fit in one request", async () => {
    const keys = Array.from({ length: 130 }, (_, i) => `inactivity:p-${i}:never`);
    const log = keys.filter((_, i) => i % 2 === 0).map((key) => ack(key));
    const { acked } = await acknowledgedAlertKeys(store({ educator_access_log: log }), keys);
    assert.equal(acked.size, 65);
    assert.ok(acked.has("inactivity:p-128:never"));
    assert.ok(!acked.has("inactivity:p-129:never"));
  });

  it("reads only acknowledgements, not the other rows the log carries", async () => {
    const log = [ack("safety_crisis:p-1:latest", "alerts")];
    const { acked } = await acknowledgedAlertKeys(store({ educator_access_log: log }), ["safety_crisis:p-1:latest"]);
    assert.equal(acked.size, 0);
  });

  it("asks nothing when the roster raises no alerts", async () => {
    const client = store({ educator_access_log: [ack("x")] });
    assert.equal((await acknowledgedAlertKeys(client, [])).acked.size, 0);
    assert.equal(client.requests.length, 0);
  });

  it("passes a read failure up instead of answering 'none acknowledged'", async () => {
    const failing = { from: () => { const c = { select: () => c, eq: () => c, in: () => c, order: () => c, range: () => Promise.resolve({ data: null, error: { message: "permission denied" } }) }; return c; } };
    const { error } = await acknowledgedAlertKeys(failing, ["safety_crisis:p-1:latest"]);
    assert.deepEqual(error, { message: "permission denied" });
  });
});

describe("which escalations reach the alert list", () => {
  const escalation = (index, acknowledged) => ({
    id: `esc-${String(index).padStart(5, "0")}`,
    participant_id: `p-${index % 50}`,
    // Lower index = older.
    detected_at: new Date(Date.UTC(2026, 8, 1) + index * 60_000).toISOString(),
    acknowledged_at: acknowledged ? "2026-10-01T00:00:00.000Z" : null,
  });

  it("shows an unacknowledged escalation however many newer rows there are", async () => {
    // The oldest row is unacknowledged and sits behind 200 newer unacknowledged
    // ones and 300 newer acknowledged ones: the 201st and the 501st at once.
    const rows = [
      escalation(0, false),
      ...Array.from({ length: 200 }, (_, i) => escalation(1 + i, false)),
      ...Array.from({ length: 300 }, (_, i) => escalation(201 + i, true)),
    ];
    const result = await readAlertEscalations(store({ safety_escalations: rows }), "id");

    assert.equal(result.error, null);
    const open = result.rows.filter((row) => row.acknowledged_at === null);
    assert.equal(open.length, 201);
    assert.ok(open.some((row) => row.id === "esc-00000"), "the oldest unacknowledged escalation is still listed");
  });

  it("reads past one page of unacknowledged escalations", async () => {
    const rows = Array.from({ length: 1234 }, (_, i) => escalation(i, false));
    const result = await readAlertEscalations(store({ safety_escalations: rows }), "id");
    assert.equal(new Set(result.rows.map((row) => row.id)).size, 1234);
  });

  it("keeps only the most recent acknowledged ones", async () => {
    const rows = Array.from({ length: 350 }, (_, i) => escalation(i, true));
    const result = await readAlertEscalations(store({ safety_escalations: rows }), "id");
    assert.equal(result.rows.length, ACKNOWLEDGED_ESCALATION_LIMIT);
    assert.ok(result.rows.some((row) => row.id === "esc-00349"));
    assert.ok(!result.rows.some((row) => row.id === "esc-00000"));
  });
});
