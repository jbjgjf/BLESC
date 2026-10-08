/**
 * A disclosure on one surface keeps shaping the conversation on another (#373).
 *
 * `recentDisclosedRisk` is the whole of the cross-surface carry-over: a crisis
 * written in the journal at 08:00 is supposed to still be shaping the chat
 * reply at 20:00, without the student having to repeat the words. It had no test
 * at all, and it was reading the newest twenty audit rows and only then dropping
 * the ones from the surface asking — so on a talkative day the window held
 * nothing but the asking surface's own rows and the answer was always `none`.
 *
 * What this locks down is the order of the two operations, and the one SQL
 * detail that makes the obvious fix wrong: `neq` on a NULL column is NULL, not
 * true, so excluding by inequality alone would also discard every row with no
 * `surface` recorded — which is what the journal's own rows look like (#372).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assessConversation, recentDisclosedRisk } from "../src/lib/server/safety.ts";

/**
 * The `or(...)` expression the module builds, modelled with SQL's own
 * three-valued semantics: `x <> 'chat'` is NULL — therefore not a match — when
 * `x` is NULL. A stub that treated it as true would pass whichever way the
 * module was written, which is the failure this file exists to catch.
 */
function orFilter(expression) {
  const clauses = expression.split(",").map((clause) => {
    const [field, operator, ...rest] = clause.split(".");
    const value = rest.join(".");
    const key = field.replace(/^retrieval_config_json->>/, "");
    const read = (row) => (row.retrieval_config_json ?? {})[key] ?? null;
    if (operator === "is" && value === "null") return (row) => read(row) === null;
    if (operator === "neq") return (row) => read(row) !== null && read(row) !== value;
    throw new Error(`the stub does not model ${clause}`);
  });
  return (row) => clauses.some((clause) => clause(row));
}

/**
 * Enough of PostgREST to tell the two orderings apart: filters narrow, then the
 * result is sorted newest-first, and only then is `limit` applied.
 */
function modelRuns(rows, { fail = false } = {}) {
  const seen = { or: null, limit: null };
  const state = { filters: [], limit: Infinity };

  const chain = {
    select: () => chain,
    eq(column, value) {
      state.filters.push((row) => row[column] === value);
      return chain;
    },
    gte(column, value) {
      state.filters.push((row) => String(row[column]) >= String(value));
      return chain;
    },
    or(expression) {
      seen.or = expression;
      state.filters.push(orFilter(expression));
      return chain;
    },
    order: () => chain,
    limit(count) {
      seen.limit = count;
      state.limit = count;
      return chain;
    },
    then(onFulfilled, onRejected) {
      const settled = fail
        ? { data: null, error: { message: "model_runs select failed" } }
        : {
            data: rows
              .filter((row) => state.filters.every((match) => match(row)))
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .slice(0, state.limit),
            error: null,
          };
      return Promise.resolve(settled).then(onFulfilled, onRejected);
    },
  };

  return { client: { from: () => chain }, seen };
}

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const audit = (surface, risk, minutes) => ({
  participant_id: "participant-1",
  artifact_type: "safety_assessment",
  created_at: minutesAgo(minutes),
  retrieval_config_json: surface === null ? { risk_level: risk } : { risk_level: risk, surface },
});

/** One row per chat turn, whatever the risk level — what the route actually writes. */
const chatTurns = (count) =>
  Array.from({ length: count }, (_, index) => audit("chat", "none", index + 1));

function captureErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.map(String).join(" "));
  try {
    return run().then(
      (value) => {
        console.error = original;
        return { value, lines };
      },
      (error) => {
        console.error = original;
        throw error;
      },
    );
  } catch (error) {
    console.error = original;
    throw error;
  }
}

describe("the asking surface is excluded before the window is cut (#373)", () => {
  it("carries a journal crisis into a chat that has already run 20 turns", async () => {
    // The regression. Twenty chat rows are all newer than the morning's journal
    // entry, so excluding after `limit(20)` leaves nothing at all.
    const { client } = modelRuns([...chatTurns(20), audit("journal", "crisis", 600)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "chat"), "crisis");
  });

  it("carries it at 60 turns too — the window is of other surfaces, not of rows", async () => {
    const { client } = modelRuns([...chatTurns(60), audit("journal", "elevated", 600)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "chat"), "elevated");
  });

  it("asks the database for the exclusion rather than doing it afterwards", async () => {
    const { client, seen } = modelRuns([...chatTurns(20), audit("journal", "crisis", 600)]);
    await recentDisclosedRisk(client, "participant-1", "chat");
    assert.ok(seen.or, "the surface exclusion must travel with the query");
    // The NULL half is the part that is easy to drop and impossible to notice:
    // without it the journal's own rows (#372) disappear from the window.
    assert.match(seen.or, /surface\.is\.null/);
    assert.match(seen.or, /surface\.neq\.chat/);
    assert.equal(seen.limit, 20);
  });

  it("reads a row that records no surface at all", async () => {
    // What a journal assessment looks like until #372 lands: no `surface` key.
    const { client } = modelRuns([...chatTurns(20), audit(null, "crisis", 600)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "chat"), "crisis");
  });

  it("still does not carry the asking surface's own rows", async () => {
    // The restraint the exclusion exists for: one elevated chat turn must not
    // stick to the participant for the rest of the day.
    const { client } = modelRuns([audit("chat", "elevated", 5)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "chat"), "none");
  });

  it("takes the highest of several surfaces", async () => {
    const { client } = modelRuns([audit("journal", "low", 100), audit("voice", "elevated", 50)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "chat"), "elevated");
  });

  it("excludes voice when voice is asking, and reads chat", async () => {
    const { client } = modelRuns([...chatTurns(0), audit("voice", "crisis", 5), audit("chat", "low", 10)]);
    assert.equal(await recentDisclosedRisk(client, "participant-1", "voice"), "low");
  });
});

describe("a read that did not happen is not reported as 'nothing disclosed'", () => {
  it("says so in the log and does not raise the turn", async () => {
    const { client } = modelRuns([audit("journal", "crisis", 600)], { fail: true });
    const { value, lines } = await captureErrors(() =>
      recentDisclosedRisk(client, "participant-1", "chat"),
    );
    // `none` is the only safe return — the caller must not be stopped from
    // replying to a student — but it cannot be the only trace.
    assert.equal(value, "none");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\[safety\]/);
    assert.match(lines[0], /could not read/);
  });

  it("says nothing on the ordinary path", async () => {
    const { client } = modelRuns([audit("journal", "crisis", 600)]);
    const { lines } = await captureErrors(() => recentDisclosedRisk(client, "participant-1", "chat"));
    assert.deepEqual(lines, []);
  });
});

describe("the carried level reaches the assessment the surface acts on", () => {
  it("raises a calm chat window to the journal's crisis", async () => {
    const { client } = modelRuns([...chatTurns(20), audit("journal", "crisis", 600)]);
    const assessment = await assessConversation(client, "participant-1", "chat", [], "今日は普通だった");
    assert.equal(assessment.risk_level, "crisis");
    assert.ok(assessment.reasons.includes("risk_disclosed_on_another_surface"));
    assert.equal(assessment.escalation_required, true);
  });

  it("leaves a calm window calm when nothing was disclosed elsewhere", async () => {
    const { client } = modelRuns(chatTurns(20));
    const assessment = await assessConversation(client, "participant-1", "chat", [], "今日は普通だった");
    assert.equal(assessment.risk_level, "none");
  });
});
