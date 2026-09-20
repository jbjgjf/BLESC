import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The one invariant that keeps /demo-view navigating client-side (#199).
 *
 * `public/demo-view` is a static export of another branch, checked in as a
 * build artifact. When the router navigates it fetches `<page>.txt` with an
 * `RSC: 1` header, and Vercel answers that request from `<page>.txt.rsc`
 * before it looks at the filesystem. If the twin is missing the fetch 404s and
 * the router silently falls back to a full page load — the demo still works,
 * so nobody notices, which is exactly how it shipped broken in 7bd9ebc and was
 * repaired in 0ad796c.
 *
 * The twins are written by `scripts/build-demo-view.sh` on the source branch
 * and copied here by hand. Nothing else checks that the copy was complete, and
 * 454 pairs is well past the number anyone will eyeball. So this test does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_VIEW = resolve(HERE, "..", "public", "demo-view");

/** Every file under `dir`, relative to it, depth-first. */
function walk(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...walk(join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

describe("the /demo-view RSC twins", () => {
  // The export is a committed artifact, so a checkout either has all of it or
  // none of it. Reading the tree once keeps this to a single pass over 1035
  // files rather than one per assertion.
  const files = statSync(DEMO_VIEW, { throwIfNoEntry: false })?.isDirectory()
    ? new Set(walk(DEMO_VIEW))
    : null;

  it("is present as a committed artifact", () => {
    assert.ok(
      files !== null,
      `public/demo-view is missing. It is checked in, not built here — see ` +
        `scripts/build-demo-view.sh and sentra/docs/demo_and_release_gate.md.`,
    );
  });

  it("gives every exported payload a byte-identical .rsc twin", () => {
    const payloads = [...files].filter((f) => f.endsWith(".txt"));

    // Guards the guard: if the export ever stops emitting `.txt` payloads this
    // test would pass over an empty list and prove nothing.
    assert.ok(
      payloads.length > 0,
      "found no .txt payloads under public/demo-view — has the export format changed?",
    );

    const missing = [];
    const differing = [];
    for (const payload of payloads) {
      const twin = `${payload}.rsc`;
      if (!files.has(twin)) {
        missing.push(payload);
        continue;
      }
      const a = readFileSync(join(DEMO_VIEW, payload));
      const b = readFileSync(join(DEMO_VIEW, twin));
      if (!a.equals(b)) differing.push(payload);
    }

    assert.deepEqual(
      { missing, differing },
      { missing: [], differing: [] },
      "every <page>.txt under public/demo-view needs a byte-identical " +
        "<page>.txt.rsc beside it, or client-side navigation in the demo " +
        "degrades to full page loads. Rebuild the export with " +
        "scripts/build-demo-view.sh rather than patching files by hand.",
    );
  });

  it("has no .rsc file without the payload it was copied from", () => {
    const orphans = [...files]
      .filter((f) => f.endsWith(".rsc"))
      .filter((f) => !files.has(f.slice(0, -".rsc".length)));

    assert.deepEqual(
      orphans,
      [],
      "these .rsc twins have no matching payload, which means the export was " +
        "copied in partially or edited by hand",
    );
  });
});
