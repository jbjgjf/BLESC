/**
 * Crawlers are kept off participant and operator URLs (#249).
 *
 * The page census works like `demo-only-routes.test.mjs`: every `page.tsx` and
 * `layout.tsx` is read, and a page that opts into indexing must be listed here.
 * Today none does, so the list is empty and any `index: true` fails.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { PRIVATE_PATHS, robotsPolicy } from "../src/lib/robotsPolicy.ts";

/** Routes allowed to be indexed. Adding one is a decision; write down whose. */
const INDEXABLE = [];

function files(dir, names, route = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...files(path, names, `${route}/${entry.name}`));
    else if (names.includes(entry.name)) found.push({ route: route || "/", path, source: readFileSync(path, "utf8") });
  }
  return found;
}

/** Whether a path is disallowed by a list of prefixes, as a crawler reads it. */
const blocked = (path, disallow) => disallow.some((prefix) => path.startsWith(prefix));

describe("robots.txt (#249)", () => {
  it("disallows everything on a pilot deployment", () => {
    const { rules } = robotsPolicy(true);
    assert.equal(rules.userAgent, "*");
    assert.equal(rules.disallow, "/");
    assert.equal(rules.allow, undefined);
  });

  it("closes the participant, operator and API paths everywhere else", () => {
    const { rules } = robotsPolicy(false);
    for (const path of [
      "/pilot/join", "/pilot/triage", "/pilot/guardian/abc", "/educator", "/educator/roster",
      "/oversight", "/research", "/research/world-model", "/journal", "/chat", "/timeline",
      "/insights", "/graph", "/recall", "/reflect", "/audit", "/sharing", "/support-summary",
      "/evaluation", "/evaluation/runs/1", "/api/health", "/login", "/demo",
    ]) {
      assert.ok(blocked(path, rules.disallow), `${path} is crawlable`);
    }
  });

  it("closes every page the app has except the landing page", () => {
    const { rules } = robotsPolicy(false);
    const pages = files("src/app", ["page.tsx"]).map((page) => page.route);
    assert.ok(pages.length > 20, `expected the app's pages, found ${pages.length}`);
    const open = pages.filter((route) => !blocked(route, rules.disallow));
    assert.deepEqual(open, ["/"]);
  });

  it("is served from the app directory and reads the build's pilot flag", () => {
    const source = readFileSync("src/app/robots.ts", "utf8");
    assert.match(source, /robotsPolicy\(process\.env\.NEXT_PUBLIC_PILOT_MODE === "1"\)/);
    assert.ok(PRIVATE_PATHS.includes("/api/"));
  });
});

describe("the noindex default (#249)", () => {
  it("is set on the root layout", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    assert.match(layout, /robots: \{ index: false, follow: false \}/);
  });

  it("keeps the two pages that already said noindex", () => {
    for (const path of ["src/app/legal/page.tsx", "src/app/pilot/guardian/[token]/page.tsx"]) {
      assert.match(readFileSync(path, "utf8"), /robots: \{ index: false, follow: false \}/, path);
    }
  });

  it("is opened only by pages on the indexable list", () => {
    const opened = files("src/app", ["page.tsx", "layout.tsx"])
      .filter(({ source }) => /index:\s*true/.test(source))
      .map(({ route }) => route);
    assert.deepEqual(opened, INDEXABLE, "a page opted into indexing; list it in INDEXABLE with who decided");
  });
});
