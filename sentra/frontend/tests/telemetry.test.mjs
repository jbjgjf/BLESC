import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EntryTelemetryCollector, findLeakedText } from "../src/lib/telemetry.ts";

/** A collector on a clock the test drives, so nothing has to sleep. */
function collectorAt(start = 1_000_000) {
  let now = start;
  const collector = new EntryTelemetryCollector({ sessionId: "sess-test", now: () => now });
  return { collector, advance: (ms) => { now += ms; } };
}

describe("EntryTelemetryCollector", () => {
  it("produces a session id and both timestamps", () => {
    const { collector, advance } = collectorAt();
    advance(5000);
    const payload = collector.finalize({ timeZone: "Asia/Tokyo" });
    assert.equal(payload.session_id, "sess-test");
    assert.equal(payload.client_timezone, "Asia/Tokyo");
    assert.equal(payload.started_at, new Date(1_000_000).toISOString());
    assert.equal(payload.submitted_at, new Date(1_005_000).toISOString());
    assert.equal(payload.aggregate_metrics.total_duration_ms, 5000);
  });

  it("records first and last input time for a field", () => {
    const { collector, advance } = collectorAt();
    advance(2000);
    collector.input("journal_entry", 5);
    advance(1000);
    collector.input("journal_entry", 12);
    const metrics = collector.finalize().field_metrics.journal_entry;
    assert.equal(metrics.first_input_at, new Date(1_002_000).toISOString());
    assert.equal(metrics.last_input_at, new Date(1_003_000).toISOString());
    assert.equal(metrics.input_count, 2);
  });

  it("counts a shortening edit as a deletion", () => {
    const { collector } = collectorAt();
    collector.input("journal_entry", 20);
    collector.input("journal_entry", 8);
    collector.input("journal_entry", 30);
    const metrics = collector.finalize().field_metrics.journal_entry;
    assert.equal(metrics.deletion_count, 1);
  });

  it("counts a long gap as a pause and a resumption as a revision", () => {
    const { collector, advance } = collectorAt();
    collector.input("journal_entry", 5);
    advance(9000);
    collector.input("journal_entry", 9);
    const metrics = collector.finalize().field_metrics.journal_entry;
    assert.equal(metrics.pause_count, 1);
    assert.equal(metrics.max_pause_ms, 9000);
    assert.equal(metrics.revision_count, 1);
    assert.equal(metrics.active_typing_ms, 0);
  });

  it("accumulates continuous typing as active time, not as pauses", () => {
    const { collector, advance } = collectorAt();
    collector.input("journal_entry", 2);
    advance(400);
    collector.input("journal_entry", 4);
    advance(600);
    collector.input("journal_entry", 6);
    const metrics = collector.finalize().field_metrics.journal_entry;
    assert.equal(metrics.pause_count, 0);
    assert.equal(metrics.active_typing_ms, 1000);
  });

  it("marks a field that was focused but never edited as skipped", () => {
    const { collector } = collectorAt();
    collector.focus("first_recall_30");
    collector.blur("first_recall_30");
    collector.input("journal_entry", 10);
    const payload = collector.finalize();
    assert.equal(payload.field_metrics.first_recall_30.skipped, true);
    assert.equal(payload.field_metrics.journal_entry.skipped, false);
    assert.equal(payload.aggregate_metrics.fields_skipped, 1);
  });

  it("records how many options are selected, never which", () => {
    const { collector } = collectorAt();
    collector.select("event_categories", 2);
    const events = collector.finalize().events.filter((event) => event.event_type === "select");
    assert.equal(events.length, 1);
    assert.equal(events[0].value_length, 2);
    assert.equal(events[0].field_name, "event_categories");
  });

  it("keeps the same session id across a retried submission", () => {
    // #135: a retry is the same submission. Two finalize() calls must not
    // produce two sessions, or entry_sessions gains a row per attempt.
    const { collector, advance } = collectorAt();
    collector.input("journal_entry", 4);
    const first = collector.finalize();
    advance(3000);
    const second = collector.finalize();
    assert.equal(first.session_id, second.session_id);
    assert.notEqual(first.submitted_at, second.submitted_at);
  });

  it("records a failed submit attempt without its content", () => {
    const { collector } = collectorAt();
    collector.submitFailed("EntryNotPersistedError");
    const event = collector.finalize().events.find((e) => e.event_type === "submit_failed");
    assert.ok(event);
    assert.equal(event.metadata.reason, "EntryNotPersistedError");
  });
});

describe("privacy regression", () => {
  it("carries no journal content anywhere in the payload", () => {
    // The guarantee #135 is built on: telemetry measures timing and volume.
    // If a future field starts carrying text, this test fails.
    const journal = "今日は部活で失敗して、家に帰ってから何もする気になれなかった";
    const recall = "頭から離れないのは、明日の朝の練習のこと";

    const { collector, advance } = collectorAt();
    collector.focus("first_recall_30");
    for (let index = 1; index <= recall.length; index += 1) {
      collector.input("first_recall_30", index, { start: index, end: index });
      advance(50);
    }
    collector.blur("first_recall_30");
    collector.select("mood", 1);
    collector.select("event_categories", 2);
    collector.paste("journal_entry", journal.length);
    for (let index = 1; index <= journal.length; index += 1) {
      collector.input("journal_entry", index);
      advance(50);
    }
    collector.step("events", "note");
    collector.submitFailed("network");

    const payload = collector.finalize({ timeZone: "Asia/Tokyo", userAgent: "test-agent" });
    assert.deepEqual(findLeakedText(payload, [journal, recall]), []);

    // And the lengths did survive — the test would also pass on an empty
    // payload, which would prove nothing.
    assert.equal(payload.field_metrics.journal_entry.last_input_at !== undefined, true);
    assert.equal(
      payload.events.some((event) => event.value_length === journal.length),
      true,
    );
  });

  it("findLeakedText catches a payload that does carry content", () => {
    const leaked = { events: [{ field_name: "journal_entry", text: "今日は部活で失敗した" }] };
    assert.deepEqual(findLeakedText(leaked, ["今日は部活で失敗した"]), ["今日は部活で失敗した"]);
  });
});
