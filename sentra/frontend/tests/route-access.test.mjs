/**
 * The server-side page gate (#229).
 *
 * `decideAccess` is the whole rule set `src/proxy.ts` applies. It is tested
 * here as a table. The e2e suite checks the same rule through a real build and
 * a real session (`e2e/pilot-join.spec.ts`, "educator screens").
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  decideAccess,
  demoApplies,
  isPublicRoute,
  requiredRole,
  safeNextPath,
} from "../src/lib/routeAccess.ts";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

const PRODUCTION = { nodeEnv: "production" };
const PILOT = { nodeEnv: "production", pilotStudySlug: "pilot-2026", pilotMode: "1" };

const STUDENT = { userId: "student", isEducator: false };
const EDUCATOR = { userId: "teacher", isEducator: true };

function decide(pathname, overrides = {}) {
  return decideAccess({
    pathname,
    search: "",
    env: PRODUCTION,
    demoRequested: false,
    supabaseConfigured: true,
    session: null,
    ...overrides,
  });
}

describe("a session is required, decided on the server", () => {
  it("sends a signed-out visitor to /login, keeping where they were going", () => {
    assert.deepEqual(decide("/educator/roster", { search: "?tab=alerts" }), {
      action: "redirect",
      location: "/login?next=%2Feducator%2Froster%3Ftab%3Dalerts",
    });
    assert.equal(decide("/").action, "redirect");
    assert.equal(decide("/journal").action, "redirect");
  });

  it("lets a signed-in student through to ordinary screens", () => {
    for (const path of ["/", "/journal", "/consent", "/timeline", "/pilot/join"]) {
      assert.deepEqual(decide(path, { session: STUDENT }), { action: "next" }, path);
    }
  });
});

describe("public routes open with no session, as before", () => {
  it("the guardian screen, the legal pages and /login", () => {
    for (const path of ["/login", "/legal", "/legal/terms", "/pilot/guardian", "/pilot/guardian/abc"]) {
      assert.equal(isPublicRoute(path), true, path);
      assert.deepEqual(decide(path), { action: "next" }, path);
    }
  });

  it("the static demo export and its short link, which are not app pages", () => {
    for (const path of ["/demo-view", "/demo-view/chat", "/meet-rusk"]) {
      assert.deepEqual(decide(path), { action: "next" }, path);
      assert.deepEqual(decide(path, { env: PILOT }), { action: "next" }, `${path} (pilot 404s it later)`);
    }
  });

  it("only those: a lookalike prefix is not public", () => {
    assert.equal(isPublicRoute("/legalese"), false);
    assert.equal(isPublicRoute("/pilot/guardianship"), false);
    assert.equal(isPublicRoute("/pilot/join"), false);
  });
});

describe("educator screens are refused before they render", () => {
  it("a signed-in non-educator is sent home, not shown the educator shell", () => {
    assert.deepEqual(decide("/educator/roster", { session: STUDENT }), { action: "redirect", location: "/" });
    assert.deepEqual(decide("/educator", { session: STUDENT }), { action: "redirect", location: "/" });
    assert.deepEqual(decide("/educator/student/abc", { session: STUDENT }), { action: "redirect", location: "/" });
  });

  it("an educator is let through", () => {
    assert.deepEqual(decide("/educator/roster", { session: EDUCATOR }), { action: "next" });
  });

  it("an educator flag missing is not an educator", () => {
    assert.deepEqual(decide("/educator", { session: { userId: "x" } }), { action: "redirect", location: "/" });
  });

  it("a lookalike prefix is not an educator route", () => {
    assert.equal(requiredRole("/educators"), null);
  });
});

describe("operator and research screens follow their API allowlists", () => {
  const env = { ...PRODUCTION, operatorUserIds: "op-1, op-2", researchUserIds: "res-1" };

  it("answers 404 to anyone not on the list, like requireOperator", () => {
    assert.deepEqual(decide("/pilot/triage", { env, session: STUDENT }), { action: "not_found" });
    assert.deepEqual(decide("/research", { env, session: EDUCATOR }), { action: "not_found" });
    assert.deepEqual(decide("/research/world-model", { env, session: { userId: "op-1" } }), {
      action: "not_found",
    });
  });

  it("lets listed users through, whitespace in the list notwithstanding", () => {
    assert.deepEqual(decide("/pilot/triage", { env, session: { userId: "op-2" } }), { action: "next" });
    assert.deepEqual(decide("/research/world-model", { env, session: { userId: "res-1" } }), { action: "next" });
  });

  it("an unset list means nobody, not everybody", () => {
    assert.deepEqual(decide("/pilot/triage", { session: { userId: "op-1" } }), { action: "not_found" });
    assert.deepEqual(decide("/research", { session: { userId: "res-1" } }), { action: "not_found" });
  });
});

describe("demo and local development are unchanged", () => {
  it("next dev passes everything, even on a pilot configuration", () => {
    const env = { ...PILOT, nodeEnv: "development" };
    assert.deepEqual(decide("/educator/roster", { env }), { action: "next" });
    assert.deepEqual(decide("/pilot/triage", { env, session: STUDENT }), { action: "next" });
  });

  it("a demo deployment passes everything", () => {
    const env = { ...PRODUCTION, demoMode: "1" };
    assert.deepEqual(decide("/educator/roster", { env }), { action: "next" });
    assert.deepEqual(decide("/", { env }), { action: "next" });
  });

  it("?demo=1 on an ordinary deployment passes, as the browser-side demo did", () => {
    assert.deepEqual(decide("/educator/roster", { demoRequested: true }), { action: "next" });
  });

  it("a pilot deployment ignores every demo override", () => {
    assert.equal(demoApplies(PILOT, true), false);
    assert.equal(demoApplies({ ...PILOT, demoMode: "1" }, true), false);
    assert.equal(decide("/educator/roster", { env: PILOT, demoRequested: true }).action, "redirect");
  });

  it("with no Supabase there is nothing to verify, and nothing is redirected", () => {
    assert.deepEqual(decide("/educator/roster", { supabaseConfigured: false }), { action: "next" });
  });
});

describe("the `next` a redirected visitor comes back with (#488)", () => {
  const ELSEWHERE = "elsewhere.example";

  it("keeps a path on this site, query and fragment included", () => {
    for (const path of [
      "/",
      "/journal",
      "/educator/roster?tab=alerts",
      "/research/world-model#summary",
      "/pilot/triage?day=3&view=open",
      "/demo-view/meet-rusk",
    ]) {
      assert.equal(safeNextPath(path), path);
    }
  });

  it("refuses anything that leaves this site", () => {
    for (const value of [
      `https://${ELSEWHERE}/`,
      `http://${ELSEWHERE}/`,
      // Protocol-relative: starts with "/" and is still another origin.
      `//${ELSEWHERE}/`,
      `///${ELSEWHERE}/`,
      // A browser reads "\" as "/" in the authority position.
      `/\\${ELSEWHERE}/`,
      `/\\/${ELSEWHERE}/`,
      // Tab, LF and CR are removed from a URL wherever they appear, so each of
      // these is "//elsewhere.example" by the time anything navigates.
      `/\t/${ELSEWHERE}/`,
      `/\n/${ELSEWHERE}/`,
      `/\r/${ELSEWHERE}/`,
      `/\t\\${ELSEWHERE}/`,
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      `${ELSEWHERE}/journal`,
      ` //${ELSEWHERE}/`,
    ]) {
      assert.equal(safeNextPath(value), "/", JSON.stringify(value));
    }
  });

  it("refuses an absent, empty or non-string value", () => {
    for (const value of [null, undefined, "", "   "]) {
      assert.equal(safeNextPath(value), "/");
    }
  });

  it("refuses /login, which is the page that reads it", () => {
    for (const value of ["/login", "/login/", "/login?next=%2Fjournal", "/login/retry"]) {
      assert.equal(safeNextPath(value), "/");
    }
    // Not a prefix match on the string: /loginzzz is an ordinary path.
    assert.equal(safeNextPath("/loginzzz"), "/loginzzz");
  });

  it("round-trips what decideAccess itself writes", () => {
    const decision = decide("/educator/roster", { search: "?tab=alerts" });
    assert.equal(decision.action, "redirect");
    const next = new URL(decision.location, "https://blesc.online").searchParams.get("next");
    assert.equal(safeNextPath(next), "/educator/roster?tab=alerts");
  });

  it("is what both screens reading `next` pass it through", () => {
    for (const file of ["../src/app/login/page.tsx", "../src/components/AuthShell.tsx"]) {
      const source = code(read(file));
      assert.match(source, /safeNextPath\(\s*searchParams\.get\("next"\)\s*\)/, file);
      assert.doesNotMatch(source, /replace\(\s*searchParams\.get\("next"\)/, file);
    }
  });
});

describe("one place per decision", () => {
  const proxy = code(read("../src/proxy.ts"));

  it("the proxy does not re-decide collection; the enrollment gate stays in pilotGate", () => {
    assert.doesNotMatch(proxy, /pilotGate|gateForUser|pilot_enrollments|pilot_collection_open/);
    assert.match(code(read("../src/app/journal/layout.tsx")), /gateForUser\(/);
  });

  it("the proxy's rules are routeAccess's rules", () => {
    assert.match(proxy, /decideAccess\(/);
  });

  it("verifies the session with Supabase rather than trusting the cookie", () => {
    assert.match(proxy, /auth\.getUser\(\)/);
    assert.doesNotMatch(proxy, /getSession\(/);
  });

  it("does not run on API routes, which answer for themselves", () => {
    assert.match(read("../src/proxy.ts"), /\(\?!api\//);
  });

  it("exports the Next 16 convention, not the deprecated one", () => {
    assert.match(proxy, /export async function proxy\(/);
  });
});
