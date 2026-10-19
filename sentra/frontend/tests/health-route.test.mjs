/**
 * `GET /api/health` answers liveness to anyone and configuration only to an
 * operator (#245).
 *
 * The handler is called through `route-loader.mjs`, so "a stranger does not
 * see `config`" is observed in the response, not read from the source.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setSignedInUser } from "./helpers/route-loader.mjs";

const { NextRequest } = await import("next/server.js");
const health = await import("../src/app/api/health/route.ts");

const get = () => health.GET(new NextRequest("http://localhost/api/health"));

describe("GET /api/health (#245)", () => {
  beforeEach(() => {
    process.env.VERCEL_GIT_COMMIT_SHA = "abcdef1234567890";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role";
    process.env.PILOT_OPERATOR_USER_IDS = "operator-1";
  });
  afterEach(() => {
    setSignedInUser(null);
    for (const key of ["VERCEL_GIT_COMMIT_SHA", "SUPABASE_SERVICE_ROLE_KEY", "PILOT_OPERATOR_USER_IDS"]) {
      delete process.env[key];
    }
  });

  it("answers 200 with status and environment only, to a caller who is not signed in", async () => {
    const response = await get();
    assert.equal(response.status, 200, "an uptime probe must keep seeing 200");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), ["environment", "status"]);
    assert.equal(body.status, "ok");
  });

  it("gives a signed-in account that is not an operator the same public answer", async () => {
    setSignedInUser({ id: "student-1" });
    const body = await (await get()).json();
    assert.equal(body.config, undefined);
    assert.equal(body.commit, undefined);
  });

  it("gives an operator the full self-report", async () => {
    setSignedInUser({ id: "operator-1" });
    const body = await (await get()).json();
    assert.equal(body.status, "ok");
    assert.equal(body.commit, "abcdef1");
    assert.equal(body.config.supabase_service_role_key, true);
    assert.equal(typeof body.config.openai_api_key, "boolean");
    assert.ok(body.config.chat_model);
  });

  it("gives nobody the detail when no operator is configured", async () => {
    delete process.env.PILOT_OPERATOR_USER_IDS;
    setSignedInUser({ id: "operator-1" });
    assert.equal((await (await get()).json()).config, undefined);
  });

  it("never reveals a credential's value, even to an operator", async () => {
    setSignedInUser({ id: "operator-1" });
    const text = await (await get()).text();
    assert.ok(!text.includes("service-role"), "the service-role key itself appeared in the response");
  });
});
