import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DEMO_ONLY_ROUTES, isDemoOnlyRoute } from "../src/lib/demoOnlyRoutes.ts";

const APP_DIR = "src/app";

/** Every `page.tsx` under `src/app`, as `{ route, source }`. */
function pages(dir = APP_DIR, route = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...pages(path, `${route}/${entry.name}`));
    } else if (entry.name === "page.tsx") {
      found.push({ route: route || "/", source: readFileSync(path, "utf8"), path });
    }
  }
  return found;
}

const readsFixtures = (source) => source.includes("@/lib/blesc/fixtures");
const branchesOnDemoMode = (source) => source.includes("useDemoMode");

describe("isDemoOnlyRoute", () => {
  it("matches a listed route and everything under it", () => {
    assert.equal(isDemoOnlyRoute("/school"), true);
    assert.equal(isDemoOnlyRoute("/educator/alerts"), true);
    assert.equal(isDemoOnlyRoute("/educator/alerts/anything"), true);
  });

  it("does not match a sibling that merely shares a prefix", () => {
    // A raw `startsWith` would hide these by accident.
    assert.equal(isDemoOnlyRoute("/schoolyard"), false);
    assert.equal(isDemoOnlyRoute("/reflection"), false);
    assert.equal(isDemoOnlyRoute("/guardians"), false);
  });

  it("leaves the educator screens that read real data alone", () => {
    assert.equal(isDemoOnlyRoute("/educator"), false);
    assert.equal(isDemoOnlyRoute("/educator/roster"), false);
    assert.equal(isDemoOnlyRoute("/educator/student/[participantId]"), false);
  });

  it("lets the research screens render outside demo mode (#226)", () => {
    // The regression this test exists for: `/research` calls `ApiClient` and
    // Supabase and reads no fixture, but sat behind the demo gate, so every
    // deployment that is not a demo answered it with "この画面はデモ専用です".
    assert.equal(isDemoOnlyRoute("/research"), false);
    assert.equal(isDemoOnlyRoute("/research/world-model"), false);
  });
});

describe("the demo-only list against the pages themselves", () => {
  const all = pages();

  it("finds the app's pages", () => {
    // A traversal that silently found nothing would make everything below pass.
    assert.ok(all.length > 20, `expected the app's pages, found ${all.length}`);
  });

  it("gates every page that can only draw fixed data", () => {
    for (const page of all) {
      if (!readsFixtures(page.source) || branchesOnDemoMode(page.source)) continue;
      assert.equal(
        isDemoOnlyRoute(page.route),
        true,
        `${page.path} renders fixtures unconditionally but ${page.route} is not demo-only`,
      );
    }
  });

  it("gates nothing that reads real data", () => {
    for (const page of all) {
      if (readsFixtures(page.source)) continue;
      assert.equal(
        isDemoOnlyRoute(page.route),
        false,
        `${page.path} reads no fixtures, so ${page.route} must render outside demo mode`,
      );
    }
  });

  it("lists no prefix that has stopped being fixed data", () => {
    for (const route of DEMO_ONLY_ROUTES) {
      const page = all.find((candidate) => candidate.route === route);
      assert.ok(page, `${route} is listed as demo-only but has no page`);
      assert.ok(
        readsFixtures(page.source) && !branchesOnDemoMode(page.source),
        `${route} is listed as demo-only but ${page.path} no longer renders fixtures unconditionally`,
      );
    }
  });
});

describe("the account menu", () => {
  // `AppNav` filters the tab bar through `DEMO_ONLY_NAV_PATHS`, but `MORE_LINKS`
  // — the account menu — is shown to every signed-in user unfiltered. A demo-only
  // route in there is a link that answers "この画面はデモ専用です" in production,
  // which is how #226 stayed invisible: "研究用の記録" pointed at `/research`.
  const nav = readFileSync("src/components/AppNav.tsx", "utf8");
  const block = nav.slice(nav.indexOf("const MORE_LINKS"), nav.indexOf("function isActive"));
  const hrefs = [...block.matchAll(/href:\s*"([^"]+)"/g)].map((match) => match[1]);

  it("reads the links", () => {
    assert.ok(hrefs.length > 0, "MORE_LINKS could not be read from AppNav.tsx");
  });

  it("points every unfiltered link at a screen that renders", () => {
    for (const href of hrefs) {
      assert.equal(isDemoOnlyRoute(href), false, `the account menu links to the demo-only ${href}`);
    }
  });
});
