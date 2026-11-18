import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recentDisclosedRisk } from "../src/lib/server/disclosedRisk.ts";

/**
 * The size of the window the module used to read (`limit(20)`). Filling past it
 * is how #373 and #529 lost a crisis, so the regression cases still do.
 */
const DISCLOSED_RISK_ROWS = 20;

/**
 * A fake `model_runs` table that answers the PostgREST builder the way the
 * database would, for the filters this module uses and no others.
 *
 * `neq` follows SQL: a row with no value is neither equal nor unequal, so it is
 * dropped. That is the point — a filter written as "not equal" alone would
 * silently lose the rows with no `surface` (journal assessments until #372).
 * Any filter the fake does not know throws, so a rewrite to a different shape
 * fails here instead of passing against a fake that ignored it.
 */
function fakeTable(rows, { error = null } = {}) {
  const calls = [];
  const field = (row, path) => {
    const json = path.match(/^(\w+)->>(\w+)$/);
    if (json) {
      const value = row[json[1]]?.[json[2]];
      return value === undefined ? null : String(value);
    }
    return row[path] ?? null;
  };
  const clause = (text) => {
    const m = text.match(/^(.+)\.(is|neq|eq)\.(.+)$/);
    if (!m) throw new Error(`fake: unsupported or-clause ${text}`);
    const [, path, op, operand] = m;
    return (row) => {
      const value = field(row, path);
      if (op === "is") {
        if (operand !== "null") throw new Error(`fake: unsupported is.${operand}`);
        return value === null;
      }
      if (value === null) return false;
      return op === "eq" ? value === operand : value !== operand;
    };
  };
  const client = {
    calls,
    from(table) {
      assert.equal(table, "model_runs");
      const filters = [];
      let order = null;
      const builder = {
        select(columns) {
          calls.push(["select", columns]);
          return builder;
        },
        eq(column, value) {
          calls.push(["eq", column, value]);
          filters.push((row) => field(row, column) === value);
          return builder;
        },
        gte(column, value) {
          calls.push(["gte", column, value]);
          filters.push((row) => field(row, column) !== null && field(row, column) >= value);
          return builder;
        },
        or(expression) {
          calls.push(["or", expression]);
          const parts = expression.split(",").map(clause);
          filters.push((row) => parts.some((part) => part(row)));
          return builder;
        },
        order(column, { ascending }) {
          calls.push(["order", column, ascending]);
          order = { column, ascending };
          return builder;
        },
        limit(count) {
          calls.push(["limit", count]);
          if (error) return Promise.resolve({ data: null, error });
          let result = rows.filter((row) => filters.every((keep) => keep(row)));
          if (order) {
            result = [...result].sort((a, b) =>
              order.ascending
                ? String(a[order.column]).localeCompare(String(b[order.column]))
                : String(b[order.column]).localeCompare(String(a[order.column])),
            );
          }
          return Promise.resolve({
            data: result.slice(0, count).map((row) => ({ retrieval_config_json: row.retrieval_config_json })),
            error: null,
          });
        },
      };
      return builder;
    },
  };
  return client;
}

const PARTICIPANT = "participant-1";

/** An audit row `minutesAgo` minutes old. */
function auditRow(minutesAgo, config, overrides = {}) {
  return {
    participant_id: PARTICIPANT,
    artifact_type: "safety_assessment",
    created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    retrieval_config_json: config,
    ...overrides,
  };
}

/** One turn per minute on `surface` for the last `count` minutes, all at `level`. */
function turns(surface, count, level = "none") {
  return Array.from({ length: count }, (_, i) => auditRow(i + 1, { risk_level: level, surface }));
}

/** One chat turn per minute for the last `count` minutes, all at `level`. */
function chatTurns(count, level = "none") {
  return turns("chat", count, level);
}

describe("recentDisclosedRisk (#373)", () => {
  it("carries a morning journal crisis into a chat with twenty or more turns that day", async () => {
    for (const turns of [DISCLOSED_RISK_ROWS - 1, DISCLOSED_RISK_ROWS, DISCLOSED_RISK_ROWS * 3]) {
      const rows = [
        ...chatTurns(turns),
        auditRow(6 * 60, { risk_level: "crisis", surface: "journal" }),
      ];
      assert.equal(
        await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"),
        "crisis",
        `${turns} chat turns hid the journal crisis`,
      );
    }
  });

  it("carries rows that carry no `surface` at all (journal rows before #372)", async () => {
    const rows = [...chatTurns(DISCLOSED_RISK_ROWS * 2), auditRow(6 * 60, { risk_level: "crisis" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "crisis");
  });

  it("does not carry this surface's own elevated turn back into itself", async () => {
    const rows = [auditRow(5, { risk_level: "elevated", surface: "chat" }), ...chatTurns(3)];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "none");
  });

  it("still carries another conversational surface's risk", async () => {
    const rows = [...chatTurns(DISCLOSED_RISK_ROWS * 2), auditRow(30, { risk_level: "elevated", surface: "voice" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "elevated");
  });

  it("ignores rows older than a day and other participants' rows", async () => {
    const rows = [
      auditRow(25 * 60, { risk_level: "crisis", surface: "journal" }),
      auditRow(10, { risk_level: "crisis", surface: "journal" }, { participant_id: "someone-else" }),
    ];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "none");
  });

  it("excludes this surface in the query itself, not after the limit", async () => {
    const client = fakeTable([]);
    await recentDisclosedRisk(client, PARTICIPANT, "chat");
    const names = client.calls.map(([name]) => name);
    assert.ok(names.includes("or"), "the surface filter must be part of the query");
    assert.ok(names.indexOf("or") < names.indexOf("limit"));
    const [, expression] = client.calls.find(([name]) => name === "or");
    assert.match(expression, /retrieval_config_json->>surface\.is\.null/);
    assert.match(expression, /retrieval_config_json->>surface\.neq\.chat/);
  });

  it("logs a failed read instead of reporting it as no risk silently", async () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args);
    try {
      const client = fakeTable([], { error: { message: "connection reset" } });
      assert.equal(await recentDisclosedRisk(client, PARTICIPANT, "chat"), "none");
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /could not read/);
    assert.equal(logged[0][1].error, "connection reset");
  });

  it("refuses a surface name that is not a plain identifier, without throwing", async () => {
    const logged = [];
    const original = console.error;
    console.error = (...args) => logged.push(args);
    try {
      const client = fakeTable([auditRow(5, { risk_level: "crisis", surface: "journal" })]);
      assert.equal(await recentDisclosedRisk(client, PARTICIPANT, "chat,x.is.null"), "none");
      assert.equal(client.calls.length, 0);
    } finally {
      console.error = original;
    }
    assert.equal(logged.length, 1);
  });
});

describe("recentDisclosedRisk (#529): a third surface filling the window", () => {
  it("carries a journal crisis into chat after many voice turns", async () => {
    for (const count of [DISCLOSED_RISK_ROWS - 1, DISCLOSED_RISK_ROWS, DISCLOSED_RISK_ROWS * 2]) {
      const rows = [...turns("voice", count), auditRow(6 * 60, { risk_level: "crisis", surface: "journal" })];
      assert.equal(
        await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"),
        "crisis",
        `${count} voice turns hid the journal crisis`,
      );
    }
  });

  it("carries a journal elevated into voice after many chat turns", async () => {
    const rows = [
      ...turns("chat", DISCLOSED_RISK_ROWS * 2),
      auditRow(6 * 60, { risk_level: "elevated", surface: "journal" }),
    ];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "voice"), "elevated");
  });

  it("carries the highest level, not the latest one", async () => {
    const rows = [
      auditRow(5, { risk_level: "elevated", surface: "voice" }),
      ...turns("voice", DISCLOSED_RISK_ROWS * 2, "low"),
      auditRow(20 * 60, { risk_level: "crisis", surface: "journal" }),
    ];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "crisis");
  });

  it("still carries a low level when nothing higher was disclosed", async () => {
    const rows = [...turns("voice", DISCLOSED_RISK_ROWS * 2), auditRow(60, { risk_level: "low", surface: "journal" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "low");
  });

  it("asks for each level in the query and reads one row per level", async () => {
    const client = fakeTable([]);
    await recentDisclosedRisk(client, PARTICIPANT, "chat");
    const levels = client.calls
      .filter(([name, column]) => name === "eq" && column === "retrieval_config_json->>risk_level")
      .map(([, , value]) => value);
    assert.deepEqual([...levels].sort(), ["crisis", "elevated", "low"]);
    const limits = client.calls.filter(([name]) => name === "limit").map(([, count]) => count);
    assert.deepEqual(limits, [1, 1, 1]);
  });
});
