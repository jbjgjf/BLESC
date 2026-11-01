import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DISCLOSED_RISK_MAX_ROWS, recentDisclosedRisk } from "../src/lib/server/disclosedRisk.ts";

/**
 * The row cap this module used to read under, and the number this file's
 * volumes are built from. It is deliberately not imported: #529 removed it,
 * and the point of these cases is that the answer no longer depends on how
 * many rows anybody wrote.
 */
const OLD_ROW_WINDOW = 20;

/**
 * A fake `model_runs` table that answers the PostgREST builder the way the
 * database would, for the filters this module uses and no others.
 *
 * `neq` follows SQL: a row with no value is neither equal nor unequal, so it is
 * dropped. That is the point — a filter written as "not equal" alone would
 * silently lose the rows with no `surface` (journal assessments until #372).
 * Any filter the fake does not know throws, so a rewrite to a different shape
 * fails here instead of passing against a fake that ignored it. `limit` is
 * among the things it does not know: reading a fixed number of recent rows is
 * the shape #529 removed, and coming back to it must fail here.
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
      const order = [];
      let exactCount = false;
      const builder = {
        select(columns, options) {
          calls.push(["select", columns, options]);
          exactCount = options?.count === "exact";
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
          order.push({ column, ascending });
          return builder;
        },
        range(from, to) {
          calls.push(["range", from, to]);
          if (error) return Promise.resolve({ data: null, error, count: null });
          let result = rows.filter((row) => filters.every((keep) => keep(row)));
          // Applied in the order the builder was given them, last key first,
          // which is how a stable sort composes into one total order.
          for (const key of [...order].reverse()) {
            result = [...result].sort((a, b) =>
              key.ascending
                ? String(a[key.column]).localeCompare(String(b[key.column]))
                : String(b[key.column]).localeCompare(String(a[key.column])),
            );
          }
          return Promise.resolve({
            data: result
              .slice(from, to + 1)
              .map((row) => ({ id: row.id, retrieval_config_json: row.retrieval_config_json })),
            error: null,
            count: exactCount ? result.length : null,
          });
        },
        limit() {
          throw new Error("fake: `limit` is the pre-#529 shape; read every row in the window instead");
        },
      };
      return builder;
    },
  };
  return client;
}

const PARTICIPANT = "participant-1";

let nextId = 0;

/** An audit row `minutesAgo` minutes old. */
function auditRow(minutesAgo, config, overrides = {}) {
  nextId += 1;
  return {
    // Padded so the fake's string ordering on the primary key matches the
    // numeric one, as a uuid's would not have to.
    id: `run-${String(nextId).padStart(6, "0")}`,
    participant_id: PARTICIPANT,
    artifact_type: "safety_assessment",
    created_at: new Date(Date.now() - minutesAgo * 60 * 1000).toISOString(),
    retrieval_config_json: config,
    ...overrides,
  };
}

/** One turn per minute for the last `count` minutes, all at `level`. */
function turns(count, surface, level = "none") {
  return Array.from({ length: count }, (_, i) => auditRow(i + 1, { risk_level: level, surface }));
}

describe("recentDisclosedRisk (#373)", () => {
  it("carries a morning journal crisis into a chat with twenty or more turns that day", async () => {
    for (const count of [OLD_ROW_WINDOW - 1, OLD_ROW_WINDOW, OLD_ROW_WINDOW * 3]) {
      const rows = [...turns(count, "chat"), auditRow(6 * 60, { risk_level: "crisis", surface: "journal" })];
      assert.equal(
        await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"),
        "crisis",
        `${count} chat turns hid the journal crisis`,
      );
    }
  });

  it("carries rows that carry no `surface` at all (journal rows before #372)", async () => {
    const rows = [...turns(OLD_ROW_WINDOW * 2, "chat"), auditRow(6 * 60, { risk_level: "crisis" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "crisis");
  });

  it("does not carry this surface's own elevated turn back into itself", async () => {
    const rows = [auditRow(5, { risk_level: "elevated", surface: "chat" }), ...turns(3, "chat")];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "none");
  });

  it("still carries another conversational surface's risk", async () => {
    const rows = [...turns(OLD_ROW_WINDOW * 2, "chat"), auditRow(30, { risk_level: "elevated", surface: "voice" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "elevated");
  });

  it("ignores rows older than a day and other participants' rows", async () => {
    const rows = [
      auditRow(25 * 60, { risk_level: "crisis", surface: "journal" }),
      auditRow(10, { risk_level: "crisis", surface: "journal" }, { participant_id: "someone-else" }),
    ];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "none");
  });

  it("excludes this surface in the query itself, before any paging", async () => {
    const client = fakeTable([]);
    await recentDisclosedRisk(client, PARTICIPANT, "chat");
    const names = client.calls.map(([name]) => name);
    assert.ok(names.includes("or"), "the surface filter must be part of the query");
    assert.ok(names.indexOf("or") < names.indexOf("range"));
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

describe("recentDisclosedRisk — a third surface must not crowd the window out (#529)", () => {
  /*
   * #373 removed the caller's own surface from the count. There are three
   * surfaces, so that left the same failure one surface over: with a cap of
   * twenty recent rows, twenty `voice` turns at "none" pushed a morning
   * `journal` crisis out of a `chat` turn's view. Both directions are pinned
   * here, at the old boundary and well past it.
   */
  it("carries a journal crisis into chat however many voice turns came after it", async () => {
    for (const count of [OLD_ROW_WINDOW - 1, OLD_ROW_WINDOW, OLD_ROW_WINDOW * 3]) {
      const rows = [...turns(count, "voice"), auditRow(6 * 60, { risk_level: "crisis", surface: "journal" })];
      assert.equal(
        await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"),
        "crisis",
        `${count} voice turns hid the journal crisis from chat`,
      );
    }
  });

  it("carries a journal elevated into voice however many chat turns came after it", async () => {
    const rows = [...turns(OLD_ROW_WINDOW * 3, "chat"), auditRow(6 * 60, { risk_level: "elevated", surface: "journal" })];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "voice"), "elevated");
  });

  it("takes the highest band, not the most recent one", async () => {
    const rows = [
      auditRow(6 * 60, { risk_level: "crisis", surface: "journal" }),
      auditRow(5, { risk_level: "elevated", surface: "voice" }),
    ];
    assert.equal(await recentDisclosedRisk(fakeTable(rows), PARTICIPANT, "chat"), "crisis");
  });

  it("reads past one page rather than stopping at it", async () => {
    // 520 other-surface rows is more than one 500-row page; the crisis is the
    // oldest, so it only arrives if the second page is read.
    const rows = [...turns(520, "voice"), auditRow(23 * 60, { risk_level: "crisis", surface: "journal" })];
    const client = fakeTable(rows);
    assert.equal(await recentDisclosedRisk(client, PARTICIPANT, "chat"), "crisis");
    assert.ok(client.calls.filter(([name]) => name === "range").length >= 2, "a second page must be requested");
  });

  it("asks for an exact count, so a short page is not read as the end of the table", async () => {
    const client = fakeTable([]);
    await recentDisclosedRisk(client, PARTICIPANT, "chat");
    const [, , options] = client.calls.find(([name]) => name === "select");
    assert.equal(options?.count, "exact");
  });

  it("orders by created_at with the primary key last, so paging cannot skip or repeat", async () => {
    const client = fakeTable([]);
    await recentDisclosedRisk(client, PARTICIPANT, "chat");
    const ordered = client.calls.filter(([name]) => name === "order").map(([, column]) => column);
    assert.deepEqual(ordered, ["created_at", "id"]);
  });

  it("has a row bound well above a day of the write limit", async () => {
    // `RULES.authenticatedWrite` is 600 an hour; a full day of that is 14,400.
    assert.ok(DISCLOSED_RISK_MAX_ROWS > 600 * 24);
  });
});
