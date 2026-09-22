/**
 * The inventory of outbound AI calls matches the code (DPA / ZDR).
 *
 * `sentra/docs/` carried nothing about DPAs, retraining or Zero Data
 * Retention. The collection-mode gate was built and tested, so the question
 * "does this leave the building" had an answer — but "and what happens to it
 * once it has" was answered only by whatever the provider's default policy
 * happened to say that month.
 *
 * A document alone would go stale the first time someone adds a sixth call
 * site. So the document has a machine-readable twin, and this compares it to
 * the source: every host the code reaches must be a provider in the inventory,
 * and every route that reaches one must be listed as a send point.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const inventory = JSON.parse(readFileSync(here("../../docs/ai-provider-inventory.json"), "utf8"));
const doc = readFileSync(here("../../docs/ai_provider_data_handling.md"), "utf8");
const SRC = here("../src");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Block comments removed; line comments left alone.
 *
 * Stripping `//` here would eat the `//` in `https://api.openai.com` and make
 * every call site invisible — which is exactly the direction this test must not
 * fail in, since an empty result reads as "nothing calls out".
 *
 * `collectionMode.ts` names all five hosts in its own block comment, and that
 * is the only place a host appears outside a real call, so removing block
 * comments is enough.
 */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ");

const HOSTS = Object.values(inventory.providers).map((p) => p.host);
const files = walk(SRC);

/** Files that actually call one of the inventoried hosts. */
const callers = files
  .filter((file) => HOSTS.some((host) => code(readFileSync(file, "utf8")).includes(host)))
  .map((file) => path.relative(here("../"), file).replace(/\\/g, "/"));

describe("the inventory covers the code", () => {
  it("found the call sites at all", () => {
    // Every comparison below is vacuously true against an empty list, so the
    // scan has to prove it found something first. An earlier version of the
    // comment stripper ate `https://` and silently reported a clean bill.
    assert.ok(callers.length >= 4, `expected to find call sites, found ${callers.length}`);
  });

  it("lists every route that reaches a provider", () => {
    const listed = new Set(inventory.send_points.map((p) => p.route));
    const missing = callers.filter((rel) => !listed.has(rel));
    assert.deepEqual(
      missing,
      [],
      "a send point that is not in the inventory is data leaving under a contract nobody checked",
    );
  });

  it("does not list routes that no longer call anything", () => {
    // A stale entry is worse than a missing one here: it says a contract covers
    // traffic that has moved somewhere else.
    const actual = new Set(callers);
    const stale = Array.from(new Set(inventory.send_points.map((p) => p.route))).filter(
      (route) => !actual.has(route),
    );
    assert.deepEqual(stale, []);
  });

  it("names a known provider for every send point", () => {
    for (const point of inventory.send_points) {
      assert.ok(inventory.providers[point.provider], `${point.id} names an unknown provider`);
      assert.ok(
        point.endpoint.includes(inventory.providers[point.provider].host),
        `${point.id}'s endpoint is not on its provider's host`,
      );
    }
  });
});

describe("every send point is gated while there is no contract", () => {
  it("is gated directly, or says in the inventory that it is not", () => {
    // `true` has to be provable from the source. `"indirect"` is allowed but
    // must explain itself, because an indirect gate is one that a second path
    // to the same credential silently removes — which is precisely what would
    // not be noticed without the note.
    for (const point of inventory.send_points) {
      const gate = point.gated_by_collection_mode;
      assert.ok(
        gate === true || gate === "indirect",
        `${point.id} is ungated; with no DPA signed there is nothing else holding it`,
      );

      const source = readFileSync(here(`../${point.route}`), "utf8");
      if (gate === true) {
        assert.match(
          source,
          /collectionOnly|collectionMode/,
          `${point.route} claims a direct gate it does not consult`,
        );
      } else {
        assert.ok(point.gate_note, `${point.id} is indirectly gated and does not say how`);
      }
    }
  });

  it("finds the browser-side call the API scan cannot see", () => {
    // `collection-mode.test.mjs` walks `src/app/api`. A call from a component
    // is outside that walk, so the gate test passes while a student's audio
    // goes straight from the browser to the provider.
    const browserPoints = inventory.send_points.filter((p) => p.runs_in === "browser");
    assert.ok(browserPoints.length > 0, "the inventory must cover client-side sends too");
    for (const point of browserPoints) {
      assert.ok(!point.route.startsWith("src/app/api/"), `${point.id} is not actually client-side`);
    }
  });
});

describe("the contractual status is recorded honestly", () => {
  it("does not claim a DPA or ZDR that has not been signed", () => {
    // The point of this file is to stop "the provider says they do not train on
    // API input" from being written down as if it were a contract.
    for (const [name, provider] of Object.entries(inventory.providers)) {
      assert.equal(typeof provider.dpa_signed, "boolean", `${name}.dpa_signed must be explicit`);
      assert.equal(
        typeof provider.zero_data_retention,
        "boolean",
        `${name}.zero_data_retention must be explicit`,
      );
      assert.ok(provider.training_opt_out, `${name}.training_opt_out must say something`);
    }
  });

  it("the document says what is unsigned, in the document approvers read", () => {
    assert.match(doc, /未締結/);
    assert.match(doc, /未申請/);
    assert.match(doc, /このリポジトリでは閉じられない/);
  });

  it("says plainly who is exposed while it is unsigned", () => {
    // The gate protects pilot participants. It does not protect everyone else,
    // and the document must not let that read as "we are covered".
    assert.match(doc, /収集期間外の一般利用者の本文と音声は、契約の無いまま出ている/);
  });

  it("flags the realtime path as not passing through this server", () => {
    assert.match(doc, /このサーバーを経由しない/);
    assert.match(doc, /一時鍵の取得経路が一つ増えた瞬間に、この封じは外れる/);
  });
});
