import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { advisories, evaluate } from "./npm-audit-gate.mjs";

const BRACES = "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm";
const NEXT_RCE = "https://github.com/advisories/GHSA-vcvr-r3jv-pc5j";

// Shaped like `npm audit --json` (auditReportVersion 2) on the tree #337 found.
function report({ withNext = false } = {}) {
  const vulnerabilities = {
    braces: { severity: "high", via: [{ url: BRACES, title: "braces DoS", severity: "high", range: "<=3.0.3" }] },
    micromatch: { severity: "high", via: ["braces"] },
    "fast-glob": { severity: "high", via: ["micromatch"] },
  };
  if (withNext) {
    vulnerabilities.next = { severity: "critical", via: [{ url: NEXT_RCE, title: "RCE in next/og", severity: "critical", range: ">=16.2.0 <16.3.6" }] };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const acceptBraces = [
  { project: "sentra/frontend", package: "braces", advisory: BRACES, dev_only: true, reason: "no fixed release exists; devDependency of eslint only" },
];

// The production tree (`npm audit --omit=dev`) as it is today: braces absent.
const PROD_CLEAN = { vulnerabilities: {} };

describe("npm audit gate", () => {
  it("counts an advisory once, on the package that carries it", () => {
    assert.deepEqual(advisories(report()).map((item) => item.package), ["braces"]);
  });

  it("blocks a high advisory nobody accepted", () => {
    const result = evaluate(report(), [], "sentra/frontend");
    assert.deepEqual(result.blocking.map((item) => item.package), ["braces"]);
  });

  it("lets an accepted advisory through, and only for its own project", () => {
    assert.equal(evaluate(report(), acceptBraces, "sentra/frontend", PROD_CLEAN).blocking.length, 0);
    assert.equal(evaluate(report(), acceptBraces, "sentra/eval", PROD_CLEAN).blocking.length, 1);
  });

  it("still blocks a critical next to an accepted one", () => {
    const result = evaluate(report({ withNext: true }), acceptBraces, "sentra/frontend", PROD_CLEAN);
    assert.deepEqual(result.blocking.map((item) => item.package), ["next"]);
  });

  it("does not block moderate or low advisories", () => {
    const moderate = { vulnerabilities: { qs: { severity: "moderate", via: [{ url: "u", severity: "moderate" }] } } };
    assert.equal(evaluate(moderate, [], "sentra/eval").blocking.length, 0);
  });

  it("reports an accepted entry that matches nothing as stale", () => {
    const result = evaluate({ vulnerabilities: {} }, acceptBraces, "sentra/frontend", PROD_CLEAN);
    assert.equal(result.stale.length, 1);
  });

  it("refuses an acceptance without a reason", () => {
    assert.throws(
      () => evaluate(report(), [{ ...acceptBraces[0], reason: "" }], "sentra/frontend", PROD_CLEAN),
      /no reason/,
    );
  });

  it("refuses an acceptance that does not say whether it is dev-only", () => {
    const { dev_only: _omitted, ...entry } = acceptBraces[0];
    assert.throws(() => evaluate(report(), [entry], "sentra/frontend", PROD_CLEAN), /dev_only/);
  });

  it("stops accepting a dev-only advisory once production reaches it", () => {
    // A production dependency starts pulling in the same vulnerable braces.
    const prod = { vulnerabilities: { braces: report().vulnerabilities.braces } };
    const result = evaluate(report(), acceptBraces, "sentra/frontend", prod);
    assert.deepEqual(result.blocking.map((item) => item.package), ["braces"]);
  });

  it("can accept a production advisory only when the entry says so", () => {
    const prod = { vulnerabilities: { braces: report().vulnerabilities.braces } };
    const anyTree = [{ ...acceptBraces[0], dev_only: false }];
    assert.equal(evaluate(report(), anyTree, "sentra/frontend", prod).blocking.length, 0);
  });

  it("the committed acceptance list is well-formed", () => {
    const { accepted } = JSON.parse(readFileSync(new URL("./npm-audit-accepted.json", import.meta.url), "utf8"));
    assert.ok(Array.isArray(accepted));
    for (const entry of accepted) {
      for (const key of ["project", "package", "advisory", "reason"]) {
        assert.equal(typeof entry[key], "string", `${key} missing on ${JSON.stringify(entry)}`);
      }
      assert.equal(typeof entry.dev_only, "boolean");
      assert.ok(entry.reason.trim().length >= 20);
    }
  });
});
