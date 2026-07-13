import type {
  AiAuditEvent,
  AiAuditSafetyDecision,
  JsonValue,
  ReflectionAuditTrail,
} from "@/api/models";

/**
 * Shape of a `model_runs` row as persisted by the entry/safety/summary flows.
 * Every value is optional because rows are written by several call sites and we
 * never want a missing field to drop an event from the reviewer trail.
 */
export interface ModelRunRecord {
  id: string;
  artifact_type: string;
  artifact_id?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt_version?: string | null;
  schema_version?: string | null;
  pipeline_version?: string | null;
  temperature?: number | null;
  retrieval_config_json?: Record<string, JsonValue> | null;
  input_provenance_json?: Record<string, JsonValue> | null;
  output_hash?: string | null;
  status?: string | null;
  error_message?: string | null;
  created_at: string;
}

const STAGE_LABELS: Record<string, string> = {
  extraction: "Emotional extraction",
  safety_assessment: "Safety assessment",
  counselor_summary: "Counselor summary",
};

// Provenance keys that are safe to surface: hashes, ids, counts, model names.
// Raw journal/recall text is never written to these fields, and any value that
// looks like a credential is dropped by `looksLikeSecret` below.
const EVIDENCE_ALLOWLIST = [
  "entry_id",
  "reflection_id",
  "field_names",
  "journal_text_hash",
  "recall_text_hash",
  "reflection_count",
  "date_range",
  "event_ids",
  "embedding_model",
  "source",
] as const;

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|authorization|bearer)/i;
const SECRET_VALUE_PATTERN = /\b(sk-[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,})\b/;

function looksLikeSecret(key: string, value: string): boolean {
  return SECRET_KEY_PATTERN.test(key) || SECRET_VALUE_PATTERN.test(value);
}

function formatValue(value: JsonValue): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => formatValue(item)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, inner]) => `${key}=${formatValue(inner as JsonValue)}`)
      .filter(Boolean)
      .join(" ");
  }
  return String(value);
}

/**
 * Build the reviewer-facing evidence references from provenance/config JSON,
 * limited to an allow-list of non-sensitive keys and stripped of anything that
 * resembles a secret. Raw content never enters this list.
 */
function evidenceRefs(record: ModelRunRecord): string[] {
  const sources: Array<Record<string, JsonValue> | null | undefined> = [
    record.input_provenance_json,
    record.retrieval_config_json,
  ];
  const refs: string[] = [];
  for (const source of sources) {
    if (!source) continue;
    for (const key of EVIDENCE_ALLOWLIST) {
      if (!(key in source)) continue;
      const rendered = formatValue(source[key]);
      if (!rendered) continue;
      if (looksLikeSecret(key, rendered)) continue;
      refs.push(`${key}: ${rendered}`);
    }
  }
  return [...new Set(refs)];
}

function safetyDecision(record: ModelRunRecord): AiAuditSafetyDecision | null {
  if (record.artifact_type !== "safety_assessment") return null;
  const config = record.retrieval_config_json ?? {};
  const riskLevel = typeof config.risk_level === "string" ? config.risk_level : "unknown";
  return {
    risk_level: riskLevel,
    escalation_required: config.escalation_required === true,
    reasons: Array.isArray(config.reasons) ? config.reasons.map(String) : [],
    policy_refs: Array.isArray(config.policy_refs) ? config.policy_refs.map(String) : [],
  };
}

/** The reflection/entry id an event belongs to, used to correlate the trail. */
function correlationId(record: ModelRunRecord): string {
  const provenance = record.input_provenance_json ?? {};
  const entryId = provenance.entry_id ?? provenance.reflection_id;
  if (typeof entryId === "string" && entryId) return entryId;
  if (typeof entryId === "number") return String(entryId);
  return record.artifact_id ?? record.id;
}

function toEvent(record: ModelRunRecord): AiAuditEvent {
  const decision = safetyDecision(record);
  const suppressed = decision?.risk_level === "crisis" || decision?.escalation_required === true;
  const rawStatus = record.status ?? "completed";
  const status = rawStatus === "completed" && suppressed ? "suppressed" : rawStatus;
  return {
    id: record.id,
    stage: record.artifact_type,
    label: STAGE_LABELS[record.artifact_type] ?? record.artifact_type,
    status,
    occurred_at: record.created_at,
    provider: record.provider ?? "unknown",
    model: record.model ?? "unknown",
    prompt_version: record.prompt_version ?? "unknown",
    schema_version: record.schema_version ?? undefined,
    pipeline_version: record.pipeline_version ?? undefined,
    temperature: typeof record.temperature === "number" ? record.temperature : undefined,
    safety_decision: decision,
    evidence_refs: evidenceRefs(record),
    output_hash: record.output_hash ?? null,
    error_message: record.error_message ?? null,
  };
}

const FAILURE_STATUSES = new Set(["failed", "error", "errored"]);

/**
 * Group persisted model runs into ordered, per-reflection audit trails.
 * Events within a trail are ordered oldest-first; trails are ordered by most
 * recent activity first. No raw content or secrets are ever included.
 */
export function buildAuditTrails(records: ModelRunRecord[]): ReflectionAuditTrail[] {
  const groups = new Map<string, AiAuditEvent[]>();
  const reflectionIds = new Map<string, string | null>();

  for (const record of records) {
    const key = correlationId(record);
    const event = toEvent(record);
    const bucket = groups.get(key) ?? [];
    bucket.push(event);
    groups.set(key, bucket);

    if (!reflectionIds.has(key)) {
      const provenance = record.input_provenance_json ?? {};
      const rawId = provenance.entry_id ?? provenance.reflection_id ?? record.artifact_id;
      reflectionIds.set(key, typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : null);
    }
  }

  const trails: ReflectionAuditTrail[] = [];
  for (const [key, events] of groups.entries()) {
    events.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
    const hasSafetyFlag = events.some(
      (event) => event.safety_decision != null && event.safety_decision.risk_level !== "none",
    );
    const hasFailure = events.some(
      (event) => FAILURE_STATUSES.has(event.status) || Boolean(event.error_message),
    );
    trails.push({
      correlation_id: key,
      reflection_id: reflectionIds.get(key) ?? null,
      first_event_at: events[0].occurred_at,
      last_event_at: events[events.length - 1].occurred_at,
      event_count: events.length,
      has_safety_flag: hasSafetyFlag,
      has_failure: hasFailure,
      events,
    });
  }

  trails.sort((a, b) => b.last_event_at.localeCompare(a.last_event_at));
  return trails;
}
