import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  BATCH,
  MAX_ATTEMPTS,
  dispatchAuthorized,
  dispatchSecretConfigured,
  runSafetyDispatch,
} from "../src/lib/server/safetyDispatch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, path), "utf8");

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const NO_SECRETS = { SAFETY_DISPATCH_TOKEN: undefined, CRON_SECRET: undefined };
const NO_CHANNELS = {
  SAFETY_ALERT_WEBHOOK_URL: undefined,
  RESEND_API_KEY: undefined,
  SAFETY_ALERT_EMAIL_FROM: undefined,
};

describe("who may trigger a dispatch", () => {
  it("refuses everything when no secret is configured", () => {
    // An unauthenticated dispatcher is a way to make this deployment send mail
    // on command, so "not configured" means "closed", never "open".
    withEnv(NO_SECRETS, () => {
      assert.equal(dispatchAuthorized("Bearer anything"), false);
      assert.equal(dispatchAuthorized(null), false);
      assert.equal(dispatchSecretConfigured(), false);
    });
  });

  it("accepts SAFETY_DISPATCH_TOKEN", () => {
    withEnv({ ...NO_SECRETS, SAFETY_DISPATCH_TOKEN: "s3cret-token" }, () => {
      assert.equal(dispatchAuthorized("Bearer s3cret-token"), true);
      assert.equal(dispatchSecretConfigured(), true);
    });
  });

  /*
   * The bug this file exists for. A Vercel cron presents `Bearer $CRON_SECRET`
   * — the name belongs to the platform, not to us — and the endpoint used to
   * compare only against SAFETY_DISPATCH_TOKEN. An operator who configured the
   * cron exactly as documented got a 403 every five minutes and a green cron
   * dashboard, so nothing retried a crisis escalation and nothing said so.
   */
  it("accepts CRON_SECRET, which is the name a Vercel cron presents", () => {
    withEnv({ ...NO_SECRETS, CRON_SECRET: "vercel-cron-secret" }, () => {
      assert.equal(dispatchAuthorized("Bearer vercel-cron-secret"), true);
      assert.equal(dispatchSecretConfigured(), true);
    });
  });

  it("accepts either when both are set, and neither value for the other", () => {
    withEnv({ SAFETY_DISPATCH_TOKEN: "token-a", CRON_SECRET: "token-b" }, () => {
      assert.equal(dispatchAuthorized("Bearer token-a"), true);
      assert.equal(dispatchAuthorized("Bearer token-b"), true);
      assert.equal(dispatchAuthorized("Bearer token-c"), false);
    });
  });

  it("rejects a wrong secret, a missing scheme and an empty bearer", () => {
    withEnv({ ...NO_SECRETS, SAFETY_DISPATCH_TOKEN: "s3cret-token" }, () => {
      assert.equal(dispatchAuthorized("Bearer wrong"), false);
      assert.equal(dispatchAuthorized("s3cret-token"), false);
      assert.equal(dispatchAuthorized("Basic s3cret-token"), false);
      assert.equal(dispatchAuthorized("Bearer "), false);
      assert.equal(dispatchAuthorized(null), false);
    });
  });

  it("rejects a prefix of the secret", () => {
    // The length is compared before `timingSafeEqual`, which throws on a
    // mismatch. A prefix must be refused, not crash the endpoint.
    withEnv({ ...NO_SECRETS, SAFETY_DISPATCH_TOKEN: "s3cret-token" }, () => {
      assert.equal(dispatchAuthorized("Bearer s3cret"), false);
      assert.equal(dispatchAuthorized("Bearer s3cret-token-and-more"), false);
    });
  });
});

/**
 * A fake Supabase client that answers the queue query, the participant lookup
 * and the two counts, and records the updates the delivery writes back.
 */
function fakeClient({ queue = [], participants = [], stuck = 0 } = {}) {
  const calls = { selects: [], updates: [], inserts: [] };
  return {
    calls,
    rpc(name, args) {
      calls.selects.push({ rpc: name, args });
      return Promise.resolve({ data: [], error: null });
    },
    from(table) {
      const state = { table, filters: {} };
      const builder = {
        select() {
          return builder;
        },
        in(column, values) {
          state.filters[`in:${column}`] = values;
          return builder;
        },
        lt(column, value) {
          state.filters[`lt:${column}`] = value;
          return builder;
        },
        gte(column, value) {
          state.filters[`gte:${column}`] = value;
          calls.selects.push(state);
          return Promise.resolve({ count: stuck, error: null });
        },
        order() {
          return builder;
        },
        limit(n) {
          state.limit = n;
          calls.selects.push(state);
          return Promise.resolve({ data: queue, error: null });
        },
        insert(rows) {
          calls.inserts.push({ table, rows });
          return {
            select: () => ({ single: () => Promise.resolve({ data: null, error: null }) }),
            then: (onFulfilled) => Promise.resolve({ error: null }).then(onFulfilled),
          };
        },
        update(values) {
          calls.updates.push({ table, values });
          return { eq: () => Promise.resolve({ error: null }) };
        },
        then(onFulfilled) {
          // `participants` resolves without a terminal operator.
          calls.selects.push(state);
          return Promise.resolve({ data: participants, error: null }).then(onFulfilled);
        },
      };
      return builder;
    },
  };
}

const OWED = {
  id: "esc-1",
  owner_user_id: "owner-1",
  participant_id: "participant-1",
  risk_level: "crisis",
  reasons: ["explicit_self_harm_statement"],
  surface: "chat",
  detected_at: "2026-09-16T17:02:00.000Z",
  status: "failed",
  attempts: 1,
};

describe("working the queue", () => {
  it("reports nothing attempted on an empty queue", async () => {
    const client = fakeClient({ queue: [] });
    const outcome = await withEnv(NO_CHANNELS, () => runSafetyDispatch(client));
    assert.deepEqual(outcome, {
      attempted: 0,
      delivered: 0,
      failed: 0,
      no_recipient: 0,
      stuck: 0,
    });
  });

  it("asks only for rows still owed, and bounds the batch", async () => {
    const client = fakeClient({ queue: [] });
    await withEnv(NO_CHANNELS, () => runSafetyDispatch(client));
    const query = client.calls.selects.find((call) => call.limit !== undefined);
    assert.deepEqual(query.filters["in:status"], ["pending", "failed"]);
    assert.equal(query.filters["lt:attempts"], MAX_ATTEMPTS);
    assert.equal(query.limit, BATCH);
  });

  it("attempts each owed row and counts what happened", async () => {
    const client = fakeClient({
      queue: [OWED],
      participants: [{ id: "participant-1", code: "2A-08" }],
    });
    const outcome = await withEnv(NO_CHANNELS, () => runSafetyDispatch(client));
    assert.equal(outcome.attempted, 1);
    // No channel is configured in this test, so the row cannot be delivered.
    // What matters here is that it was attempted and its status was written
    // back — the counts are the dispatcher's report, not its judgement.
    assert.equal(outcome.delivered, 0);
    const written = client.calls.updates.find((call) => call.table === "safety_escalations");
    assert.ok(written, "the attempted row's status was written back");
  });

  it("reports rows that have exhausted their attempts", async () => {
    const client = fakeClient({ queue: [], stuck: 3 });
    const outcome = await withEnv(NO_CHANNELS, () => runSafetyDispatch(client));
    assert.equal(outcome.stuck, 3);
  });
});

/*
 * #179. The retry only exists if something runs it, and for this deployment
 * that something is a Vercel cron. Two things made the documented
 * configuration a no-op, and both are cheap to hold still:
 *
 *   - a Vercel cron issues GET, and GET on /api/safety/dispatch is the health
 *     probe, which returns 200 without retrying anything;
 *   - Vercel reads vercel.json from the project's Root Directory, which is
 *     sentra/frontend — not the repository root.
 *
 * Either mistake produces a cron job that shows green forever while no crisis
 * escalation is ever retried. That is the exact failure this test refuses.
 */
describe("the scheduler is actually wired", () => {
  const config = JSON.parse(read("../vercel.json"));

  it("declares a cron for the dispatcher", () => {
    assert.ok(Array.isArray(config.crons) && config.crons.length > 0, "vercel.json declares crons");
  });

  it("points the cron at a path that dispatches, not at the health probe", () => {
    const paths = config.crons.map((job) => job.path);
    assert.ok(
      paths.includes("/api/safety/dispatch/run"),
      "the cron targets /api/safety/dispatch/run",
    );
    assert.ok(
      !paths.includes("/api/safety/dispatch"),
      "the cron does not target /api/safety/dispatch, whose GET only reports counts",
    );
  });

  it("keeps a GET handler on the path the cron calls", () => {
    // A Vercel cron issues GET and nothing else. A run route that only exports
    // POST is a cron that 405s every five minutes.
    const route = read("../src/app/api/safety/dispatch/run/route.ts");
    assert.match(route, /export async function GET\(/);
  });

  it("leaves the health probe a probe", () => {
    // If GET on the dispatch route ever starts retrying, an uptime check pages
    // a school every time it polls.
    const route = read("../src/app/api/safety/dispatch/route.ts");
    const get = route.slice(route.indexOf("export async function GET("));
    assert.ok(!get.includes("runSafetyDispatch"), "GET on the dispatch route does not dispatch");
  });
});
