import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * A failed enrollment-gate E2E run leaves something to read (#545).
 *
 * CI used to run the `list` reporter only, so `playwright-report/` was never
 * written, and the failure upload (with `if-no-files-found: ignore`) uploaded
 * nothing without a word. The traces and screenshots in `test-results/` had no
 * upload step at all.
 */

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const config = read("../playwright.config.ts");
const workflow = read("../../../.github/workflows/research-contracts.yml");

describe("E2E failure artifacts", () => {
  it("writes the HTML report in CI as well, not only locally", () => {
    const reporter = config.match(/^\s*reporter:\s*(.+),$/m);
    assert.ok(reporter, "playwright.config.ts no longer declares a reporter");
    assert.doesNotMatch(reporter[1], /process\.env\.CI/, "the reporter differs between CI and local runs again");
    assert.match(reporter[1], /"html"/);
  });

  it("uploads both the report and test-results on failure", () => {
    for (const path of ["sentra/frontend/playwright-report", "sentra/frontend/test-results"]) {
      assert.ok(workflow.includes(`path: ${path}\n`), `no upload step for ${path}`);
    }
  });

  it("does not let a missing artifact pass silently", () => {
    assert.doesNotMatch(workflow, /if-no-files-found:\s*ignore/);
  });
});
