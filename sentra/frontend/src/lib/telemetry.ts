/**
 * Input telemetry for a submission (#135).
 *
 * `supabaseWriter` has written `entry_sessions`, `entry_fields`,
 * `interaction_events` and `entry_research_links` since the research data layer
 * landed, all behind `if (telemetry.session_id)`. The journal screen never sent
 * a `telemetry` object, so `session_id` was always undefined and those four
 * tables were empty in production — the whole wiring existed except its first
 * inch.
 *
 * What is measured is timing and volume: when a field was first touched, when
 * it was last edited, how many separate edits, how much was deleted, how long
 * the pauses were. What is *not* measured is content. No keystroke, no text, no
 * device fingerprint — `value_length` is a number, and `assertNoRawText` below
 * is the regression test for that promise rather than a comment claiming it.
 */

export type TelemetryFieldName = "first_recall_30" | "mood" | "event_categories" | "journal_entry";

export type FieldMetrics = {
  first_input_at?: string;
  last_input_at?: string;
  focus_count: number;
  blur_count: number;
  input_count: number;
  deletion_count: number;
  paste_count: number;
  revision_count: number;
  pause_count: number;
  max_pause_ms: number;
  active_typing_ms: number;
  skipped: boolean;
};

export type InteractionEvent = {
  field_name: string;
  event_type: string;
  occurred_at: string;
  relative_ms: number;
  value_length?: number;
  selection_start?: number;
  selection_end?: number;
  metadata?: Record<string, string | number | boolean | null>;
};

export type TelemetryPayload = {
  session_id: string;
  started_at: string;
  submitted_at: string;
  client_timezone?: string;
  user_agent?: string;
  events: InteractionEvent[];
  field_metrics: Record<string, FieldMetrics>;
  aggregate_metrics: Record<string, string | number | boolean | null>;
};

/** A gap longer than this counts as a pause rather than continuous typing. */
const PAUSE_THRESHOLD_MS = 2500;
/** Cap on stored events, matching MAX_INTERACTION_EVENTS in the writer. */
const MAX_EVENTS = 1200;

function emptyMetrics(): FieldMetrics {
  return {
    focus_count: 0,
    blur_count: 0,
    input_count: 0,
    deletion_count: 0,
    paste_count: 0,
    revision_count: 0,
    pause_count: 0,
    max_pause_ms: 0,
    active_typing_ms: 0,
    skipped: true,
  };
}

/**
 * Collects one submission's telemetry.
 *
 * Deliberately not a React hook: a hook cannot be unit-tested without a
 * renderer, and this is the part with the logic worth testing. `useTelemetry`
 * in the journal page holds one of these in a ref.
 *
 * The clock is injectable so tests do not have to sleep.
 */
export class EntryTelemetryCollector {
  readonly sessionId: string;
  readonly startedAt: number;
  private readonly now: () => number;
  private readonly events: InteractionEvent[] = [];
  private readonly metrics = new Map<string, FieldMetrics>();
  private readonly lastInputAt = new Map<string, number>();
  private readonly lastLength = new Map<string, number>();
  private droppedEvents = 0;

  constructor(options: { sessionId?: string; now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.sessionId = options.sessionId ?? newSessionId();
    this.startedAt = this.now();
  }

  private metricsFor(field: string): FieldMetrics {
    let entry = this.metrics.get(field);
    if (!entry) {
      entry = emptyMetrics();
      this.metrics.set(field, entry);
    }
    return entry;
  }

  private record(event: InteractionEvent): void {
    if (this.events.length >= MAX_EVENTS) {
      this.droppedEvents += 1;
      return;
    }
    this.events.push(event);
  }

  private stamp(): { occurred_at: string; relative_ms: number; at: number } {
    const at = this.now();
    return { occurred_at: new Date(at).toISOString(), relative_ms: at - this.startedAt, at };
  }

  focus(field: TelemetryFieldName): void {
    const metrics = this.metricsFor(field);
    metrics.focus_count += 1;
    const { occurred_at, relative_ms } = this.stamp();
    this.record({ field_name: field, event_type: "focus", occurred_at, relative_ms });
  }

  blur(field: TelemetryFieldName): void {
    const metrics = this.metricsFor(field);
    metrics.blur_count += 1;
    const { occurred_at, relative_ms } = this.stamp();
    this.record({ field_name: field, event_type: "blur", occurred_at, relative_ms });
  }

  /**
   * One text change. `length` is the new length — never the text.
   *
   * A shorter value than last time is counted as a deletion; the count of them
   * is the "wrote it and deleted it" signal the study is after, and it needs no
   * knowledge of what was deleted.
   */
  input(field: TelemetryFieldName, length: number, selection?: { start?: number; end?: number }): void {
    const metrics = this.metricsFor(field);
    const { occurred_at, relative_ms, at } = this.stamp();
    const previousLength = this.lastLength.get(field) ?? 0;
    const previousAt = this.lastInputAt.get(field);

    metrics.input_count += 1;
    metrics.skipped = false;
    if (length < previousLength) metrics.deletion_count += 1;
    if (!metrics.first_input_at) metrics.first_input_at = occurred_at;
    metrics.last_input_at = occurred_at;

    if (previousAt !== undefined) {
      const gap = at - previousAt;
      if (gap > PAUSE_THRESHOLD_MS) {
        metrics.pause_count += 1;
        metrics.max_pause_ms = Math.max(metrics.max_pause_ms, gap);
        // A new burst after a pause is a revision of what was there.
        metrics.revision_count += 1;
      } else {
        metrics.active_typing_ms += gap;
      }
    }

    this.lastInputAt.set(field, at);
    this.lastLength.set(field, length);
    this.record({
      field_name: field,
      event_type: "input",
      occurred_at,
      relative_ms,
      value_length: length,
      selection_start: selection?.start,
      selection_end: selection?.end,
    });
  }

  /** A discrete choice (mood, a category chip). `optionCount` is how many are
   *  now selected, not which. */
  select(field: TelemetryFieldName, optionCount: number): void {
    const metrics = this.metricsFor(field);
    const { occurred_at, relative_ms } = this.stamp();
    metrics.input_count += 1;
    metrics.skipped = false;
    if (!metrics.first_input_at) metrics.first_input_at = occurred_at;
    metrics.last_input_at = occurred_at;
    this.record({
      field_name: field,
      event_type: "select",
      occurred_at,
      relative_ms,
      value_length: optionCount,
    });
  }

  paste(field: TelemetryFieldName, length: number): void {
    const metrics = this.metricsFor(field);
    metrics.paste_count += 1;
    const { occurred_at, relative_ms } = this.stamp();
    this.record({ field_name: field, event_type: "paste", occurred_at, relative_ms, value_length: length });
  }

  /** Moving between the one-question-at-a-time steps. */
  step(from: string, to: string): void {
    const { occurred_at, relative_ms } = this.stamp();
    this.record({
      field_name: to,
      event_type: "step_change",
      occurred_at,
      relative_ms,
      metadata: { from, to },
    });
  }

  /** A submit attempt that did not persist. Retries are part of the record:
   *  a session with three of these took three tries to save. */
  submitFailed(reason: string): void {
    const { occurred_at, relative_ms } = this.stamp();
    this.record({
      field_name: "submission",
      event_type: "submit_failed",
      occurred_at,
      relative_ms,
      metadata: { reason: reason.slice(0, 120) },
    });
  }

  /**
   * Freeze the payload for sending. Safe to call more than once — a retried
   * submission sends the same `session_id` with a later `submitted_at`, which
   * is what makes `entry_sessions.client_session_id` unique per submission
   * rather than per attempt.
   */
  finalize(options: { timeZone?: string; userAgent?: string } = {}): TelemetryPayload {
    const submittedAt = this.now();
    const fieldMetrics: Record<string, FieldMetrics> = {};
    for (const [field, metrics] of this.metrics) fieldMetrics[field] = { ...metrics };
    return {
      session_id: this.sessionId,
      started_at: new Date(this.startedAt).toISOString(),
      submitted_at: new Date(submittedAt).toISOString(),
      client_timezone: options.timeZone,
      user_agent: options.userAgent,
      events: this.events.slice(0, MAX_EVENTS),
      field_metrics: fieldMetrics,
      aggregate_metrics: {
        total_duration_ms: submittedAt - this.startedAt,
        event_count: this.events.length,
        dropped_event_count: this.droppedEvents,
        fields_touched: this.metrics.size,
        fields_skipped: Array.from(this.metrics.values()).filter((metrics) => metrics.skipped).length,
      },
    };
  }
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * The privacy guarantee, as an assertion rather than a promise in prose.
 *
 * Returns the substrings of the participant's own text that appear anywhere in
 * the serialised payload. It must always be empty; the regression test in
 * `tests/telemetry.test.mjs` fails the build if a future field starts carrying
 * content.
 *
 * Short fragments are skipped — a three-character sample would match by
 * coincidence and say nothing about whether content leaked.
 */
export function findLeakedText(payload: unknown, texts: string[]): string[] {
  const serialized = JSON.stringify(payload ?? {});
  return texts
    .map((text) => text.trim())
    .filter((text) => text.length >= 8 && serialized.includes(text));
}
