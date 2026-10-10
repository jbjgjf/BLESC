/**
 * One study period, stated the same way everywhere (#315).
 *
 * The repository said 21 days (14 baseline + 7 observation) while the original
 * Google Doc said 「1ヶ月」, and nothing noticed: the period is written in prose
 * in a dozen documents and as a number in a migration, a seed and the code that
 * sizes the triage queue. The owner settled it at 28 days with no split; this
 * file is what keeps it settled.
 *
 * Two kinds of check:
 *
 *   1. **Agreement.** The protocol, the consent pack, the research explanation
 *      on `/legal` and the `pilot_studies.study_days` default all state the
 *      value in `src/lib/pilotProtocol.ts`.
 *   2. **No leftovers.** No line in the documents and code that describe the
 *      study still states the old period — unless the same line says it is
 *      history, by citing #315 or naming the v2 documents. A revision record
 *      has to be able to say what changed; a current description must not.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  PILOT_MAX_ENTRIES,
  PILOT_PROTOCOL_VERSION,
  PILOT_STUDY_DAYS,
  PILOT_TARGET_PARTICIPANTS,
} from "../src/lib/pilotProtocol.ts";
import { DEFAULT_STUDY_DAYS } from "../src/lib/researchExport.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path) => readFileSync(join(REPO, path), "utf8");

const DAYS = PILOT_STUDY_DAYS;

describe("the period itself", () => {
  it("is 28 days for 50 participants, at most 1,400 entries", () => {
    assert.equal(PILOT_STUDY_DAYS, 28);
    assert.equal(PILOT_TARGET_PARTICIPANTS, 50);
    assert.equal(PILOT_MAX_ENTRIES, 1400);
    assert.equal(PILOT_PROTOCOL_VERSION, "pilot-protocol-v3");
  });

  it("is four whole weeks, so every weekday occurs equally often", () => {
    // The reason 28 was chosen over a calendar month or 30. If this is ever
    // changed to a length that is not a multiple of 7, the protocol's stated
    // rationale stops being true and has to be rewritten with it.
    assert.equal(PILOT_STUDY_DAYS % 7, 0);
  });

  it("is what the export assumes for a study it did not read", () => {
    assert.equal(DEFAULT_STUDY_DAYS, PILOT_STUDY_DAYS);
  });
});

describe("every statement of the period agrees", () => {
  it("the schema default", () => {
    const migration = read("sentra/supabase/migrations/20261004000000_pilot_study_days.sql");
    assert.match(migration, new RegExp(`alter column study_days set default ${DAYS};`));
    const drop = read("sentra/supabase/migrations/20261004000100_drop_pilot_study_split.sql");
    assert.match(drop, /drop column if exists baseline_days/);
    assert.match(drop, /drop column if exists observation_days/);
  });

  it("the protocol", () => {
    const protocol = read("docs/pilot/protocol.md");
    assert.match(protocol, new RegExp(`^# 研究protocol: ${PILOT_TARGET_PARTICIPANTS}名×${DAYS}日`, "m"));
    assert.match(protocol, new RegExp(`改訂案 \`${PILOT_PROTOCOL_VERSION}\``));
    assert.match(protocol, new RegExp(`Day 1-${DAYS} +収集期間（${DAYS}日）`));
    assert.match(protocol, new RegExp(`Day ${DAYS + 1}- +収集終了`));
    assert.match(protocol, /1,400件/);
  });

  it("the consent pack", () => {
    const pack = read("docs/pilot/consent-pack.md");
    assert.match(pack, new RegExp(`（\`${PILOT_PROTOCOL_VERSION}\`）`));
    assert.match(pack, new RegExp(`\\| Day 1–${DAYS} \\| 収集期間`));
    assert.match(pack, new RegExp(`\\| Day ${DAYS + 1}以降 \\| 収集終了`));
    assert.match(pack, new RegExp(`\\| 何をするか \\| 1か月（${DAYS}日間）`));
    assert.match(pack, new RegExp(`本研究の${DAYS}日間、実施者は`));
  });

  it("the research explanation a participant reads on /legal", () => {
    const legal = read("sentra/frontend/src/lib/legalDocuments.ts");
    assert.match(legal, new RegExp(`期間は1か月（${DAYS}日間）です。`));
    assert.match(legal, new RegExp(`この${DAYS}日間はAI抽出`));
    // The sentence #315 asked to delete: it contrasted the plan with a 1-month
    // proposal, which is now the plan.
    assert.doesNotMatch(legal, /企画書とは異なる計画/);
  });

  it("the dry-run seed sets its own length rather than inheriting the pilot's", () => {
    const seed = read("sentra/supabase/seed/pilot_dry_run.seed.sql");
    assert.match(seed, /study_days, is_dry_run/);
  });
});

/*
 * Statements of the pre-#315 period. Each is something a current description
 * of the study could plausibly still say.
 */
const OLD_PERIOD = [
  /21 ?日/,
  /21 days/i,
  /21-day/i,
  /\bday 21\b/i,
  /Day 1[–-]14/,
  /Day 15/,
  /Day 22/,
  /15[–-]21/,
  /1,050/,
  /\b1050\b/,
  /50 ?[×x] ?21/,
  /14 ?[＋+] ?7/,
  /14日と7日/,
  /1週目と3週目/,
  /\bbaseline_days\b/,
  /\bobservation_days\b/,
  /\bstudy_phase\b/,
];

/** A line that cites #315 or names a v2 document is describing history. */
const HISTORY = /#315|issues\/315|v2/;

/*
 * Where the study is described. Directories rather than a file list, so a new
 * document added to them is checked without anyone remembering to add it.
 */
const SCANNED = [
  "README.md",
  "docs/pilot",
  "docs/legal",
  "docs/rollout",
  "docs/adr",
  "sentra/docs/world-model",
  "sentra/frontend/src/lib",
  "sentra/frontend/src/app/api/research",
  "sentra/frontend/src/app/pilot",
  "sentra/frontend/e2e",
  "sentra/supabase/seed",
  "sentra/supabase/tests",
];

/*
 * Not scanned, and why:
 *
 *   - `docs/pilot/audit-evidence/` — dated evidence snapshots. Rewriting them to
 *     the new period would falsify what was observed on that date.
 *   - `sentra/frontend/src/lib/blesc/` and `src/lib/i18n/` — the demo. Its
 *     fictional student has 21 days of entries because the change signal
 *     needs 14 days of their own history first (`RAMP_UP_DAYS`); that is a
 *     property of the demo data, not of the study.
 *   - `sentra/supabase/migrations/` other than the two above — applied
 *     migrations are history and are not edited.
 */
const SKIPPED = ["docs/pilot/audit-evidence/", "sentra/frontend/src/lib/blesc/", "sentra/frontend/src/lib/i18n/"];

const TEXT = /\.(md|json|ts|tsx|mjs|sql)$/;

function filesUnder(path) {
  const absolute = join(REPO, path);
  if (statSync(absolute).isFile()) return [path];
  return readdirSync(absolute, { recursive: true })
    .map((name) => relative(REPO, join(absolute, String(name))))
    .filter((name) => TEXT.test(name) && statSync(join(REPO, name)).isFile());
}

describe("no current description still states the old period", () => {
  const files = SCANNED.flatMap(filesUnder).filter(
    (file) => !SKIPPED.some((prefix) => file.startsWith(prefix)),
  );

  it("scans the places the study is described", () => {
    // Guards the guard: if a directory moves, the scan must not quietly pass
    // by finding nothing.
    for (const expected of [
      "docs/pilot/protocol.md",
      "docs/pilot/consent-pack.md",
      "docs/pilot/data-dictionary.json",
      "sentra/frontend/src/lib/legalDocuments.ts",
      "sentra/frontend/src/lib/server/crisisTriage.ts",
      "sentra/docs/world-model/math-dynamics.md",
    ]) {
      assert.ok(files.includes(expected), `${expected} is not scanned`);
    }
  });

  it("finds the old period only where a line marks itself as history", () => {
    const leftovers = [];
    for (const file of files) {
      read(file)
        .split("\n")
        .forEach((line, index) => {
          if (HISTORY.test(line)) return;
          const hit = OLD_PERIOD.find((pattern) => pattern.test(line));
          if (hit) leftovers.push(`${file}:${index + 1} ${hit} — ${line.trim().slice(0, 120)}`);
        });
    }
    assert.deepEqual(
      leftovers,
      [],
      "These lines still state the pre-#315 period. Update them to 28 days, or — if the line is " +
        "describing what changed — cite #315 on the same line.",
    );
  });
});
