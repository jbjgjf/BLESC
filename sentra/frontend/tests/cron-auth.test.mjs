/**
 * The gate on the scheduled jobs (#204).
 *
 * `authorizedCron` is the only thing standing between the public internet and
 * two endpoints that delete participant text and send mail. It shipped in #179
 * and #185 with no test of any kind, which leaves it able to fail in both
 * directions without anything going red:
 *
 *   too loose — anyone can drive a purge, or make this deployment send;
 *   too tight — every scheduled run 403s, the 90-day retention promise quietly
 *               stops holding, and crisis notifications stop being retried.
 *
 * The second is the one that looks like nothing is wrong.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { authorizedCron, cronSecretConfigured } from "../src/lib/server/cronAuth.ts";
import { purgeExpiredRawText, purgedCount } from "../src/lib/server/retentionPurge.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, path), "utf8");

/**
 * Enough of a request for the thing under test.
 *
 * `authorizedCron` reads exactly one header. A fuller fake would start
 * asserting its own shape rather than the module's behaviour.
 */
const request = (authorization) => ({
  headers: new Headers(authorization === undefined ? {} : { authorization }),
});

/** As in `safety-escalation.test.mjs`: restore the environment after, and await. */
async function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SECRET = "s3cr3t-value-for-the-scheduler";

describe("who may trigger a scheduled job", () => {
  it("accepts the configured bearer token", async () => {
    await withEnv({ CRON_SECRET: SECRET }, () => {
      assert.equal(authorizedCron(request(`Bearer ${SECRET}`)), true);
    });
  });

  it("refuses everything when no secret is configured", async () => {
    /*
     * Fail closed. An endpoint anyone on the internet can fire is a way to
     * drive a purge, or to make this deployment send mail, on command — so
     * "unset" must not mean "unguarded". The cost is that the schedule then
     * silently does nothing, which is why the route logs it and why
     * /api/research/pilot-dashboard reports it (#205).
     */
    await withEnv({ CRON_SECRET: undefined }, () => {
      assert.equal(authorizedCron(request(`Bearer ${SECRET}`)), false);
      assert.equal(authorizedCron(request("Bearer anything")), false);
    });
  });

  it("refuses an empty secret, not just a missing one", async () => {
    // `CRON_SECRET=` in a dashboard is a setting somebody believes they made.
    await withEnv({ CRON_SECRET: "" }, () => {
      assert.equal(authorizedCron(request("Bearer ")), false);
      assert.equal(cronSecretConfigured(), false);
    });
  });

  it("refuses a request with no authorization header", async () => {
    await withEnv({ CRON_SECRET: SECRET }, () => {
      assert.equal(authorizedCron(request(undefined)), false);
    });
  });

  it("refuses a token that is not presented as a bearer", async () => {
    await withEnv({ CRON_SECRET: SECRET }, () => {
      assert.equal(authorizedCron(request(SECRET)), false);
      assert.equal(authorizedCron(request(`Basic ${SECRET}`)), false);
      assert.equal(authorizedCron(request("Bearer")), false);
      assert.equal(authorizedCron(request("Bearer    ")), false);
    });
  });

  it("refuses a wrong token of the same length", async () => {
    // The comparison must actually compare, not merely measure.
    const wrong = `${"x".repeat(SECRET.length - 1)}y`;
    assert.equal(wrong.length, SECRET.length);
    await withEnv({ CRON_SECRET: SECRET }, () => {
      assert.equal(authorizedCron(request(`Bearer ${wrong}`)), false);
    });
  });

  it("refuses a token of a different length without throwing", async () => {
    /*
     * `timingSafeEqual` throws on a length mismatch. If the length check in
     * front of it is ever removed, this stops returning false and starts
     * raising — which, in a route handler, is a 500 rather than a 403, and a
     * 500 is a different and louder kind of wrong.
     */
    await withEnv({ CRON_SECRET: SECRET }, () => {
      assert.equal(authorizedCron(request("Bearer short")), false);
      assert.equal(authorizedCron(request(`Bearer ${SECRET}${SECRET}`)), false);
    });
  });

  it("reports whether the secret is configured at all", async () => {
    await withEnv({ CRON_SECRET: undefined }, () => assert.equal(cronSecretConfigured(), false));
    await withEnv({ CRON_SECRET: SECRET }, () => assert.equal(cronSecretConfigured(), true));
  });
});

describe("the count a purge reports", () => {
  it("passes a real count through", () => {
    assert.equal(purgedCount(0), 0);
    assert.equal(purgedCount(41), 41);
  });

  it("refuses anything that is not a finite count", () => {
    /*
     * The alternative to a number is not a crash. `Number(null)` is 0, and the
     * previous coercion — `typeof data === "number" ? data : 0` — reported
     * every non-number as a purge that ran and found nothing.
     *
     * "Nothing to delete" and "that call did not do what we think it did" must
     * not look identical on the one dashboard whose job is to say whether
     * retained text is being deleted.
     */
    for (const value of [null, undefined, "12", {}, [], NaN, Infinity]) {
      assert.equal(purgedCount(value), null, `${String(value)} is not a count`);
    }
  });
});

describe("purging expired raw text", () => {
  const client = (outcome) => {
    const calls = [];
    return {
      calls,
      rpc(name) {
        calls.push(name);
        return Promise.resolve(outcome);
      },
    };
  };

  it("calls the function the migration granted to service_role", async () => {
    const service = client({ data: 3, error: null });
    const result = await purgeExpiredRawText(service);
    assert.deepEqual(service.calls, ["purge_expired_raw_text"]);
    assert.deepEqual(result, { purged: 3 });
  });

  it("reports a database error rather than a purge of zero", async () => {
    const service = client({ data: null, error: { message: "permission denied" } });
    const result = await purgeExpiredRawText(service);
    assert.deepEqual(result, { error: "permission denied" });
  });

  it("reports a missing count as a failure", async () => {
    // Text the participant was told would be gone is still there; the operator
    // has to hear about it.
    const service = client({ data: null, error: null });
    const result = await purgeExpiredRawText(service);
    assert.ok("error" in result);
  });
});

describe("the routes behind the gate", () => {
  it("both cron routes check authorisation before doing anything", () => {
    for (const path of ["retention-purge", "safety-dispatch"]) {
      const route = read(`../src/app/api/cron/${path}/route.ts`);
      const guard = route.indexOf("if (!authorizedCron(request))");
      const work = route.indexOf("serviceRoleClient()");
      assert.ok(guard !== -1, `${path} does not check authorizedCron`);
      assert.ok(work > guard, `${path} reaches Supabase before checking authorisation`);
      assert.ok(route.includes("status: 403"));
    }
  });

  it("is scheduled at a path that exists", () => {
    // The manifest used to sit at the repository root, where Vercel never read
    // it, naming two routes that did not exist (#179, #185).
    const manifest = JSON.parse(read("../vercel.json"));
    for (const entry of manifest.crons) {
      assert.ok(
        existsSync(resolve(HERE, `../src/app${entry.path}/route.ts`)),
        `${entry.path} is scheduled but has no route`,
      );
    }
  });

  it("keeps the purge call testable outside a Next runtime", () => {
    // If the RPC moves back inline, this file can no longer assert anything
    // about it, which is the state #204 was filed against.
    const route = read("../src/app/api/cron/retention-purge/route.ts");
    assert.ok(route.includes("purgeExpiredRawText"));
    assert.ok(!route.includes('rpc("purge_expired_raw_text")'));
  });
});
