/**
 * The research export reads the whole scope or fails (#509).
 *
 * PostgREST caps every response at `db-max-rows` (1,000 on a stock project) and
 * reports success, so a plain select returns a shorter list nobody can tell from
 * a complete one. The pilot's design scale is 50 participants x 28 days = 1,400
 * entries, above that cap. The fake below caps its responses the same way, and
 * the route handler is called for real against it.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { setServiceClient, setSignedInUser } from "./helpers/route-loader.mjs";
import { fakeSupabase } from "./helpers/fake-supabase.mjs";

const { NextRequest } = await import("next/server.js");
const { GET } = await import("../src/app/api/research/export/route.ts");

const EXPORTER = "00000000-0000-4000-8000-0000000000ee";
const STUDY = "00000000-0000-4000-8000-00000000057d";
const PARTICIPANTS = 50;
const DAYS = 28;
/** `db-max-rows` on a stock Supabase project. */
const CAP = 1000;

const pid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dayIso = (day, hour = 3) =>
  new Date(Date.UTC(2026, 10, 1 + day, hour, 0, 0)).toISOString(); // 12:00 JST at hour 3

/** A consent row that grants research use. `minute` orders the history. */
function consent(participant, id, minute) {
  return {
    id,
    participant_id: participant,
    app_use: true,
    research_analysis: true,
    anonymized_export: true,
    raw_text_retention: false,
    model_training_use: false,
    minor_assent: true,
    guardian_consent: true,
    consent_version: "v1",
    document_version: "v1",
    status: "active",
    granted_at: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(),
    revoked_at: null,
    created_at: new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString(),
  };
}

/**
 * 50 enrolled participants writing every day of a 28-day window.
 *
 * Consent history is uneven on purpose: the first ten consented once, early,
 * and never touched it again; the other forty re-confirmed thirty times later.
 * That is 1,210 rows, and newest-first the first ten's rows are the oldest —
 * exactly the rows a 1,000-row cut drops.
 */
function pilotAtDesignScale() {
  const enrollments = [];
  const entries = [];
  const consents = [];
  for (let n = 1; n <= PARTICIPANTS; n += 1) {
    const participant = pid(n);
    enrollments.push({
      id: `e-${String(n).padStart(3, "0")}`,
      participant_id: participant,
      research_code: `R${String(n).padStart(3, "0")}`,
      cohort: "default",
      study_id: STUDY,
      state: "collecting",
      collection_started_at: dayIso(0, 0),
      collection_ends_at: null,
      withdrawn_at: null,
    });
    for (let day = 0; day < DAYS; day += 1) {
      entries.push({
        id: `entry-${String(n).padStart(3, "0")}-${String(day).padStart(2, "0")}`,
        participant_id: participant,
        created_at: dayIso(day),
        observation_type: "journal",
        extraction_json: { nodes: [], relations: [] },
        raw_text_ciphertext: null,
        raw_text_expires_at: null,
      });
    }
    if (n <= 10) {
      consents.push(consent(participant, `c-${String(n).padStart(3, "0")}-00`, n));
    } else {
      for (let k = 0; k < 30; k += 1) {
        consents.push(consent(participant, `c-${String(n).padStart(3, "0")}-${String(k).padStart(2, "0")}`, 100 + n * 30 + k));
      }
    }
  }
  return fakeSupabase({
    maxRows: CAP,
    tables: {
      pilot_enrollments: enrollments,
      entries,
      consent_records: consents,
      pilot_studies: [{ id: STUDY, study_days: DAYS }],
      pilot_self_reports: [],
      research_exports: [],
    },
  });
}

const call = (query = "") => GET(new NextRequest(`http://localhost/api/research/export${query}`));

let db;
let error;

beforeEach(() => {
  process.env.RESEARCH_EXPORT_USER_IDS = EXPORTER;
  process.env.PILOT_TIMEZONE = "Asia/Tokyo";
  setSignedInUser({ id: EXPORTER });
  db = pilotAtDesignScale();
  setServiceClient(db);
  error = console.error;
  console.error = () => {};
});

afterEach(() => {
  console.error = error;
  setServiceClient(null);
  setSignedInUser(null);
  delete process.env.RESEARCH_EXPORT_USER_IDS;
  delete process.env.PILOT_TIMEZONE;
});

describe("GET /api/research/export at the pilot's design scale (#509)", () => {
  it("the fixture really is above the cap", () => {
    assert.equal(db.tables.entries.length, PARTICIPANTS * DAYS);
    assert.ok(db.tables.entries.length > CAP);
    assert.ok(db.tables.consent_records.length > CAP);
  });

  it("returns all 1,400 entries, not the first 1,000", async () => {
    const response = await call();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.rows.length, PARTICIPANTS * DAYS);
    assert.equal(body.count, PARTICIPANTS * DAYS);
    assert.equal(body.participant_count, PARTICIPANTS);
  });

  it("does not record a consented participant as no_research_consent when the history is long", async () => {
    // Cut at 1,000 newest-first, the ten earliest consents fall off, and their
    // 280 entries would be excluded as if those ten had never agreed.
    const body = await (await call()).json();
    assert.equal(body.excluded.no_research_consent, 0);
    const codes = new Set(body.rows.map((row) => row.research_code));
    for (let n = 1; n <= 10; n += 1) assert.ok(codes.has(`R${String(n).padStart(3, "0")}`));
  });

  it("the audit row says the read was complete and counts every row", async () => {
    await call();
    const [audit] = db.tables.research_exports;
    assert.equal(audit.status, "completed");
    assert.equal(audit.row_count, PARTICIPANTS * DAYS);
    assert.deepEqual(audit.participant_scope_json, { research_code: null, complete: true });
    assert.equal(audit.reason, null);
  });

  it("a read it cannot finish fails the export instead of shortening it", async () => {
    db.failNext("consent_records");
    const response = await call();
    assert.equal(response.status, 502);
    const [audit] = db.tables.research_exports;
    assert.equal(audit.status, "failed");
    assert.equal(audit.row_count, 0);
  });

  it("refuses the retired limit parameter rather than ignoring it", async () => {
    const response = await call("?limit=200");
    assert.equal(response.status, 400);
    const [audit] = db.tables.research_exports;
    assert.equal(audit.status, "failed");
    assert.match(audit.reason, /limit/);
    // Nothing was read past the audit write.
    assert.ok(!db.calls.some((c) => c.table === "entries"));
  });

  it("still narrows by research_code", async () => {
    const body = await (await call("?research_code=R007")).json();
    assert.equal(body.rows.length, DAYS);
    assert.ok(body.rows.every((row) => row.research_code === "R007"));
  });
});
