/**
 * The two routes #234's limits missed, called (#246, #253), and a census of
 * every API route so a fourth one cannot be added without the question being
 * asked.
 *
 * The handlers are imported and invoked — `route-loader.mjs` resolves their
 * imports and hands them an in-memory Supabase — so "the limit runs before the
 * token is looked up" is observed as "no table was touched", not inferred from
 * the order of lines in a file.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient, setSignedInUser } from "./helpers/route-loader.mjs";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const { NextRequest } = await import("next/server.js");
const { RULES } = await import("../src/lib/server/rateLimit.ts");
const { generateGuardianToken, hashGuardianToken } = await import("../src/lib/server/guardianTokens.ts");
const { LEGAL_ENACTED_VERSION } = await import("../src/lib/legalEnactment.ts");
const confirm = await import("../src/app/api/pilot/guardian/confirm/route.ts");
const acceptance = await import("../src/app/api/legal/acceptance/route.ts");

const TOO_MANY = "試行回数が多すぎます。しばらく待ってからもう一度お試しください。";

/** `bump_rate_limit` as the SQL function behaves: one counter per bucket and window. */
function counter() {
  const counts = new Map();
  return (args) => {
    const key = `${args.p_bucket}|${args.p_window_start}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { data: counts.get(key), error: null };
  };
}

const post = (url, body, address = "203.0.113.7") =>
  new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify(body),
  });

let warn;
let error;
beforeEach(() => {
  warn = console.warn;
  error = console.error;
  console.warn = () => {};
  console.error = () => {};
});
afterEach(() => {
  console.warn = warn;
  console.error = error;
  setServiceClient(null);
  setSignedInUser(null);
  for (const key of ["PILOT_GUARDIAN_HMAC_KEY", "NEXT_PUBLIC_LEGAL_ENACTED", "NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE"]) {
    delete process.env[key];
  }
});

describe("POST /api/pilot/guardian/confirm (#246)", () => {
  const VERIFICATIONS = "pilot_guardian_verifications";
  let service;
  let token;

  beforeEach(() => {
    process.env.PILOT_GUARDIAN_HMAC_KEY = Buffer.alloc(32, 3).toString("base64");
    token = generateGuardianToken();
    service = fakeSupabase({
      rpc: { bump_rate_limit: counter() },
      tables: {
        [VERIFICATIONS]: [
          {
            id: "verification-1",
            enrollment_id: "enrollment-1",
            token_hash: hashGuardianToken(token),
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
            claimed_at: null,
            decision: null,
            revoked_at: null,
          },
        ],
      },
    });
    setServiceClient(service);
  });

  const answer = (body, address) => confirm.POST(post("/api/pilot/guardian/confirm", body, address));
  const tableCalls = () => service.calls.filter((call) => call.table === VERIFICATIONS).length;

  it("lets a guardian answer, and reopen the link afterwards, without meeting the limit", async () => {
    const first = await answer({ token, decision: "declined" });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { status: "recorded", decision: "declined" });

    for (let visit = 0; visit < 5; visit += 1) {
      const again = await answer({ token, decision: "declined" });
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { status: "already_decided", decision: "declined" });
    }
  });

  it("refuses past the limit before the token is looked up", async () => {
    const unknown = () => answer({ token: generateGuardianToken(), decision: "confirmed" });
    for (let attempt = 0; attempt < RULES.guardianConfirm.limit; attempt += 1) {
      assert.equal((await unknown()).status, 404);
    }
    const lookups = tableCalls();

    const refused = await unknown();
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { detail: TOO_MANY, code: "rate_limited" });
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    assert.equal(refused.headers.get("x-ratelimit-limit"), String(RULES.guardianConfirm.limit));
    assert.equal(refused.headers.get("x-ratelimit-remaining"), "0");
    assert.equal(tableCalls(), lookups, "the database was asked about a token after the limit was reached");
  });

  it("gives the same refusal for a real token as for one that does not exist", async () => {
    for (let attempt = 0; attempt < RULES.guardianConfirm.limit; attempt += 1) {
      await answer({ token: generateGuardianToken(), decision: "confirmed" });
    }
    const forReal = await answer({ token, decision: "confirmed" });
    const forUnknown = await answer({ token: generateGuardianToken(), decision: "confirmed" });

    assert.equal(forReal.status, 429);
    assert.deepEqual(await forReal.json(), await forUnknown.json());
    assert.equal(service.tables[VERIFICATIONS][0].claimed_at, null, "a refused request claimed the link");
  });

  it("is distinguishable from an unusable link", async () => {
    const unusable = await answer({ token: generateGuardianToken(), decision: "confirmed" });
    assert.equal(unusable.status, 404);
    assert.equal((await unusable.json()).code, "not_found");
  });

  it("counts each address separately", async () => {
    for (let attempt = 0; attempt <= RULES.guardianConfirm.limit; attempt += 1) {
      await answer({ token: generateGuardianToken(), decision: "confirmed" }, "198.51.100.1");
    }
    assert.equal((await answer({ token: generateGuardianToken(), decision: "confirmed" }, "198.51.100.1")).status, 429);
    assert.equal((await answer({ token, decision: "declined" }, "198.51.100.2")).status, 200);
  });

  it("does not spend the counter on input that is not token-shaped", async () => {
    const response = await answer({ token: "not-a-token", decision: "confirmed" });
    assert.equal(response.status, 404);
    assert.equal(service.rpcCalls.length, 0);
    assert.equal(tableCalls(), 0);
  });

  it("still lets the guardian answer when the counter cannot be read", async () => {
    service = fakeSupabase({
      rpc: { bump_rate_limit: () => ({ data: null, error: { message: "counter table unavailable" } }) },
      tables: service.tables,
    });
    setServiceClient(service);
    const response = await answer({ token, decision: "declined" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "recorded", decision: "declined" });
  });
});

describe("POST /api/legal/acceptance (#253)", () => {
  let service;
  let own;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_LEGAL_ENACTED = LEGAL_ENACTED_VERSION;
    process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE = "2026-10-01";
    service = fakeSupabase({ rpc: { bump_rate_limit: counter() } });
    own = fakeSupabase({ defaults: { legal_acceptances: () => ({ accepted_at: "2026-10-10T00:00:00Z" }) } });
    setServiceClient(service);
    setSignedInUser({ id: "user-alice" }, own);
  });

  const accept = (address) => acceptance.POST(post("/api/legal/acceptance", { document_id: "terms" }, address));

  it("is not counted, and writes nothing, for a caller who is not signed in", async () => {
    setSignedInUser(null);
    assert.equal((await accept()).status, 401);
    assert.equal(service.rpcCalls.length, 0);
  });

  it("records an acceptance under the limit", async () => {
    const response = await accept();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "recorded");
    assert.equal(own.tables.legal_acceptances[0].document_version, LEGAL_ENACTED_VERSION);
  });

  it("answers 429 past the limit and stops writing", async () => {
    for (let attempt = 0; attempt < RULES.legalAcceptance.limit; attempt += 1) {
      assert.equal((await accept()).status, 200);
    }
    const written = own.tables.legal_acceptances.length;

    const refused = await accept();
    assert.equal(refused.status, 429);
    assert.deepEqual(await refused.json(), { detail: TOO_MANY, code: "rate_limited" });
    assert.ok(Number(refused.headers.get("retry-after")) > 0);
    assert.equal(refused.headers.get("x-ratelimit-limit"), String(RULES.legalAcceptance.limit));
    assert.equal(own.tables.legal_acceptances.length, written, "an insert was attempted after the limit");
  });

  it("counts the account, not the address it came from", async () => {
    for (let attempt = 0; attempt < RULES.legalAcceptance.limit; attempt += 1) await accept("198.51.100.1");
    assert.equal((await accept("198.51.100.99")).status, 429, "a new address reset the count");

    setSignedInUser({ id: "user-bob" }, own);
    assert.equal((await accept("198.51.100.1")).status, 200, "another account was limited by alice's attempts");
  });

  it("still records when the counter cannot be read", async () => {
    setServiceClient(fakeSupabase({ rpc: { bump_rate_limit: () => ({ data: null, error: { message: "down" } }) } }));
    assert.equal((await accept()).status, 200);
  });
});

describe("the two limits are adjustable per deployment", () => {
  afterEach(() => {
    delete process.env.PILOT_GUARDIAN_CONFIRM_LIMIT;
    delete process.env.LEGAL_ACCEPTANCE_LIMIT;
  });

  it("reads each from its own environment variable, and ignores a value that is not a count", async () => {
    process.env.PILOT_GUARDIAN_CONFIRM_LIMIT = "3";
    process.env.LEGAL_ACCEPTANCE_LIMIT = "abc";
    // The rules are built when the module loads, so load a second copy.
    const reloaded = await import("../src/lib/server/rateLimit.ts?reloaded");
    assert.equal(reloaded.RULES.guardianConfirm.limit, 3);
    assert.equal(reloaded.RULES.legalAcceptance.limit, RULES.legalAcceptance.limit);
  });

  it("is written down where an operator looks", () => {
    const runbook = readFileSync(
      fileURLToPath(new URL("../../../docs/pilot/infrastructure-runbook.md", import.meta.url)),
      "utf8",
    );
    const example = readFileSync(fileURLToPath(new URL("../.env.example", import.meta.url)), "utf8");
    for (const name of ["PILOT_GUARDIAN_CONFIRM_LIMIT", "LEGAL_ACCEPTANCE_LIMIT"]) {
      assert.ok(runbook.includes(`\`${name}\``), `${name} is not in the runbook's table`);
      assert.ok(example.includes(`${name}=`), `${name} is not in .env.example`);
    }
  });
});

/**
 * Every route is either limited, or says why it is not, or is listed as not yet
 * decided. #234 added limits to five routes and three more turned up without
 * one (#240, #246, #253), each found by someone reading. A new `route.ts` that
 * appears in none of the three lists fails here, which is the question being
 * asked at the time the route is written.
 */
describe("every API route has an answer to 'is this limited?'", () => {
  const API = fileURLToPath(new URL("../src/app/api", import.meta.url));
  const routes = readdirSync(API, { recursive: true })
    .filter((path) => path.endsWith("route.ts"))
    .map((path) => relative(API, join(API, path)).replace(/\/route\.ts$/, ""))
    .sort();
  const source = (route) => readFileSync(join(API, route, "route.ts"), "utf8");

  const LIMITED = {
    "audio/transcriptions": "externalModel",
    chat: "externalModel",
    "legal/acceptance": "legalAcceptance",
    "pilot/guardian/confirm": "guardianConfirm",
    "pilot/guardian/issue": "guardianIssue",
    "pilot/invite/check": "inviteCheck",
    "pilot/redeem": "inviteRedeem",
  };

  /** No limit, on purpose, and why. */
  const UNLIMITED_BY_DESIGN = {
    "cron/retention-purge": "called by the scheduler with CRON_SECRET; refuses anyone else before doing work",
    "cron/safety-dispatch": "called by the scheduler with CRON_SECRET; refuses anyone else before doing work",
    "safety/dispatch": "called by the dispatcher with its secret; a limit here would delay an escalation",
  };

  /**
   * Nobody has decided yet. Not a claim that these are fine — a list that is
   * only allowed to shrink. `voice/realtime-session` is #240.
   */
  const UNDECIDED = [
    "consent",
    "entries",
    "entries/followups",
    "health",
    "pilot/admin/invitations",
    "pilot/admin/ops",
    "pilot/enrollment",
    "pilot/guardian",
    "pilot/triage",
    "research/conversation-recall",
    "research/conversation-recall/memory-objects",
    "research/export",
    "research/identity-map",
    "research/pilot-dashboard",
    "research/world-model",
    "voice/realtime-session",
    "voice/turn",
  ];

  it("no route is missing from the three lists, and no list names a route that is gone", () => {
    const classified = [...Object.keys(LIMITED), ...Object.keys(UNLIMITED_BY_DESIGN), ...UNDECIDED].sort();
    assert.deepEqual(classified, routes);
  });

  it("the routes listed as limited consume their rule and can answer 429", () => {
    for (const [route, rule] of Object.entries(LIMITED)) {
      assert.ok(rule in RULES, `RULES.${rule} does not exist`);
      assert.ok(source(route).includes(`RULES.${rule}`), `${route} does not consume RULES.${rule}`);
      assert.ok(source(route).includes("429"), `${route} cannot answer 429`);
    }
  });

  it("a route that gained a limit is moved out of the other lists", () => {
    for (const route of [...Object.keys(UNLIMITED_BY_DESIGN), ...UNDECIDED]) {
      assert.ok(!source(route).includes("consumeRateLimit"), `${route} is limited now; move it to LIMITED`);
    }
  });

  it("every rule has a route", () => {
    assert.deepEqual([...new Set(Object.values(LIMITED))].sort(), Object.keys(RULES).sort());
  });
});
