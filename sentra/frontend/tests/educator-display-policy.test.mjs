import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The educator surface shows observations, never a risk classification
 * (`docs/educator_display_policy.md` rule 1, #175).
 *
 * This scan exists because the policy has now been broken twice in the same
 * way, and neither time by someone deciding to break it. The first time,
 * `PERSIST_ANOMALY_SCORE = False` was applied to the FastAPI backend and not
 * to the Next.js route handler that production actually uses; scores kept
 * being written for two months. The second time, the display rule was applied
 * to `src/app/educator/` — the real-data screens — and not to the demo screens
 * built from the same fixtures, which went on painting a three-way band over
 * every student in the class.
 *
 * A policy enforced in one of two implementations is not enforced. A review
 * cannot catch the third instance either, because the third instance will also
 * be in the file nobody thought to look at. So the check is a scan over every
 * file, not a test of the screens that exist today.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * The vocabulary of a per-student classification.
 *
 * Each entry is a term plus the files allowed to contain it. Allowances are
 * narrow on purpose: a comment explaining why the band was removed has to be
 * able to name it, but the allowance is a specific path, not a pattern, so a
 * new screen cannot inherit one.
 */
const FORBIDDEN = [
  { term: "RiskBand", allowed: ["lib/blesc/types.ts"] },
  { term: "BAND_ORDER", allowed: [] },
  { term: "BANDS[", allowed: [] },
  // The three band labels, as a student would read them off the screen.
  { term: "高リスク", allowed: [] },
  { term: "悪化傾向", allowed: ["lib/blesc/labels.ts", "lib/i18n/ja.ts"] },
  { term: "改善傾向", allowed: ["lib/blesc/labels.ts", "lib/i18n/ja.ts"] },
];

/**
 * `data-band` is how a classification comes back through CSS rather than
 * through JSX: an attribute on a row plus a rule that colours it. Both halves
 * are checked, because either half alone is inert and looks harmless in review.
 */
const FORBIDDEN_ATTRIBUTE = "data-band";

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe("no risk classification reaches an educator screen", () => {
  it("the band vocabulary appears nowhere outside its documented graves", async () => {
    const files = await sourceFiles(SRC);
    assert.ok(files.length > 50, `found only ${files.length} source files; the scan is not working`);

    const offenders = [];
    for (const file of files) {
      const relative = path.relative(SRC, file).split(path.sep).join("/");
      const source = await readFile(file, "utf8");
      for (const { term, allowed } of FORBIDDEN) {
        if (!source.includes(term)) continue;
        if (allowed.includes(relative)) continue;
        offenders.push(`${relative}: ${term}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `A three-way risk classification is back in the interface:\n  ${offenders.join("\n  ")}\n` +
        "See docs/educator_display_policy.md. Removing the band was arithmetic, not a " +
        "validation deficiency — at 5% prevalence a classifier at 80/90 is wrong about " +
        "seven of every ten students it flags, and a better model does not change that.",
    );
  });

  it("no row is coloured by a band attribute", async () => {
    const files = await sourceFiles(SRC);
    const offenders = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes(FORBIDDEN_ATTRIBUTE)) {
        offenders.push(path.relative(SRC, file).split(path.sep).join("/"));
      }
    }
    assert.deepEqual(offenders, [], `${FORBIDDEN_ATTRIBUTE} found in: ${offenders.join(", ")}`);
  });
});

describe("the demo roster carries no classification", () => {
  it("StudentSummary has no band or trend field", async () => {
    const { CLASS_ROSTER } = await import("../src/lib/blesc/fixtures.ts");

    for (const student of CLASS_ROSTER) {
      assert.equal("band" in student, false, `${student.name} still carries a band`);
      assert.equal("trend" in student, false, `${student.name} still carries a trend`);
    }
  });

  /**
   * Rule 2: an observation an educator cannot trace back to something the
   * student wrote is worse than no observation, so it is not displayed at all.
   * The screen filters on this; the fixture should not need the filter.
   */
  it("every observation in the fixtures carries a time and its reasons", async () => {
    const { CLASS_ROSTER } = await import("../src/lib/blesc/fixtures.ts");

    const observed = CLASS_ROSTER.filter((student) => student.urgent);
    assert.ok(observed.length > 0, "the demo shows no observation at all");

    for (const student of observed) {
      assert.ok(student.urgent.detectedAt, `${student.name}: observation has no timestamp`);
      assert.ok(
        student.urgent.reasons.length > 0,
        `${student.name}: observation has no reasons, so it cannot be shown`,
      );
    }
  });
});
