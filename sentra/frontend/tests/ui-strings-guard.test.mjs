import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractStrings } from "../scripts/ui-strings.mjs";

/**
 * Tests for the language check's own reader (#534).
 *
 * `i18n.test.mjs` asserts the outcome — no English left in `src` — which is the
 * thing that matters and the thing that cannot tell you *why* it passed. It
 * passed for months with 「Layout is visual; it is not diagnostic.」 in a
 * `<span>` on /graph, because `looksLikeCopy` treated any semicolon as proof of
 * code and returned before the text was ever considered.
 *
 * So the shapes the reader has to get right are pinned here directly, against
 * source written inline. Both directions are load-bearing: a reader that
 * reports nothing passes `i18n.test.mjs` for ever, and a reader that reports
 * statement fragments gets its rule widened back out by the next person who
 * has to make the suite green.
 */

/** The texts `extractStrings` found, for an assertion that reads like the file. */
function texts(source) {
  return extractStrings(source, "probe.tsx").map((entry) => entry.text);
}

describe("the language check's reader", () => {
  describe("reports copy that happens to contain a semicolon", () => {
    it("finds it in JSX text", () => {
      // The exact shape that shipped: prose with a semicolon, inside a span
      // whose className is blanked before the sweep runs.
      const source = `
        export function Notice() {
          return (
            <span className="rounded border border-amber-200 px-3 py-1">
              Layout is visual; it is not diagnostic.
            </span>
          );
        }
      `;
      assert.ok(
        texts(source).includes("Layout is visual; it is not diagnostic."),
        "a sentence with a semicolon in the markup must still be read as copy",
      );
    });

    it("finds it in a quoted literal", () => {
      const source = `const label = "Saved locally; not yet submitted";`;
      assert.ok(texts(source).includes("Saved locally; not yet submitted"));
    });

    it("finds it when the sentence also carries parentheses", () => {
      // Parentheses are deliberately not evidence of code: a sentence uses them
      // too, and no statement fragment the sweep picks up relies on them alone.
      const source = `
        <p>
          Submitted (local time); the research day is counted in JST.
        </p>
      `;
      assert.ok(texts(source).includes("Submitted (local time); the research day is counted in JST."));
    });
  });

  describe("does not report statements that the JSX sweep picks up", () => {
    // The sweep reads the run between a closing `}` and the next `<`. On a
    // component that closes a hook before its `return (`, that run is code.
    const fragments = [
      // The commonest shape: the tail of a useCallback/useMemo, then `return (`.
      `
        const handle = useCallback(() => {
          setOpen(true);
        }, []);

        return (
          <p>本文</p>
        );
      `,
      // An assignment on one line, with no newline between it and the markup.
      `
        function View({ runs }) {
          const latest = runs[0];
          return (
            <p>本文</p>
          );
        }
      `,
      // A destructuring tail.
      `
        function View({ overview }) {
          const { title, body } = overview;
          return (
            <p>本文</p>
          );
        }
      `,
    ];

    for (const [index, source] of fragments.entries()) {
      it(`leaves fragment ${index + 1} alone`, () => {
        const reported = texts(source).filter((text) => /[A-Za-z]{2,}/.test(text));
        assert.deepEqual(
          reported,
          [],
          `statement fragments must not be reported as copy:\n${reported.join("\n")}`,
        );
      });
    }

    it("leaves a MIME type alone", () => {
      const source = `const headers = { "content-type": "text/html; charset=utf-8" };`;
      assert.ok(!texts(source).includes("text/html; charset=utf-8"));
    });

    it("leaves an inline boot script alone", () => {
      // `A11Y_BOOT_SCRIPT` in lib/a11y.ts: a template literal of real
      // JavaScript, several lines long, addressed to the browser.
      const source = [
        "export const BOOT = `(function(){try{",
        'var s=JSON.parse(localStorage.getItem("blesc:a11y")||"{}");',
        'var d=document.documentElement.dataset;d.blText=s.text||"m";',
        "}catch(e){}})();`;",
      ].join("\n");
      const reported = texts(source).filter((text) => /[A-Za-z]{2,}/.test(text));
      assert.deepEqual(reported, [], `reported:\n${reported.join("\n")}`);
    });
  });

  describe("keeps the rules it already had", () => {
    it("still reads an arrow function as code", () => {
      const source = `const pick = "value => value.id";`;
      assert.ok(!texts(source).includes("value => value.id"));
    });

    it("still requires a bare literal to read as a phrase", () => {
      // One word in a quoted string could be anything the code needs; one word
      // in the markup is copy by position. Only the second is reported.
      assert.ok(!texts(`const kind = "pending";`).includes("pending"));
      assert.ok(texts(`<p>pending</p>`).includes("pending"));
    });
  });
});
