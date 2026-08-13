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
import { buildTemporalDiff, EMPTY_SNAPSHOT, relationShiftSummary, usesLegacyPositionalIds, type SnapshotShape } from "@/lib/temporalDiff";

type Json = Record<string, unknown>;

export type SupabaseSyncResult = {
  status: "written" | "skipped" | "failed";
  entry_id?: string;
  graph_snapshot_id?: string | null;
  insight_id?: string | null;
  entry_session_id?: string | null;
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
  anomaly_result?: { day?: string; anomaly_score?: number; z_scores_json?: Json } | null;
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
): Promise<Json> {
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
      const temporalDiff = await temporalDiffAgainstSupabase(
        client,
        participantId,
        day,
        {
          nodes: (snapshot.nodes_json ?? []) as SnapshotShape["nodes"],
          relations: (snapshot.relations_json ?? []) as SnapshotShape["relations"],
        },
        snapshot.temporal_diff_json ?? {},
      );
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
      const day =
        asDay(computed.anomaly_result?.day) ??
        asDay(computed.explanation?.day) ??
        new Date().toISOString().slice(0, 10);
      const insightRow = unwrap(
        "insights insert",
        await client
          .from("insights")
          .insert({
            owner_user_id: ownerUserId,
            participant_id: participantId,
            entry_id: entryId,
            graph_snapshot_id: graphSnapshotId,
            day,
            anomaly_score: computed.anomaly_result?.anomaly_score ?? 0,
            z_scores_json: computed.anomaly_result?.z_scores_json ?? {},
            triggered_rules_json: computed.explanation?.triggered_rules_json ?? [],
            baseline_deviation_json: computed.explanation?.baseline_deviation_json ?? {},
            changed_relations_json: computed.explanation?.changed_relations_json ?? [],
            protective_decline_json: computed.explanation?.protective_decline_json ?? {},
            uncertainty_json: computed.explanation?.uncertainty_json ?? {},
            evidence_summaries: computed.explanation?.evidence_summaries ?? [],
            graph_summary_json:
              computed.explanation?.graph_summary_json ?? computed.graph_snapshot?.graph_summary_json ?? {},
            score_breakdown_json: computed.explanation?.score_breakdown_json ?? {},
            key_relations: computed.explanation?.key_relations ?? [],
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
          latest_anomaly_score: computed.anomaly_result?.anomaly_score ?? null,
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
    warnings,
  };
}
