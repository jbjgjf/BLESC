/**
 * How the five-minute crisis-retry workflow reads the dispatcher's answer (#453).
 *
 * The reading lives inline in `.github/workflows/safety-dispatch.yml`, because
 * that workflow has no checkout and no repository access (#208). So this test
 * lifts the block between the `<<'PY'` / `PY` markers out of the workflow
 * file and runs it — the real code, not a copy — against fixed JSON bodies.
 *
 *   node --test scripts/ci/safety-dispatch-report.test.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const WORKFLOW = resolve(import.meta.dirname, "../../.github/workflows/safety-dispatch.yml");

/** The heredoc body, dedented to where the `PY` terminator sits. */
function reportScript() {
  const lines = readFileSync(WORKFLOW, "utf8").split("\n");
  const start = lines.findIndex((line) => line.trimEnd().endsWith("<<'PY'"));
  assert.ok(start >= 0, "the workflow no longer has a <<'PY' block");
  const end = lines.findIndex((line, index) => index > start && line.trim() === "PY");
  assert.ok(end > start, "the <<'PY' block in the workflow is not terminated");
  const indent = lines[end].length - lines[end].trimStart().length;
  return lines
    .slice(start + 1, end)
    .map((line) => line.slice(Math.min(indent, line.length - line.trimStart().length)))
    .join("\n");
}

const dir = mkdtempSync(join(tmpdir(), "safety-dispatch-report-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const script = join(dir, "report.py");
writeFileSync(script, reportScript());

let fixture = 0;
/** The annotation lines the workflow would print for this response body. */
function report(body) {
  const file = join(dir, `response-${fixture++}.json`);
  writeFileSync(file, JSON.stringify(body));
  return execFileSync("python3", [script, file], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const RUN = { attempted: 2, delivered: 2, failed: 0, no_recipient: 0 };

describe("safety-dispatch workflow: reading stuck and pending", () => {
  it("says nothing when both are zero", () => {
    assert.deepEqual(report({ ...RUN, pending: 0, stuck: 0 }), []);
  });

  it("warns that retries were exhausted when stuck is a positive count", () => {
    const lines = report({ ...RUN, pending: 0, stuck: 2 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^::warning::Some escalations have exhausted their retries/);
    assert.match(lines[0], /\(stuck: 2\)$/);
  });

  it("warns that the count is unknown, with stuck_error, when stuck is null", () => {
    const lines = report({ ...RUN, pending: 0, stuck: null, stuck_error: "connection reset" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^::warning::Could not count escalations/);
    assert.match(lines[0], /stuck_error: connection reset/);
    assert.doesNotMatch(lines[0], /have exhausted their retries/, "null is not 'exhausted'");
  });

  it("treats an absent stuck as unknown rather than zero", () => {
    const lines = report({ ...RUN, pending: 0 });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^::warning::Could not count escalations.*\(stuck: null\)$/);
  });

  it("reads pending the same three ways", () => {
    assert.deepEqual(report({ ...RUN, pending: 0, stuck: 0 }), []);
    assert.match(report({ ...RUN, pending: 4, stuck: 0 })[0], /^::warning::Some escalations reached nobody.*\(pending: 4\)$/);
    const unknown = report({ ...RUN, pending: null, stuck: 0 });
    assert.equal(unknown.length, 1);
    assert.match(unknown[0], /^::warning::The dispatcher did not report how many escalations stayed queued/);
  });

  it("does not take a boolean or a string for a count", () => {
    const lines = report({ ...RUN, pending: "3", stuck: true });
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => /unknown/.test(line)));
  });

  it("keeps a multi-line error inside one annotation", () => {
    const lines = report({ ...RUN, pending: 0, stuck: null, stuck_error: "line one\nline two 100%" });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /line one%0Aline two 100%25/);
  });
});
