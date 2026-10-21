import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recordEscalation } from "../../frontend/src/lib/server/safetyEscalation.ts";
import { SYNTHETIC_ACCOUNTS, loadEnv } from "../src/config.ts";
import { RESET_EXCLUSIONS, RESET_TABLES, ResetFailed, provisionAccounts, resetSyntheticData } from "../src/provision.ts";
import { FakeSupabase } from "./fakes/supabase.ts";
import { readSchema } from "./support/migrations.ts";

describe("synthetic account contract", () => {
  it("provisions exactly 28 students, 4 counselors, 1 reviewer on .invalid", () => {
    assert.equal(SYNTHETIC_ACCOUNTS.students.length, 28);  // 20 English + 8 Japanese
    assert.equal(SYNTHETIC_ACCOUNTS.counselors.length, 4);
    for (const email of [...SYNTHETIC_ACCOUNTS.students, ...SYNTHETIC_ACCOUNTS.counselors, SYNTHETIC_ACCOUNTS.reviewer]) {
      assert.ok(email.endsWith("@synthetic.blesc.invalid"), email);
    }
    assert.equal(SYNTHETIC_ACCOUNTS.students[0], "student-01@synthetic.blesc.invalid");
    assert.equal(SYNTHETIC_ACCOUNTS.students[19], "student-20@synthetic.blesc.invalid");
    assert.equal(SYNTHETIC_ACCOUNTS.orgName, "BLESC Evaluation Lab");
  });

  it("answers the question it was asked when another variable is also missing", () => {
    const prior = process.env.EVAL_SUPABASE_URL;
    const priorKey = process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    // Deleted on purpose: the guard has to answer the question it was asked
    // even when an unrelated variable is also missing (#181). With the check at
    // the end of `loadEnv`, this environment answered "no OpenAI key" and said
    // nothing about being pointed somewhere it must not write.
    delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    // A placeholder, not the production ref. `assertTargetAllowed` is an
    // allowlist compared by exact host, so any host outside
    // `ALLOWED_SUPABASE_HOSTS` proves the same thing — naming the real
    // production project added no test power and committed its ref to a public
    // repository (#479).
    process.env.EVAL_SUPABASE_URL = "https://not-on-the-allowlist.supabase.co";
    try {
      assert.throws(() => loadEnv(), /Refusing to run evaluation/i);
    } finally {
      if (priorKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = priorKey;
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });

  it("refuses any Supabase project that is not on the allowlist", () => {
    /*
     * The case the old denylist missed (#187). #166 stands up a brand-new
     * Supabase for the pilot; its ref is not the one the denylist named, so
     * `reset` would have run against a project holding participant data.
     */
    const prior = process.env.EVAL_SUPABASE_URL;
    const cases = [
      "https://brandnewpilotref.supabase.co",
      "https://staging-somewhere.supabase.co",
      // Substring matching would have let these through.
      "https://127.0.0.1.attacker.example",
      "https://vkrhcctlbdjlhtbninsd.supabase.co.evil.test",
    ];
    try {
      for (const url of cases) {
        process.env.EVAL_SUPABASE_URL = url;
        assert.throws(() => loadEnv(), /Refusing to run evaluation/i, url);
      }
    } finally {
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });

  it("allows the local stack and the dedicated evaluation project", () => {
    const prior = process.env.EVAL_SUPABASE_URL;
    const priorKey = process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
    process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = "test-key";
    try {
      for (const url of [
        "http://127.0.0.1:54321",
        "http://localhost:54321",
        "https://vkrhcctlbdjlhtbninsd.supabase.co",
      ]) {
        process.env.EVAL_SUPABASE_URL = url;
        assert.doesNotThrow(() => loadEnv(), url);
      }
    } finally {
      if (priorKey === undefined) delete process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY;
      else process.env.BLESC_EVAL_RUNNER_OPENAI_API_KEY = priorKey;
      if (prior === undefined) delete process.env.EVAL_SUPABASE_URL;
      else process.env.EVAL_SUPABASE_URL = prior;
    }
  });
});

describe("reset covers the schema (#375)", () => {
  const schema = readSchema();
  const reset = new Set<string>(RESET_TABLES);
  const excluded = new Set(Object.keys(RESET_EXCLUSIONS));

  it("finds the owner-scoped tables in the migrations at all", () => {
    // Guards the reader: if it ever parses nothing, the checks below are vacuous.
    assert.ok(schema.ownerScoped.size >= 30, `only ${schema.ownerScoped.size} owner-scoped tables found`);
    assert.ok(schema.ownerScoped.has("safety_escalations") && schema.ownerScoped.has("entries"));
  });

  it("resets or explicitly excludes every table with owner_user_id — a new one fails here", () => {
    const unaccounted = [...schema.ownerScoped].filter((table) => !reset.has(table) && !excluded.has(table)).sort();
    assert.deepEqual(unaccounted, [], "add each to RESET_TABLES, or to RESET_EXCLUSIONS with the reason");
    const stale = [...reset, ...excluded].filter((table) => !schema.ownerScoped.has(table)).sort();
    assert.deepEqual(stale, [], "listed but no longer an owner-scoped table in the migrations");
    assert.deepEqual([...reset].filter((table) => excluded.has(table)), [], "both reset and excluded");
  });

  it("deletes a child before any parent it references without a cascade", () => {
    const order = new Map(RESET_TABLES.map((table, index) => [table as string, index]));
    for (const fk of schema.foreignKeys) {
      if (fk.onDelete === "cascade" || fk.onDelete === "set null" || fk.child === fk.parent) continue;
      if (!order.has(fk.parent)) continue;
      assert.ok(order.has(fk.child), `${fk.child} blocks deleting ${fk.parent} (${fk.onDelete}, ${fk.file}) but is not reset`);
      assert.ok(order.get(fk.child)! < order.get(fk.parent)!, `${fk.child} must be deleted before ${fk.parent} (${fk.file})`);
    }
  });
});

describe("resetSyntheticData against a fake database (#375)", () => {
  const SYNTHETIC = { id: "u-syn", email: "student-01@synthetic.blesc.invalid" };
  const REAL = { id: "u-real", email: "someone@school.example" };

  function database() {
    const db = new FakeSupabase();
    db.users = [SYNTHETIC, REAL];
    // As in 20260916000000_safety_escalations.sql: one row per participant,
    // level, surface and UTC hour.
    db.rule("safety_escalations", { unique: [["participant_id", "dedupe_key"]] });
    db.rule("educator_access_log", { deny: ["delete"] });
    return db;
  }

  const escalate = (db: FakeSupabase, at: Date) => recordEscalation(db.asClient(), {
    ownerUserId: SYNTHETIC.id, participantId: "p-syn", participantCode: "SYN_01", riskLevel: "crisis", reasons: ["synthetic"], surface: "chat", detectedAt: at,
  });

  it("lets a second run in the same hour record its escalation", async () => {
    const db = database();
    const at = new Date("2026-10-11T03:10:00Z");
    assert.ok(await escalate(db, at), "first run records the escalation");
    // Without a reset the product's dedupe swallows the second one, by design.
    assert.equal(await escalate(db, new Date("2026-10-11T03:40:00Z")), null);
    await resetSyntheticData(db.asClient());
    assert.ok(await escalate(db, new Date("2026-10-11T03:50:00Z")), "after a reset, the same hour records again");
  });

  it("empties every reset table for synthetic accounts only, and leaves the exclusions alone", async () => {
    const db = database();
    for (const table of [...RESET_TABLES, ...Object.keys(RESET_EXCLUSIONS)]) {
      db.seed(table, [{ owner_user_id: SYNTHETIC.id }, { owner_user_id: REAL.id }]);
    }
    const report = await resetSyntheticData(db.asClient());
    for (const table of RESET_TABLES) {
      assert.deepEqual(db.rows(table).map((row) => row.owner_user_id), [REAL.id], table);
    }
    for (const table of Object.keys(RESET_EXCLUSIONS)) assert.equal(db.rows(table).length, 2, table);
    assert.equal(report.deleted.length, RESET_TABLES.length);
    assert.equal(db.calls("educator_access_log", "delete").length, 0, "an append-only table is not even attempted");
    const excluded = report.excluded.map((entry) => entry.table);
    assert.ok(excluded.includes("legal_acceptances") && excluded.includes("educator_access_log"), excluded.join(", "));
  });

  it("reports a missing table instead of calling it wiped", async () => {
    const db = database().rule("pilot_self_reports", { missing: true });
    const report = await resetSyntheticData(db.asClient());
    assert.deepEqual(report.missing, ["pilot_self_reports"]);
    assert.ok(!report.deleted.some((entry) => entry.table === "pilot_self_reports"));
  });

  it("fails, naming the table, when a delete is refused — after trying the rest", async () => {
    const db = database().rule("entries", { deny: ["delete"] });
    await assert.rejects(resetSyntheticData(db.asClient()), (error: unknown) =>
      error instanceof ResetFailed && error.failures.some((failure) => failure.table === "entries")
      && error.report.deleted.some((entry) => entry.table === "chat_sessions"));
  });
});

describe("provisionAccounts against a fake database (#385)", () => {
  it("creates the cohort, a participant per student, the roster, and reviewer access", async () => {
    const db = new FakeSupabase();
    const accounts = await provisionAccounts(db.asClient());
    const everyone = [...SYNTHETIC_ACCOUNTS.students, ...SYNTHETIC_ACCOUNTS.counselors, SYNTHETIC_ACCOUNTS.reviewer];
    assert.deepEqual([...accounts.passwords.keys()], everyone);
    assert.equal(new Set(accounts.passwords.values()).size, everyone.length, "a fresh password per account");
    assert.equal(db.rows("participants").length, SYNTHETIC_ACCOUNTS.students.length);
    assert.deepEqual(db.rows("participants").map((row) => row.code).slice(0, 2), ["SYN_01", "SYN_02"]);
    assert.equal(db.rows("oversight_roster").length, SYNTHETIC_ACCOUNTS.students.length);
    assert.equal(db.rows("organization_members").length, SYNTHETIC_ACCOUNTS.counselors.length);
    assert.equal(db.rows("evaluation_access").length, 1);
    assert.equal(db.rows("organizations").length, 1);
  });

  it("is idempotent: a second run rotates passwords and creates nothing new", async () => {
    const db = new FakeSupabase();
    await provisionAccounts(db.asClient());
    const first = { users: db.users.length, participants: db.rows("participants").length, roster: db.rows("oversight_roster").length };
    await provisionAccounts(db.asClient());
    assert.deepEqual({ users: db.users.length, participants: db.rows("participants").length, roster: db.rows("oversight_roster").length }, first);
    assert.equal(db.passwordWrites.length, first.users * 2, "every existing account had its password rotated");
  });
});
