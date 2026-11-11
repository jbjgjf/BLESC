/**
 * A failing enrollment-gate run has to leave something to read (#545).
 *
 * `pilot-e2e` is the only place #164's gate — the thing that keeps an
 * unenrolled or withdrawn student out of the collection screen — is actually
 * executed. Its reporter was `process.env.CI ? "list" : [["list"], ["html",
 * …]]`, and `playwright-report/` is written by the `html` reporter alone. So on
 * CI the directory never existed, the `if: failure()` upload found nothing, and
 * `if-no-files-found: ignore` let that pass without an annotation. The trace
 * and screenshot that Playwright did write went to `outputDir`, which no step
 * uploaded.
 *
 * Reproduced before the fix, with the old reporter expression and one
 * deliberately failing test:
 *
 *     CI=1  -> playwright-report/: ABSENT   test-results/: PRESENT
 *     (CI unset) -> playwright-report/: PRESENT   test-results/: PRESENT
 *
 * The first two cases below ask `e2eReporters()` directly, which is why it is a
 * module and not an expression inside `playwright.config.ts`: that config
 * imports `e2e/env.ts`, which shells out to `supabase status` at module load
 * and throws when the local stack is not running.
 *
 * The last case is the part worth keeping afterwards. The directory names are
 * stated twice — to Playwright, and to `upload-artifact` — so a rename that
 * moved only one of them would restore exactly the silence this fixes.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  OUTPUT_ARTIFACT_PATH,
  OUTPUT_DIR,
  REPORT_ARTIFACT_PATH,
  REPORT_DIR,
  e2eReporters,
} from "../e2e/reporters.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const withCi = (value, run) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, "CI");
  const previous = process.env.CI;
  if (value === undefined) delete process.env.CI;
  else process.env.CI = value;
  try {
    return run();
  } finally {
    if (had) process.env.CI = previous;
    else delete process.env.CI;
  }
};

const named = (reporters, name) => reporters.filter(([reporter]) => reporter === name);

describe("the end-to-end run reports the same way on CI as locally (#545)", () => {
  it("writes an HTML report whether or not CI is set", () => {
    for (const ci of [undefined, "", "1", "true"]) {
      const reporters = withCi(ci, () => e2eReporters());
      const html = named(reporters, "html");
      assert.equal(
        html.length,
        1,
        `CI=${JSON.stringify(ci)}: exactly one html reporter is what writes ${REPORT_DIR}/`,
      );
      assert.equal(html[0][1]?.outputFolder, REPORT_DIR);
      // Anything else (the default is "on-failure") serves the report and
      // waits, which on a runner is a step that never finishes.
      assert.equal(html[0][1]?.open, "never", `CI=${JSON.stringify(ci)}: html must not try to serve`);
    }
  });

  it("does not branch on CI at all", () => {
    const off = withCi(undefined, () => e2eReporters());
    const on = withCi("1", () => e2eReporters());
    assert.deepEqual(on, off, "the CI run and the local run must produce the same artifacts");
    // `list` stays, and stays first: the log should still read as a list while
    // the run is going. The reporters are additive, not alternatives.
    assert.equal(off[0][0], "list");
  });

  it("names the directories the config uses in the workflow that uploads them", () => {
    const config = read("../playwright.config.ts");
    const workflow = read("../../../.github/workflows/research-contracts.yml");

    // The config must take both names from the module, not restate them.
    assert.match(config, /from "\.\/e2e\/reporters"/);
    assert.match(config, /reporter:\s*e2eReporters\(\)/);
    assert.match(config, /outputDir:\s*OUTPUT_DIR/);

    // `upload-artifact` resolves `path` from the workspace root and ignores the
    // job's `working-directory`, so these are the composed paths.
    assert.equal(REPORT_ARTIFACT_PATH, `sentra/frontend/${REPORT_DIR}`);
    assert.equal(OUTPUT_ARTIFACT_PATH, `sentra/frontend/${OUTPUT_DIR}`);
    for (const path of [REPORT_ARTIFACT_PATH, OUTPUT_ARTIFACT_PATH]) {
      assert.ok(
        workflow.includes(`path: ${path}`),
        `the workflow must upload ${path}; a renamed directory has to be renamed in both places`,
      );
    }

    // An upload that finds nothing is the failure this step exists to report.
    const uploads = workflow
      .split("\n")
      .filter((line) => line.includes("if-no-files-found:"))
      .map((line) => line.trim());
    const e2eUploads = uploads.filter((line) => line.endsWith("warn") || line.endsWith("ignore"));
    assert.ok(e2eUploads.length > 0, "expected the upload steps to state if-no-files-found");
    assert.ok(
      !uploads.some((line) => line.endsWith("ignore")),
      `if-no-files-found: ignore is what let an empty upload pass in silence (found: ${uploads.join(", ")})`,
    );
  });
});
