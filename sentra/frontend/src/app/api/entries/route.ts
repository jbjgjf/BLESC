import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ExtractedNode = {
  id: string;
  category: "State" | "Trigger" | "Protective" | "Behavior" | "Event";
  label: string;
  intensity: number;
  confidence: number;
};

type ExtractedRelation = {
  source_id: string;
  target_id: string;
  type: "causes" | "escalates" | "buffers" | "avoids" | "co_occurs" | "precedes";
  confidence: number;
};

type ExtractionPayload = {
  nodes: ExtractedNode[];
  relations: ExtractedRelation[];
  temporal_summary: string;
  summary: string;
  evidence_summaries: string[];
};

type EntryRequest = {
  text?: string;
  journal_text?: string;
  recall_text?: string;
  telemetry?: Record<string, JsonValue>;
  consent?: Record<string, JsonValue>;
};

const EXTRACTION_MODEL = process.env.OPENAI_EXTRACTION_MODEL || process.env.LLM_MODEL_NAME || "gpt-4.1-mini";
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

function sanitizeId(value: string, index: number): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return cleaned || `node_${index + 1}`;
}

function clamp01(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, typeof value === "number" && Number.isFinite(value) ? value : fallback));
}

function normalizeExtraction(candidate: Partial<ExtractionPayload>, sourceText: string): ExtractionPayload {
  const sourceNodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];
  const nodes: ExtractedNode[] = sourceNodes
    .map((node, index) => {
      const label = String(node?.label ?? `Observation ${index + 1}`).trim().slice(0, 80);
      const category = ["State", "Trigger", "Protective", "Behavior", "Event"].includes(String(node?.category))
        ? node.category
        : "State";
      return {
        id: sanitizeId(String(node?.id ?? label), index),
        category,
        label: label || `Observation ${index + 1}`,
        intensity: clamp01(node?.intensity, 0.55),
        confidence: clamp01(node?.confidence, 0.65),
      };
    })
    .filter((node, index, all) => all.findIndex((other) => other.id === node.id) === index)
    .slice(0, 18);

  const fallback = fallbackExtraction(sourceText);
  const finalNodes = nodes.length >= 3 ? nodes : fallback.nodes;
  const nodeIds = new Set(finalNodes.map((node) => node.id));
  const sourceRelations = Array.isArray(candidate.relations) ? candidate.relations : [];
  const relations = sourceRelations
    .map((relation) => ({
      source_id: String(relation?.source_id ?? ""),
      target_id: String(relation?.target_id ?? ""),
      type: ["causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"].includes(String(relation?.type))
        ? relation.type
        : "co_occurs",
      confidence: clamp01(relation?.confidence, 0.6),
    }))
    .filter((relation) => nodeIds.has(relation.source_id) && nodeIds.has(relation.target_id) && relation.source_id !== relation.target_id)
    .slice(0, 24);

  return {
    nodes: finalNodes,
    relations: relations.length ? relations : fallback.relations,
    temporal_summary: String(candidate.temporal_summary || fallback.temporal_summary).slice(0, 280),
    summary: String(candidate.summary || fallback.summary).slice(0, 360),
    evidence_summaries: (Array.isArray(candidate.evidence_summaries) && candidate.evidence_summaries.length
      ? candidate.evidence_summaries
      : fallback.evidence_summaries
    ).map((item) => String(item).slice(0, 220)).slice(0, 8),
  };
}

function fallbackExtraction(sourceText: string): ExtractionPayload {
  const lowered = sourceText.toLowerCase();
  const nodes: ExtractedNode[] = [
    { id: "current_reflection", category: "State", label: "Current reflection", intensity: 0.5, confidence: 0.55 },
    { id: "written_journal", category: "Behavior", label: "Written journal entry", intensity: 0.55, confidence: 0.8 },
    { id: "first_recall", category: "Event", label: "First recall moment", intensity: 0.45, confidence: 0.75 },
  ];
  if (/(friend|talk|help|support|walk|music|sleep|rest|plan|study)/i.test(sourceText)) {
    nodes.push({ id: "protective_signal", category: "Protective", label: "Protective signal", intensity: 0.58, confidence: 0.58 });
  }
  if (/(anxious|stress|tired|deadline|worry|sad|angry|fear)/i.test(sourceText)) {
    nodes.push({ id: "stress_signal", category: "Trigger", label: "Stress signal", intensity: lowered.includes("very") ? 0.75 : 0.58, confidence: 0.58 });
  }
  while (nodes.length < 5) {
    nodes.push({ id: `context_signal_${nodes.length}`, category: "Event", label: `Context signal ${nodes.length}`, intensity: 0.4, confidence: 0.45 });
  }
  const relations: ExtractedRelation[] = [
    { source_id: "first_recall", target_id: "current_reflection", type: "precedes" as const, confidence: 0.65 },
    { source_id: "written_journal", target_id: "current_reflection", type: "co_occurs" as const, confidence: 0.62 },
    ...(nodes.some((node) => node.id === "protective_signal")
      ? [{ source_id: "protective_signal", target_id: "stress_signal", type: "buffers" as const, confidence: 0.52 }]
      : []),
  ].filter((relation) => nodes.some((node) => node.id === relation.source_id) && nodes.some((node) => node.id === relation.target_id));

  return {
    nodes,
    relations,
    temporal_summary: "single-session self-report with first-recall context",
    summary: `${nodes.length} nodes extracted from a student journal and 30-first-recall submission.`,
    evidence_summaries: ["Student submitted a journal entry and a first-recall note."],
  };
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

async function extractWithOpenAI(entryText: string): Promise<{ extraction: ExtractionPayload; provider: string; model: string; status: string }> {
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
        temperature: 0.2,
        input: [
          {
            role: "system",
            content: "You are Sentra's transparent research extraction model. Return schema-valid, evidence-grounded JSON for longitudinal journaling analysis.",
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

async function embeddingArtifact(contentKind: string, content: string, metadata: Record<string, JsonValue>) {
  const contentHash = await sha256(content);
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

  const createdAt = isoNow();
  const idSeed = await sha256(`${userId}:${createdAt}:${entryText}`);
  const entryId = `prod_${idSeed.slice(0, 16)}`;
  const { extraction, provider, model, status } = await extractWithOpenAI(entryText);
  const day = createdAt.slice(0, 10);
  const protectiveCount = extraction.nodes.filter((node) => node.category === "Protective").length;
  const triggerCount = extraction.nodes.filter((node) => node.category === "Trigger").length;
  const anomalyScore = Math.max(0, Math.min(10, Number((1 + triggerCount * 0.8 - protectiveCount * 0.25 + extraction.relations.length * 0.05).toFixed(2))));
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
    embeddingArtifact("journal_entry", journalText, { pipeline_version: PIPELINE_VERSION, field_name: "journal_entry" }),
    embeddingArtifact("first_recall_30", recallText, { pipeline_version: PIPELINE_VERSION, field_name: "first_recall_30" }),
    embeddingArtifact("combined_submission", entryText, { pipeline_version: PIPELINE_VERSION, field_name: "combined_submission" }),
  ]);

  return NextResponse.json({
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
      temporal_diff_json: {
        added_nodes: extraction.nodes,
        removed_nodes: [],
        added_relations: extraction.relations,
        removed_relations: [],
        changed_relations: [],
        relation_shift_summary: "production submission baseline snapshot",
        protective_decline: {},
        uncertainty: { extraction_status: status, telemetry_hash: telemetryHash, consent_hash: consentHash },
      },
      extraction_provider: provider,
      extraction_model: model,
      created_at: createdAt,
    },
    anomaly_result: {
      id: `${entryId}_anomaly`,
      user_id: userId,
      day,
      anomaly_score: anomalyScore,
      z_scores_json: {
        trigger_count: triggerCount,
        protective_count: protectiveCount,
        relation_count: extraction.relations.length,
      },
      explanation_id: `${entryId}_explanation`,
    },
    explanation: {
      id: `${entryId}_explanation`,
      user_id: userId,
      day,
      triggered_rules_json: extraction.evidence_summaries.map((evidence, index) => ({
        rule: `evidence_${index + 1}`,
        evidence,
        weight: 0.5,
      })),
      baseline_deviation_json: { baseline_available: false, reason: "single production submission" },
      changed_relations_json: [],
      protective_decline_json: {},
      uncertainty_json: { extraction_status: status, model, pipeline_version: PIPELINE_VERSION },
      evidence_summaries: extraction.evidence_summaries,
      graph_summary_json: graphSummary,
      score_breakdown_json: {
        trigger_component: triggerCount * 0.8,
        protective_component: protectiveCount * -0.25,
        relation_component: extraction.relations.length * 0.05,
        final_score: anomalyScore,
      },
      key_relations: extraction.relations.slice(0, 5),
      created_at: createdAt,
    },
    research_artifacts: {
      embedding_artifacts: artifacts,
      pipeline_version: PIPELINE_VERSION,
    },
  });
}
