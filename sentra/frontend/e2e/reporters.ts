/**
 * Where an end-to-end run leaves what somebody has to read afterwards (#545).
 *
 * Lifted out of `playwright.config.ts` for the reason `retentionPurge.ts` was
 * lifted out of its route: the config imports `e2e/env.ts`, which shells out to
 * `supabase status` at module load and throws when the local stack is not
 * running. So the reporter choice could only be exercised by standing up
 * Postgres, nothing did, and it was wrong. This module imports nothing, so
 * `tests/e2e-reporting.test.mjs` can ask it directly.
 *
 * The directory names live here because they are stated twice: once to
 * Playwright, and once to `actions/upload-artifact` in
 * `.github/workflows/research-contracts.yml`. A rename that moved only one of
 * the two would put the uploads back where they started — reporting nothing,
 * and reporting it quietly. The test pins the pair.
 */

/** The `html` reporter's output, relative to the frontend project root. */
export const REPORT_DIR = "playwright-report";

/**
 * `outputDir`: traces, failure screenshots and `error-context.md`.
 *
 * Set explicitly rather than left to Playwright's default, which is this same
 * name. The default is not the problem — being unwritten is: the workflow has
 * to name this directory to upload it, and a default has nowhere to be named
 * from.
 */
export const OUTPUT_DIR = "test-results";

/**
 * The prefix `upload-artifact` needs.
 *
 * Its `path` resolves from the workspace root and ignores the job's
 * `defaults.run.working-directory`, so the workflow cannot use the two names
 * above as they stand.
 */
export const ARTIFACT_ROOT = "sentra/frontend";

/** Where the workflow looks for each one. */
export const REPORT_ARTIFACT_PATH = `${ARTIFACT_ROOT}/${REPORT_DIR}`;
export const OUTPUT_ARTIFACT_PATH = `${ARTIFACT_ROOT}/${OUTPUT_DIR}`;

/**
 * One entry of Playwright's `reporter` array.
 *
 * Restated rather than imported from `@playwright/test`, so this module pulls
 * in nothing and the node test runner can load it. Kept assignable to
 * Playwright's own `ReporterDescription` (`readonly [string] | readonly
 * [string, any]`) — `npm run typecheck` is what holds the two together, since
 * `playwright.config.ts` passes the result straight to `defineConfig`.
 */
export type ReporterDescription = readonly [string] | readonly [string, Record<string, unknown>];

/**
 * The reporters an end-to-end run uses — the same ones on CI and locally.
 *
 * It used to be `process.env.CI ? "list" : [["list"], ["html", …]]`, and
 * `playwright-report/` is written by the `html` reporter alone. So on CI the
 * directory never existed; the `if: failure()` upload found nothing, and
 * `if-no-files-found: ignore` let that pass without a word. A failing
 * enrollment-gate run (#164, the gate enrollment itself waits on) left one
 * screen of `list` output and no trace of the 300-second build-and-serve it
 * takes to reproduce.
 *
 * `list` stays first so the log still reads as a list while the run is going;
 * the reporters are additive, not alternatives.
 *
 * `open: "never"` is what makes `html` safe on CI. Its default (`on-failure`)
 * serves the report and waits, which on a runner is a step that never ends.
 */
export function e2eReporters(): ReporterDescription[] {
  return [
    ["list"],
    ["html", { open: "never", outputFolder: REPORT_DIR }],
  ];
}
