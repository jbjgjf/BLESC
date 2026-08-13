/**
 * Server-side Supabase write for a submission (#2).
 *
 * Two backends answer `POST /entries`: FastAPI when `NEXT_PUBLIC_API_URL`
 * points at it, and the route handler in `src/app/api/entries/route.ts`
 * otherwise, which is the Vercel deployment. Until now neither of them wrote
 * anything — `client.ts` took the computed response and inserted it into
 * Supabase from the browser tab, a second write with no retry and no
 * transaction. A closed tab between the response and the last insert left
 * Supabase holding part of a submission.
 *
 * FastAPI now writes its own result (`backend/app/services/supabase_writer.py`).
 * This is the same write for the route handler, so that removing the browser
 * write does not depend on which backend is deployed. The two are intentionally
 * parallel: same tables, same order, same `diff_basis` vocabulary.
 *
 * The service-role key bypasses RLS, which is what allows this module to write
 * rows owned by the signed-in user without holding their session. It is read
 * from `SUPABASE_SERVICE_ROLE_KEY` — never `NEXT_PUBLIC_`-prefixed, and never
 * imported into a client component.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildTemporalDiff, EMPTY_SNAPSHOT, relationShiftSummary, usesLegacyPositionalIds, type SnapshotShape, type TemporalDiff } from "@/lib/temporalDiff";
import {
  MIN_BASELINE_DAYS,
  PERSIST_ANOMALY_SCORE,
  checkRules,
  combineHybridScore,
  evaluateBaseline,
  protectiveDecline,
  scoreTemporalShift,
  topFeatures,
  type DayGraph,
} from "@/lib/baseline";

type Json = Record<string, unknown>;

export type SupabaseSyncResult = {
  status: "written" | "skipped" | "failed";
  entry_id?: string;
  graph_snapshot_id?: string | null;
  insight_id?: string | null;
  entry_session_id?: string | null;
  /** The stored insight, so the caller renders what landed rather than the
   *  empty placeholder it posted. Absent when no insight row was written. */
  anomaly_result?: Record<string, unknown>;
  explanation?: Record<string, unknown>;
  reason?: string;
  warnings: string[];
};

export type SubmissionIdentity = {
  ownerUserId?: string | null;
  participantId?: string | null;
};

/**
 * The subset of a submission response this module reads. Deliberately
 * structural rather than tied to `api/models.ts`: both the route handler's
 * literal and FastAPI's serialised response have to satisfy it.
 */
export type ComputedSubmission = {
  entry: { expires_at?: string | null } & Record<string, unknown>;
  extraction: {
    nodes_json: Array<Json>;
    relations_json: Array<Json>;
    temporal_summary?: string;
    safety_flags_json?: unknown;
    // Only the fields the audit row records — declared structurally so both
    // `SafetyAssessment` and FastAPI's plain dict satisfy it.
    safety_assessment_json?: {
      risk_level?: unknown;
      escalation_required?: unknown;
      reasons?: unknown;
      policy_refs?: unknown;
    } | null;
    extraction_provider: string;
    extraction_model: string;
  };
  graph_snapshot?: {
    day: string;
    nodes_json: Array<Json>;
    relations_json: Array<Json>;
    graph_summary_json: Json;
    temporal_diff_json?: Json;
  } | null;
  // Read only for its `day`. The score is recomputed here — the route handler
  // sends null, and FastAPI's own value is not what lands in this table.
  anomaly_result?: { day?: string; user_id?: string; anomaly_score?: number | null; z_scores_json?: Json } | null;
  explanation?: {
    day?: string;
    triggered_rules_json?: unknown;
    baseline_deviation_json?: Json;
    changed_relations_json?: unknown;
    protective_decline_json?: Json;
    uncertainty_json?: Json;
    evidence_summaries?: unknown;
    graph_summary_json?: Json;
    score_breakdown_json?: Json;
    key_relations?: unknown;
  } | null;
  research_artifacts?: {
    embedding_artifacts?: Array<{
      content_kind: string;
      embedding_model: string;
      vector_json?: number[];
      content_hash: string;
      metadata_json?: Json;
    }>;
    pipeline_version?: string;
  };
};

export type SubmissionContext = {
  observationType: string;
  journalText: string;
  recallText: string;
  telemetry?: Json | null;
  consent?: Json | null;
};

const MAX_INTERACTION_EVENTS = 1200;
const MAX_GRAPH_CHANGE_ROWS = 24;

const DEFAULT_CONSENT = {
  app_use: true,
  research_analysis: true,
  anonymized_export: false,
  future_fine_tuning: false,
  consent_version: "research-consent-v1",
};

let cachedClient: SupabaseClient | null = null;

function serviceRoleClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) return null;
  if (!key) {
    console.warn("[supabase-sync] SUPABASE_URL is set but SUPABASE_SERVICE_ROLE_KEY is not; skipping sync");
    return null;
  }
  if (!cachedClient) {
    cachedClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return cachedClient;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function asDay(value: unknown): string | null {
  return typeof value === "string" && value.length >= 10 ? value.slice(0, 10) : null;
}

/**
 * Throws on a PostgREST error so every failure reaches the caller's guard in
 * one shape. The client is untyped (no generated `Database` type in this
 * project), so returned rows arrive as `never` and are read back as records.
 */
function unwrap(label: string, result: { data: unknown; error: unknown }): Record<string, unknown> {
  if (result.error) {
    const error = result.error as { message?: string };
    throw new Error(`${label}: ${error.message ?? JSON.stringify(result.error)}`);
  }
  if (result.data === null || result.data === undefined) throw new Error(`${label}: no row returned`);
  return result.data as Record<string, unknown>;
}

/**
 * Day-over-day diff computed from Supabase's own history.
 *
 * The route handler builds its `temporal_diff_json` against nothing and labels
 * it `no_previous_lookup`, because it has no participant context. Here there
 * is both a client and a participant id, so the real comparison happens — this
 * is the recomputation that `client.ts` used to own, moved to the server with
 * its `diff_basis` vocabulary intact (#106).
 */
async function temporalDiffAgainstSupabase(
  client: SupabaseClient,
  participantId: string,
  day: string,
  current: SnapshotShape,
  existingDiff: Json,
): Promise<{ diff: Json; previousDayGraph: SnapshotShape | null }> {
  const previousSnapshot = await client
    .from("graph_snapshots")
    .select("nodes_json, relations_json, day, created_at")
    .eq("participant_id", participantId)
    .lt("day", day)
    .order("day", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // A failed lookup must not silently become "no previous day" — that is
  // indistinguishable from the bug being fixed.
  const lookupFailed = Boolean(previousSnapshot.error);
  if (lookupFailed) {
    console.warn("[supabase-sync] previous snapshot lookup failed; diff basis degraded", previousSnapshot.error);
  }
  const hadPrevious = Boolean(previousSnapshot.data);
  const previous: SnapshotShape = previousSnapshot.data
    ? {
        nodes: (previousSnapshot.data.nodes_json ?? []) as SnapshotShape["nodes"],
        relations: (previousSnapshot.data.relations_json ?? []) as SnapshotShape["relations"],
      }
    : EMPTY_SNAPSHOT;
  // Diffing a label-derived snapshot against a positional-id one compares
  // `node_1` to a concept, so every node reads as both removed and added.
  const legacyBoundary = hadPrevious && usesLegacyPositionalIds(previous);
  const diff = buildTemporalDiff(current, legacyBoundary ? EMPTY_SNAPSHOT : previous);

  return {
    diff: {
      ...existingDiff,
      ...diff,
      relation_shift_summary: legacyBoundary
        ? "previous snapshot predates label-derived node identity; not comparable"
        : relationShiftSummary(diff, hadPrevious),
      diff_basis: lookupFailed
        ? "lookup_failed"
        : legacyBoundary
          ? "legacy_id_scheme_boundary"
          : hadPrevious
            ? "previous_snapshot"
            : "first_snapshot_for_participant",
    },
    // Handed back so the insight can measure protective decline against the
    // same previous snapshot the diff was taken against, rather than issuing a
    // second lookup that could disagree with it.
    previousDayGraph: hadPrevious ? previous : null,
  };
}

/**
 * The participant's own prior days, one bucket per distinct day, most recent
 * first — the input a personal baseline is estimated from.
 *
 * This is the piece production never had. The FastAPI backend reads
 * `daily_feature_aggregations` out of SQLite, and in production nothing ever
 * writes there: `NEXT_PUBLIC_API_URL` is unset on Vercel, so submissions go to
 * the route handler and every row lands in Supabase instead. The backend's
 * 14-day ramp could therefore never complete, and the score a student saw came
 * from an arithmetic formula over one submission.
 *
 * Supabase has no aggregation table, but it does not need one: the daily
 * feature vector is a pure function of the nodes and relations, and those are
 * in `graph_snapshots` already.
 */
async function loadBaselineHistory(
  client: SupabaseClient,
  participantId: string,
  beforeDay: string,
): Promise<{ history: DayGraph[][]; lookupFailed: boolean; truncated: boolean }> {
  // Enough rows to reach MIN_BASELINE_DAYS distinct days even for a participant
  // who submits several times a day. `truncated` records the case where it was
  // not — a short window must not be indistinguishable from a student who
  // genuinely has fewer days.
  const ROW_LIMIT = 300;
  const { data, error } = await client
    .from("graph_snapshots")
    .select("day, nodes_json, relations_json")
    .eq("participant_id", participantId)
    .lt("day", beforeDay)
    .order("day", { ascending: false })
    .limit(ROW_LIMIT);

  if (error) {
    console.warn("[insights] baseline history lookup failed", error);
    return { history: [], lookupFailed: true, truncated: false };
  }

  const byDay = new Map<string, DayGraph[]>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const day = String(row.day);
    const bucket = byDay.get(day) ?? [];
    bucket.push({
      nodes: (row.nodes_json ?? []) as DayGraph["nodes"],
      relations: (row.relations_json ?? []) as DayGraph["relations"],
    });
    byDay.set(day, bucket);
  }

  return {
    history: [...byDay.values()].slice(0, MIN_BASELINE_DAYS),
    lookupFailed: false,
    truncated: (data?.length ?? 0) >= ROW_LIMIT && byDay.size < MIN_BASELINE_DAYS,
  };
}

/**
 * The `insights` row for one submission: a real deviation against the student's
 * own history, or an explicit refusal to produce one.
 *
 * Replaces what the route handler used to hand over untouched:
 *
 *     anomaly_score = 1 + triggers * 0.8 - protective * 0.25 + relations * 0.05
 *     baseline_deviation_json = { baseline_available: false, reason: "single production submission" }
 *
 * The second line was true. Nothing read it, and the first line was rendered as
 * "Hybrid Reflection Signal" — a number with a floor of 1.0 that moved with how
 * much a student wrote and could not move with anything else, because it had no
 * history to compare against.
 *
 * This ran in `api/client.ts` until #2. It has to sit next to the insert: it
 * reads history out of `graph_snapshots` and its output IS the row. Now that
 * the insert is here, so is this.
 */
async function buildInsight(params: {
  client: SupabaseClient;
  participantId: string;
  day: string;
  snapshot: ComputedSubmission["graph_snapshot"];
  previousDayGraph: DayGraph | null;
}): Promise<Record<string, unknown>> {
  const { client, participantId, day, snapshot, previousDayGraph } = params;
  const today: DayGraph = {
    nodes: (snapshot?.nodes_json ?? []) as unknown as DayGraph["nodes"],
    relations: (snapshot?.relations_json ?? []) as unknown as DayGraph["relations"],
  };
  const graphSummary = (snapshot?.graph_summary_json ?? {}) as {
    event_count?: number;
    key_relations?: unknown;
  };
  const diff = (snapshot?.temporal_diff_json ?? {}) as unknown as Partial<TemporalDiff>;

  const { history, lookupFailed, truncated } = await loadBaselineHistory(client, participantId, day);
  const outcome = evaluateBaseline([today], history);
  const decline = protectiveDecline(today, previousDayGraph ?? { nodes: [], relations: [] }, Boolean(previousDayGraph));

  const shared = {
    changed_relations_json: diff.changed_relations ?? [],
    protective_decline_json: decline,
    graph_summary_json: graphSummary ?? {},
    key_relations: graphSummary?.key_relations ?? [],
  };

  if (outcome.status === "not_enough_data") {
    // The shape `_persist_not_enough_data_explanation` writes in the backend. A
    // student in their first fortnight gets an explicit empty state, not a
    // score computed against statistics nobody measured (#91).
    const reasons = [
      `Reflection Signal needs at least ${outcome.requiredDays} prior day(s) of this student's own data.`,
      `Only ${outcome.observedDays} prior day(s) are available.`,
    ];
    if (lookupFailed) reasons.push("The history lookup failed, so the day count above is a floor, not a count.");
    if (truncated) reasons.push("The history window was truncated by the row limit; the day count above is a floor.");

    return {
      ...shared,
      // Not written while PERSIST_ANOMALY_SCORE is off. The column is not
      // nullable in older rows, so zero is the same value the backend writes
      // rather than a reading of zero.
      anomaly_score: 0,
      z_scores_json: {},
      triggered_rules_json: [],
      baseline_deviation_json: {
        status: "not_enough_data",
        baseline_available: false,
        baseline_type: "none",
        baseline_provenance: outcome.provenance,
        baseline_day_count: outcome.observedDays,
        required_baseline_days: outcome.requiredDays,
        feature_zscores: {},
        top_features: [],
        score: null,
        latest_feature_vector: outcome.featureVector,
        history_lookup_failed: lookupFailed,
        history_window_truncated: truncated,
      },
      uncertainty_json: {
        level: "high",
        status: "not_enough_data",
        reasons,
        missing_signals: ["personal baseline"],
      },
      evidence_summaries: ["Not enough personal history is available to calculate a Reflection Signal yet."],
      score_breakdown_json: {
        status: "not_enough_data",
        rule_score: 0,
        deviation_score: 0,
        temporal_shift_score: 0,
        final_score: null,
      },
    };
  }

  const ruleHits = checkRules(outcome.featureVector, outcome.zScores, graphSummary, diff, decline);
  const breakdown = combineHybridScore(ruleHits, outcome.deviationScore, scoreTemporalShift(diff));

  return {
    ...shared,
    // Computed, and deliberately not persisted. `PERSIST_ANOMALY_SCORE` is off
    // pending legal review of retaining a risk classification attached to an
    // identifiable minor (docs/educator_display_policy.md). The real value is
    // in score_breakdown_json.final_score, as it is on the backend.
    anomaly_score: PERSIST_ANOMALY_SCORE ? breakdown.final_score : 0,
    z_scores_json: {
      ...outcome.zScores,
      baseline_deviation_score: outcome.deviationScore,
      temporal_shift_score: breakdown.temporal_shift_score,
    },
    triggered_rules_json: ruleHits,
    baseline_deviation_json: {
      status: "ok",
      baseline_available: true,
      baseline_type: outcome.baselineType,
      baseline_provenance: outcome.provenance,
      baseline_day_count: outcome.observedDays,
      required_baseline_days: MIN_BASELINE_DAYS,
      feature_zscores: outcome.zScores,
      top_features: topFeatures(outcome.zScores),
      score: outcome.deviationScore,
      latest_feature_vector: outcome.featureVector,
      // Features that did not move across the whole window, so their z-scores
      // carry no information however large their weight. #85 was this exact
      // failure reported as a measurement.
      degenerate_features: outcome.degenerate,
    },
    uncertainty_json: {
      level: today.nodes.length >= 4 ? "low" : "medium",
      status: "ok",
      reasons: [
        today.nodes.length >= 4 ? "Graph coverage is adequate" : "Sparse graph coverage",
        previousDayGraph ? "Compared with prior structural snapshot" : "No prior graph to compare",
      ],
      missing_signals: outcome.degenerate.length
        ? [`features with no variance across the window: ${outcome.degenerate.join(", ")}`]
        : [],
    },
    evidence_summaries: ruleHits.map((hit) => hit.evidence),
    score_breakdown_json: { status: "ok", ...breakdown },
  };
}

/**
 * Mirror one computed submission into Supabase. Never throws.
 *
 * The three tables the UI reads are chained by foreign key and reported as one
 * outcome. The research mirrors that follow are independent; each failure is
 * named in `warnings` rather than aborting the rest, because those rows
 * duplicate research records that survive elsewhere.
 */
export async function writeEntryResult(
  identity: SubmissionIdentity,
  computed: ComputedSubmission,
  context: SubmissionContext,
): Promise<SupabaseSyncResult> {
  const ownerUserId = identity.ownerUserId;
  const participantId = identity.participantId;
  if (!ownerUserId || !participantId) {
    return { status: "skipped", reason: "owner_user_id/participant_id not supplied", warnings: [] };
  }
  const client = serviceRoleClient();
  if (!client) {
    return { status: "skipped", reason: "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set", warnings: [] };
  }

  const warnings: string[] = [];
  const consent = { ...DEFAULT_CONSENT, ...(context.consent ?? {}) };
  const telemetry = (context.telemetry ?? {}) as Json;
  const pipelineVersion = computed.research_artifacts?.pipeline_version ?? "research-pipeline-v1";
  const { journalText, recallText } = context;

  const mirror = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      console.warn(`[supabase-sync] ${label} mirror failed`, err);
      warnings.push(label);
    }
  };

  let entryId: string;
  let graphSnapshotId: string | null = null;
  let insightId: string | null = null;
  // The insight row, once computed. Returned to the caller as well as written:
  // the route handler emits an empty placeholder because it cannot see history,
  // so this is the only version of the score that measured anything.
  let insightRowValues: Record<string, unknown> | null = null;
  let insightDay: string | null = null;
  // The snapshot as actually written — the recomputed diff, not the one the
  // backend handed over — and the previous day it was compared against.
  let writtenSnapshot: ComputedSubmission["graph_snapshot"] = null;
  let writtenPreviousDayGraph: DayGraph | null = null;
  try {
    const entryRow = unwrap(
      "entries insert",
      await client
        .from("entries")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          // Raw text is never persisted server-side; the column exists for the
          // TTL window that the FastAPI path uses.
          raw_text: null,
          is_masked: true,
          extraction_json: computed.extraction as unknown as Json,
          extraction_provider: computed.extraction.extraction_provider,
          extraction_model: computed.extraction.extraction_model,
          expires_at: computed.entry.expires_at ?? null,
          observation_type: context.observationType,
        })
        .select("id")
        .single(),
    );
    entryId = entryRow.id as string;

    if (computed.graph_snapshot) {
      const snapshot = computed.graph_snapshot;
      const day = asDay(snapshot.day) ?? new Date().toISOString().slice(0, 10);
      const { diff: temporalDiff, previousDayGraph } = await temporalDiffAgainstSupabase(
        client,
        participantId,
        day,
        {
          nodes: (snapshot.nodes_json ?? []) as SnapshotShape["nodes"],
          relations: (snapshot.relations_json ?? []) as SnapshotShape["relations"],
        },
        snapshot.temporal_diff_json ?? {},
      );
      writtenPreviousDayGraph = previousDayGraph as DayGraph | null;
      writtenSnapshot = { ...snapshot, temporal_diff_json: temporalDiff };
      const graphRow = unwrap(
        "graph_snapshots insert",
        await client
          .from("graph_snapshots")
          .insert({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_id: entryId,
            day,
            nodes_json: snapshot.nodes_json ?? [],
            relations_json: snapshot.relations_json ?? [],
            graph_summary_json: snapshot.graph_summary_json ?? {},
            temporal_diff_json: temporalDiff,
            extraction_provider: computed.extraction.extraction_provider,
            extraction_model: computed.extraction.extraction_model,
          })
          .select("id")
          .single(),
      );
      graphSnapshotId = graphRow.id as string;
    }

    if (computed.anomaly_result || computed.explanation) {
      insightDay =
        asDay(computed.anomaly_result?.day) ??
        asDay(computed.explanation?.day) ??
        new Date().toISOString().slice(0, 10);
      // Not copied from `computed`: the route handler emits an empty
      // placeholder there precisely because it cannot see history. The real
      // deviation is estimated here, against the rows just read.
      insightRowValues = await buildInsight({
        client,
        participantId,
        day: insightDay,
        snapshot: writtenSnapshot ?? computed.graph_snapshot,
        previousDayGraph: writtenPreviousDayGraph,
      });
      const insightRow = unwrap(
        "insights insert",
        await client
          .from("insights")
          .insert({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_id: entryId,
            graph_snapshot_id: graphSnapshotId,
            day: insightDay,
            ...insightRowValues,
            extraction_provider: computed.extraction.extraction_provider,
            extraction_model: computed.extraction.extraction_model,
          })
          .select("id")
          .single(),
      );
      insightId = insightRow.id as string;
    }
  } catch (err) {
    console.error("[supabase-sync] core write failed", err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err), warnings };
  }

  await mirror("consent_records", async () => {
    unwrap(
      "consent_records insert",
      await client
        .from("consent_records")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          app_use: Boolean(consent.app_use),
          research_analysis: Boolean(consent.research_analysis),
          anonymized_export: Boolean(consent.anonymized_export),
          future_fine_tuning: Boolean(consent.future_fine_tuning),
          consent_version: String(consent.consent_version),
          source: "next_route_sync",
        })
        .select("id")
        .single(),
    );
  });

  let entrySessionId: string | null = null;
  if (telemetry.session_id) {
    await mirror("entry_sessions", async () => {
      const sessionRow = unwrap(
        "entry_sessions insert",
        await client
          .from("entry_sessions")
          .insert({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            client_session_id: telemetry.session_id,
            status: "submitted",
            started_at: telemetry.started_at,
            submitted_at: telemetry.submitted_at,
            client_timezone: telemetry.client_timezone ?? null,
            user_agent: telemetry.user_agent ?? null,
            consent_snapshot_json: consent,
            aggregate_metrics_json: telemetry.aggregate_metrics ?? {},
          })
          .select("id")
          .single(),
      );
      entrySessionId = sessionRow.id as string;

      const fieldMetrics = (telemetry.field_metrics ?? {}) as Record<string, Json>;
      const fieldRows = await Promise.all(
        ([
          ["journal_entry", journalText],
          ["first_recall_30", recallText],
        ] as const).map(async ([fieldName, text]) => {
          const metrics = fieldMetrics[fieldName] ?? {};
          return {
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_session_id: entrySessionId,
            field_name: fieldName,
            final_text_hash: await sha256(text),
            char_count: text.length,
            word_count: wordCount(text),
            metrics_json: metrics,
            started_at: typeof metrics.first_input_at === "string" ? metrics.first_input_at : null,
            completed_at: typeof metrics.last_input_at === "string" ? metrics.last_input_at : null,
          };
        }),
      );
      const fieldsInsert = await client.from("entry_fields").insert(fieldRows);
      if (fieldsInsert.error) throw new Error(`entry_fields insert: ${fieldsInsert.error.message}`);

      const events = ((telemetry.events ?? []) as Array<Json>).slice(0, MAX_INTERACTION_EVENTS);
      if (events.length > 0) {
        const eventsInsert = await client.from("interaction_events").insert(
          events.map((event) => ({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_session_id: entrySessionId,
            field_name: event.field_name,
            event_type: event.event_type,
            occurred_at: event.occurred_at,
            relative_ms: event.relative_ms ?? 0,
            value_length: event.value_length ?? null,
            selection_start: event.selection_start ?? null,
            selection_end: event.selection_end ?? null,
            metadata_json: event.metadata ?? {},
          })),
        );
        if (eventsInsert.error) throw new Error(`interaction_events insert: ${eventsInsert.error.message}`);
      }

      const linkInsert = await client.from("entry_research_links").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        entry_id: entryId,
        entry_session_id: entrySessionId,
        field_name: "combined_submission",
        source_hash: await sha256(`${journalText}\n\n${recallText}`),
      });
      if (linkInsert.error) throw new Error(`entry_research_links insert: ${linkInsert.error.message}`);
    });
  }

  const embeddingArtifacts = computed.research_artifacts?.embedding_artifacts ?? [];
  if (embeddingArtifacts.length > 0) {
    await mirror("entry_embeddings", async () => {
      const insert = await client.from("entry_embeddings").insert(
        embeddingArtifacts.map((artifact) => ({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          entry_id: entryId,
          content_kind: artifact.content_kind,
          embedding_model: artifact.embedding_model,
          // pgvector's text input format. An empty vector stores as NULL: the
          // column type rejects a zero-dimensional literal.
          embedding: artifact.vector_json?.length ? `[${artifact.vector_json.join(",")}]` : null,
          content_hash: artifact.content_hash,
          metadata_json: {
            ...(artifact.metadata_json ?? {}),
            synced_from_backend_response: true,
            pipeline_version: pipelineVersion,
          },
        })),
      );
      if (insert.error) throw new Error(`entry_embeddings insert: ${insert.error.message}`);
    });
  }

  // model_runs is not bookkeeping: the educator cohort view reads the
  // safety_assessment rows. Losing them empties the safety column.
  await mirror("model_runs", async () => {
    const runInsert = await client
      .from("model_runs")
      .insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        artifact_type: "extraction",
        artifact_id: entryId,
        provider: computed.extraction.extraction_provider ?? "unknown",
        model: computed.extraction.extraction_model ?? "unknown",
        prompt_version: "sentra-production-extraction-v1",
        schema_version: "sentra-entry-extraction-v1",
        pipeline_version: pipelineVersion,
        temperature: 0.2,
        retrieval_config_json: {
          embedding_model: embeddingArtifacts[0]?.embedding_model ?? "unknown",
          source: "next_route_sync",
        },
        input_provenance_json: {
          entry_id: entryId,
          field_names: ["journal_entry", "first_recall_30"],
          journal_text_hash: await sha256(journalText),
          recall_text_hash: await sha256(recallText),
        },
        output_hash: await sha256(JSON.stringify(computed.extraction)),
        status: "completed",
      })
      .select("id")
      .single();
    if (runInsert.error) throw new Error(`model_runs insert: ${runInsert.error.message}`);
    const modelRunId = runInsert.data?.id ?? null;

    const safetyAssessment = computed.extraction.safety_assessment_json;
    if (safetyAssessment) {
      const safetyInsert = await client.from("model_runs").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        artifact_type: "safety_assessment",
        artifact_id: entryId,
        provider: "rules",
        model: "safety-assessment-v1",
        prompt_version: "safety-assessment-v1",
        schema_version: "safety-assessment-v1",
        pipeline_version: pipelineVersion,
        temperature: 0,
        retrieval_config_json: {
          risk_level: safetyAssessment.risk_level,
          escalation_required: safetyAssessment.escalation_required,
          reasons: safetyAssessment.reasons,
          policy_refs: safetyAssessment.policy_refs,
        },
        input_provenance_json: { entry_id: entryId },
        output_hash: await sha256(JSON.stringify(safetyAssessment)),
        status: "completed",
      });
      if (safetyInsert.error) throw new Error(`safety model_runs insert: ${safetyInsert.error.message}`);
    }

    const extractionInsert = await client.from("extractions").insert({
      owner_user_id: ownerUserId,
      participant_id: participantId,
      entry_id: entryId,
      model_run_id: modelRunId,
      nodes_json: computed.extraction.nodes_json ?? [],
      relations_json: computed.extraction.relations_json ?? [],
      temporal_json: { summary: computed.extraction.temporal_summary },
      uncertainty_json: computed.explanation?.uncertainty_json ?? {},
      safety_flags: computed.extraction.safety_flags_json ?? [],
    });
    if (extractionInsert.error) throw new Error(`extractions insert: ${extractionInsert.error.message}`);
  });

  if (computed.graph_snapshot) {
    await mirror("graph_versions", async () => {
      const snapshot = computed.graph_snapshot!;
      const existing = await client
        .from("graph_versions")
        .select("id", { count: "exact", head: true })
        .eq("owner_user_id", ownerUserId)
        .eq("participant_id", participantId);
      const versionInsert = await client
        .from("graph_versions")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          entry_id: entryId,
          graph_snapshot_id: graphSnapshotId,
          version_index: (existing.count ?? 0) + 1,
          nodes_json: snapshot.nodes_json ?? [],
          relations_json: snapshot.relations_json ?? [],
          summary_json: snapshot.graph_summary_json ?? {},
        })
        .select("id")
        .single();
      if (versionInsert.error) throw new Error(`graph_versions insert: ${versionInsert.error.message}`);
      const graphVersionId = versionInsert.data?.id;
      if (!graphVersionId) return;

      const changeRows = [
        ...(snapshot.nodes_json ?? []).slice(0, MAX_GRAPH_CHANGE_ROWS).map((node) => ({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          graph_version_id: graphVersionId,
          change_type: "added",
          entity_type: "node",
          entity_key: node.id,
          previous_json: null,
          current_json: node,
          semantic_drift_score: 0,
          trajectory_tags: [node.category],
        })),
        ...(snapshot.relations_json ?? []).slice(0, MAX_GRAPH_CHANGE_ROWS).map((relation) => ({
          owner_user_id: ownerUserId,
          participant_id: participantId,
          graph_version_id: graphVersionId,
          change_type: "added",
          entity_type: "relation",
          entity_key: `${relation.source_id}:${relation.type}:${relation.target_id}`,
          previous_json: null,
          current_json: relation,
          semantic_drift_score: 0,
          trajectory_tags: [relation.type],
        })),
      ];
      if (changeRows.length > 0) {
        const changeInsert = await client.from("graph_change_events").insert(changeRows);
        if (changeInsert.error) throw new Error(`graph_change_events insert: ${changeInsert.error.message}`);
      }
    });
  }

  await mirror("longitudinal_features", async () => {
    const snapshot = computed.graph_snapshot;
    const day =
      asDay(snapshot?.day) ?? asDay(computed.anomaly_result?.day) ?? new Date().toISOString().slice(0, 10);
    const nodes = snapshot?.nodes_json ?? [];
    const relations = snapshot?.relations_json ?? [];
    const nodeCount = nodes.length;
    const protectiveCount = nodes.filter((node) => node.category === "Protective").length;
    const triggerCount = nodes.filter((node) => node.category === "Trigger").length;
    const relationCount = relations.length;
    const addedNodes = (snapshot?.temporal_diff_json?.added_nodes ?? []) as unknown[];

    const rows = [7, 30].map((windowDays) => {
      const end = new Date(`${day}T00:00:00.000Z`);
      const start = new Date(end);
      start.setUTCDate(start.getUTCDate() - windowDays + 1);
      return {
        owner_user_id: ownerUserId,
        participant_id: participantId,
        window_days: windowDays,
        window_start: start.toISOString().slice(0, 10),
        window_end: day,
        pipeline_version: "longitudinal-v1",
        feature_json: {
          // Always null while PERSIST_ANOMALY_SCORE is off, matching the
          // insights column. This used to carry the route handler's formula, so
          // the longitudinal table accumulated a time series of a number that
          // never measured anything — and a series reads as far stronger
          // evidence than any single value in it.
          latest_anomaly_score: PERSIST_ANOMALY_SCORE
            ? (insightRowValues?.anomaly_score as number | null) ?? null
            : null,
          node_count: nodeCount,
          relation_count: relationCount,
          protective_count: protectiveCount,
          trigger_count: triggerCount,
          protective_ratio: nodeCount ? protectiveCount / nodeCount : 0,
          trigger_ratio: nodeCount ? triggerCount / nodeCount : 0,
          consistency_proxy: relationCount ? nodeCount / relationCount : nodeCount,
          change_rate_proxy: addedNodes.length || nodeCount,
        },
      };
    });
    const insert = await client.from("longitudinal_features").insert(rows);
    if (insert.error) throw new Error(`longitudinal_features insert: ${insert.error.message}`);
  });

  if (consent.research_analysis) {
    await mirror("eval_examples", async () => {
      const insert = await client.from("eval_examples").insert({
        owner_user_id: ownerUserId,
        participant_id: participantId,
        source_entry_id: entryId,
        task_type: "entry_extraction",
        input_json: {
          journal_text_hash: await sha256(journalText),
          recall_text_hash: await sha256(recallText),
          field_names: ["journal_entry", "first_recall_30"],
          journal_char_count: journalText.length,
          recall_char_count: recallText.length,
        },
        expected_output_json: {
          nodes_json: computed.extraction.nodes_json ?? [],
          relations_json: computed.extraction.relations_json ?? [],
          graph_summary_json: computed.graph_snapshot?.graph_summary_json ?? {},
        },
        consent_snapshot_json: consent,
        review_status: "unreviewed",
      });
      if (insert.error) throw new Error(`eval_examples insert: ${insert.error.message}`);
    });
  }

  console.info("[supabase-sync] core rows written", { entryId, graphSnapshotId, insightId, warnings });
  return {
    status: "written",
    entry_id: entryId,
    graph_snapshot_id: graphSnapshotId,
    insight_id: insightId,
    entry_session_id: entrySessionId,
    // The insight travels back so the caller renders what was stored rather
    // than the placeholder it posted. `anomaly_score` follows the same rule the
    // read path applies (`hasSettledBaseline`): a number only when a baseline
    // was actually estimated, null during ramp-up, never zero-as-a-reading.
    ...(insightId && insightRowValues
      ? {
          anomaly_result: {
            id: insightId,
            user_id: computed.anomaly_result?.user_id ?? "",
            day: insightDay ?? "",
            anomaly_score: settledScore(insightRowValues),
            z_scores_json: (insightRowValues.z_scores_json ?? {}) as Record<string, number>,
            explanation_id: insightId,
          },
          explanation: {
            id: insightId,
            user_id: computed.anomaly_result?.user_id ?? "",
            day: insightDay ?? "",
            created_at: new Date().toISOString(),
            ...insightRowValues,
          },
        }
      : {}),
    warnings,
  };
}

/**
 * The score a consumer may render: present only when the row rests on a real
 * personal baseline. Mirrors `hasSettledBaseline` on the read path, so a
 * freshly written row and the same row read back agree.
 */
function settledScore(insight: Record<string, unknown>): number | null {
  const deviation = insight.baseline_deviation_json as { baseline_available?: boolean } | undefined;
  if (deviation?.baseline_available !== true) return null;
  return (insight.anomaly_score as number | null) ?? null;
}
