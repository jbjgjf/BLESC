import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildIdentityMap,
  buildResearchDataset,
  dayIndex,
  identityLeakIn,
} from "../src/lib/researchExport.ts";

const TZ = "Asia/Tokyo";

const entry = (over = {}) => ({
  id: "entry-1",
  participant_id: "participant-1",
  created_at: "2026-09-08T02:00:00Z", // 11:00 JST on the 8th
  observation_type: "daily",
  extraction_json: {
    schema_version: "sentra-extraction-schema-v1",
    prompt_version: "sentra-ontology-extractor-v2",
    provider: "openai",
    model: "gpt-6-astra",
    nodes: [
      { type: "State", label: "不安", evidence_text: "テストが不安で眠れなかった" },
      { type: "Trigger", label: "テスト", evidence_text: "明日は数学のテスト" },
    ],
    relations: [{ type: "causes", from: "テスト", to: "不安", evidence_text: "テストのせいで不安" }],
  },
  raw_text_ciphertext: "ciphertext",
  raw_text_expires_at: "2027-03-07T00:00:00Z",
  ...over,
});

const enrollment = (over = {}) => ({
  participant_id: "participant-1",
  research_code: "P-0001",
  cohort: "default",
  state: "collecting",
  collection_started_at: "2026-09-05T23:00:00Z", // 08:00 JST on the 6th
  withdrawn_at: null,
  ...over,
});

const consented = (over = {}) => ({
  research: true,
  retention: true,
  consent_version: "research-consent-v1",
  document_version: "research-consent-doc-v1",
  ...over,
});

const build = (over = {}) =>
  buildResearchDataset({
    entries: [entry()],
    enrollments: [enrollment()],
    consentByParticipant: new Map([["participant-1", consented()]]),
    timeZone: TZ,
    ...over,
  });

describe("dayIndex", () => {
  it("is 1 on the first day of the window", () => {
    assert.equal(dayIndex("2026-09-06T02:00:00Z", "2026-09-05T23:00:00Z", TZ), 1);
  });

  it("counts calendar days, not 24-hour blocks", () => {
    // 23:50 JST on day 1 and 00:10 JST on day 2 are twenty minutes apart and
    // must land on different days — that boundary is where a nightly journal
    // actually sits.
    const late = dayIndex("2026-09-06T14:50:00Z", "2026-09-05T23:00:00Z", TZ); // 23:50 JST 6th
    const early = dayIndex("2026-09-06T15:10:00Z", "2026-09-05T23:00:00Z", TZ); // 00:10 JST 7th
    assert.equal(late, 1);
    assert.equal(early, 2);
  });

  it("uses the study timezone rather than UTC", () => {
    // Only the entry crosses the date line between the two zones: 16:00 UTC on
    // the 7th is 01:00 JST on the 8th, while the window start lands on the 6th
    // either way. So the same pair of instants is day 3 in Tokyo and day 2 in
    // UTC — an off-by-one in every participant's window if the zone is wrong.
    const start = "2026-09-06T00:00:00Z";
    const entry = "2026-09-07T16:00:00Z";
    assert.equal(dayIndex(entry, start, TZ), 3);
    assert.equal(dayIndex(entry, start, "UTC"), 2);
  });

  it("returns null for an unparseable instant", () => {
    assert.equal(dayIndex("not-a-date", "2026-09-05T23:00:00Z", TZ), null);
  });
});

describe("buildResearchDataset — pseudonymity", () => {
  it("identifies a row by research_code", () => {
    const { rows } = build();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].research_code, "P-0001");
  });

  it("carries no database identity and no wall-clock timestamp", () => {
    const { rows } = build();
    const keys = Object.keys(rows[0]);
    for (const forbidden of ["participant_id", "owner_user_id", "created_at", "email", "user_id"]) {
      assert.ok(!keys.includes(forbidden), `row exposed ${forbidden}`);
    }
  });

  it("dates a row by relative day only", () => {
    const { rows } = build();
    assert.equal(rows[0].day_index, 3); // window opens 9/6 JST, entry is 9/8 JST
  });

  it("the guard catches a row that regained an absolute time", () => {
    // The fix above removed the one field that leaked. This asserts the guard
    // now refuses the whole class, so a later change that spreads another
    // timestamp column into a row fails here rather than shipping.
    const rows = build().rows;
    rows[0].raw_text_expires_at = "2027-03-07T00:00:00Z";
    assert.equal(identityLeakIn(rows), "raw_text_expires_at");
  });

  it("keeps a management reference to the encrypted original", () => {
    const { rows } = build();
    assert.equal(rows[0].raw_text_ref, "entry-1");
    assert.equal(rows[0].raw_text_available, true);
  });

  it("passes its own identity guard", () => {
    assert.equal(identityLeakIn(build().rows), null);
  });

  it("the guard catches a row that gained an identifying field", () => {
    const rows = build().rows;
    rows[0].participant_id = "participant-1";
    assert.equal(identityLeakIn(rows), "participant_id");
  });
});

describe("buildResearchDataset — withdrawal", () => {
  it("excludes a participant whose state is withdrawn", () => {
    const result = build({ enrollments: [enrollment({ state: "withdrawn" })] });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.withdrawn, 1);
  });

  it("excludes on the timestamp even when the state disagrees", () => {
    // A row repaired by hand in the dashboard may carry only one of the two.
    // Shipping the entries of someone who asked to leave because two columns
    // disagreed is the kind of failure nobody notices.
    const result = build({
      enrollments: [enrollment({ state: "collecting", withdrawn_at: "2026-09-09T00:00:00Z" })],
    });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.withdrawn, 1);
  });

  it("counts withdrawal as withdrawal even when consent still reads active", () => {
    // Withdrawal and consent revocation are written separately, so the two can
    // disagree for a moment. The exclusion reason has to name the real cause.
    const result = build({
      enrollments: [enrollment({ state: "withdrawn" })],
      consentByParticipant: new Map([["participant-1", consented()]]),
    });
    assert.equal(result.excluded.withdrawn, 1);
    assert.equal(result.excluded.no_research_consent, 0);
  });
});

describe("buildResearchDataset — consent and enrollment gates", () => {
  it("excludes an entry with no research consent", () => {
    const result = build({
      consentByParticipant: new Map([["participant-1", consented({ research: false })]]),
    });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.no_research_consent, 1);
  });

  it("excludes an entry from a participant with no consent record at all", () => {
    const result = build({ consentByParticipant: new Map() });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.no_research_consent, 1);
  });

  it("excludes an entry from someone who is not enrolled", () => {
    const result = build({ enrollments: [] });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.not_enrolled, 1);
  });

  it("excludes an entry written before collection opened", () => {
    const result = build({ enrollments: [enrollment({ collection_started_at: null })] });
    assert.equal(result.rows.length, 0);
    assert.equal(result.excluded.collection_not_started, 1);
  });
});

describe("buildResearchDataset — journal text", () => {
  it("strips verbatim quotations when the text is not included", () => {
    const { rows } = build();
    const serialized = JSON.stringify(rows[0]);
    // `evidence_text` quotes the sentence a node came from. Emitting the graph
    // whole was how journal text left for participants who never agreed to
    // retention — gating `raw_text` alone did not stop it.
    assert.ok(!serialized.includes("眠れなかった"));
    assert.ok(!serialized.includes("evidence_text"));
    assert.equal(rows[0].raw_text, undefined);
  });

  it("keeps the structure after stripping the quotations", () => {
    const { rows } = build();
    assert.equal(rows[0].ontology.nodes.length, 2);
    assert.equal(rows[0].ontology.nodes[0].type, "State");
    assert.equal(rows[0].ontology.nodes[0].label, "不安");
  });

  it("counts what the extraction found without repeating what it said", () => {
    const { rows } = build();
    assert.deepEqual(rows[0].measures, {
      node_count: 2,
      relation_count: 1,
      node_kinds: { State: 1, Trigger: 1 },
      relation_kinds: { causes: 1 },
    });
  });

  it("includes the text and scans it when the caller was allowed it", () => {
    const { rows } = build({
      decryptedText: new Map([["entry-1", "田中先生に 090-1234-5678 で連絡した"]]),
    });
    assert.equal(rows[0].raw_text, "田中先生に 090-1234-5678 で連絡した");
    assert.equal(rows[0].pii.high, 1); // the phone number
    assert.ok(rows[0].pii.findings.some((f) => f.kind === "phone"));
  });

  it("does not scan when there is no text", () => {
    assert.equal(build().rows[0].pii, undefined);
  });

  it("treats a decryption failure as no text rather than as empty text", () => {
    const { rows } = build({ decryptedText: new Map([["entry-1", null]]) });
    assert.equal(rows[0].raw_text, undefined);
    assert.equal(rows[0].pii, undefined);
  });
});

describe("buildResearchDataset — accounting", () => {
  it("counts distinct contributing participants, not rows", () => {
    const result = buildResearchDataset({
      entries: [entry(), entry({ id: "entry-2", created_at: "2026-09-09T02:00:00Z" })],
      enrollments: [enrollment()],
      consentByParticipant: new Map([["participant-1", consented()]]),
      timeZone: TZ,
    });
    assert.equal(result.rows.length, 2);
    assert.equal(result.participant_count, 1);
  });

  it("reports zero exclusions when nothing was excluded", () => {
    assert.deepEqual(build().excluded, {
      withdrawn: 0,
      not_enrolled: 0,
      no_research_consent: 0,
      collection_not_started: 0,
      outside_window: 0,
    });
  });

  it("excludes an entry written before the participant's window opened", () => {
    // `entries` has no study id, so selecting by participant alone would stamp
    // a pre-study journal with this study's research_code and protocol and hand
    // it over as day 0 of a window it predates.
    const result = build({ entries: [entry({ created_at: "2026-08-01T02:00:00Z" })] });
    assert.deepEqual(result.rows, []);
    assert.equal(result.excluded.outside_window, 1);
  });

  it("excludes an entry written after the window closed", () => {
    const result = build({
      enrollments: [enrollment({ collection_ends_at: "2026-09-10T00:00:00Z" })],
      entries: [entry({ created_at: "2026-09-20T02:00:00Z" })],
    });
    assert.deepEqual(result.rows, []);
    assert.equal(result.excluded.outside_window, 1);
  });

  it("exports the retention expiry as a study day, never as a timestamp", () => {
    // The expiry is submission time plus a fixed interval, so an absolute value
    // hands the submission's calendar date back by subtraction — the same
    // re-identification dropping `created_at` was meant to prevent.
    const [row] = build({ entries: [entry({ raw_text_expires_at: "2027-03-01T00:00:00Z" })] }).rows;
    assert.equal(typeof row.raw_text_expires_day, "number");
    assert.ok(!("raw_text_expires_at" in row), "the absolute expiry is still on the row");
    assert.ok(!JSON.stringify(row).includes("2027-03-01"), "the absolute expiry leaked");
  });
});

describe("buildIdentityMap", () => {
  it("maps the pseudonym to the database identity", () => {
    const [row] = buildIdentityMap([enrollment()]);
    assert.equal(row.research_code, "P-0001");
    assert.equal(row.participant_id, "participant-1");
  });

  it("carries no journal content", () => {
    const [row] = buildIdentityMap([enrollment()]);
    assert.deepEqual(Object.keys(row).sort(), [
      "cohort",
      "collection_started_at",
      "participant_id",
      "research_code",
      "state",
      "withdrawn_at",
    ]);
  });

  it("includes withdrawn participants", () => {
    // Honouring a withdrawal needs the mapping for exactly the person who asked
    // to leave: find their rows, purge the text, confirm it is done.
    const rows = buildIdentityMap([enrollment({ state: "withdrawn", withdrawn_at: "2026-09-09T00:00:00Z" })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "withdrawn");
  });
});
