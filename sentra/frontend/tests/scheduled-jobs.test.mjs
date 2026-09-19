/**
 * The scheduled jobs are actually scheduled, and reachable by the scheduler
 * that is configured to call them (#B3).
 *
 * Two failures this locks down, both of which return 200 while doing nothing:
 *
 *   1. `vercel.json` has no `crons` at all. `/api/safety/dispatch` documented
 *      its own cron entry in a comment that nobody had applied, so every failed
 *      crisis notification stayed `pending` forever, and
 *      `purge_expired_raw_text()` — the function that makes the retention
 *      promise true — was called by nothing but the SQL tests.
 *
 *   2. A cron pointed at a POST-only path. Vercel cron sends **GET**, so such
 *      an entry runs the path's GET handler instead. On the dispatcher that is
 *      the read-only health check: a green cron that delivers nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const vercel = JSON.parse(read("../../../vercel.json"));

const JOBS = [
  {
    path: "/api/cron/safety-dispatch",
    route: "../src/app/api/cron/safety-dispatch/route.ts",
    runner: "runSafetyDispatch",
  },
  {
    path: "/api/cron/retention-purge",
    route: "../src/app/api/cron/retention-purge/route.ts",
    runner: "runRetentionPurge",
  },
];

describe("vercel.json schedules the jobs", () => {
  it("has a crons array", () => {
    assert.ok(
      Array.isArray(vercel.crons) && vercel.crons.length > 0,
      "no crons means the retry path and the retention purge never run",
    );
  });

  for (const job of JOBS) {
    it(`schedules ${job.path}`, () => {
      const entry = vercel.crons.find((cron) => cron.path === job.path);
      assert.ok(entry, `${job.path} is not scheduled`);
      assert.match(entry.schedule, /^[\d*/,\- ]+$/, "schedule must be a cron expression");
    });
  }

  it("never points a cron at a path whose work is behind POST", () => {
    // The trap: Vercel cron issues GET. A cron on a POST-only action path runs
    // that path's GET handler, which is by convention the read-only check.
    for (const cron of vercel.crons) {
      const segments = cron.path.replace(/^\//, "").split("/");
      const file = `../src/app/${segments.join("/")}/route.ts`;
      const source = read(file);
      assert.match(
        source,
        /export async function GET\(/,
        `${cron.path} is scheduled but exports no GET; Vercel cron would never reach its work`,
      );
    }
  });
});

describe("the scheduled entry points do the same work as the manual ones", () => {
  for (const job of JOBS) {
    it(`${job.path} calls ${job.runner} from the shared module`, () => {
      const source = read(job.route);
      assert.match(source, new RegExp(`${job.runner}\\b`));
      assert.match(source, /from "@\/lib\/server\/scheduledJobs"/);
    });

    it(`${job.path} refuses without CRON_SECRET`, () => {
      const source = read(job.route);
      assert.match(
        source,
        /bearerAuthorized\(request, "CRON_SECRET"\)/,
        "an unauthenticated scheduled endpoint is a way to trigger this deployment on demand",
      );
    });
  }

  it("keeps the runners in one place", () => {
    const shared = read("../src/lib/server/scheduledJobs.ts");
    assert.match(shared, /export async function runSafetyDispatch/);
    assert.match(shared, /export async function runRetentionPurge/);

    // The manual routes must delegate, not re-implement.
    const dispatch = read("../src/app/api/safety/dispatch/route.ts");
    assert.match(dispatch, /runSafetyDispatch\(service\)/);
    assert.doesNotMatch(
      dispatch,
      /deliverEscalation\(/,
      "the route must delegate to the shared runner, not carry its own copy of the loop",
    );
  });
});

describe("the retention purge is reachable at all", () => {
  it("calls the function that enforces the promise", () => {
    const shared = read("../src/lib/server/scheduledJobs.ts");
    assert.match(
      shared,
      /rpc\("purge_expired_raw_text"\)/,
      "a retention period nothing enforces is a sentence in a document",
    );
  });

  it("can be asked how much is overdue without deleting anything", () => {
    const shared = read("../src/lib/server/scheduledJobs.ts");
    assert.match(shared, /export async function retentionOverdue/);
  });
});

describe("the secrets are documented", () => {
  const env = read("../.env.example");

  it("names CRON_SECRET and RETENTION_PURGE_TOKEN", () => {
    // A deployment that misses these has crons returning 403 on schedule, which
    // looks exactly like a working cron in the Vercel dashboard's green tick.
    assert.match(env, /^CRON_SECRET=/m);
    assert.match(env, /^RETENTION_PURGE_TOKEN=/m);
  });
});
