import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { scan, untranslated, MACHINE_MODULES } from "../scripts/ui-strings.mjs";
import { ALLOWLIST } from "../scripts/ui-strings-allowlist.mjs";
import { t } from "../src/lib/i18n/index.ts";

/**
 * The product ships to Japanese schools (#116). Translating every screen once
 * is the easy half; the half that decays is the next screen somebody adds.
 *
 * These tests are that guard. They read the source the way a reader would —
 * what is written in the markup, what is passed as a label — and fail when
 * something reaches a screen in English without a reason recorded next to it.
 */

const UI_ROOTS = ["src"];

describe("Japanese UI", () => {
  it("has no English left where a student or teacher would read it", async () => {
    const leaked = untranslated(await scan(UI_ROOTS), ALLOWLIST);
    const report = leaked.map((entry) => `${entry.file}:${entry.line}  ${JSON.stringify(entry.text)}`);

    assert.deepEqual(
      report,
      [],
      `Untranslated UI text. Move it into src/lib/i18n/ja.ts, or — if it is not read by a person — ` +
        `add it to scripts/ui-strings-allowlist.mjs under the group that says why:\n${report.join("\n")}`,
    );
  });

  it("keeps the allowlist honest", async () => {
    // An allowlist entry that no longer matches anything is a claim about code
    // that has since changed. Left in place it quietly widens the exemption.
    const present = new Set((await scan(UI_ROOTS)).map((entry) => entry.text));
    const stale = ALLOWLIST.filter((entry) => !present.has(entry));

    assert.deepEqual(stale, [], `Allowlist entries that match nothing any more:\n${stale.join("\n")}`);
  });

  it("excuses whole modules only with a reason", () => {
    for (const [file, reason] of Object.entries(MACHINE_MODULES)) {
      assert.ok(reason.trim().length > 10, `${file} is skipped without saying why`);
    }
  });
});

describe("the message catalogue", () => {
  /** Every string the catalogue can produce, with the path that reaches it. */
  function leaves(node, path = "t") {
    if (typeof node === "string") return [[path, node]];
    // A message with a parameter is a function; calling it with placeholder
    // arguments is the only way to see the text around the interpolation.
    if (typeof node === "function") {
      const args = Array.from({ length: node.length }, () => 1);
      return [[`${path}()`, String(node(...args))]];
    }
    if (node && typeof node === "object") {
      return Object.entries(node).flatMap(([key, value]) => leaves(value, `${path}.${key}`));
    }
    return [];
  }

  it("is written in Japanese", () => {
    const entries = leaves(t).map(([path, text]) => ({ file: path, line: 0, kind: "literal", text }));
    const notJapanese = untranslated(entries, ALLOWLIST)
      .filter((entry) => /[A-Za-z]{2,}/.test(entry.text))
      .map((entry) => `${entry.file}  ${JSON.stringify(entry.text)}`);

    assert.deepEqual(notJapanese, [], `Catalogue entries with no Japanese in them:\n${notJapanese.join("\n")}`);
  });

  it("has no empty messages", () => {
    const empty = leaves(t).filter(([, text]) => !text.trim()).map(([path]) => path);
    assert.deepEqual(empty, [], `Empty catalogue entries:\n${empty.join("\n")}`);
  });
});

/**
 * Text an API route produces as data and a screen then renders (#239).
 *
 * `scripts/ui-strings.mjs` skips `src/app/api` as a whole — route handlers
 * mostly answer other programs, and #371 is the work to classify the rest. The
 * crisis card's "Support first" got through that gap: a title the research
 * screen rendered as-is, above a Japanese body. Until #371 lands, the fields a
 * screen renders verbatim are checked here directly.
 */
describe("display text written by API routes (#239)", () => {
  const API = "src/app/api";
  const routes = readdirSync(API, { recursive: true }).filter((path) => path.endsWith("route.ts"));

  it("gives no rendered title or body an English-only literal", () => {
    const found = [];
    for (const path of routes) {
      const source = readFileSync(join(API, path), "utf8");
      for (const match of source.matchAll(/\b(title|body|label):\s*"([^"]*)"/g)) {
        if (/[A-Za-z]{2,}/.test(match[2]) && !/[぀-ヿ一-鿿]/.test(match[2])) found.push(`${path}: ${match[0]}`);
      }
    }
    assert.deepEqual(found, []);
  });

  it("takes the crisis card's title from the catalogue", () => {
    const entries = readFileSync(join(API, "entries/route.ts"), "utf8");
    assert.ok(entries.includes("title: t.safety.crisisCardTitle"));
    assert.ok(!entries.includes("Support first"));
    assert.match(t.safety.crisisCardTitle, /[぀-ヿ一-鿿]/);
  });
});
