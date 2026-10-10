import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COHORT_READ_INCOMPLETE, latestRowPerParticipant } from "../src/lib/cohortLatestRows.ts";

/**
 * The educator roster's "newest row per student" (#338), run against a store
 * the size of the pilot: 50 students × 21 days. The store applies filters,
 * ordering and ranges and returns at most `MAX_ROWS` per request, as PostgREST
 * does.
 */
const MAX_ROWS = 1000;

function store(tables, { failOn = null } = {}) {
  const requests = [];
  return {
    requests,
    from(table) {
      const query = { table, filters: [], orders: [], range: null };
      requests.push(query);
      const chain = {
        select: () => chain,
        eq: (column, expected) => (query.filters.push((row) => row[column] === expected), chain),
        in: (column, list) => (query.filters.push((row) => list.includes(row[column])), chain),
        order: (column, { ascending = true } = {}) => (query.orders.push({ column, ascending }), chain),
        range: (from, to) => ((query.range = [from, to]), chain),
        then(resolve) {
          if (failOn === table) return Promise.resolve({ data: null, error: { message: "permission denied" } }).then(resolve);
          let rows = tables[table].filter((row) => query.filters.every((keep) => keep(row)));
          rows.sort((a, b) => {
            for (const { column, ascending } of query.orders) {
              const order = String(a[column]).localeCompare(String(b[column]));
              if (order !== 0) return ascending ? order : -order;
            }
            return 0;
          });
          if (query.range) rows = rows.slice(query.range[0], query.range[1] + 1);
          return Promise.resolve({ data: rows.slice(0, MAX_ROWS), error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

const STUDENTS = Array.from({ length: 50 }, (_, i) => `p-${String(i).padStart(2, "0")}`);
const day = (n) => `2026-09-${String(n).padStart(2, "0")}`;

/** One insights row and one safety run per student per day written. */
function pilot(daysWritten) {
  const insights = [];
  const model_runs = [];
  for (const id of STUDENTS) {
    for (const n of daysWritten(id)) {
      insights.push({ participant_id: id, day: day(n) });
      model_runs.push({
        participant_id: id,
        artifact_type: "safety_assessment",
        created_at: `${day(n)}T12:00:00.000Z`,
        retrieval_config_json: { risk_level: "none" },
      });
      // Other audit rows share the table and must not be read as safety runs.
      model_runs.push({ participant_id: id, artifact_type: "extraction", created_at: `${day(n)}T12:00:01.000Z` });
    }
  }
  return { insights, model_runs };
}

const readInsights = (client, ids = STUDENTS) =>
  latestRowPerParticipant(client, { table: "insights", columns: "participant_id, day", participantIds: ids, newestBy: "day" });
const readSafety = (client, ids = STUDENTS) =>
  latestRowPerParticipant(client, {
    table: "model_runs",
    columns: "participant_id, retrieval_config_json, created_at",
    participantIds: ids,
    newestBy: "created_at",
    where: { artifact_type: "safety_assessment" },
  });

describe("the newest row per student", () => {
  const everyDay = Array.from({ length: 21 }, (_, i) => i + 1);

  it("is found for all 50 students across 1,050 rows", async () => {
    const tables = pilot(() => everyDay);
    assert.equal(tables.insights.length, 1050);

    const insights = await readInsights(store(tables));
    const safety = await readSafety(store(tables));
    assert.equal(insights.error, null);
    assert.equal(safety.error, null);
    for (const id of STUDENTS) {
      assert.equal(insights.latest.get(id)?.day, day(21), id);
      // Not the extraction row written a second later.
      assert.equal(safety.latest.get(id)?.created_at, `${day(21)}T12:00:00.000Z`, id);
      assert.equal(safety.latest.get(id)?.retrieval_config_json.risk_level, "none");
    }
  });

  it("keeps a student who wrote for 14 days and then stopped", async () => {
    // Everyone else kept writing for nine more days: 49 × 9 = 441 newer rows,
    // which is more than the 400 the roster used to read for the whole cohort.
    const quiet = "p-07";
    const crisisDay = 12;
    const tables = pilot((id) => (id === quiet ? everyDay.slice(0, 12) : everyDay));
    tables.model_runs.find((row) => row.participant_id === quiet && row.created_at.startsWith(day(crisisDay)) && row.artifact_type === "safety_assessment")
      .retrieval_config_json = { risk_level: "crisis", reasons: ["self_harm_or_suicide_risk"] };

    const insights = await readInsights(store(tables));
    const safety = await readSafety(store(tables));
    // A last active day, so the roster reports "no entries in 7 days" rather
    // than "no entries yet", and the crisis assessment is still on the row.
    assert.equal(insights.latest.get(quiet)?.day, day(12));
    assert.equal(safety.latest.get(quiet)?.retrieval_config_json.risk_level, "crisis");
    assert.equal(insights.latest.size, 50);
  });

  it("leaves out only the students who really have no rows", async () => {
    const tables = pilot((id) => (id === "p-03" ? [] : everyDay));
    const insights = await readInsights(store(tables));
    assert.equal(insights.error, null);
    assert.equal(insights.latest.has("p-03"), false);
    assert.equal(insights.latest.size, 49);
  });

  it("stops reading once every student has been seen", async () => {
    const client = store(pilot(() => everyDay));
    await readInsights(client);
    assert.equal(client.requests.length, 1, "the newest page already holds all 50");
  });

  it("covers a cohort larger than one request's worth of ids", async () => {
    const many = Array.from({ length: 230 }, (_, i) => `q-${String(i).padStart(3, "0")}`);
    const insights = many.flatMap((id) => [{ participant_id: id, day: day(1) }, { participant_id: id, day: day(2) }]);
    const result = await readInsights(store({ insights }), many);
    assert.equal(result.latest.size, 230);
    assert.ok([...result.latest.values()].every((row) => row.day === day(2)));
  });

  it("reports a failed read instead of an empty answer", async () => {
    const result = await readInsights(store(pilot(() => everyDay), { failOn: "insights" }));
    assert.deepEqual(result.error, { message: "permission denied" });
  });

  it("says so when it gives up before every student is accounted for", async () => {
    // One student with no rows behind far more rows than any pilot produces.
    const insights = Array.from({ length: 25_000 }, (_, i) => ({ participant_id: "p-00", day: `d-${String(i).padStart(6, "0")}` }));
    const result = await readInsights(store({ insights }), ["p-00", "p-missing"]);
    assert.equal(result.error?.message, COHORT_READ_INCOMPLETE);
  });
});
