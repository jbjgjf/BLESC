import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractStrings } from "../scripts/ui-strings.mjs";

/**
 * Regression tests for the scanner behind the Japanese UI guard (#534).
 *
 * The guard used to treat any `;` as proof that a string was code, so English
 * copy with a semicolon in it — "Layout is visual; it is not diagnostic." —
 * reached `/graph` without the guard reporting it. These pin both halves of the
 * narrower rule: a mid-sentence semicolon is prose, a statement terminator is
 * code.
 */

const texts = (source) => extractStrings(source, "fixture.tsx").map((entry) => entry.text);

describe("ui-strings scanner: semicolons", () => {
  it("reports English JSX text that contains a semicolon", () => {
    const source = `export function Note() {\n  return (\n    <span className="note">\n      Layout is visual; it is not diagnostic.\n    </span>\n  );\n}\n`;
    assert.ok(texts(source).includes("Layout is visual; it is not diagnostic."));
  });

  it("reports an English literal that contains a semicolon", () => {
    const source = `const label = "Saved; you can close this page.";\n`;
    assert.ok(texts(source).includes("Saved; you can close this page."));
  });

  it("does not report the statements between a hook and the returned markup", () => {
    const source = [
      "export function Page() {",
      "  const ready = useReady();",
      "  useEffect(() => {",
      "    load();",
      "  }, []);",
      "",
      "  return (",
      "    <p>こんにちは</p>",
      "  );",
      "}",
      "",
    ].join("\n");
    const found = texts(source);
    assert.ok(!found.some((text) => /return|load\(\)/.test(text)), `code read as copy: ${JSON.stringify(found)}`);
    assert.ok(found.includes("こんにちは"));
  });

  it("does not report an inline script made of statements", () => {
    const source = 'export const BOOT = `(function(){try{\nvar s=JSON.parse(localStorage.getItem("k")||"{}");\nvar d=document.documentElement.dataset;\n}catch(e){}})();`;\n';
    assert.deepEqual(texts(source), []);
  });

  it("does not report a MIME type with parameters", () => {
    const source = `const headers = { "content-type": "text/html; charset=utf-8" };\n`;
    assert.deepEqual(texts(source), []);
  });

  it("does not report text inside a console call", () => {
    const source = `console.warn("recipient lookup failed; consent was not checked");\n`;
    assert.deepEqual(texts(source), []);
  });
});
