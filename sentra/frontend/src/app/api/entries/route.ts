import { NextRequest, NextResponse } from "next/server";
import { assessSafety, SAFETY_ASSESSMENT_VERSION } from "@/lib/safety-assessment";
import {
  fallbackExtraction,
  normalizeExtraction,
  type ExtractionPayload,
} from "@/lib/extraction";
import { buildTemporalDiff, EMPTY_SNAPSHOT } from "@/lib/temporalDiff";
import { serviceRoleClient, writeEntryResult } from "@/lib/server/supabaseWriter";
import {
  COLLECTION_ONLY_PROVIDER,
  COLLECTION_ONLY_STATUS,
  collectionOnlyExtraction,
  collectionOnlyForParticipant,
} from "@/lib/server/collectionMode";
import { recordSubmissionFailure } from "@/lib/server/submissionFailures";
import { jsonError, requireUser } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 60;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type EntryRequest = {
  text?: string;
  journal_text?: string;
  recall_text?: string;
  telemetry?: Record<string, JsonValue>;
  /** What the client believes it consented to. Recorded for mismatch
   *  detection only — the stored consent record decides (#134). */
  consent?: Record<string, JsonValue>;
  /** Stable across retries of one submission, so a retry cannot create a
   *  second entry (#132). */
  client_submission_id?: string;
  // No identity fields. The owner and participant are derived from the
  // caller's session below, never read from the body — the write uses the
  // service-role key, which bypasses RLS, so a body-supplied id would let any
  // caller create rows under any participant.
};

const EXTRACTION_MODEL = process.env.OPENAI_EXTRACTION_MODEL || process.env.LLM_MODEL_NAME || "gpt-6-astra";
const EXTRACTION_REASONING_EFFORT = process.env.OPENAI_EXTRACTION_REASONING_EFFORT || "high";
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const PIPELINE_VERSION = "next-production-research-pipeline-v1";

const extractionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes", "relations", "temporal_summary", "summary", "evidence_summaries"],
  properties: {
    nodes: {
      type: "array",
      minItems: 5,
      maxItems: 18,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "category", "label", "intensity", "confidence"],
        properties: {
          id: { type: "string" },
          category: { type: "string", enum: ["State", "Trigger", "Protective", "Behavior", "Event"] },
          label: { type: "string" },
          intensity: { type: "number", minimum: 0, maximum: 1 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    relations: {
      type: "array",
      minItems: 3,
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_id", "target_id", "type", "confidence"],
        properties: {
          source_id: { type: "string" },
          target_id: { type: "string" },
          type: { type: "string", enum: ["causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    temporal_summary: { type: "string" },
    summary: { type: "string" },
    evidence_summaries: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
  },
} as const;

function secretKey(): string | undefined {
  return process.env["OPENAI_" + "API_KEY"];
}

function isoNow(): string {
  return new Date().toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function outputText(response: Record<string, unknown>): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
    }
  }
  return null;
}

async function extractWithOpenAI(
  entryText: string,
  collectionOnly: boolean,
): Promise<{ extraction: ExtractionPayload; provider: string; model: string; status: string }> {
  // The gate is here, before the key is even read, so that a participant inside
  // a collection window cannot reach the network through this function under
  // any configuration (#165).
  if (collectionOnly) {
    return {
      extraction: collectionOnlyExtraction(),
      provider: COLLECTION_ONLY_PROVIDER,
      model: COLLECTION_ONLY_STATUS,
      status: COLLECTION_ONLY_STATUS,
    };
  }

  const key = secretKey();
  if (!key) {
    return { extraction: fallbackExtraction(entryText), provider: "deterministic", model: "fallback", status: "missing_key" };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        store: false,
        reasoning: { effort: EXTRACTION_REASONING_EFFORT },
        input: [
          {
            role: "system",
            content: [
              "You are Sentra's transparent research extraction model. Return schema-valid, evidence-grounded JSON for longitudinal journaling analysis.",
              // Labels, summaries and reflection cards are rendered verbatim on
              // a Japanese student's screen and in the educator view (#116).
              // Without this the model answers in the language of its
              // instructions, and English reaches the product through the data,
              // where reviewing the UI would never catch it.
              "Write every human-readable field — labels, summaries, evidence and reflection card titles and bodies — in natural Japanese (敬体), the way a Japanese school would write to a student.",
              "Use plain, school-appropriate wording. Do not diagnose, do not assert certainty, and avoid clinical terms.",
              "Enum values, ids and schema keys stay exactly as the schema defines them; only the human-readable text is Japanese.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Extract typed ontology nodes and relations from this student submission. Keep labels short and evidence-grounded.\\n\\n${entryText}`,
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "sentra_entry_extraction",
            strict: true,
            schema: extractionSchema,
          },
        },
      }),
    });

    if (!response.ok) {
      return { extraction: fallbackExtraction(entryText), provider: "openai", model: EXTRACTION_MODEL, status: `failed_${response.status}` };
    }
    const json = await response.json() as Record<string, unknown>;
    const text = outputText(json);
    if (!text) throw new Error("Missing structured output text");
    return {
      extraction: normalizeExtraction(JSON.parse(text) as Partial<ExtractionPayload>, entryText),
      provider: "openai",
      model: EXTRACTION_MODEL,
      status: "completed",
    };
  } catch {
    return { extraction: fallbackExtraction(entryText), provider: "openai", model: EXTRACTION_MODEL, status: "fallback" };
  }
}

async function embeddingArtifact(
  contentKind: string,
  content: string,
  metadata: Record<string, JsonValue>,
  collectionOnly: boolean,
) {
  const contentHash = await sha256(content);
  if (collectionOnly) {
    // The hash is still computed and stored: it is derived locally, it does not
    // leave, and it is what lets a later batch run prove it embedded the same
    // text that was collected.
    return {
      content_kind: contentKind,
      embedding_model: COLLECTION_ONLY_STATUS,
      vector_json: [],
      content_hash: contentHash,
      metadata_json: metadata,
    };
  }

  const key = secretKey();
  if (!key || !content.trim()) {
    return {
      content_kind: contentKind,
      embedding_model: key ? EMBEDDING_MODEL : "deterministic-fallback",
      vector_json: [],
      content_hash: contentHash,
      metadata_json: metadata,
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: content }),
    });
    if (!response.ok) throw new Error(`embedding_${response.status}`);
    const json = await response.json() as { data?: Array<{ embedding?: number[] }> };
    return {
      content_kind: contentKind,
      embedding_model: EMBEDDING_MODEL,
      vector_json: json.data?.[0]?.embedding ?? [],
      content_hash: contentHash,
      metadata_json: metadata,
    };
  } catch {
    return {
      content_kind: contentKind,
      embedding_model: EMBEDDING_MODEL,
      vector_json: [],
      content_hash: contentHash,
      metadata_json: { ...metadata, status: "embedding_failed" },
    };
  }
}

export async function POST(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const userId = searchParams.get("user_id") || "research_user_01";
  const observationType = searchParams.get("observation_type") || "daily";
  const payload = await request.json().catch(() => ({})) as EntryRequest;
  const journalText = payload.journal_text || payload.text || "";
  const recallText = payload.recall_text || "";
  const entryText = [
    journalText.trim() ? `Journal entry:\n${journalText.trim()}` : "",
    recallText.trim() ? `30-first-recall:\n${recallText.trim()}` : "",
  ].filter(Boolean).join("\n\n");

  if (!entryText.trim()) {
    return NextResponse.json({ detail: "Entry text is required" }, { status: 422 });
  }

  // Who is writing, and for which participant — derived, never accepted.
  //
  // The write below uses the service-role key, which bypasses RLS. Everywhere
  // else Postgres decides whether a caller may touch a row; here it has been
  // told not to ask, so this block is the only thing standing between a request
  // and another student's data. `requireUser` establishes the owner from the
  // session, and the participant is then looked up through that user's own
  // RLS-scoped client — a code belonging to someone else simply is not found.
  //
  // These ids used to come from the request body and were written straight
  // through. Any caller could name any participant.
  const auth = await requireUser(request);
  if ("error" in auth) return auth.error;

  const participantResult = await auth.client
    .from("participants")
    .select("id")
    .eq("code", userId)
    .limit(1)
    .maybeSingle();
  if (participantResult.error) return jsonError(participantResult.error.message, 502);
  const participant = participantResult.data as { id: string } | null;
  if (!participant) return jsonError("Participant was not found.", 404);

  // Is this participant inside an open collection window? Everything that would
  // send their text to a third party consults this one answer (#165). Resolved
  // here, before any of it, so there is a single place to read and a single
  // place to get wrong.
  const collectionOnly = await collectionOnlyForParticipant(serviceRoleClient(), participant.id);

  const createdAt = isoNow();
  const idSeed = await sha256(`${userId}:${createdAt}:${entryText}`);
  const entryId = `prod_${idSeed.slice(0, 16)}`;
  const { extraction, provider, model, status } = await extractWithOpenAI(entryText, collectionOnly);
  const safetyAssessment = assessSafety(entryText);
  const day = createdAt.slice(0, 10);
  const graphSummary = {
    node_count: extraction.nodes.length,
    relation_count: extraction.relations.length,
    event_count: extraction.nodes.filter((node) => node.category === "Event").length,
    key_nodes: extraction.nodes.slice(0, 5),
    key_relations: extraction.relations.slice(0, 5),
    summary: extraction.summary,
  };

  const telemetryHash = await sha256(JSON.stringify(payload.telemetry ?? {}));
  const consentHash = await sha256(JSON.stringify(payload.consent ?? {}));
  const artifacts = await Promise.all([
    embeddingArtifact("journal_entry", journalText, { pipeline_version: PIPELINE_VERSION, field_name: "journal_entry" }, collectionOnly),
    embeddingArtifact("first_recall_30", recallText, { pipeline_version: PIPELINE_VERSION, field_name: "first_recall_30" }, collectionOnly),
    embeddingArtifact("combined_submission", entryText, { pipeline_version: PIPELINE_VERSION, field_name: "combined_submission" }, collectionOnly),
  ]);

  const computed = {
    entry: {
      id: entryId,
      user_id: userId,
      raw_text: null,
      is_masked: true,
      created_at: createdAt,
      observation_type: observationType,
    },
    extraction: {
      id: `${entryId}_extraction`,
      entry_id: entryId,
      nodes_json: extraction.nodes,
      relations_json: extraction.relations,
      temporal_summary: extraction.temporal_summary,
      emotional_state_json: {
        reflection_id: entryId,
        locale: "und",
        primary_emotions: [],
        intensity: safetyAssessment.risk_level === "crisis" ? 5 : safetyAssessment.risk_level === "elevated" ? 4 : 2,
        trigger_candidates: [],
        cognitive_themes: [],
        body_behavior_signals: [],
        protective_factors: [],
        support_needs: [],
        uncertainty_notes: [],
        evidence_spans: [],
        safety_classification: {
          level: safetyAssessment.risk_level === "none" ? "normal" : safetyAssessment.risk_level,
          flags: safetyAssessment.reasons,
          action: safetyAssessment.risk_level === "crisis" ? "suppress_cards_and_prioritize_escalation" : "show_reflection_cards",
        },
        prompt_version: SAFETY_ASSESSMENT_VERSION,
        model: "deterministic-rules",
        status: "complete",
      },
      reflection_cards_json: safetyAssessment.risk_level === "crisis" ? [{
        id: `${entryId}:crisis_suppressed`,
        type: "safety_suppression",
        title: "Support first",
        body: safetyAssessment.safe_response,
        evidence_refs: [],
        confidence: "high",
        status: "suppressed",
        prompt_version: SAFETY_ASSESSMENT_VERSION,
        policy_refs: safetyAssessment.policy_refs,
      }] : [],
      safety_flags_json: safetyAssessment.reasons,
      safety_assessment_json: safetyAssessment,
      extractor_version: PIPELINE_VERSION,
      extraction_provider: provider,
      extraction_model: model,
      created_at: createdAt,
    },
    graph_snapshot: {
      id: `${entryId}_graph`,
      entry_id: entryId,
      user_id: userId,
      day,
      nodes_json: extraction.nodes,
      relations_json: extraction.relations,
      graph_summary_json: graphSummary,
      // The route handler is stateless with respect to a participant's history:
      // it has no Supabase client and cannot see yesterday. So it emits the
      // diff-against-nothing and SAYS SO in `diff_basis`. The caller that owns
      // the database connection recomputes this against the real previous
      // snapshot before insert (see `client.ts`).
      //
      // This used to be the same shape with `relation_shift_summary:
      // "production submission baseline snapshot"` hard-coded and no basis
      // field — so every stored row claimed to be a baseline and no row could
      // contradict it. That is why the defect survived unnoticed (#106).
      temporal_diff_json: {
        ...buildTemporalDiff({ nodes: extraction.nodes, relations: extraction.relations }, EMPTY_SNAPSHOT),
        relation_shift_summary: "not computed at the route handler; no history available here",
        diff_basis: "no_previous_lookup",
        protective_decline: {},
        uncertainty: { extraction_status: status, telemetry_hash: telemetryHash, consent_hash: consentHash },
      },
      extraction_provider: provider,
      extraction_model: model,
      created_at: createdAt,
    },
    // Present so the caller knows to write an insight row, and empty because
    // this handler cannot fill it.
    //
    // It has no Supabase client and cannot see the participant's history, so it
    // cannot estimate a baseline, and without a baseline there is no z-score
    // and no deviation — the same reason `temporal_diff_json` above is emitted
    // as `no_previous_lookup` and recomputed by the caller.
    //
    // What used to be here instead:
    //
    //     anomaly_score = 1 + triggers*0.8 - protective*0.25 + relations*0.05
    //     z_scores_json = { trigger_count, protective_count, relation_count }
    //
    // A number with a floor of 1.0, computed from one submission, written
    // straight into `insights.anomaly_score` and rendered to the student as
    // "Hybrid Reflection Signal". Its `z_scores_json` held raw counts under a
    // name that says they had been divided by a standard deviation. The real
    // computation lives in `lib/baseline.ts` and runs in `api/client.ts`, which
    // is the only place with both the database connection and the participant.
    anomaly_result: {
      id: `${entryId}_anomaly`,
      user_id: userId,
      day,
      anomaly_score: null,
      z_scores_json: {},
      score_basis: "not_computed_at_route_handler",
      explanation_id: `${entryId}_explanation`,
    },
    explanation: {
      id: `${entryId}_explanation`,
      user_id: userId,
      day,
      // Rule hits require z-scores, which require a baseline, which requires
      // history this handler cannot see. Previously each extracted evidence
      // string was emitted as a rule named `evidence_1`, `evidence_2` … with a
      // flat weight of 0.5 — the shape of a rule engine's output with none of
      // its content, and those weights fed the score. The real rules are in
      // `lib/baseline.ts:checkRules`, run by the caller.
      triggered_rules_json: [],
      baseline_deviation_json: {
        status: "not_computed_at_route_handler",
        baseline_available: false,
        reason: "no participant history available in a stateless route handler",
      },
      changed_relations_json: [],
      protective_decline_json: {},
      uncertainty_json: { extraction_status: status, model, pipeline_version: PIPELINE_VERSION },
      evidence_summaries: extraction.evidence_summaries,
      graph_summary_json: graphSummary,
      score_breakdown_json: { status: "not_computed_at_route_handler", final_score: null },
      key_relations: extraction.relations.slice(0, 5),
      created_at: createdAt,
    },
    research_artifacts: {
      embedding_artifacts: artifacts,
      pipeline_version: PIPELINE_VERSION,
    },
  };

  // The write used to happen in the browser after this response was received
  // (#2). It happens here now, with the service-role key, so that a submission
  // is durable the moment the handler returns rather than depending on the tab
  // staying open. `supabase_sync` tells the caller what landed; a failure is
  // reported, not thrown, because the computed result is still worth returning.
  const supabaseSync = await writeEntryResult(
    { ownerUserId: auth.user.id, participantId: participant.id },
    computed,
    {
      observationType,
      journalText,
      recallText,
      telemetry: payload.telemetry,
      consent: payload.consent,
      clientSubmissionId: payload.client_submission_id ?? null,
    },
  );

  // `collection_only` tells the client why there is no graph to show. Without
  // it the journal screen cannot distinguish "the study withheld extraction"
  // from "extraction failed", and would show the failure copy for a submission
  // that worked exactly as designed.
  const body = { ...computed, supabase_sync: supabaseSync, collection_only: collectionOnly };
  const durable = supabaseSync.status === "written" && Boolean(supabaseSync.entry_id);

  if (!durable) {
    // 200 used to be returned here whatever happened, and the client logged the
    // failure to the console. So a submission that reached no database came
    // back as a success and the student was shown the completion screen (#132).
    //
    // Two things change: the status says the entry is not stored, and the
    // failure is recorded where an operator can count it — a lost entry leaves
    // no row of its own, so without `submission_failures` it is
    // indistinguishable from a day nobody wrote.
    await recordSubmissionFailure({
      ownerUserId: auth.user.id,
      participantId: participant.id,
      clientSubmissionId: payload.client_submission_id ?? null,
      outcome: supabaseSync.status === "skipped" ? "skipped" : "failed",
      reason: supabaseSync.reason ?? null,
      warnings: supabaseSync.warnings,
      observationType,
    });
    return NextResponse.json(
      { ...body, detail: "日記を保存できませんでした。" },
      { status: 502 },
    );
  }

  // The core rows landed and a research mirror did not. The entry is safe, so
  // the student proceeds; the gap is recorded so it is not discovered at the
  // end of the pilot as unexplained missing research rows.
  if (supabaseSync.warnings.length > 0) {
    await recordSubmissionFailure({
      ownerUserId: auth.user.id,
      participantId: participant.id,
      clientSubmissionId: payload.client_submission_id ?? null,
      outcome: "partial",
      reason: null,
      warnings: supabaseSync.warnings,
      observationType,
    });
  }

  return NextResponse.json(body);
}
