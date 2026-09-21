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
  // `AppNav` filters the tab bar through `DEMO_ONLY_NAV_PATHS`. `MORE_LINKS` —
  // the account menu — has no such filter, so a demo-only route listed there is
  // a link that answers "この画面はデモ専用です" in production.
  //
  // That is what `/research` was, and it was papered over at the render site
  // rather than fixed: `MORE_LINKS.filter((link) => demo || link.href !==
  // "/research")` dropped the one link to it outside demo mode, which left the
  // screen unreachable except by typing the URL and hid the gate bug from
  // anyone using the app. Both halves are gone, so both are checked here — the
  // list, and the fact that the render site still renders all of it.
  const nav = readFileSync("src/components/AppNav.tsx", "utf8");
  const declaration = nav.indexOf("const MORE_LINKS");
  const block = nav.slice(declaration, nav.indexOf("function isActive"));
  const hrefs = [...block.matchAll(/href:\s*"([^"]+)"/g)].map((match) => match[1]);

  it("reads the links", () => {
    assert.ok(hrefs.length > 0, "MORE_LINKS could not be read from AppNav.tsx");
  });

  it("lists no link to a screen that will not render", () => {
    for (const href of hrefs) {
      assert.equal(isDemoOnlyRoute(href), false, `the account menu links to the demo-only ${href}`);
    }
  });

  it("renders the whole list, with no path singled out", () => {
    // Anything other than `.map` here is a link being hidden by hand, which is
    // how a route stays unreachable while the list above still looks correct.
    const calls = [...nav.slice(declaration).matchAll(/MORE_LINKS\.(\w+)\(/g)].map((m) => m[1]);
    assert.ok(calls.length > 0, "MORE_LINKS is declared but never rendered");
    assert.deepEqual(
      calls.filter((call) => call !== "map"),
      [],
      `MORE_LINKS is narrowed before rendering (${calls.join(", ")}); hide a route by listing it in DEMO_ONLY_ROUTES instead`,
    );
  });
});
