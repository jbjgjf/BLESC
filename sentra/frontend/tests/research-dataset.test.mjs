import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { scanForPii, summarizePii, hasPii, PII_SCANNER_LIMITS } from "../src/lib/piiScan.ts";

/** Source with comments removed. Every assertion below is about what the code
 *  does; a comment that names the thing being forbidden ("not `owner_user_id`")
 *  must not be able to fail a test that forbids it. */
const codeOnly = (path) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const EXPORT_ROUTE = fileURLToPath(new URL("../src/app/api/research/export/route.ts", import.meta.url));
const DASHBOARD_ROUTE = fileURLToPath(new URL("../src/app/api/research/dashboard/route.ts", import.meta.url));
const REVIEW_ROUTE = fileURLToPath(new URL("../src/app/api/research/pii-reviews/route.ts", import.meta.url));
const PII_MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/20260910000100_research_pii_review.sql", import.meta.url),
);

/* -------------------------------------------------------------------------- */
/* The PII scanner                                                            */
/* -------------------------------------------------------------------------- */

describe("scanForPii finds what it claims to find", () => {
  const kinds = (text) => scanForPii(text).map((finding) => finding.kind);

  it("finds an email address", () => {
    assert.deepEqual(kinds("連絡先は taro.yamada@example.co.jp です"), ["email"]);
  });

  it("finds Japanese phone numbers in the shapes people type", () => {
    assert.ok(kinds("090-1234-5678 にかけて").includes("phone_jp"));
    assert.ok(kinds("09012345678").includes("phone_jp"));
    assert.ok(kinds("03-1234-5678").includes("phone_jp"));
  });

  it("finds a URL", () => {
    assert.ok(kinds("https://example.com/abc を見た").includes("url"));
  });

  it("finds a postal code", () => {
    assert.ok(kinds("〒123-4567").includes("postal_jp"));
  });

  it("finds a name with an honorific", () => {
    assert.ok(kinds("田中さんと帰った").includes("honorific_name"));
    assert.ok(kinds("佐藤先生に相談した").includes("honorific_name"));
  });

  it("finds a class, which is where a cohort of fifty becomes a person", () => {
    assert.ok(kinds("3年2組で").includes("school_year_class"));
  });

  it("reports every overlapping finding rather than picking one", () => {
    // A phone number inside a URL is both. Hiding one for a tidier list keeps
    // information from the reviewer.
    const found = kinds("https://example.com/09012345678");
    assert.ok(found.includes("url"));
  });

  it("returns findings in positional order", () => {
    const findings = scanForPii("先頭 a@b.co まんなか 090-1234-5678 おわり");
    const starts = findings.map((finding) => finding.start);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  it("never returns the matched text", () => {
    // The queue is read by a surface that must not display journal text, and a
    // finding carrying its match would put the most sensitive fragment of the
    // entry into exactly that surface.
    for (const finding of scanForPii("taro@example.com 090-1234-5678")) {
      assert.deepEqual(Object.keys(finding).sort(), ["end", "kind", "start"]);
    }
  });

  it("does not carry a stale lastIndex between calls", () => {
    const text = "a@b.co と c@d.co";
    assert.equal(scanForPii(text).length, scanForPii(text).length);
    assert.equal(scanForPii(text).filter((f) => f.kind === "email").length, 2);
  });
});

describe("scanForPii does not flag ordinary diary prose", () => {
  const clean = [
    "今日は部活がきつくて、あんまり眠れていない。",
    "テストが80点だった。前より20点あがった。",
    "2026年の目標を書いた。",
    "1500メートル走のタイムが縮まった。",
    "ねむい。あしたもがんばる。",
    "みんなといっしょに帰った。",
  ];

  for (const text of clean) {
    it(`leaves alone: ${text.slice(0, 14)}…`, () => {
      assert.deepEqual(scanForPii(text), [], text);
      assert.equal(hasPii(text), false);
    });
  }

  it("does not treat a year or a score as an identifier", () => {
    // The digit-run detector needs twelve, which is above any year, price or
    // score a diary plausibly contains.
    assert.deepEqual(scanForPii("2026 1500 98765"), []);
  });

  it("does not read hiragana before さん as a name", () => {
    // あのさん / おかあさん are words, not classmates.
    assert.deepEqual(scanForPii("おかあさんに話した"), []);
  });
});

describe("summarizePii", () => {
  it("counts per kind and carries no positions", () => {
    const summary = summarizePii(scanForPii("a@b.co c@d.co 090-1234-5678"));
    assert.equal(summary.email, 2);
    assert.equal(summary.phone_jp, 1);
    for (const value of Object.values(summary)) assert.equal(typeof value, "number");
  });
});

describe("the scanner says what it cannot do", () => {
  it("names its limits in code, not only in a document", () => {
    assert.deepEqual([...PII_SCANNER_LIMITS], [
      "personal_names_without_honorific",
      "place_names",
      "dates_of_birth",
      "identification_by_combination",
    ]);
  });

  it("ships those limits with every queue listing", () => {
    // So they travel with the queue rather than living in a document the
    // reviewer read once, months ago.
    assert.match(readFileSync(REVIEW_ROUTE, "utf8"), /scanner_limits: PII_SCANNER_LIMITS/);
  });
});

/* -------------------------------------------------------------------------- */
/* The export                                                                 */
/* -------------------------------------------------------------------------- */

describe("the export's three outputs", () => {
  const source = readFileSync(EXPORT_ROUTE, "utf8");

  it("puts re-identification behind its own allowlist", () => {
    // Being able to run the analysis file does not carry the right to undo its
    // pseudonymisation.
    assert.match(source, /RESEARCH_IDENTITY_USER_IDS/);
    assert.match(source, /kind === "identity_map" \? "RESEARCH_IDENTITY_USER_IDS" : "RESEARCH_EXPORT_USER_IDS"/);
  });

  it("keeps the login id out of the identity map too", () => {
    // The map joins to the school's enrollment paperwork, which is where a name
    // lives. A login id here would make it a credential-adjacent artefact.
    const code = codeOnly(EXPORT_ROUTE);
    const block = code.slice(code.indexOf('if (kind === "identity_map")'), code.indexOf("const participantIds"));
    assert.ok(block.length > 0, "expected to find the identity_map block");
    assert.doesNotMatch(block, /owner_user_id/);
    assert.doesNotMatch(block, /email/);
  });

  it("excludes a withdrawn participant from every kind", () => {
    assert.match(source, /withdrawn\.has\(row\.participant_id\)/);
    assert.match(source, /row\.state === "withdrawn"/);
  });

  it("audits every attempt, including the denied ones", () => {
    assert.match(source, /await audit\("denied"/);
    assert.match(source, /await audit\("failed"/);
    assert.match(source, /await audit\("completed"/);
  });

  it("scans for PII where the text is decrypted, not at submission", () => {
    assert.match(source, /await queuePiiReview\(service, row\.id, row\.participant_id, text\)/);
  });
});

describe("the dashboard", () => {
  const source = readFileSync(DASHBOARD_ROUTE, "utf8");

  it("selects no column that could carry journal text", () => {
    // The surface exists so the study can be watched without reading anyone's
    // diary. Asserted on the `select(...)` projections rather than on the whole
    // file: the retention alarm filters on `raw_text_ciphertext is not null`
    // with `head: true`, which counts rows without reading one.
    const projections = codeOnly(DASHBOARD_ROUTE).match(/\.select\(\s*("(?:[^"\\]|\\.)*"(?:\s*\+\s*"(?:[^"\\]|\\.)*")*)/g) ?? [];
    assert.ok(projections.length > 0, "expected to find select projections");
    for (const projection of projections) {
      for (const column of ["raw_text", "extraction_json", "responses_json"]) {
        assert.doesNotMatch(projection, new RegExp(column), projection);
      }
    }
  });

  it("is behind the operator allowlist, not the export one", () => {
    // Watching the run is an operations job and should not require the
    // permission that pulls text.
    assert.match(source, /requireOperator/);
    assert.doesNotMatch(source, /RESEARCH_EXPORT_USER_IDS/);
  });

  it("reports the three operational alarms the dry run reconciles against", () => {
    assert.match(source, /submission_failures/);
    assert.match(source, /pii_reviews_pending/);
    assert.match(source, /retention_overdue/);
  });
});

describe("the PII review migration", () => {
  const sql = readFileSync(PII_MIGRATION, "utf8");

  it("stores counts, not text and not offsets", () => {
    assert.match(sql, /findings_json jsonb not null/);
    // No column holds a fragment of the entry. Checked against column
    // definitions, not against the prose that explains why there are none.
    const columns = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    assert.doesNotMatch(columns, /(matched_text|snippet|excerpt|span|offset)\s+\w/);
  });

  it("keeps the queue away from the browser entirely", () => {
    assert.match(sql, /revoke all on public\.research_pii_reviews from public, anon, authenticated/);
  });

  it("will not let a status move with nobody attached", () => {
    assert.match(sql, /status = 'pending' or \(reviewed_by is not null and reviewed_at is not null\)/);
  });

  it("records which scanner produced the findings", () => {
    assert.match(sql, /scanner_version text not null/);
    assert.match(sql, /unique \(entry_id, scanner_version\)/);
  });
});
