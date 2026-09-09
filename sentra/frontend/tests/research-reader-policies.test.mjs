import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const POLICIES = fileURLToPath(
  new URL("../../supabase/migrations/20260910010000_research_reader_policies.sql", import.meta.url),
);

const migrationSources = () =>
  readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => ({ name, sql: readFileSync(`${MIGRATIONS_DIR}/${name}`, "utf8") }));

describe("research_reader can actually read what it is granted", () => {
  const sql = readFileSync(POLICIES, "utf8");

  it("admits the role on the tables that hold the research record", () => {
    // The finding: seven tables grant SELECT to `research_reader`, RLS is
    // enabled on all of them, and none had a policy admitting the role — which
    // on PostgreSQL means the grant reads back zero rows. Verified against
    // PostgreSQL 16: 0 rows before this migration, 1 after, with the
    // column-level narrowing still refusing `owner_user_id`.
    for (const table of [
      "research_exports",
      "pilot_studies",
      "pilot_enrollments",
      "pilot_guardian_verifications",
      "pilot_self_reports",
      "pilot_pii_reviews",
    ]) {
      assert.match(sql, new RegExp(`'${table}'`), `${table} is not in the policy list`);
    }
    assert.match(sql, /for select to research_reader using \(true\)/);
  });

  it("leaves the table holding journal text for a person to decide", () => {
    // `entries` grants table-wide SELECT, so a policy there would hand the role
    // every `raw_text_ciphertext` — minors' journal text. That is an expansion
    // of who can reach it, and it belongs to whoever owns the export process,
    // not to a migration fixing a privilege bug.
    const listBlock = sql.slice(sql.indexOf("array["), sql.indexOf("]"));
    assert.doesNotMatch(listBlock, /'entries'/);
  });

  it("no-ops on a table this deployment has not reached", () => {
    // The pilot migrations have already moved timestamps once to avoid
    // colliding with main. Failing on a table that arrives two files later
    // would be worse than skipping and being re-run.
    assert.match(sql, /to_regclass\('public\.' \|\| target\) is null/);
  });

  it("is idempotent", () => {
    assert.match(sql, /drop policy if exists/);
  });
});

describe("every research_reader grant has a policy behind it", () => {
  it("finds no table granted to the role without one, except the documented exclusion", () => {
    // The regression this guards: a future migration adds
    // `grant select ... to research_reader` and stops there, recreating the
    // silent-zero-rows bug on a new table.
    const granted = new Set();
    const admitted = new Set();

    for (const { sql } of migrationSources()) {
      for (const match of sql.matchAll(
        /grant\s+select[^;]*?\s+on\s+public\.([a-z_]+)(?:\s*,\s*public\.([a-z_]+))?[^;]*?to\s+research_reader/gis,
      )) {
        granted.add(match[1]);
        if (match[2]) granted.add(match[2]);
      }
      for (const match of sql.matchAll(/'([a-z_]+)'/g)) {
        if (sql.includes("for select to research_reader")) admitted.add(match[1]);
      }
      for (const match of sql.matchAll(
        /create policy[^;]*?on\s+public\.([a-z_]+)[^;]*?to\s+research_reader/gis,
      )) {
        admitted.add(match[1]);
      }
    }

    assert.ok(granted.size > 0, "expected to find research_reader grants");

    // `entries` is excluded on purpose — see the migration header.
    const missing = [...granted].filter((table) => table !== "entries" && !admitted.has(table));
    assert.deepEqual(missing, [], `granted to research_reader with no policy: ${missing.join(", ")}`);
  });
});
