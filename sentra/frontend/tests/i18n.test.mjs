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

describe("dates and numbers are formatted for one locale", () => {
  /**
   * `toLocaleDateString()` with no locale asks the runtime what language it is
   * in. On the server that is Node's default and in the browser it is the
   * reader's browser setting, so the same screen renders `Sep 11, 09:14 PM` or
   * 「9月11日 21:14」 depending on where it was rendered. The research screen
   * did exactly that until the display QA opened it (#116).
   *
   * The product has one language. The locale is a decision, not a runtime
   * question, so it is written at every call site.
   */
  it("no call site leaves the locale to the runtime", async () => {
    const { readFile, readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const root = fileURLToPath(new URL("../src", import.meta.url));
    const files = [];
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
      }
    };
    await walk(root);

    // `toLocaleLowerCase` is a string operation, not a display decision.
    const unpinned = /\.toLocale(?!LowerCase|UpperCase)[A-Za-z]*\(\s*(\)|undefined|\{)/;
    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (unpinned.test(line)) {
          offenders.push(`${path.relative(root, file)}:${index + 1}  ${line.trim().slice(0, 80)}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `A locale is left to the runtime here. Pass "ja-JP" explicitly:\n${offenders.join("\n")}`,
    );
  });
});
