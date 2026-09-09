/**
 * Where the end-to-end run gets its configuration.
 *
 * The local Supabase stack mints its keys on `supabase start`, so they are read
 * from the CLI at run time rather than written into the repository. They are
 * the published development defaults either way — the point is that nothing in
 * `e2e/` looks like a credential, so nothing here can be mistaken for one or
 * copied into a deployment.
 *
 * The pilot variables are fixed test values. `PILOT_INVITE_HMAC_KEY` has to be
 * the same for the seed (which hashes the codes) and the server (which hashes
 * what the participant types), and a constant is what makes the seeded codes
 * predictable enough to type in a test.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The directory holding `supabase/`, found by walking up from the working
 * directory.
 *
 * Not `import.meta.url`, which is the obvious way to do this and does not
 * work: Playwright transpiles its config and everything the config imports to
 * CommonJS, where `import.meta` is a syntax error. The walk also means the
 * seed can be run from either `frontend/` or `sentra/`.
 */
function findSupabaseWorkdir(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, "supabase", "config.toml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not find supabase/config.toml above ${start}`);
}

const SUPABASE_WORKDIR = findSupabaseWorkdir();

/** 32 bytes, base64. Fixed so seeded invite codes stay reproducible. */
export const INVITE_HMAC_KEY = Buffer.alloc(32, 7).toString("base64");
/** 32 bytes, base64, distinct from the invite key. */
export const RAW_TEXT_KEY = Buffer.alloc(32, 11).toString("base64");

/**
 * A fresh identity for every run.
 *
 * The seed used to delete its study and its accounts and rebuild them. That
 * stops working the moment a run gets far enough to produce enrollment events:
 * `pilot_enrollment_events` carries a `before update or delete` trigger that
 * raises on every attempt, so the cascade from `pilot_studies` (and from
 * `auth.users`) is refused. The audit trail is behaving correctly — an
 * append-only log that a test fixture could truncate would not be one — so the
 * fixture stops trying to delete and takes a new name instead.
 *
 * Runs therefore leave rows behind in the local database. That is what
 * `supabase db reset` is for.
 */
/*
 * Read from the environment first. Playwright runs the tests in worker
 * processes that re-evaluate this module, so a value computed here twice would
 * be two different values — the seed would create `e2e-adult-<a>` and the test
 * would try to log in as `e2e-adult-<b>`. The config publishes the id it
 * computed into `E2E_RUN_ID`, and the workers inherit it.
 */
export const RUN_ID = process.env.E2E_RUN_ID ?? Date.now().toString(36);

export const STUDY_SLUG = `e2e-pilot-${RUN_ID}`;
export const TIMEZONE = "Asia/Tokyo";

function supabaseStatusEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = execFileSync("supabase", ["status", "-o", "env"], {
      cwd: SUPABASE_WORKDIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      "The local Supabase stack is not running. Start it before the e2e run:\n" +
        "  cd sentra && supabase start && supabase db reset\n" +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const values: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const status = supabaseStatusEnv();

export const SUPABASE_URL = status.API_URL;
export const SUPABASE_ANON_KEY = status.ANON_KEY;
export const SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("`supabase status -o env` did not report the local URL and keys.");
}

/** The environment the Next server under test runs with. */
export const serverEnv = {
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PILOT_STUDY_SLUG: STUDY_SLUG,
  PILOT_INVITE_HMAC_KEY: INVITE_HMAC_KEY,
  PILOT_TIMEZONE: TIMEZONE,
  RESEARCH_RAW_TEXT_KEY: RAW_TEXT_KEY,
  // Demo mode and a pilot deployment are mutually exclusive: with both on,
  // `collectionRefusal` refuses everything and every test would fail for a
  // reason that has nothing to do with what it is testing.
  NEXT_PUBLIC_DEMO_MODE: "0",
  // No provider budget is spent by an e2e run.
  USE_MOCK_LLM: "true",
  // Set explicitly, and this one matters more than it looks.
  //
  // `NEXT_PUBLIC_*` values are inlined at build time, and Next reads
  // `.env.local` as well as the real environment. A variable this object does
  // not name is therefore taken from `.env.local` — and the developer's
  // `.env.local` points `NEXT_PUBLIC_API_URL` at the local FastAPI on :8000,
  // which is not running during an e2e run. Every call from the browser then
  // failed with "Failed to fetch", and the tests failed at the first screen
  // that needed the API. The suite under test talks to the Next route
  // handlers, so the base URL is the app's own origin.
  NEXT_PUBLIC_API_URL: "/api",
};
