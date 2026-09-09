import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  SELF_REPORT_ITEMS,
  SELF_REPORT_SCHEMA_VERSION,
  hasSelfReportContent,
  normalizeSelfReport,
} from "../src/lib/pilotSelfReport.ts";

describe("the instrument is fixed", () => {
  it("is the five settled items, in protocol order", () => {
    assert.deepEqual(
      SELF_REPORT_ITEMS.map((item) => item.id),
      ["mood", "stress", "sleep_quality", "sleep_hours", "event_intensity"],
    );
  });

  it("does not implement support_contact, which the protocol has not settled", () => {
    // The data dictionary marks it DECISION REQUIRED: asking whether a student
    // talked to someone is itself a nudge to talk to someone, and the ethics
    // lead has not decided whether the pilot may do that. Implementing it from
    // a guess is the failure this test exists to catch.
    assert.ok(!SELF_REPORT_ITEMS.some((item) => item.id === "support_contact"));
  });

  it("matches the data dictionary the protocol publishes, when it is present", async () => {
    // docs/pilot/data-dictionary.json ships with the protocol (#162) and may not
    // be on this branch yet. When it is, the item set and the ranges have to
    // agree — two definitions of "mood is 0-10" is how one of them becomes 1-7.
    const path = fileURLToPath(new URL("../../../docs/pilot/data-dictionary.json", import.meta.url));
    let dictionary;
    try {
      dictionary = JSON.parse(await readFile(path, "utf8"));
    } catch {
      return; // Protocol not merged here yet; the assertions above still hold.
    }

    const block = dictionary.daily_self_report;
    assert.equal(block.schema_id, SELF_REPORT_SCHEMA_VERSION);
    const settled = block.items.filter((item) => !String(item.description ?? "").includes("DECISION REQUIRED"));
    assert.deepEqual(
      SELF_REPORT_ITEMS.map((item) => item.id),
      settled.sort((a, b) => a.order - b.order).map((item) => item.id),
    );
    for (const item of SELF_REPORT_ITEMS) {
      const spec = settled.find((candidate) => candidate.id === item.id);
      assert.equal(item.scale, spec.scale, `${item.id}: scale disagrees with the data dictionary`);
    }
  });
});

describe("a skip is null, not a number", () => {
  it("returns every item as null when nothing was answered", () => {
    const report = normalizeSelfReport({});
    assert.deepEqual(report.values, {
      mood: null,
      stress: null,
      sleep_quality: null,
      sleep_hours: null,
      event_intensity: null,
    });
    assert.equal(report.empty, true);
    assert.deepEqual(report.answered, []);
  });

  it("treats an explicit null and an empty string as a skip, not a rejection", () => {
    const report = normalizeSelfReport({ mood: null, stress: "" });
    assert.equal(report.values.mood, null);
    assert.equal(report.values.stress, null);
    assert.deepEqual(report.rejected, {});
  });

  it("keeps zero as an answer", () => {
    // The whole point. A participant who reports 0 stress said something; a
    // participant who skipped the item did not, and the two must not collapse.
    const report = normalizeSelfReport({ stress: 0 });
    assert.equal(report.values.stress, 0);
    assert.deepEqual(report.answered, ["stress"]);
    assert.equal(report.empty, false);
  });

  it("writes no row for a submission that carried no self-report at all", () => {
    assert.equal(hasSelfReportContent(normalizeSelfReport(undefined)), false);
    assert.equal(hasSelfReportContent(normalizeSelfReport({ mood: 5 })), true);
  });

  it("writes a row when everything was rejected, so a broken client is visible", () => {
    const report = normalizeSelfReport({ mood: 99 });
    assert.equal(report.empty, true);
    assert.equal(hasSelfReportContent(report), true);
  });
});

describe("an invalid value is rejected, never clamped", () => {
  it("refuses a value above the maximum", () => {
    const report = normalizeSelfReport({ mood: 11 });
    assert.equal(report.values.mood, null, "11 must not become 10");
    assert.equal(report.rejected.mood, "out_of_range");
  });

  it("refuses a value below the minimum", () => {
    const report = normalizeSelfReport({ stress: -1 });
    assert.equal(report.values.stress, null);
    assert.equal(report.rejected.stress, "out_of_range");
  });

  it("refuses a fractional answer on an integer scale", () => {
    const report = normalizeSelfReport({ mood: 4.5 });
    assert.equal(report.values.mood, null);
    assert.equal(report.rejected.mood, "off_step");
  });

  it("accepts half hours and refuses anything finer", () => {
    assert.equal(normalizeSelfReport({ sleep_hours: 7.5 }).values.sleep_hours, 7.5);
    assert.equal(normalizeSelfReport({ sleep_hours: 7.3 }).rejected.sleep_hours, "off_step");
  });

  it("refuses text and non-finite numbers", () => {
    const report = normalizeSelfReport({ mood: "ふつう", stress: Number.NaN, sleep_quality: Infinity });
    assert.equal(report.rejected.mood, "not_a_number");
    assert.equal(report.rejected.stress, "not_a_number");
    assert.equal(report.rejected.sleep_quality, "not_a_number");
  });

  it("accepts a numeric string, because a range input sends one", () => {
    assert.equal(normalizeSelfReport({ mood: "7" }).values.mood, 7);
  });

  it("refuses an item this schema version does not define", () => {
    const report = normalizeSelfReport({ support_contact: "yes", secret_field: 1 });
    assert.equal(report.rejected.support_contact, "unknown_item");
    assert.equal(report.rejected.secret_field, "unknown_item");
    assert.equal(report.empty, true);
  });

  it("records a rejection reason and never the value that caused it", () => {
    // A rejected value could be free text a participant typed. Keeping it would
    // put journal-shaped content into an operations field.
    const report = normalizeSelfReport({ mood: "先生に相談した" });
    assert.deepEqual(Object.values(report.rejected), ["not_a_number"]);
    assert.ok(!JSON.stringify(report).includes("先生"));
  });
});

describe("normalisation is total", () => {
  it("survives input that is not an object", () => {
    for (const input of [null, undefined, 42, "mood", [1, 2, 3], true]) {
      const report = normalizeSelfReport(input);
      assert.equal(report.schema_version, SELF_REPORT_SCHEMA_VERSION);
      assert.equal(report.empty, true);
    }
  });

  it("stamps the schema version on every result", () => {
    assert.equal(normalizeSelfReport({ mood: 3 }).schema_version, SELF_REPORT_SCHEMA_VERSION);
  });

  it("reports answered items in presentation order", () => {
    const report = normalizeSelfReport({ event_intensity: 2, mood: 8, sleep_hours: 6 });
    assert.deepEqual(report.answered, ["mood", "sleep_hours", "event_intensity"]);
  });
});
