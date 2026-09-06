import {
  AnomalyResult,
  AudioTranscriptionResponse,
  ChatResponse,
  CounselorSupportSummary,
  ConsentSnapshot,
  ConversationMemoryObject,
  ConversationRecallSummary,
  DailyFeatureAggregation,
  Entry,
  EntryTelemetryPayload,
  EntrySubmissionResponse,
  ExplanationPayload,
  GraphSnapshot,
  GraphSnapshotResponse,
  JsonValue,
  RecordId,
  CohortAlert,
  EducatorStudentStatus,
  OrgCounselor,
  OversightRequest,
  ReflectionAuditTrail,
  SharedSupportSummary,
  StudentAccessRecord,
} from "./models";
import { supabase } from "@/lib/supabase/client";
import { NO_CONSENT, consentSnapshot, normalizeConsent, type ConsentState } from "@/lib/consent";
import { EMPTY_STATS, computeJournalStats, type JournalStats } from "@/lib/journalStats";
import { generateCounselorSummary, type CounselorTimelineEvent } from "@/lib/counselor-summary";
import { buildAuditTrails, type ModelRunRecord } from "@/lib/audit-trail";
import { t } from "@/lib/i18n";
import { readDemoFlag } from "@/lib/demo";
import * as demo from "@/lib/blesc/demoApi";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "/api";
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

function shouldAttachAuthorizationHeader() {
  if (typeof window === "undefined") return true;
  if (API_BASE_URL.startsWith("/")) return false;
  try {
    return new URL(API_BASE_URL, window.location.origin).origin !== window.location.origin;
  } catch {
    return true;
  }
}

type ParticipantRow = {
  id: string;
  code: string;
};

type EntryRow = {
  id: string;
  // No `raw_text`. The column-level grants added in the 20260906 migration
  // take SELECT on the raw-text columns away from `authenticated`, so naming
  // one here would make every entry read fail — which is the point: the read
  // path a student or educator travels cannot reach retained journal text
  // (#131).
  is_masked: boolean;
  extraction_json: Record<string, JsonValue>;
  expires_at: string | null;
  created_at: string;
  participant_id: string;
  participants?: { code: string } | { code: string }[] | null;
  observation_type?: string;
  extraction_provider?: string;
  extraction_model?: string;
};

type SummaryEntryRow = Pick<EntryRow, "id" | "created_at" | "extraction_json">;

type GraphSnapshotRow = {
  id: string;
  entry_id: string | null;
  day: string;
  nodes_json: JsonValue;
  relations_json: JsonValue;
  graph_summary_json: JsonValue;
  temporal_diff_json: JsonValue;
  extraction_provider?: string;
  extraction_model?: string;
  created_at: string;
  participants?: { code: string } | { code: string }[] | null;
};

type InsightRow = {
  id: string;
  day: string;
  anomaly_score: number;
  z_scores_json: Record<string, number> | null;
  triggered_rules_json: JsonValue;
  baseline_deviation_json: Record<string, JsonValue> | null;
  changed_relations_json: JsonValue;
  protective_decline_json: Record<string, JsonValue> | null;
  uncertainty_json: Record<string, JsonValue> | null;
  evidence_summaries: JsonValue;
  graph_summary_json: JsonValue;
  score_breakdown_json: Record<string, JsonValue> | null;
  key_relations: JsonValue;
  extraction_provider?: string;
  extraction_model?: string;
  created_at: string;
  participants?: { code: string } | { code: string }[] | null;
};

type ConversationRecallSummaryRow = {
  id: string;
  window_turn_count: number;
  message_start: string | null;
  message_end: string | null;
  summary_json: Record<string, JsonValue>;
  source_message_hashes_json: JsonValue;
  memory_object_ids_json?: JsonValue;
  pipeline_version: string;
  status: string;
  created_at: string;
};

function asArray<T>(value: JsonValue | undefined, fallback: T[] = []): T[] {
  return Array.isArray(value) ? value as T[] : fallback;
}

function asRecord<T extends Record<string, unknown>>(value: JsonValue | null | undefined, fallback: T): T {
  return value && typeof value === "object" && !Array.isArray(value) ? value as T : fallback;
}

function participantCode(row: { participants?: { code: string } | { code: string }[] | null }, fallback: string): string {
  const participant = Array.isArray(row.participants) ? row.participants[0] : row.participants;
  return participant?.code ?? fallback;
}

function summaryEvent(row: SummaryEntryRow): CounselorTimelineEvent {
  const extraction = asRecord(row.extraction_json, {} as Record<string, JsonValue>);
  const emotional = asRecord(extraction.emotional_state_json, {} as Record<string, JsonValue>);
  const assessment = asRecord(extraction.safety_assessment_json, {} as Record<string, JsonValue>);
  const nodes = asArray<Record<string, JsonValue>>(extraction.nodes_json);
  const labels = (values: JsonValue | undefined) => asArray<Record<string, JsonValue>>(values).map((item) => String(item.label ?? "")).filter(Boolean);
  const nodeLabels = (category: string) => nodes.filter((node) => node.category === category).map((node) => String(node.label ?? "")).filter(Boolean);
  const unique = (values: string[]) => [...new Set(values)];
  const primaryEmotion = asArray<Record<string, JsonValue>>(emotional.primary_emotions)[0]?.label ?? nodes.find((node) => node.category === "State")?.label;
  const safetyClassification = asRecord(emotional.safety_classification, {} as Record<string, JsonValue>);
  return {
    event_id: String(row.id),
    timestamp: row.created_at,
    primary_emotion: primaryEmotion ? String(primaryEmotion) : undefined,
    intensity: typeof emotional.intensity === "number" ? emotional.intensity : undefined,
    triggers: unique([...labels(emotional.trigger_candidates), ...nodeLabels("Trigger")]),
    support_needs: unique(labels(emotional.support_needs)),
    protective_factors: unique([...labels(emotional.protective_factors), ...nodeLabels("Protective")]),
    safety_level: String(assessment.risk_level ?? safetyClassification.level ?? "none"),
    safety_reasons: asArray<string>(assessment.reasons, asArray<string>(extraction.safety_flags_json, asArray<string>(safetyClassification.flags))),
  };
}

function throwSupabaseError(context: string, error: unknown): never {
  if (error instanceof Error) {
    throw new Error(`${context}: ${error.message}`);
  }
  if (error && typeof error === "object") {
    const details = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts = [details.message, details.details, details.hint, details.code].filter(Boolean).map(String);
    throw new Error(`${context}: ${parts.join(" | ") || JSON.stringify(error)}`);
  }
  throw new Error(`${context}: ${String(error)}`);
}

async function stableHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The entry computed but did not reach the database (#132).
 *
 * A distinct type because the journal screen has to tell these apart from a
 * network error: both mean "not saved", but this one is already known to the
 * server, which has recorded it in `submission_failures`, and the retry that
 * follows carries the same submission id so the two attempts cannot both land.
 */
export class EntryNotPersistedError extends Error {
  readonly syncStatus: string;
  readonly reason?: string;

  constructor(syncStatus: string, reason?: string) {
    super(
      syncStatus === "skipped"
        ? "日記を保存できませんでした（保存先が設定されていません）。"
        : "日記を保存できませんでした。",
    );
    this.name = "EntryNotPersistedError";
    this.syncStatus = syncStatus;
    this.reason = reason;
  }
}

async function responseError(prefix: string, res: Response): Promise<Error> {
  let detail = res.statusText || `HTTP ${res.status}`;
  try {
    const payload = await res.json();
    if (typeof payload.detail === "string") detail = payload.detail;
    else if (typeof payload.error === "string") detail = payload.error;
  } catch {
    // Keep status text when the body is not JSON.
  }
  return new Error(`${prefix} (${res.status}): ${detail}`);
}

function toEntry(row: EntryRow, userId: string): Entry {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    // Never populated from a read. Retained text is decrypted only by the
    // research export path, under the `research_reader` role.
    raw_text: undefined,
    is_masked: row.is_masked,
    created_at: row.created_at,
    expires_at: row.expires_at ?? undefined,
    observation_type: row.observation_type,
  };
}

function toGraphSnapshot(row: GraphSnapshotRow, userId: string): GraphSnapshot {
  return {
    id: row.id,
    entry_id: row.entry_id ?? row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    nodes_json: asArray(row.nodes_json),
    relations_json: asArray(row.relations_json),
    graph_summary_json: asRecord(row.graph_summary_json, {
      node_count: 0,
      relation_count: 0,
      event_count: 0,
      key_nodes: [],
      key_relations: [],
      summary: "",
    }),
    temporal_diff_json: asRecord(row.temporal_diff_json, {
      added_nodes: [],
      removed_nodes: [],
      added_relations: [],
      removed_relations: [],
      changed_relations: [],
      relation_shift_summary: "",
      protective_decline: {},
      uncertainty: {},
    }),
    extraction_provider: row.extraction_provider ?? "unknown",
    extraction_model: row.extraction_model ?? "unknown",
    created_at: row.created_at,
  };
}

/**
 * Whether a stored insight row rests on a real personal baseline.
 *
 * This is the single gate every consumer of a score goes through, and it is
 * deliberately positive-only: a row counts as a measurement when it says so,
 * not when it fails to say otherwise. Three kinds of row do not qualify:
 *
 *  - a student still inside the 14-day ramp, where there is no baseline (#91);
 *  - a row from the route handler, which cannot see history at all;
 *  - every row written before this change, whose `anomaly_score` holds
 *    `1 + triggers*0.8 - protective*0.25 + relations*0.05` and whose
 *    `baseline_deviation_json` already recorded `baseline_available: false`.
 *
 * The third is why this is applied on read rather than only on write. Those
 * rows are still in the table — deleting them is irreversible and waits on the
 * same legal advice as the retention question — and they must stop rendering as
 * measurements now, not whenever they age out.
 */
function hasSettledBaseline(row: InsightRow): boolean {
  return row.baseline_deviation_json?.baseline_available === true;
}

function toAnomaly(row: InsightRow, userId: string): AnomalyResult {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    anomaly_score: hasSettledBaseline(row) ? row.anomaly_score : null,
    z_scores_json: hasSettledBaseline(row) ? row.z_scores_json ?? {} : {},
    explanation_id: row.id,
  };
}

function toExplanation(row: InsightRow, userId: string): ExplanationPayload {
  return {
    id: row.id,
    user_id: participantCode(row, userId),
    day: row.day,
    triggered_rules_json: asArray(row.triggered_rules_json),
    baseline_deviation_json: row.baseline_deviation_json ?? {},
    changed_relations_json: asArray(row.changed_relations_json),
    protective_decline_json: row.protective_decline_json ?? {},
    uncertainty_json: row.uncertainty_json ?? {},
    evidence_summaries: asArray<string>(row.evidence_summaries),
    graph_summary_json: asRecord(row.graph_summary_json, {
      node_count: 0,
      relation_count: 0,
      event_count: 0,
      key_nodes: [],
      key_relations: [],
      summary: "",
    }),
    score_breakdown_json: row.score_breakdown_json ?? {},
    key_relations: asArray(row.key_relations),
    created_at: row.created_at,
  };
}

function toConversationRecall(row: ConversationRecallSummaryRow): ConversationRecallSummary {
  return {
    id: row.id,
    status: row.status,
    window_turn_count: row.window_turn_count,
    required_turn_count: 6,
    message_start: row.message_start,
    message_end: row.message_end,
    summary_json: row.summary_json as ConversationRecallSummary["summary_json"],
    source_message_hashes: asArray<string>(row.source_message_hashes_json),
    memory_object_ids: asArray<string | number>(row.memory_object_ids_json),
    pipeline_version: row.pipeline_version,
    created_at: row.created_at,
  };
}

export class ApiClient {
  static async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (shouldAttachAuthorizationHeader() && !headers.has("Authorization")) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) {
        headers.set("Authorization", `Bearer ${data.session.access_token}`);
      }
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        headers,
        signal: options.signal ?? controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`${t.apiError.requestTimedOut(DEFAULT_REQUEST_TIMEOUT_MS / 1000)}: ${path}`);
      }
      throw err;
    } finally {
      window.clearTimeout(timeout);
    }
    if (!res.ok) {
      throw await responseError(t.apiError.requestFailed, res);
    }
    return res.json();
  }

  static async transcribeAudio(file: File): Promise<AudioTranscriptionResponse> {
    const body = new FormData();
    const headers = new Headers();
    if (shouldAttachAuthorizationHeader()) {
      const { data } = await supabase.auth.getSession();
      if (data.session?.access_token) headers.set("Authorization", `Bearer ${data.session.access_token}`);
    }
    body.append("file", file);
    const res = await fetch(`${API_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers,
      body,
    });
    if (!res.ok) {
      throw await responseError(t.apiError.transcriptionFailed, res);
    }
    return res.json();
  }

  private static async requireOwnerId(): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw new Error(t.apiError.notAuthenticated);
    }
    return data.user.id;
  }

  private static async getParticipant(userId: string): Promise<ParticipantRow> {
    const ownerUserId = await this.requireOwnerId();
    const { data, error } = await supabase
      .from("participants")
      .select("id, code")
      .eq("owner_user_id", ownerUserId)
      .eq("code", userId)
      .single();

    if (error) throwSupabaseError(t.apiError.loadParticipant, error);
    return data;
  }

  static async getEntries(userId: string): Promise<Entry[]> {
    if (readDemoFlag()) return demo.demoEntries();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("entries")
      .select("id, is_masked, extraction_json, expires_at, created_at, participant_id, observation_type, extraction_provider, extraction_model, participants!entries_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false });

    if (error) throwSupabaseError(t.apiError.loadEntries, error);
    return (data ?? []).map((row) => toEntry(row as unknown as EntryRow, userId));
  }

  /**
   * Submit an entry. The backend computes it, writes it to Supabase, and
   * returns the result; this method does not write to Supabase at all (#2).
   * Either backend does the write — FastAPI when `NEXT_PUBLIC_API_URL` points
   * at it, otherwise the route handler in `src/app/api/entries/`.
   *
   * It used to. The backend computed the submission, returned it, and this
   * method then inserted that response into `entries`, `graph_snapshots`,
   * `insights` and a dozen research tables — a second write, from a browser
   * tab, with no retry. A closed tab or one failed request left Supabase
   * holding part of a submission while SQLite held all of it, and the two
   * drifted apart with nothing to reconcile them.
   *
   * The baseline computation that used to run here went with it, to
   * `lib/server/supabaseWriter.ts`. It has to sit next to the insert: it reads
   * the participant's history out of `graph_snapshots` and its output IS the
   * insight row. Splitting the two would mean two round trips to Supabase from
   * different processes, with the row written by one of them.
   *
   * No identity is sent. The backend derives the owner from the caller's
   * session — the cookie for the route handler, the bearer token for FastAPI —
   * and resolves the participant from `userId` scoped to that owner. An earlier
   * version posted `owner_user_id` and `participant_id` in the body; because
   * the write uses the service-role key, which bypasses RLS, that let any
   * caller name any participant and have rows created under it.
   *
   * `supabase_sync` on the response reports what the backend wrote. When it
   * carries row ids, those replace the backend's own ids so the returned object
   * matches what a subsequent read from Supabase will show.
   *
   * **Throws `EntryNotPersistedError` when the entry is not durably stored.**
   *
   * It used to not throw. `status: "failed"` was logged to the console with a
   * comment explaining the decision — "the submission itself succeeded and the
   * student\'s result is in hand" — and `status: "skipped"` produced no output
   * at all. The journal screen\'s `persistJournal` was a `try/catch` around
   * this call, so a method that never threw made it a function that always
   * returned true, and the student saw "今日の日記を記録しました" over a
   * submission that reached no database (#132).
   *
   * Durable means `written` with an `entry_id`. Everything else — a failed
   * write, a skipped one, a response with no id — throws, because from the
   * student\'s side those are the same event: what they wrote is gone.
   * `warnings` do not throw: the core rows landed and only research mirrors
   * are missing, which is worth recording and not worth losing the entry over.
   */
  static async createEntry(
    userId: string,
    text: string,
    observationType: string = "daily",
    researchPayload?: {
      journal_text?: string;
      recall_text?: string;
      telemetry?: EntryTelemetryPayload;
      consent?: ConsentSnapshot;
      /** Stable across retries of the same submission, so the server can
       *  collapse them into one row (#132). */
      client_submission_id?: string;
    },
  ): Promise<EntrySubmissionResponse> {
    const computed = await this.fetch<EntrySubmissionResponse>(`/entries?user_id=${encodeURIComponent(userId)}&observation_type=${encodeURIComponent(observationType)}`, {
      method: "POST",
      body: JSON.stringify({
        text,
        journal_text: researchPayload?.journal_text ?? text,
        recall_text: researchPayload?.recall_text ?? "",
        telemetry: researchPayload?.telemetry,
        consent: researchPayload?.consent,
        client_submission_id: researchPayload?.client_submission_id,
      }),
    });

    const sync = computed.supabase_sync;
    if (sync?.warnings?.length) {
      console.warn("[entries] backend Supabase sync incomplete", sync.warnings);
    }
    if (!sync || sync.status !== "written" || !sync.entry_id) {
      throw new EntryNotPersistedError(sync?.status ?? "missing", sync?.reason);
    }
    // The insight is the backend's, not the route handler's empty placeholder:
    // only the writer had the history to estimate a baseline from, so its
    // anomaly_result and explanation are the ones that measured anything.
    return {
      ...computed,
      entry: { ...computed.entry, id: sync.entry_id },
      extraction: { ...computed.extraction, entry_id: sync.entry_id },
      graph_snapshot: computed.graph_snapshot && sync.graph_snapshot_id
        ? { ...computed.graph_snapshot, id: sync.graph_snapshot_id, entry_id: sync.entry_id }
        : computed.graph_snapshot,
      anomaly_result: sync.anomaly_result ?? computed.anomaly_result,
      explanation: sync.explanation ?? computed.explanation,
    };
  }

  /**
   * The participant's stored consent (#134).
   *
   * Read through the browser's own RLS-scoped client: a student may read their
   * own consent record and nobody else's. Grants go through the API route
   * instead, so the server records the source and can act on a revocation.
   */
  static async getConsent(userId: string): Promise<ConsentState> {
    try {
      const ownerUserId = await this.requireOwnerId();
      const participant = await this.getParticipant(userId);
      const { data, error } = await supabase
        .from("consent_records")
        .select(
          "app_use, research_analysis, anonymized_export, raw_text_retention, future_fine_tuning, minor_assent, guardian_consent, consent_version, document_version, status, granted_at, revoked_at, created_at",
        )
        .eq("owner_user_id", ownerUserId)
        .eq("participant_id", participant.id)
        .order("granted_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return { ...NO_CONSENT };
      return normalizeConsent(data);
    } catch {
      // No session, no participant, no table — all mean "nothing is consented
      // to", which is the answer that keeps research data out of the database.
      return { ...NO_CONSENT };
    }
  }

  /** Record a consent decision. Each grant is sent explicitly; an omitted one
   *  is a refusal, never an inherited yes. */
  static async grantConsent(
    userId: string,
    grants: {
      app_use: boolean;
      research_analysis: boolean;
      anonymized_export: boolean;
      raw_text_retention: boolean;
      future_fine_tuning: boolean;
      minor_assent: boolean;
      guardian_consent: boolean;
      document_version?: string;
    },
  ): Promise<ConsentState> {
    const result = await this.fetch<{ consent: ConsentState }>(
      `/consent?user_id=${encodeURIComponent(userId)}`,
      { method: "POST", body: JSON.stringify(grants) },
    );
    return normalizeConsent(result.consent);
  }

  /** Withdraw consent. The server records the revocation and deletes any
   *  retained journal text before returning (#131). */
  static async revokeConsent(userId: string): Promise<ConsentState> {
    const result = await this.fetch<{ consent: ConsentState }>(
      `/consent?user_id=${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
    return normalizeConsent(result.consent);
  }

  /**
   * Persist one follow-up answer (#133).
   *
   * Sent per answer rather than as a batch at the end: the panel can be closed
   * at any point, and the answers given before that are the ones most worth
   * keeping — the follow-up fires precisely for the students whose entries
   * warranted asking.
   */
  static async saveFollowupResponse(
    userId: string,
    response: {
      entry_id: string;
      entry_session_id?: string | null;
      probe_id: string;
      probe_index: number;
      probe_version?: string;
      question_text: string;
      answer_kind: "choice" | "free_text" | "none";
      answer_text?: string | null;
      outcome: "answered" | "declined" | "stopped" | "abandoned";
      answered_at?: string;
    },
  ): Promise<void> {
    await this.fetch(`/entries/followups?user_id=${encodeURIComponent(userId)}`, {
      method: "POST",
      body: JSON.stringify(response),
    });
  }

  /**
   * Streak and weekly counts from the participant's own submissions (#133).
   *
   * The completion screen counted up to a hard-coded 7 and 6. These come from
   * `entries.created_at`, bucketed into the viewer's local calendar days.
   */
  static async getJournalStats(userId: string, timeZone?: string): Promise<JournalStats> {
    try {
      const ownerUserId = await this.requireOwnerId();
      const participant = await this.getParticipant(userId);
      const { data, error } = await supabase
        .from("entries")
        .select("created_at")
        .eq("owner_user_id", ownerUserId)
        .eq("participant_id", participant.id)
        .order("created_at", { ascending: false })
        .limit(400);
      if (error || !data) return { ...EMPTY_STATS };
      const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      return computeJournalStats((data as Array<{ created_at: string }>).map((row) => row.created_at), zone);
    } catch {
      return { ...EMPTY_STATS };
    }
  }

  static async createChat(userId: string, message: string, limit = 5, options: { mode?: "general" | "recall_workspace"; conversationContext?: string[] } = {}): Promise<ChatResponse> {
    if (readDemoFlag()) return demo.demoChatReply(message);
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const chatConsent = await this.getConsent(userId);
    const response = await this.fetch<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        participant_code: userId,
        message,
        limit,
        mode: options.mode ?? "general",
        conversation_context: options.conversationContext ?? [],
      }),
    });
    if (response.mirrored) return response;

    try {
      const chatSession = await supabase
        .from("chat_sessions")
        .insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          // The participant's stored consent, not a claim.
          //
          // This was `{ app_use: true, research_analysis: true }`, hard-coded,
          // written on every chat session regardless of what the participant
          // had agreed to — the same defect as the entry writer's
          // DEFAULT_CONSENT, in a second place (#134).
          consent_snapshot_json: { ...consentSnapshot(chatConsent), source: "student_ui" },
        })
        .select("id")
        .single();

      if (chatSession.error || !chatSession.data) {
        console.warn("[chat] Supabase session mirror skipped", chatSession.error);
        return response;
      }

      const userHash = await stableHash(message);
      const assistantHash = await stableHash(response.answer);
      const { error } = await supabase.from("chat_messages").insert([
        {
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          chat_session_id: chatSession.data.id,
          role: "user",
          content_hash: userHash,
          content_redacted: message.slice(0, 500),
          evidence_refs_json: [],
        },
        {
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          chat_session_id: chatSession.data.id,
          role: "assistant",
          content_hash: assistantHash,
          content_redacted: response.answer.slice(0, 1000),
          evidence_refs_json: response.evidence_refs as unknown as JsonValue,
        },
      ]);
      if (error) console.warn("[chat] Supabase message mirror skipped", error);
    } catch (err) {
      console.warn("[chat] Supabase mirror failed", err);
    }

    const recall = response.conversation_recall_30;
    if (recall) {
      try {
        const { error } = await supabase.from("conversation_recall_summaries").insert({
          owner_user_id: ownerUserId,
          participant_id: participant.id,
          window_turn_count: recall.window_turn_count,
          message_start: recall.message_start ?? null,
          message_end: recall.message_end ?? null,
          summary_json: recall.summary_json as Record<string, JsonValue>,
          source_message_hashes_json: recall.source_message_hashes ?? [],
          memory_object_ids_json: recall.memory_object_ids ?? [],
          pipeline_version: recall.pipeline_version,
          status: recall.status,
        });
        if (error) console.info("[conversation_recall_30] Supabase mirror skipped", error);
      } catch (err) {
        console.info("[conversation_recall_30] Supabase mirror failed", err);
      }

      // Mirror the discrete memory objects too (best-effort, non-blocking). Note:
      // merged_into_id/superseded_by_id/window_id reference the backend's own
      // integer ids and aren't remapped here, same as chat_session_id above --
      // the canonical merge/contradiction lineage lives in the backend DB; this
      // mirror is for Supabase-side realtime/RLS reads of the surface fields.
      if (recall.memory_objects?.length) {
        try {
          const rows = recall.memory_objects.map((memoryObject) => ({
            owner_user_id: ownerUserId,
            participant_id: participant.id,
            source_message_ids_json: memoryObject.source_message_ids as unknown as JsonValue,
            topic: memoryObject.topic,
            summary: memoryObject.summary,
            emotional_tone_json: memoryObject.emotional_tone as unknown as Record<string, JsonValue>,
            importance_score: memoryObject.importance_score,
            score_breakdown_json: memoryObject.score_breakdown,
            recurrence_score: memoryObject.recurrence_score,
            recurrence_count: memoryObject.recurrence_count,
            confidence_score: memoryObject.confidence_score,
            extraction_mode: memoryObject.extraction_mode,
            embedding_model: memoryObject.embedding_model,
            embedding_status: memoryObject.embedding_status,
            contradiction_status: memoryObject.contradiction_status,
            contradiction_detail_json: memoryObject.contradiction_detail ?? {},
            pipeline_version: memoryObject.pipeline_version,
          }));
          const { error } = await supabase.from("conversation_memory_objects").insert(rows);
          if (error) console.info("[conversation_memory_objects] Supabase mirror skipped", error);
        } catch (err) {
          console.info("[conversation_memory_objects] Supabase mirror failed", err);
        }
      }
    }

    return response;
  }

  static async getConversationRecall(userId: string, refresh = false): Promise<ConversationRecallSummary> {
    return this.fetch<ConversationRecallSummary>(
      `/research/conversation-recall?user_id=${encodeURIComponent(userId)}&refresh=${refresh ? "true" : "false"}`,
    );
  }

  static async getConversationMemoryObjects(userId: string, activeOnly = true): Promise<ConversationMemoryObject[]> {
    const response = await this.fetch<{ memory_objects: ConversationMemoryObject[] }>(
      `/research/conversation-recall/memory-objects?user_id=${encodeURIComponent(userId)}&active_only=${activeOnly ? "true" : "false"}`,
    );
    return response.memory_objects;
  }

  static async getMirroredConversationRecall(userId: string): Promise<ConversationRecallSummary | null> {
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("conversation_recall_summaries")
      .select("id, window_turn_count, message_start, message_end, summary_json, source_message_hashes_json, memory_object_ids_json, pipeline_version, status, created_at")
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throwSupabaseError(t.apiError.loadConversationRecall, error);
    return data ? toConversationRecall(data as unknown as ConversationRecallSummaryRow) : null;
  }

  static async getConversationRecallWithFallback(userId: string, refresh = false): Promise<ConversationRecallSummary> {
    try {
      const mirrored = await this.getMirroredConversationRecall(userId);
      if (mirrored && !refresh) {
        console.info("[conversation_recall_30] source=supabase_mirror", {
          status: mirrored.status,
          turns: mirrored.window_turn_count,
        });
        return mirrored;
      }
    } catch (err) {
      console.info("[conversation_recall_30] Supabase mirror unavailable; using backend", err);
    }
    const backend = await this.getConversationRecall(userId, refresh);
    console.info("[conversation_recall_30] source=backend", {
      status: backend.status,
      turns: backend.window_turn_count,
    });
    return backend;
  }

  static async getTimeline(userId: string): Promise<AnomalyResult[]> {
    if (readDemoFlag()) return demo.demoTimeline();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true });

    if (error) throwSupabaseError(t.apiError.loadTimeline, error);
    return (data ?? []).map((row) => toAnomaly(row as unknown as InsightRow, userId));
  }

  static async generateCounselorSummary(userId: string, limit = 10): Promise<CounselorSupportSummary> {
    if (readDemoFlag()) return demo.demoCounselorSummary();
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("entries")
      .select("id, extraction_json, created_at")
      .eq("owner_user_id", ownerUserId)
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 30)));
    if (error) throwSupabaseError(t.apiError.generateSupportSummary, error);

    const summary = generateCounselorSummary((data ?? []).map((row) => summaryEvent(row as SummaryEntryRow)));
    const { error: auditError } = await supabase.from("model_runs").insert({
      owner_user_id: ownerUserId,
      participant_id: participant.id,
      artifact_type: "counselor_summary",
      artifact_id: summary.summary_id,
      provider: "rules",
      model: "counselor-summary-v1",
      prompt_version: "counselor-summary-v1",
      schema_version: "counselor-summary-v1",
      pipeline_version: "counselor-summary-v1",
      temperature: 0,
      retrieval_config_json: { source: "entries.extraction_json", event_ids: summary.sections.flatMap((section) => section.evidence_event_ids) },
      input_provenance_json: { reflection_count: summary.reflection_count, date_range: summary.date_range },
      output_hash: await stableHash(JSON.stringify(summary)),
      status: "completed",
    });
    if (auditError) console.warn("[support-summary] audit insert skipped", auditError);
    return summary;
  }

  static async listOversightRequests(userId: string): Promise<OversightRequest[]> {
    if (readDemoFlag()) return demo.demoOversightRequests();
    const participant = await this.getParticipant(userId);

    const [rosterResult, consentResult] = await Promise.all([
      supabase
        .from("oversight_roster")
        .select("id, org_id, status, created_at, organizations(name)")
        .eq("participant_id", participant.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("oversight_consents")
        .select("org_id, status, granted_at, revoked_at")
        .eq("participant_id", participant.id)
        .is("educator_user_id", null),
    ]);
    if (rosterResult.error) throwSupabaseError(t.apiError.loadOversightRequests, rosterResult.error);
    if (consentResult.error) throwSupabaseError(t.apiError.loadOversightConsents, consentResult.error);

    type RosterRow = { id: string; org_id: string; status: string; organizations?: { name: string } | { name: string }[] | null };
    type ConsentRow = { org_id: string; status: string; granted_at: string | null; revoked_at: string | null };
    const consentByOrg = new Map<string, ConsentRow>();
    for (const consent of (consentResult.data ?? []) as ConsentRow[]) {
      consentByOrg.set(consent.org_id, consent);
    }

    // One card per organization; any active roster link outranks revoked ones.
    const byOrg = new Map<string, OversightRequest>();
    for (const row of (rosterResult.data ?? []) as RosterRow[]) {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      const consent = consentByOrg.get(row.org_id) ?? null;
      const existing = byOrg.get(row.org_id);
      const candidate: OversightRequest = {
        roster_id: row.id,
        org_id: row.org_id,
        org_name: org?.name ?? t.apiError.unknownOrganization,
        roster_status: row.status,
        consent_status: (consent?.status as OversightRequest["consent_status"]) ?? null,
        granted_at: consent?.granted_at ?? null,
        revoked_at: consent?.revoked_at ?? null,
      };
      if (!existing || (existing.roster_status !== "active" && row.status === "active")) {
        byOrg.set(row.org_id, candidate);
      }
    }
    return [...byOrg.values()];
  }

  static async grantOversightConsent(userId: string, orgId: string): Promise<void> {
    if (readDemoFlag()) return demo.demoSetConsent(true);
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const existing = await supabase
      .from("oversight_consents")
      .select("id")
      .eq("participant_id", participant.id)
      .eq("org_id", orgId)
      .is("educator_user_id", null)
      .maybeSingle();
    if (existing.error) throwSupabaseError(t.apiError.loadConsent, existing.error);

    if (existing.data) {
      const { error } = await supabase
        .from("oversight_consents")
        .update({ status: "active" })
        .eq("id", existing.data.id);
      if (error) throwSupabaseError(t.apiError.grantConsent, error);
      return;
    }
    const { error } = await supabase.from("oversight_consents").insert({
      participant_id: participant.id,
      owner_user_id: ownerUserId,
      org_id: orgId,
    });
    if (error) throwSupabaseError(t.apiError.grantConsent, error);
  }

  static async revokeOversightConsent(userId: string, orgId: string): Promise<void> {
    if (readDemoFlag()) return demo.demoSetConsent(false);
    const participant = await this.getParticipant(userId);
    const { error } = await supabase
      .from("oversight_consents")
      .update({ status: "revoked" })
      .eq("participant_id", participant.id)
      .eq("org_id", orgId)
      .is("educator_user_id", null);
    if (error) throwSupabaseError(t.apiError.revokeConsent, error);
  }

  // ------------------------------------------------------------------
  // Educator oversight reads (issues #29/#30/#31). All queries below run
  // through the educator RLS policies: only actively rostered AND
  // consented students are ever returned, and raw text is unreachable.
  // ------------------------------------------------------------------

  private static stateBand(score: number | null): EducatorStudentStatus["state_band"] {
    if (score === null || !Number.isFinite(score)) return "unknown";
    if (score >= 2) return "review";
    if (score >= 1.2) return "watch";
    return "settled";
  }

  static async getCohortRoster(): Promise<EducatorStudentStatus[]> {
    if (readDemoFlag()) return demo.demoCohortRoster();
    const rosterResult = await supabase.rpc("overseen_participants");
    if (rosterResult.error) throwSupabaseError(t.apiError.loadCohortRoster, rosterResult.error);
    type RosterRow = { participant_id: string; org_id: string; owner_user_id: string; code: string; display_name: string | null };
    const roster = (rosterResult.data ?? []) as RosterRow[];
    if (!roster.length) return [];
    const ids = roster.map((row) => row.participant_id);

    const [insightsResult, safetyResult] = await Promise.all([
      supabase
        .from("insights")
        .select("participant_id, day, anomaly_score, baseline_deviation_json")
        .in("participant_id", ids)
        .order("day", { ascending: false })
        .limit(400),
      supabase
        .from("model_runs")
        .select("participant_id, retrieval_config_json, created_at")
        .eq("artifact_type", "safety_assessment")
        .in("participant_id", ids)
        .order("created_at", { ascending: false })
        .limit(400),
    ]);
    if (insightsResult.error) throwSupabaseError(t.apiError.loadCohortInsights, insightsResult.error);
    if (safetyResult.error) throwSupabaseError(t.apiError.loadCohortSafety, safetyResult.error);

    type InsightRowLite = {
      participant_id: string;
      day: string;
      anomaly_score: number | null;
      baseline_deviation_json: {
        baseline_available?: boolean;
        baseline_provenance?: { is_provisional?: boolean; days_remaining?: number; baseline_type?: string };
      } | null;
    };
    type SafetyRowLite = { participant_id: string; retrieval_config_json: Record<string, JsonValue> | null; created_at: string };
    const latestInsight = new Map<string, InsightRowLite>();
    for (const row of (insightsResult.data ?? []) as InsightRowLite[]) {
      if (!latestInsight.has(row.participant_id)) latestInsight.set(row.participant_id, row);
    }
    const latestSafety = new Map<string, SafetyRowLite>();
    for (const row of (safetyResult.data ?? []) as SafetyRowLite[]) {
      if (!latestSafety.has(row.participant_id)) latestSafety.set(row.participant_id, row);
    }

    return roster.map((row) => {
      const insight = latestInsight.get(row.participant_id);
      const safety = latestSafety.get(row.participant_id);
      // Same positive-only gate as `hasSettledBaseline`. Without it, a student
      // inside the ramp — and every row written before the baseline reached
      // production — feeds `state_band`, and `state_band === "review"` raises
      // an `anomaly_spike` alert to an educator reading
      // "Reflection signal 3.40 is above the review threshold (2.0)".
      // That sentence needs the 3.40 to have measured something.
      const score = insight?.baseline_deviation_json?.baseline_available === true
        ? insight.anomaly_score ?? null
        : null;
      const provenance = insight?.baseline_deviation_json?.baseline_provenance;
      const config = safety?.retrieval_config_json ?? null;
      const reasons = Array.isArray(config?.reasons)
        ? (config!.reasons as JsonValue[]).filter((reason): reason is string => typeof reason === "string")
        : [];
      return {
        participant_id: row.participant_id,
        org_id: row.org_id,
        owner_user_id: row.owner_user_id,
        code: row.code,
        display_name: row.display_name,
        last_active_day: insight?.day ?? null,
        latest_score: score,
        state_band: this.stateBand(score),
        safety_level: typeof safety?.retrieval_config_json?.risk_level === "string"
          ? String(safety.retrieval_config_json.risk_level)
          : null,
        safety_at: safety?.created_at ?? null,
        safety_reasons: reasons,
        safety_surface: typeof config?.surface === "string" ? String(config.surface) : null,
        // A missing provenance means the row predates D-04; treat it as
        // provisional rather than assuming a settled baseline.
        baseline_is_provisional: provenance?.is_provisional ?? true,
        baseline_days_remaining: typeof provenance?.days_remaining === "number" ? provenance.days_remaining : null,
        baseline_type: typeof provenance?.baseline_type === "string" ? provenance.baseline_type : null,
      };
    });
  }

  static async getCohortAlerts(): Promise<CohortAlert[]> {
    const roster = await this.getCohortRoster();
    if (!roster.length) return [];
    // Built from the roster either way — in the demo the only thing missing is
    // the acknowledgement log, so nothing is acknowledged yet.
    if (readDemoFlag()) return this.alertsFromRoster(roster, new Set<string>());

    const ackResult = await supabase
      .from("educator_access_log")
      .select("metadata")
      .eq("view_type", "alert_ack")
      .limit(500);
    if (ackResult.error) throwSupabaseError(t.apiError.loadAlertAcknowledgements, ackResult.error);
    const acked = new Set(
      ((ackResult.data ?? []) as Array<{ metadata: Record<string, JsonValue> | null }>)
        .map((row) => String(row.metadata?.alert_key ?? ""))
        .filter(Boolean),
    );

    return this.alertsFromRoster(roster, acked);
  }

  /**
   * Alerts from roster rows. One place, because the demo path and the
   * Supabase path differ only in whether an acknowledgement log exists —
   * two copies of this loop would drift on the next alert kind.
   */
  private static alertsFromRoster(roster: EducatorStudentStatus[], acked: Set<string>): CohortAlert[] {
    const alerts: CohortAlert[] = [];
    const now = Date.now();
    for (const student of roster) {
      const base = {
        participant_id: student.participant_id,
        org_id: student.org_id,
        owner_user_id: student.owner_user_id,
        code: student.code,
      };
      if (student.safety_level === "crisis" || student.safety_level === "elevated") {
        const type = student.safety_level === "crisis" ? "safety_crisis" as const : "safety_elevated" as const;
        const key = `${type}:${student.participant_id}:${student.safety_at ?? "latest"}`;
        alerts.push({
          ...base,
          alert_key: key,
          type,
          severity: student.safety_level === "crisis" ? 3 : 2,
          occurred_at: student.safety_at ?? new Date().toISOString(),
          detail: student.safety_level === "crisis" ? t.alert.safetyCrisis : t.alert.safetyElevated,
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
      if (student.state_band === "review" && student.last_active_day) {
        const key = `anomaly_spike:${student.participant_id}:${student.last_active_day}`;
        alerts.push({
          ...base,
          alert_key: key,
          type: "anomaly_spike",
          severity: 2,
          occurred_at: student.last_active_day,
          detail: t.alert.anomalySpike(student.latest_score?.toFixed(2) ?? "—", "2.0"),
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
      const lastActive = student.last_active_day ? new Date(student.last_active_day).getTime() : null;
      if (lastActive === null || now - lastActive > 7 * 24 * 60 * 60 * 1000) {
        const key = `inactivity:${student.participant_id}:${student.last_active_day ?? "never"}`;
        alerts.push({
          ...base,
          alert_key: key,
          type: "inactivity",
          severity: 1,
          occurred_at: student.last_active_day ?? new Date(0).toISOString(),
          detail: lastActive === null ? t.alert.noEntriesYet : t.alert.noEntriesLast7Days,
          policy_refs: [],
          acknowledged: acked.has(key),
        });
      }
    }
    return alerts.sort((a, b) => b.severity - a.severity || a.code.localeCompare(b.code));
  }

  /** Append-only accountability record (issue #31). Never blocks the view. */
  static async recordEducatorAccess(
    student: Pick<EducatorStudentStatus, "participant_id" | "org_id" | "owner_user_id">,
    viewType: "roster" | "alerts" | "student_overview" | "alert_ack",
    metadata: Record<string, JsonValue> = {},
  ): Promise<void> {
    // The demo has no log to write to, and an access record nobody can read is
    // not worth pretending to keep. What the student's own screen shows about
    // who looked is `demoEducatorAccess()`.
    if (readDemoFlag()) return;
    const educator = await this.requireOwnerId();
    const { error } = await supabase.from("educator_access_log").insert({
      educator_user_id: educator,
      org_id: student.org_id,
      participant_id: student.participant_id,
      owner_user_id: student.owner_user_id,
      view_type: viewType,
      metadata,
    });
    if (error) console.warn("[oversight] access log insert skipped", error);
  }

  static async acknowledgeAlert(alert: CohortAlert): Promise<void> {
    await this.recordEducatorAccess(alert, "alert_ack", { alert_key: alert.alert_key, alert_type: alert.type });
  }

  /** Batched accountability records for list views (one row per student shown). */
  static async recordCohortAccess(
    students: Array<Pick<EducatorStudentStatus, "participant_id" | "org_id" | "owner_user_id">>,
    viewType: "roster" | "alerts",
  ): Promise<void> {
    if (!students.length || readDemoFlag()) return;
    const educator = await this.requireOwnerId();
    const { error } = await supabase.from("educator_access_log").insert(
      students.map((student) => ({
        educator_user_id: educator,
        org_id: student.org_id,
        participant_id: student.participant_id,
        owner_user_id: student.owner_user_id,
        view_type: viewType,
      })),
    );
    if (error) console.warn("[oversight] cohort access log insert skipped", error);
  }

  /** Minimized per-student view for educators (issue #36). */
  static async getStudentOverviewForEducator(participantId: string): Promise<{
    student: EducatorStudentStatus;
    signals: Array<{ day: string; score: number | null }>;
    themes: Array<{ label: string; count: number }>;
    safetyRuns: Array<{ level: string; occurred_at: string }>;
  } | null> {
    if (readDemoFlag()) return demo.demoStudentOverview(participantId);
    const roster = await this.getCohortRoster();
    const student = roster.find((row) => row.participant_id === participantId);
    if (!student) return null;

    const [insightsResult, safetyResult] = await Promise.all([
      supabase
        .from("insights")
        .select("day, anomaly_score, graph_summary_json")
        .eq("participant_id", participantId)
        .order("day", { ascending: false })
        .limit(30),
      supabase
        .from("model_runs")
        .select("retrieval_config_json, created_at")
        .eq("artifact_type", "safety_assessment")
        .eq("participant_id", participantId)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (insightsResult.error) throwSupabaseError(t.apiError.loadStudentSignals, insightsResult.error);
    if (safetyResult.error) throwSupabaseError(t.apiError.loadStudentSafety, safetyResult.error);

    type InsightRowLite = { day: string; anomaly_score: number | null; graph_summary_json: Record<string, JsonValue> | null };
    const rows = (insightsResult.data ?? []) as InsightRowLite[];
    const themeCounts = new Map<string, number>();
    for (const row of rows) {
      const keyNodes = Array.isArray(row.graph_summary_json?.key_nodes) ? row.graph_summary_json.key_nodes : [];
      for (const node of keyNodes as Array<Record<string, JsonValue>>) {
        const label = typeof node?.label === "string" ? node.label : null;
        if (label) themeCounts.set(label, (themeCounts.get(label) ?? 0) + 1);
      }
    }
    const themes = [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([label, count]) => ({ label, count }));

    void this.recordEducatorAccess(student, "student_overview");

    return {
      student,
      signals: rows.map((row) => ({ day: row.day, score: row.anomaly_score })),
      themes,
      safetyRuns: ((safetyResult.data ?? []) as Array<{ retrieval_config_json: Record<string, JsonValue> | null; created_at: string }>)
        .map((row) => ({
          level: typeof row.retrieval_config_json?.risk_level === "string" ? String(row.retrieval_config_json.risk_level) : "unknown",
          occurred_at: row.created_at,
        }))
        .filter((run) => run.level !== "none" && run.level !== "low"),
    };
  }

  /** Student-facing view of who looked at their data (issue #31). */
  static async listEducatorAccess(userId: string, limit = 20): Promise<StudentAccessRecord[]> {
    if (readDemoFlag()) return demo.demoEducatorAccess();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("educator_access_log")
      .select("id, view_type, occurred_at, organizations(name)")
      .eq("participant_id", participant.id)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) throwSupabaseError(t.apiError.loadEducatorAccessLog, error);
    type Row = { id: string; view_type: string; occurred_at: string; organizations?: { name: string } | { name: string }[] | null };
    return ((data ?? []) as Row[]).map((row) => {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      return { id: row.id, view_type: row.view_type, occurred_at: row.occurred_at, org_name: org?.name ?? "Organization" };
    });
  }

  // ------------------------------------------------------------------
  // Student-controlled support-summary sharing (counselor handoff).
  // ------------------------------------------------------------------

  static async listOrgCounselors(orgId: string): Promise<OrgCounselor[]> {
    if (readDemoFlag()) return demo.demoOrgCounselors();
    const { data, error } = await supabase.rpc("org_counselors", { target_org: orgId });
    if (error) throwSupabaseError(t.apiError.loadCounselors, error);
    return (data ?? []) as OrgCounselor[];
  }

  static async shareSupportSummary(
    userId: string,
    summary: CounselorSupportSummary,
    orgId: string,
    counselorUserId?: string | null,
  ): Promise<void> {
    if (readDemoFlag()) {
      demo.demoShareSummary(summary, counselorUserId ?? null);
      return;
    }
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    const { error } = await supabase.from("shared_support_summaries").insert({
      participant_id: participant.id,
      owner_user_id: ownerUserId,
      org_id: orgId,
      counselor_user_id: counselorUserId ?? null,
      summary_id: summary.summary_id,
      summary_json: summary as unknown as Record<string, JsonValue>,
      evidence_event_ids: [...new Set(summary.sections.flatMap((section) => section.evidence_event_ids))],
      date_range_from: summary.date_range.from,
      date_range_to: summary.date_range.to,
      reflection_count: summary.reflection_count,
    });
    if (error) throwSupabaseError(t.apiError.shareSummary, error);
  }

  static async listMySummaryShares(userId: string): Promise<SharedSupportSummary[]> {
    if (readDemoFlag()) return demo.demoMySummaryShares();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("shared_support_summaries")
      .select("id, participant_id, org_id, counselor_user_id, summary_id, summary_json, evidence_event_ids, reflection_count, status, shared_at, revoked_at, organizations(name)")
      .eq("participant_id", participant.id)
      .order("shared_at", { ascending: false });
    if (error) throwSupabaseError(t.apiError.loadSummaryShares, error);
    type Row = SharedSupportSummary & { organizations?: { name: string } | { name: string }[] | null };
    return ((data ?? []) as Row[]).map((row) => {
      const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
      return { ...row, org_name: org?.name ?? "Organization" };
    });
  }

  static async revokeSummaryShare(shareId: string): Promise<void> {
    if (readDemoFlag()) return demo.demoRevokeShare(shareId);
    const { error } = await supabase
      .from("shared_support_summaries")
      .update({ status: "revoked" })
      .eq("id", shareId);
    if (error) throwSupabaseError(t.apiError.revokeSummaryShare, error);
  }

  /** Counselor view: active shares for students passing all four gates. */
  static async counselorListSharedSummaries(): Promise<SharedSupportSummary[]> {
    if (readDemoFlag()) return demo.demoSharedSummaries();
    const [sharesResult, roster] = await Promise.all([
      supabase
        .from("shared_support_summaries")
        .select("id, participant_id, org_id, counselor_user_id, summary_id, summary_json, evidence_event_ids, reflection_count, status, shared_at, revoked_at")
        .order("shared_at", { ascending: false }),
      this.getCohortRoster(),
    ]);
    if (sharesResult.error) throwSupabaseError(t.apiError.loadSharedSummaries, sharesResult.error);
    const codeByParticipant = new Map(roster.map((student) => [student.participant_id, student.code]));
    return ((sharesResult.data ?? []) as SharedSupportSummary[]).map((share) => ({
      ...share,
      student_code: codeByParticipant.get(share.participant_id) ?? share.participant_id,
    }));
  }

  static async getAuditTrails(userId: string, reflectionId?: string, limit = 200): Promise<ReflectionAuditTrail[]> {
    if (readDemoFlag()) return demo.demoAuditTrails();
    const ownerUserId = await this.requireOwnerId();
    const participant = await this.getParticipant(userId);
    let query = supabase
      .from("model_runs")
      .select(
        "id, artifact_type, artifact_id, provider, model, prompt_version, schema_version, pipeline_version, temperature, retrieval_config_json, input_provenance_json, output_hash, status, error_message, created_at",
      )
      .eq("owner_user_id", ownerUserId)
      .eq("participant_id", participant.id)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 500)));
    if (reflectionId) {
      query = query.eq("artifact_id", reflectionId);
    }
    const { data, error } = await query;
    if (error) throwSupabaseError(t.apiError.loadAuditTrails, error);
    return buildAuditTrails((data ?? []) as unknown as ModelRunRecord[]);
  }

  static async getExplanation(explanationId: RecordId): Promise<ExplanationPayload> {
    if (readDemoFlag()) return demo.demoExplanation(explanationId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("id", String(explanationId))
      .single();

    if (error) throwSupabaseError(t.apiError.loadExplanation, error);
    return toExplanation(data as unknown as InsightRow, participantCode(data, ""));
  }

  static getFeatures(): Promise<DailyFeatureAggregation[]> {
    return Promise.resolve([]);
  }

  static async getAnomaly(userId: string): Promise<AnomalyResult> {
    if (readDemoFlag()) return demo.demoAnomaly();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("insights")
      .select("id, day, anomaly_score, z_scores_json, triggered_rules_json, baseline_deviation_json, changed_relations_json, protective_decline_json, uncertainty_json, evidence_summaries, graph_summary_json, score_breakdown_json, key_relations, extraction_provider, extraction_model, created_at, participants!insights_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) throwSupabaseError(t.apiError.loadAnomaly, error);
    return toAnomaly(data as unknown as InsightRow, userId);
  }

  static async getGraphSnapshots(userId: string, limit = 12): Promise<GraphSnapshotResponse[]> {
    if (readDemoFlag()) return demo.demoGraphSnapshots();
    const participant = await this.getParticipant(userId);
    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("id, entry_id, day, nodes_json, relations_json, graph_summary_json, temporal_diff_json, extraction_provider, extraction_model, created_at, participants!graph_snapshots_participant_id_fkey(code)")
      .eq("participant_id", participant.id)
      .order("day", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throwSupabaseError(t.apiError.loadGraphSnapshots, error);
    return (data ?? []).map((row) => toGraphSnapshot(row as unknown as GraphSnapshotRow, userId));
  }
}
