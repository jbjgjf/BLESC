/**
 * Extraction normalisation for the production research pipeline.
 *
 * Moved out of `app/api/entries/route.ts` unchanged so it can be tested: it is
 * pure, it decides what the stored graph looks like, and it had no coverage.
 * Behaviour is identical to the route-handler version at the time of the move —
 * fixes land in a separate commit so the bug and the fix are separable.
 */

export type ExtractedNode = {
  id: string;
  category: "State" | "Trigger" | "Protective" | "Behavior" | "Event";
  label: string;
  intensity: number;
  confidence: number;
};

export type ExtractedRelation = {
  source_id: string;
  target_id: string;
  type: "causes" | "escalates" | "buffers" | "avoids" | "co_occurs" | "precedes";
  confidence: number;
};

export type ExtractionPayload = {
  nodes: ExtractedNode[];
  relations: ExtractedRelation[];
  temporal_summary: string;
  summary: string;
  evidence_summaries: string[];
};

export const NODE_CATEGORIES = ["State", "Trigger", "Protective", "Behavior", "Event"] as const;
export const RELATION_TYPES = ["causes", "escalates", "buffers", "avoids", "co_occurs", "precedes"] as const;

export function sanitizeId(value: string, index: number): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  return cleaned || `node_${index + 1}`;
}

/**
 * Stable, script-agnostic node identity derived from the label.
 *
 * `sanitizeId` strips every non-ASCII character, so a Japanese label reduced to
 * an empty string and fell through to `node_${index}` — a POSITIONAL id. Two
 * unrelated concepts written on two different days both became `node_1` because
 * each happened to be listed first, which made cross-day identity meaningless
 * and made the relation remapping below impossible.
 *
 * Identity comes from the label, not from the model's `id` field. The model is
 * free to name 「眠れない」 differently on different days; the label is the
 * observation. Exact-label match is the base layer only — alias resolution
 * (「眠れない」 vs 「不眠」) belongs to the participant temporal graph (#95) and
 * is deliberately not attempted here.
 *
 * NFKC first so that ｅｘａｍ and exam, or ﾃｽﾄ and テスト, are the same node.
 */
export function canonicalNodeId(label: string): string {
  const normalised = label.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " ");
  if (!normalised) return "";
  const asciiSlug = normalised.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  // Pure-ASCII labels keep the readable slug they already had, so English ids
  // are unchanged by this fix. Anything else keeps its own characters rather
  // than being hashed: the id stays legible in stored JSON and in a debugger,
  // and same-label-same-id holds by construction with no collision handling to
  // get wrong.
  return (asciiSlug || normalised).slice(0, 64);
}

export function clamp01(value: unknown, fallback: number): number {
  return Math.max(0, Math.min(1, typeof value === "number" && Number.isFinite(value) ? value : fallback));
}

export function normalizeExtraction(candidate: Partial<ExtractionPayload>, sourceText: string): ExtractionPayload {
  const sourceNodes = Array.isArray(candidate.nodes) ? candidate.nodes : [];

  // Model id -> stored id. Relations arrive in the model's id space and the
  // nodes are renamed out of it, so without this map every relation on a
  // Japanese entry failed the membership check below and the entire graph
  // structure was silently discarded.
  const idByModelId = new Map<string, string>();

  const nodes: ExtractedNode[] = sourceNodes
    .map((node, index) => {
      const label = String(node?.label ?? `Observation ${index + 1}`).trim().slice(0, 80);
      const category = (NODE_CATEGORIES as readonly string[]).includes(String(node?.category))
        ? node.category
        : "State";
      const id = canonicalNodeId(label) || sanitizeId(String(node?.id ?? label), index);
      const modelId = String(node?.id ?? "").trim();
      if (modelId) idByModelId.set(modelId, id);
      // A model that omits `id` still emits relations keyed by something; the
      // label is the only other handle it has.
      if (label) idByModelId.set(label, id);
      return {
        id,
        category,
        label: label || `Observation ${index + 1}`,
        intensity: clamp01(node?.intensity, 0.55),
        confidence: clamp01(node?.confidence, 0.65),
      };
    })
    .filter((node, index, all) => all.findIndex((other) => other.id === node.id) === index)
    .slice(0, 18);

  const fallback = fallbackExtraction(sourceText);
  const usingFallbackNodes = nodes.length < 3;
  const finalNodes = usingFallbackNodes ? fallback.nodes : nodes;
  const nodeIds = new Set(finalNodes.map((node) => node.id));
  const resolve = (raw: unknown): string => {
    const value = String(raw ?? "").trim();
    if (!value) return "";
    const mapped = idByModelId.get(value);
    if (mapped) return mapped;
    // Direct hit on a stored id, for a model that already used them.
    if (nodeIds.has(value)) return value;
    // Last resort: the model may have referenced the label in a different
    // normalisation than it declared it in.
    const canonical = canonicalNodeId(value);
    return nodeIds.has(canonical) ? canonical : "";
  };

  const sourceRelations = Array.isArray(candidate.relations) ? candidate.relations : [];
  const relations = sourceRelations
    .map((relation) => ({
      source_id: resolve(relation?.source_id),
      target_id: resolve(relation?.target_id),
      type: (RELATION_TYPES as readonly string[]).includes(String(relation?.type))
        ? relation.type
        : "co_occurs",
      confidence: clamp01(relation?.confidence, 0.6),
    }))
    .filter((relation) => nodeIds.has(relation.source_id) && nodeIds.has(relation.target_id) && relation.source_id !== relation.target_id)
    .slice(0, 24);

  // Only fall back to the fallback RELATIONS when the fallback NODES are in
  // use. Mixing them produced edges whose endpoints were absent from the stored
  // graph, which the renderer then dropped — a graph of isolated nodes.
  const finalRelations = relations.length
    ? relations
    : usingFallbackNodes
      ? fallback.relations
      : [];

  return {
    nodes: finalNodes,
    relations: finalRelations,
    temporal_summary: String(candidate.temporal_summary || fallback.temporal_summary).slice(0, 280),
    summary: String(candidate.summary || fallback.summary).slice(0, 360),
    evidence_summaries: (Array.isArray(candidate.evidence_summaries) && candidate.evidence_summaries.length
      ? candidate.evidence_summaries
      : fallback.evidence_summaries
    ).map((item) => String(item).slice(0, 220)).slice(0, 8),
  };
}

export function fallbackExtraction(sourceText: string): ExtractionPayload {
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
