/**
 * protocol §4.4's manual review has somewhere to happen (#225).
 *
 * The rule existed — an authorised person looks at retained journal text at
 * 10:00 and 16:00 JST — with no screen, no queue and no record that anybody
 * ever looked. A rule with nowhere to run is a rule the Go/No-Go can be signed
 * against and never kept.
 *
 * What this locks down is mostly the restraint: the classifier must not become
 * the decision, listing must not become reading, and reading must not happen
 * without a record.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { slotFor } from "../src/lib/server/crisisTriage.ts";
import { SAFETY_ASSESSMENT_VERSION } from "../src/lib/safety-assessment.ts";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const lib = read("../src/lib/server/crisisTriage.ts");
const route = read("../src/app/api/pilot/triage/route.ts");
const page = read("../src/app/pilot/triage/page.tsx");
const migration = read("../../supabase/migrations/20260921030000_pilot_crisis_triage.sql");

describe("the review slots follow §4.4", () => {
  const at = (iso) => new Date(iso);

  it("10:00 JST is the morning slot", () => {
    assert.equal(slotFor(at("2026-09-21T01:00:00Z")), "morning"); // 10:00 JST
  });

  it("16:00 JST is the afternoon slot", () => {
    assert.equal(slotFor(at("2026-09-21T07:00:00Z")), "afternoon"); // 16:00 JST
  });

  it("02:00 JST is neither, and is recorded as such", () => {
    // §4.4 promises two reviews a day and promises no night watch. Rounding a
    // 02:00 review into "morning" would make the log claim a schedule was kept.
    assert.equal(slotFor(at("2026-09-20T17:00:00Z")), "ad_hoc"); // 02:00 JST
  });

  it("the screen says when the operator is outside the slots", () => {
    assert.match(page, /§4\.4 が定める枠の外/);
  });
});

describe("the classifier sorts, it does not decide", () => {
  it("keeps entries the lexicon scored none in the queue", () => {
    // A crisis written in words the lexicon does not carry scores `none`. A
    // queue that filters those has quietly narrowed §4.4 to "review what the
    // regex found".
    assert.doesNotMatch(code(lib), /assessed_risk.*neq.*none|\.neq\("assessed_risk"/);
    assert.match(lib, /'none' の行がレビュー対象から消えない|scored `none` stay in the queue/);
  });

  it("records the assessor version from the assessor", () => {
    assert.match(code(route), /ASSESSOR_VERSION = SAFETY_ASSESSMENT_VERSION/);
    assert.ok(SAFETY_ASSESSMENT_VERSION.length > 0);
  });

  it("refuses 'pending' as a decision", () => {
    assert.match(code(route), /"pending" は判断ではありません/);
  });

  it("a decided row must name who decided it", () => {
    assert.match(migration, /reviewed_by is not null and reviewed_at is not null/);
  });
});

describe("listing is not reading", () => {
  it("the queue carries no journal text", () => {
    const queueType = lib.slice(lib.indexOf("export type QueueRow"), lib.indexOf("export async function loadQueue"));
    assert.doesNotMatch(queueType, /\braw_text\b|\btext:\s*string/);
    assert.match(queueType, /text_available: boolean/);
  });

  it("reading is a POST, because it writes a read record", () => {
    assert.match(code(route), /body\.action === "read"/);
    assert.match(code(lib), /from\("pilot_crisis_review_reads"\)\.insert/);
  });

  it("refuses to return text when the read could not be logged", () => {
    // The log is what turns "your text may be read" from a disclaimer into a
    // promise, so an unlogged read is not a read that may be served.
    const body = code(lib);
    const insertAt = body.indexOf("pilot_crisis_review_reads");
    const decryptAt = body.indexOf("decryptRawText(ciphertext)");
    assert.ok(insertAt !== -1 && decryptAt > insertAt, "the read must be logged before the text is decrypted");
    assert.match(lib, /閲覧の記録に失敗したため、本文を表示しません/);
  });
});

describe("the note is a note, not a second copy of the journal", () => {
  it("is capped in the database", () => {
    assert.match(migration, /char_length\(reviewer_note\) <= 500/);
  });

  it("is capped again before the insert, so a long note is truncated not rejected", () => {
    assert.match(code(lib), /note\.slice\(0, 500\)/);
  });

  it("tells the reviewer not to quote", () => {
    assert.match(page, /日記の本文は書き写さないでください/);
  });
});

describe("rows whose text is gone still need a decision", () => {
  it("the queue counts them rather than hiding them", () => {
    // Dropping them silently makes "the text was purged" indistinguishable from
    // "nobody wrote that day".
    assert.match(code(route), /no_text:/);
    assert.match(code(lib), /"unreadable"/);
  });

  it("the screen offers the decision", () => {
    assert.match(code(page), /decide\(openId, "unreadable"\)/);
  });
});

describe("only an operator gets in", () => {
  it("the route is behind the operator allowlist", () => {
    assert.match(code(route), /requireOperator\(request\)/);
  });

  it("neither table is readable by anon or authenticated", () => {
    assert.match(migration, /revoke all on public\.pilot_crisis_reviews from public, anon, authenticated/);
    assert.match(migration, /revoke all on public\.pilot_crisis_review_reads from public, anon, authenticated/);
  });

  it("row level security is on for both", () => {
    assert.match(migration, /alter table public\.pilot_crisis_reviews enable row level security/);
    assert.match(migration, /alter table public\.pilot_crisis_review_reads enable row level security/);
  });
});

describe("the screen does not overstate what this is", () => {
  it("says it is not a night watch and not an emergency service", () => {
    assert.match(page, /夜間・休日の監視を代替しません/);
    assert.match(page, /緊急対応を行いません/);
  });

  it("does not claim the escalate button notifies anyone", () => {
    assert.match(page, /このボタンは記録であって、通知は送りません/);
  });
});
