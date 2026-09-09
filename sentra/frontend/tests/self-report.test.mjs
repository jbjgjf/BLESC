import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  SELF_REPORT_ITEMS,
  SELF_REPORT_ITEM_IDS,
  SELF_REPORT_SCHEMA_ID,
  flattenSelfReport,
  hasAnyAnswer,
  normalizeSelfReport,
} from "../src/lib/selfReport.ts";

const MIGRATION = fileURLToPath(
  new URL("../../supabase/migrations/20260910000000_pilot_daily_self_report.sql", import.meta.url),
);
const JOURNAL_PAGE = fileURLToPath(new URL("../src/app/journal/page.tsx", import.meta.url));
const FOLLOWUP_ROUTE = fileURLToPath(new URL("../src/app/api/entries/followups/route.ts", import.meta.url));
const ENTRIES_ROUTE = fileURLToPath(new URL("../src/app/api/entries/route.ts", import.meta.url));
const CHAT_LAYOUT = fileURLToPath(new URL("../src/app/chat/layout.tsx", import.meta.url));
const GRAPH_LAYOUT = fileURLToPath(new URL("../src/app/graph/layout.tsx", import.meta.url));

describe("the pinned self-report schema", () => {
  it("matches the protocol's data dictionary", () => {
    // `docs/pilot/data-dictionary.json`, `pilot-selfreport-v1`. If the
    // dictionary changes, this test is the thing that notices — a scale that
    // means 0-10 in the app and 1-7 in the analysis produces a dataset nobody
    // can pool.
    assert.equal(SELF_REPORT_SCHEMA_ID, "pilot-selfreport-v1");
    assert.deepEqual(SELF_REPORT_ITEM_IDS, [
      "mood",
      "stress",
      "sleep_quality",
      "sleep_hours",
      "event_intensity",
    ]);
  });

  it("keeps the presentation order fixed and gapless", () => {
    // Re-ordering mid-study damages the data the same way rewording does.
    assert.deepEqual(
      SELF_REPORT_ITEMS.map((item) => item.order),
      [1, 2, 3, 4, 5],
    );
  });

  it("puts four items on the same Likert scale and sleep on hours", () => {
    const likert = SELF_REPORT_ITEMS.filter((item) => item.kind === "likert_0_10");
    assert.equal(likert.length, 4);

    const sleep = SELF_REPORT_ITEMS.find((item) => item.id === "sleep_hours");
    assert.equal(sleep.kind, "hours_0_5_step");
    assert.equal(sleep.min, 0);
    assert.equal(sleep.max, 16);
    assert.equal(sleep.step, 0.5);
  });

  it("does not implement the item the protocol has not settled", () => {
    // `support_contact` ("誰かに相談できたか") is marked DECISION REQUIRED in the
    // dictionary, with the ethics lead named as the decider: asking it is
    // itself an intervention that may prompt help-seeking, in the middle of
    // measuring whether help-seeking changes. Implementing it from a guess
    // would settle a question nobody has settled.
    assert.equal(SELF_REPORT_ITEM_IDS.includes("support_contact"), false);
  });
});

describe("normalizeSelfReport", () => {
  it("records an unanswered item as unanswered, not as zero", () => {
    // The failure this prevents: a default written into the record that the
    // analysis cannot tell from a real answer. Zero is a real answer on every
    // one of these scales.
    const responses = normalizeSelfReport({});
    for (const id of SELF_REPORT_ITEM_IDS) {
      assert.deepEqual(responses[id], { value: null, observed: false });
    }
    assert.equal(hasAnyAnswer(responses), false);
  });

  it("keeps a real zero", () => {
    const responses = normalizeSelfReport({ mood: 0 });
    assert.deepEqual(responses.mood, { value: 0, observed: true });
    assert.equal(hasAnyAnswer(responses), true);
  });

  it("drops a Likert value outside the scale", () => {
    for (const bad of [-1, 11, 1000]) {
      assert.deepEqual(normalizeSelfReport({ mood: bad }).mood, { value: null, observed: false });
    }
  });

  it("drops a non-integer Likert value rather than rounding it", () => {
    // Rounding would invent an answer on a scale whose points are labelled.
    assert.deepEqual(normalizeSelfReport({ stress: 6.5 }).stress, { value: null, observed: false });
  });

  it("drops anything that is not a number", () => {
    for (const bad of ["7", true, null, {}, [], NaN, Infinity]) {
      assert.deepEqual(normalizeSelfReport({ mood: bad }).mood, { value: null, observed: false });
    }
  });

  it("accepts the half-hour steps sleep is asked in", () => {
    assert.deepEqual(normalizeSelfReport({ sleep_hours: 7.5 }).sleep_hours, { value: 7.5, observed: true });
    assert.deepEqual(normalizeSelfReport({ sleep_hours: 0 }).sleep_hours, { value: 0, observed: true });
    assert.deepEqual(normalizeSelfReport({ sleep_hours: 16 }).sleep_hours, { value: 16, observed: true });
  });

  it("snaps a slider's floating-point tail instead of discarding the answer", () => {
    const responses = normalizeSelfReport({ sleep_hours: 7.499999999 });
    assert.deepEqual(responses.sleep_hours, { value: 7.5, observed: true });
  });

  it("drops a sleep value outside the range", () => {
    assert.deepEqual(normalizeSelfReport({ sleep_hours: 25 }).sleep_hours, { value: null, observed: false });
    assert.deepEqual(normalizeSelfReport({ sleep_hours: -1 }).sleep_hours, { value: null, observed: false });
  });

  it("drops an item the protocol does not define", () => {
    // A client cannot add a field to the dataset by sending one.
    const responses = normalizeSelfReport({ mood: 5, support_contact: "yes", invented: 3 });
    assert.deepEqual(Object.keys(responses).sort(), [...SELF_REPORT_ITEM_IDS].sort());
  });

  it("survives a round trip through storage", () => {
    const once = normalizeSelfReport({ mood: 8, sleep_hours: 6.5 });
    const twice = normalizeSelfReport(once);
    assert.deepEqual(twice, once);
  });

  it("never throws, whatever it is handed", () => {
    // An invalid rating must never cost a participant their journal text
    // (#132). The route calls this before writing, and it has to be total.
    for (const input of [null, undefined, 42, "x", [], { mood: { value: "x" } }]) {
      assert.doesNotThrow(() => normalizeSelfReport(input));
    }
  });
});

describe("flattenSelfReport", () => {
  it("gives the export one column per item, null where unanswered", () => {
    const flat = flattenSelfReport(normalizeSelfReport({ mood: 3, sleep_hours: 8 }));
    assert.deepEqual(flat, {
      mood: 3,
      stress: null,
      sleep_quality: null,
      sleep_hours: 8,
      event_intensity: null,
    });
  });
});

describe("the collection window stops the adaptive surfaces", () => {
  it("refuses follow-up answers on the server, not only in the UI", () => {
    const source = readFileSync(FOLLOWUP_ROUTE, "utf8");
    assert.match(source, /collectionOnlyForParticipant/);
    assert.match(source, /collection_only/);
  });

  it("does not ask follow-up questions during collection", () => {
    const source = readFileSync(JOURNAL_PAGE, "utf8");
    assert.match(source, /!collectionOnly && needsFollowUp\(\)/);
  });

  it("removes the chat and graph screens rather than emptying them", () => {
    for (const layout of [CHAT_LAYOUT, GRAPH_LAYOUT]) {
      const source = readFileSync(layout, "utf8");
      assert.match(source, /collectionOnlyForCurrentUser/);
      assert.match(source, /redirect\(/);
    }
  });

  it("stores a self-report only for a submission inside the window", () => {
    const source = readFileSync(ENTRIES_ROUTE, "utf8");
    assert.match(source, /collectionOnly && payload\.self_report/);
    // Normalised, never stored as sent.
    assert.match(source, /normalizeSelfReport\(payload\.self_report\)/);
  });

  it("sends the fixed items only when the server said the window is open", () => {
    const source = readFileSync(JOURNAL_PAGE, "utf8");
    assert.match(source, /self_report: collectionOnly \? ratings : undefined/);
  });
});

describe("the self-report migration", () => {
  const sql = readFileSync(MIGRATION, "utf8");

  it("pins every row to a schema version", () => {
    assert.match(sql, /schema_id text not null/);
  });

  it("ties one self-report to one submission", () => {
    assert.match(sql, /unique \(entry_id\)/);
  });

  it("does not let the browser write its own answers", () => {
    // Validation happens on the server against the pinned schema. A client that
    // could insert directly could store an out-of-range value, an item the
    // protocol does not define, or a different schema_id than it was shown.
    assert.match(sql, /grant select on public\.entry_self_reports to authenticated/);
    assert.doesNotMatch(sql, /grant[^;]*insert[^;]*to authenticated/);
    assert.match(sql, /for select to authenticated/);
  });

  it("gives the research role a policy, so its grant is an access and not an intention", () => {
    // A column grant to a role with RLS enabled and no policy admitting it
    // reads back zero rows. The same shape on `entries`, `pilot_studies`,
    // `pilot_enrollments` and `research_exports` currently has no policy — the
    // export does not notice because it runs under the service-role key, which
    // bypasses RLS. Verified against PostgreSQL 16: with this policy the role
    // reads the granted columns and is denied `owner_user_id`.
    assert.match(sql, /create policy "entry_self_reports_research_read"[\s\S]*?to research_reader/);
  });

  it("keeps the login id out of the research role's view", () => {
    const grant = sql.match(
      /grant select \(([\s\S]*?)\)\s*\n\s*on public\.entry_self_reports to research_reader/,
    );
    assert.ok(grant, "expected a column-level grant to research_reader");
    assert.doesNotMatch(grant[1], /owner_user_id/);
  });
});
