import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * The educator surfaces show observations, not classifications (#175).
 *
 * `docs/educator_display_policy.md` decided this on 2026-08-06, and it has now
 * been broken twice — which is the reason this file exists rather than the
 * policy document alone.
 *
 *   1. `PERSIST_ANOMALY_SCORE = False` was added to the FastAPI backend and not
 *      to the Next.js route handler that production actually runs. Scores kept
 *      being written for two months.
 *   2. The rule was applied to `src/app/educator/` (real data) and not to
 *      `src/lib/blesc/` (the demo). `/educator/class` went on painting every
 *      student's cell by risk band — 安定 / 要注意 / 高リスク — and
 *      `/educator/student/[participantId]` went on rendering `anomaly_score`
 *      to two decimal places beside a named student.
 *
 * The policy states the lesson itself: "a policy enforced in one of two
 * implementations is not enforced." A document cannot notice the third time.
 * This sweeps the source, so a band that comes back arrives as a failing test
 * in review rather than as a screenshot in a school.
 *
 * **What this cannot check.** It matches names, not meaning. A band renamed to
 * `LEVELS` with labels 「良好 / 注意」 would pass. It is a tripwire on the known
 * shape of the mistake, not a proof that no classification is rendered — the
 * acceptance criteria in #175 still need a person to look at the screens.
 */

/**
 * What an educator sees. Nothing here may carry a classification or a score.
 */
const EDUCATOR_SURFACES = ["src/app/educator", "src/app/school", "src/components/educator"];

/**
 * The demo data library, swept under a narrower rule.
 *
 * `src/lib/blesc` feeds both the educator demo screens and the student's own
 * screens, and `anomaly_score` legitimately appears in the second: `/insights`
 * and `/timeline` show a student their own reflection signal. The educator
 * display policy is about what *an adult* is shown about *a minor* — it does
 * not say a person may not see their own number.
 *
 * So the band identifiers are banned here and the score is not. The score
 * reaching an educator surface is caught by the sweep above, where it belongs.
 */
const DEMO_LIB = ["src/lib/blesc"];

/**
 * Identifiers that only exist to classify a student.
 *
 * `safety_level` is deliberately absent: it names which deterministic rule in
 * `safety.py` matched, it is always rendered with the matched text and its
 * timestamp beside it, and policy rule 2 is what permits that. The difference
 * is that a rule match can be shown to the student and explained; a band is a
 * verdict with no sentence behind it.
 */
const BAND_IDENTIFIERS = ["RiskBand", "BAND_ORDER", "BANDS", "state_band", "worsening", "improving"];

const SCORE_IDENTIFIERS = ["anomaly_score", "latest_score", "latest_anomaly_score", "hybrid_score"];

/** Labels that classify, or claim a direction of travel for a minor's state. */
const FORBIDDEN_LABELS = [
  "高リスク",
  "要注意",
  "悪化傾向",
  "改善傾向",
  "リスクスコア",
  "リスク判定",
  "危険度",
  "感情が改善",
  "改善が見られません",
  "強い無力感を示す",
];

/** `src/lib/i18n` holds the copy these screens render, so it is swept too. */
const COPY_SOURCES = [...EDUCATOR_SURFACES, ...DEMO_LIB, "src/lib/i18n"];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A directory that does not exist has nothing to violate.
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

/**
 * Source with comments removed.
 *
 * Every removal in #175 left a comment saying what used to be there and why it
 * went, and those comments name the very identifiers this test forbids. Keeping
 * them is the point — a deletion with no record invites the next person to add
 * it back — so the sweep reads code, not prose.
 */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

async function collect(roots) {
  const files = [];
  for (const root of roots) {
    for await (const path of walk(root)) {
      files.push({ path, source: code(await readFile(path, "utf8")) });
    }
  }
  return files;
}

describe("educator display policy", () => {
  it("sweeps a non-empty set of files", async () => {
    // A walk that silently found nothing would make every assertion below pass.
    const surfaces = await collect(EDUCATOR_SURFACES);
    const lib = await collect(DEMO_LIB);
    assert.ok(surfaces.length > 5, `expected the educator surfaces to be swept, found ${surfaces.length} files`);
    assert.ok(lib.length > 2, `expected the demo library to be swept, found ${lib.length} files`);
  });

  it("puts no band or score on an educator surface", async () => {
    const files = await collect(EDUCATOR_SURFACES);
    const offences = [];
    for (const { path, source } of files) {
      for (const identifier of [...BAND_IDENTIFIERS, ...SCORE_IDENTIFIERS]) {
        if (source.includes(identifier)) offences.push(`${path}: ${identifier}`);
      }
    }
    assert.deepEqual(offences, [], `classification reached an educator surface:\n${offences.join("\n")}`);
  });

  it("keeps the band out of the demo data library", async () => {
    const files = await collect(DEMO_LIB);
    const offences = [];
    for (const { path, source } of files) {
      for (const identifier of BAND_IDENTIFIERS) {
        if (source.includes(identifier)) offences.push(`${path}: ${identifier}`);
      }
    }
    assert.deepEqual(offences, [], `a risk band is back in the demo fixtures:\n${offences.join("\n")}`);
  });

  it("shows no classifying or directional label", async () => {
    const files = await collect(COPY_SOURCES);
    const offences = [];
    for (const { path, source } of files) {
      for (const label of FORBIDDEN_LABELS) {
        if (source.includes(label)) offences.push(`${path}: ${label}`);
      }
    }
    assert.deepEqual(offences, [], `a classifying label is rendered:\n${offences.join("\n")}`);
  });

  it("keeps the demo's promise and the demo's screens in agreement", async () => {
    // The demo script tells a school 「リスクの判定は表示しません」 while walking
    // them through these exact screens. If that sentence is edited away, this
    // test should stop vouching for screens nobody is promising anything about.
    const catalogue = await readFile("src/lib/i18n/ja.ts", "utf8");
    assert.ok(
      catalogue.includes("リスクの判定は表示しません"),
      "the demo script no longer promises that no risk judgement is shown; " +
        "if that promise was withdrawn, revisit the screens before this test",
    );
  });

  it("orders the class list by observation time, not by anything inferred", async () => {
    const source = await readFile("src/app/educator/class/page.tsx", "utf8");
    // Ordering is how a classification comes back after the colours are gone:
    // the ranking survives the repaint.
    assert.ok(source.includes("detectedAt"), "the class list should sort on the observation timestamp");
    assert.ok(
      code(source).includes("C.rosterOrder"),
      "the class list must state what it is sorted by; an unexplained order reads as severity",
    );
  });
});
