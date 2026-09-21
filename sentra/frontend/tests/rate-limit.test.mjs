import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  consumeRateLimit,
  rateLimitHeaders,
  rateLimitSubject,
} from "../src/lib/server/rateLimit.ts";

/**
 * Attempt limits (#234), and the invite gate they exist alongside (#223).
 *
 * The catalogue has carried 「試行回数が多すぎます」 with no path that could
 * produce it. These tests are mostly about the two decisions that are easy to
 * get wrong and invisible once wrong: counting per instance rather than
 * globally, and failing closed when the counter is unreachable.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(resolve(HERE, relative), "utf8");
const code = (relative) =>
  read(relative).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** A Supabase stand-in whose `bump_rate_limit` counts per bucket, as the SQL does. */
function fakeStore({ failing = false } = {}) {
  const counts = new Map();
  return {
    counts,
    rpc(name, args) {
      if (failing) return Promise.resolve({ data: null, error: { message: "unavailable" } });
      assert.equal(name, "bump_rate_limit");
      const key = `${args.p_bucket}@${args.p_window_start}`;
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve({ data: next, error: null });
    },
  };
}

const RULE = { route: "test", limit: 3, windowSeconds: 60 };

describe("counting", () => {
  it("allows up to the limit and refuses after", async () => {
    const store = fakeStore();
    const outcomes = [];
    for (let i = 0; i < 5; i += 1) {
      outcomes.push((await consumeRateLimit(store, RULE, "a:subject")).allowed);
    }
    assert.deepEqual(outcomes, [true, true, true, false, false]);
  });

  it("counts each subject separately", async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(store, RULE, "a:one");
    const other = await consumeRateLimit(store, RULE, "a:two");
    assert.equal(other.allowed, true, "one subject's attempts must not spend another's");
  });

  it("counts each route separately", async () => {
    const store = fakeStore();
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(store, RULE, "a:one");
    const other = await consumeRateLimit(store, { ...RULE, route: "other" }, "a:one");
    assert.equal(other.allowed, true);
  });

  it("starts again in the next window", async () => {
    const store = fakeStore();
    const first = new Date("2026-09-21T10:00:30Z");
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(store, RULE, "a:one", { now: first });
    const blocked = await consumeRateLimit(store, RULE, "a:one", { now: first });
    assert.equal(blocked.allowed, false);

    const next = new Date("2026-09-21T10:01:05Z");
    const allowed = await consumeRateLimit(store, RULE, "a:one", { now: next });
    assert.equal(allowed.allowed, true);
  });

  it("reports how long until the window rolls over", async () => {
    const store = fakeStore();
    const result = await consumeRateLimit(store, RULE, "a:one", {
      now: new Date("2026-09-21T10:00:30Z"),
    });
    assert.equal(result.retryAfterSeconds, 30);
    assert.equal(rateLimitHeaders(result)["retry-after"], "30");
  });
});

describe("when the counter cannot be reached", () => {
  it("allows by default, rather than locking participants out", async () => {
    /*
     * The opposite of `cronAuth.ts`, on purpose. A cron that does not run is a
     * job delayed; a limiter that refuses during a Supabase outage keeps fifty
     * enrolled students out of the study to prevent an abuse that may not be
     * happening. Nothing here is an authorisation check — those are elsewhere
     * and all fail closed.
     */
    const result = await consumeRateLimit(fakeStore({ failing: true }), RULE, "a:one");
    assert.equal(result.allowed, true);
  });

  it("allows when there is no client at all", async () => {
    const result = await consumeRateLimit(null, RULE, "a:one");
    assert.equal(result.allowed, true);
  });

  it("can be asked to fail closed", async () => {
    const result = await consumeRateLimit(fakeStore({ failing: true }), RULE, "a:one", {
      failClosed: true,
    });
    assert.equal(result.allowed, false);
  });
});

describe("who gets counted", () => {
  const request = (headers) => ({ headers: { get: (k) => headers[k] ?? null } });

  it("counts a signed-in user by id", () => {
    const subject = rateLimitSubject(request({}), "user-123");
    assert.equal(subject, "u:user-123");
  });

  it("falls back to the address, hashed", () => {
    const subject = rateLimitSubject(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    assert.match(subject, /^a:[0-9a-f]{24}$/);
    // The counter table is abuse accounting, not a visitor log.
    assert.ok(!subject.includes("203.0.113.9"));
  });

  it("takes the left-most forwarded address", () => {
    const one = rateLimitSubject(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    const two = rateLimitSubject(request({ "x-forwarded-for": "203.0.113.9, 192.0.2.7" }));
    assert.equal(one, two, "a trailing proxy hop must not create a new bucket");
  });

  it("prefers the user id over the address", () => {
    const subject = rateLimitSubject(request({ "x-forwarded-for": "203.0.113.9" }), "user-1");
    assert.equal(subject, "u:user-1");
  });
});

describe("limits are configurable", () => {
  it("every rule reads an environment variable with a documented default", () => {
    const source = code("../src/lib/server/rateLimit.ts");
    for (const name of ["PILOT_INVITE_CHECK_LIMIT", "PILOT_INVITE_REDEEM_LIMIT",
                        "PILOT_GUARDIAN_ISSUE_LIMIT", "EXTERNAL_MODEL_LIMIT"]) {
      assert.ok(source.includes(name), `${name} should be overridable`);
    }
    const runbook = read("../../../docs/pilot/infrastructure-runbook.md");
    for (const name of ["PILOT_INVITE_CHECK_LIMIT", "EXTERNAL_MODEL_LIMIT"]) {
      assert.ok(runbook.includes(name), `${name} should be in the runbook`);
    }
  });

  it("ships defaults well above normal use", async () => {
    // A limit that catches real use is a limit somebody turns off. A student
    // typing a code off a printed sheet gets it wrong once or twice.
    const { RULES } = await import("../src/lib/server/rateLimit.ts");
    assert.ok(RULES.inviteCheck.limit >= 10);
    assert.ok(RULES.inviteRedeem.limit >= 5);
    assert.ok(RULES.externalModel.limit >= 30);
    for (const rule of Object.values(RULES)) {
      assert.ok(rule.windowSeconds > 0 && rule.limit > 0, rule.route);
    }
  });

  it("the store is shared, not per-instance", () => {
    // Vercel shares no memory between instances, so a module-level Map counts
    // per instance and the effective limit is the configured one times however
    // many happen to be warm.
    const source = code("../src/lib/server/rateLimit.ts");
    assert.ok(source.includes("bump_rate_limit"));
    assert.ok(!/new Map\(\)/.test(source), "an in-process Map would not be a limit");
  });

  it("the increment is atomic in SQL", () => {
    const migration = read("../../supabase/migrations/20260921000000_rate_limit_counters.sql");
    // Read-then-write lets two requests both read 4 and both write 5.
    assert.match(migration, /on conflict \(bucket, window_start\) do update/);
  });
});

describe("the routes that carry a limit", () => {
  const limited = [
    ["../src/app/api/chat/route.ts", "externalModel"],
    ["../src/app/api/audio/transcriptions/route.ts", "externalModel"],
    ["../src/app/api/pilot/redeem/route.ts", "inviteRedeem"],
    ["../src/app/api/pilot/guardian/issue/route.ts", "guardianIssue"],
    ["../src/app/api/pilot/invite/check/route.ts", "inviteCheck"],
  ];

  for (const [path, rule] of limited) {
    it(`${path.split("/api/")[1]} uses RULES.${rule}`, () => {
      const source = code(path);
      assert.ok(source.includes(`RULES.${rule}`), `${path} should consume RULES.${rule}`);
      assert.ok(source.includes("429"), `${path} should answer 429 when over`);
    });
  }

  it("answers with the message the catalogue already had", () => {
    // 「試行回数が多すぎます」 has been in `ja.ts` with no path that produced it.
    for (const [path] of limited) {
      assert.ok(read(path).includes("試行回数が多すぎます"), path);
    }
  });
});

describe("the invite gate (#223)", () => {
  const login = read("../src/app/login/page.tsx");
  const check = code("../src/app/api/pilot/invite/check/route.ts");

  it("blocks signup on a pilot deployment until a code is verified", () => {
    assert.match(login, /NEXT_PUBLIC_PILOT_MODE === "1"/);
    assert.match(login, /needsInvite/);
    // Not only by disabling a button: a submit that bypasses the control is
    // stopped in the handler too.
    assert.match(login, /if \(needsInvite\) \{/);
  });

  it("leaves a non-pilot deployment alone", () => {
    // `invitePilot` is false without the variable, so demo, school evaluation
    // and local development keep the signup they have.
    assert.match(login, /const invitePilot = process\.env\.NEXT_PUBLIC_PILOT_MODE === "1"/);
  });

  it("does not consume the invitation when checking it", () => {
    assert.ok(!check.includes("redeem_pilot_invitation"), "checking must not spend a code");
    assert.ok(check.includes("code_hash"));
  });

  it("reuses the existing HMAC verification rather than writing new logic", () => {
    assert.ok(check.includes("hashInviteCode"));
    assert.ok(check.includes("inviteHashingConfigured"));
  });

  it("answers the same way for every kind of bad code", () => {
    /*
     * "expired" would confirm the code existed, which turns a guess into a
     * probe. The route computes one boolean from all five conditions rather
     * than branching per reason, and the message the participant sees says
     * only that the code cannot be used.
     */
    assert.ok(check.includes("const valid = Boolean("), "one boolean, not a branch per reason");
    assert.equal((check.match(/valid: false/g) ?? []).length, 1,
      "more than one early `valid: false` return would be a reason-specific path");

    const message = read("../src/lib/i18n/ja.ts")
      .split("inviteInvalid:")[1].split("\n")[1];
    for (const leak of ["期限", "失効", "使用済", "取り消"]) {
      assert.ok(!message.includes(leak), `the message names why: ${leak}`);
    }
  });

  it("refuses rather than guesses when the HMAC key is missing", () => {
    // Answering `false` would tell a participant holding a good code it is bad.
    assert.ok(check.includes("503"));
  });
});
