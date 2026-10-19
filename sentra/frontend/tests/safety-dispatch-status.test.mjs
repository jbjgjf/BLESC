/**
 * `GET /api/safety/dispatch` never reports a failed read as "nothing owed" (#453).
 *
 * The endpoint is what an uptime check polls to see whether crisis
 * notifications are piling up. It used to answer `owed: count ?? 0` without
 * looking at `error`, so a database that could not be read came back as a 200
 * saying the queue was empty. The route is called here with a client whose
 * counts can be made to fail.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient } from "./helpers/route-loader.mjs";

const { NextRequest } = await import("next/server.js");
const { GET } = await import("../src/app/api/safety/dispatch/route.ts");

const TOKEN = "dispatch-token-for-tests";

/**
 * Answers the two head-count queries the route makes. `owed` is the
 * `.in("status", …)` query and `no_recipient` the `.eq("status", …)` one; each
 * is `{ count, error }` as supabase-js returns it.
 */
function countingClient({ owed = { count: 0, error: null }, no_recipient = { count: 0, error: null } } = {}) {
  return {
    from(table) {
      assert.equal(table, "safety_escalations");
      const chain = {
        select: () => chain,
        in: () => Promise.resolve(owed),
        eq: () => Promise.resolve(no_recipient),
      };
      return chain;
    },
  };
}

const call = () =>
  GET(
    new NextRequest("http://localhost/api/safety/dispatch", {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );

let error;
let errors;

beforeEach(() => {
  process.env.SAFETY_DISPATCH_TOKEN = TOKEN;
  process.env.SAFETY_ALERT_WEBHOOK_URL = "https://hooks.example.test/alert";
  error = console.error;
  errors = [];
  console.error = (...args) => errors.push(args.join(" "));
});
afterEach(() => {
  console.error = error;
  setServiceClient(null);
  delete process.env.SAFETY_DISPATCH_TOKEN;
  delete process.env.SAFETY_ALERT_WEBHOOK_URL;
});

describe("GET /api/safety/dispatch", () => {
  it("reports the counts with 200 when both were read", async () => {
    setServiceClient(
      countingClient({ owed: { count: 3, error: null }, no_recipient: { count: 1, error: null } }),
    );
    const response = await call();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { channels: true, owed: 3, no_recipient: 1 });
  });

  it("keeps a real zero as zero", async () => {
    setServiceClient(countingClient());
    const response = await call();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { channels: true, owed: 0, no_recipient: 0 });
    assert.deepEqual(errors, []);
  });

  it("answers 502 with owed: null and the reason when the owed count fails", async () => {
    setServiceClient(
      countingClient({ owed: { count: null, error: { message: "connection reset" } } }),
    );
    const response = await call();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.owed, null, "a failed read must not arrive as 0");
    assert.equal(body.owed_error, "connection reset");
    assert.equal(body.no_recipient, 0);
    assert.equal(body.channels, true, "channels does not depend on the database");
    assert.ok(errors.some((line) => line.includes("owed escalations")));
  });

  it("treats a missing count without an error as unknown too", async () => {
    setServiceClient(countingClient({ no_recipient: { count: null, error: null } }));
    const response = await call();
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.no_recipient, null);
    assert.equal(body.no_recipient_error, "no_count_returned");
    assert.equal(body.owed, 0);
  });

  it("still reports channels: false as a value, not an error", async () => {
    delete process.env.SAFETY_ALERT_WEBHOOK_URL;
    setServiceClient(countingClient());
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).channels, false);
  });

  it("answers 503 when supabase is not configured", async () => {
    setServiceClient(null);
    const response = await call();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { detail: "supabase_not_configured" });
  });

  it("refuses a caller without the token", async () => {
    setServiceClient(countingClient());
    const response = await GET(new NextRequest("http://localhost/api/safety/dispatch"));
    assert.equal(response.status, 403);
  });
});
