import type { ExplanationPayload, GraphSnapshot, RecordId } from "@/api/models";
import type { GraphMode, GraphViewerData, GraphViewerLink, GraphViewerNode, GraphNodeSelection } from "./graphTypes";
import { t } from "@/lib/i18n";

export const CATEGORY_COLORS: Record<string, string> = {
  State: "#c92a2a",
  Trigger: "#d97706",
  Event: "#0072b2",
  Protective: "#2f9e44",
  Behavior: "#6f42c1",
};

const CATEGORY_ORDER = ["State", "Trigger", "Behavior", "Event", "Protective"];

export const RELATION_STYLES: Record<string, { color: string; width: number; opacity: number; dashed: boolean }> = {
  causes: { color: "#ff6b35", width: 1.0, opacity: 0.75, dashed: false },
  escalates: { color: "#ff4455", width: 1.2, opacity: 0.75, dashed: false },
  buffers: { color: "#44ff88", width: 0.9, opacity: 0.7, dashed: false },
  avoids: { color: "#cc66ff", width: 0.8, opacity: 0.6, dashed: true },
  co_occurs: { color: "#44bbff", width: 0.7, opacity: 0.55, dashed: false },
  precedes: { color: "#88aacc", width: 0.7, opacity: 0.5, dashed: true },
};

function safeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function resolveRelationStyle(type: string) {
  return RELATION_STYLES[type] ?? RELATION_STYLES.co_occurs;
}

/**
 * One field of a relation, under whichever of its two names it arrived with.
 *
 * An extracted relation names its endpoints `source_node_id` / `target_node_id`
 * — that is what `llm_adapter.py`'s response schema marks required, what its
 * prompt asks the model for, and therefore what `relations_json` holds. The
 * `ExtractionRelation` type declares `source_id` / `target_id`, which is the
 * shape `buildConceptGraphData` writes back out and what the research pipeline
 * hands to the explanation payload. Both reach this module.
 *
 * So every endpoint read in this file goes through here rather than restating
 * the fallback. Four call sites each wrote their own, and the ones that forgot
 * — link resolution, and the two badge checks in `summarizeNodeRelations` —
 * failed silently: `relation.source_id` is `undefined` on an extracted
 * relation, `nodeMap.get(undefined)` misses, and the link was dropped. The
 * daily and temporal views drew every vertex at a radius computed from the
 * degree those dropped edges contributed, with no edges at all (#303).
 */
function relationField(value: object, field: "source_id" | "target_id" | "type"): string | undefined {
  const record = value as Record<string, unknown>;
  const legacyField = field === "source_id" ? "source_node_id" : field === "target_id" ? "target_node_id" : field;
  const direct = record[field];
  if (typeof direct === "string") return direct;
  const legacy = record[legacyField];
  return typeof legacy === "string" ? legacy : undefined;
}

/** The id of a relation's source endpoint, or undefined if it carries neither name. */
export function relationSourceId(relation: object): string | undefined {
  return relationField(relation, "source_id");
}

/** The id of a relation's target endpoint, or undefined if it carries neither name. */
export function relationTargetId(relation: object): string | undefined {
  return relationField(relation, "target_id");
}

/**
 * A relation's type.
 *
 * Falls back to `co_occurs` — the same relation `resolveRelationStyle` falls
 * back to — so a relation missing its type is drawn as the weakest claim the
 * palette has rather than not drawn at all.
 */
export function relationType(relation: object): string {
  return relationField(relation, "type") ?? "co_occurs";
}

function sameRelationShape(left: object, right: object) {
  return relationField(left, "source_id") === relationField(right, "source_id")
    && relationField(left, "target_id") === relationField(right, "target_id")
    && relationField(left, "type") === relationField(right, "type");
}

export function buildGraphViewerData(
  snapshots: GraphSnapshot[],
  mode: GraphMode,
  currentSnapshot?: GraphSnapshot | null,
): GraphViewerData {
  const orderedSnapshots = [...snapshots].sort((a, b) => `${a.day}`.localeCompare(`${b.day}`));
  const visibleSnapshots =
    mode === "temporal"
      ? (orderedSnapshots.length > 0 ? orderedSnapshots : currentSnapshot ? [currentSnapshot] : [])
      : currentSnapshot
        ? [currentSnapshot]
        : orderedSnapshots.slice(-1);

  const nodes: GraphViewerNode[] = [];
  const links: GraphViewerLink[] = [];
  let unresolved = 0;

  visibleSnapshots.forEach((snapshot, layerIndex) => {
    const z = mode === "temporal" ? (layerIndex - Math.max(0, visibleSnapshots.length - 1) / 2) * 90 : 0;
    const nodeMap = new Map<string, GraphViewerNode>();
    const categoryCounts = new Map<string, number>();

    // Pre-compute degree for size scaling
    const degreeCounts = new Map<string, number>();
    safeArray(snapshot.relations_json).forEach((rel) => {
      const src = relationSourceId(rel);
      const tgt = relationTargetId(rel);
      if (src) degreeCounts.set(src, (degreeCounts.get(src) ?? 0) + 1);
      if (tgt) degreeCounts.set(tgt, (degreeCounts.get(tgt) ?? 0) + 1);
    });

    safeArray(snapshot.nodes_json).forEach((node, index) => {
      const color = CATEGORY_COLORS[node.category] ?? "#94a3b8";
      const intensity = typeof node.intensity === "number" ? node.intensity : 0.5;
      const degree = degreeCounts.get(node.id) ?? 0;
      const categoryIndex = Math.max(0, CATEGORY_ORDER.indexOf(node.category));
      const categorySeen = categoryCounts.get(node.category) ?? 0;
      categoryCounts.set(node.category, categorySeen + 1);
      const angle = (categoryIndex / CATEGORY_ORDER.length) * Math.PI * 2 - Math.PI / 2;
      const localOffset = (categorySeen - 1) * 14;
      const orbitRadius = 58 + Math.min(24, index * 3);
      // Degree and intensity influence vertex size, but the layout stays readable.
      const radius = Math.max(2.8, 2.2 + Math.sqrt(degree) * 1.2 + intensity * 1.5);
      const viewerNode: GraphViewerNode = {
        ...node,
        originalId: node.id,
        snapshotId: snapshot.id,
        snapshotDay: snapshot.day,
        layerIndex,
        x: Math.cos(angle) * orbitRadius + Math.cos(angle + Math.PI / 2) * localOffset,
        y: Math.sin(angle) * orbitRadius + Math.sin(angle + Math.PI / 2) * localOffset,
        z,
        fx: 0,
        fy: 0,
        fz: 0,
        color,
        radius,
        sourceKind: mode === "temporal" && layerIndex < visibleSnapshots.length - 1 ? "historical" : "current",
      };
      nodeMap.set(node.id, viewerNode);
      nodes.push(viewerNode);
    });

    safeArray(snapshot.relations_json).forEach((relation) => {
      const type = relationType(relation);
      const style = resolveRelationStyle(type);
      const sourceId = relationSourceId(relation);
      const targetId = relationTargetId(relation);
      const source = sourceId
        ? nodeMap.get(sourceId) ?? nodes.find((item) => item.snapshotId === snapshot.id && item.originalId === sourceId)
        : undefined;
      const target = targetId
        ? nodeMap.get(targetId) ?? nodes.find((item) => item.snapshotId === snapshot.id && item.originalId === targetId)
        : undefined;
      if (!source || !target) {
        // A relation naming an endpoint this snapshot does not carry. Still
        // dropped — there is nothing to draw it between — but counted, because
        // dropping every relation of every snapshot is how this read as working
        // for as long as it did.
        unresolved += 1;
        return;
      }
      const confidence = typeof relation.confidence === "number" ? relation.confidence : 1;
      const isAdded = mode === "temporal" && safeArray(snapshot.temporal_diff_json?.added_relations).some((item) => sameRelationShape(item, relation));
      const isChanged = mode === "temporal" && safeArray(snapshot.temporal_diff_json?.changed_relations).some((item) => sameRelationShape(item, relation));
      links.push({
        ...relation,
        // Canonical names on the way out, whichever name came in. A consumer
        // holding a `GraphViewerLink` reads `source_id` off the type and must
        // not have to repeat the fallback above to get a value. Taken from the
        // resolved vertices, which is where the ids just came from and is the
        // one form of them that cannot be undefined.
        source_id: source.originalId,
        target_id: target.originalId,
        type,
        source,
        target,
        color: isAdded ? "#14b8a6" : isChanged ? "#f59e0b" : style.color,
        width: Math.max(0.6, style.width * (0.72 + confidence * 0.72)),
        opacity: Math.min(0.9, Math.max(0.35, style.opacity * (0.7 + confidence * 0.45))),
        dashed: style.dashed || isChanged,
        layerIndex,
        snapshotId: snapshot.id,
        snapshotDay: snapshot.day,
      });
    });
  });

  if (nodes.length > 0) {
    const center = nodes.reduce(
      (acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y, z: acc.z + node.z }),
      { x: 0, y: 0, z: 0 },
    );
    center.x /= nodes.length;
    center.y /= nodes.length;
    center.z /= nodes.length;
    nodes.forEach((node) => {
      node.x -= center.x;
      node.y -= center.y;
      node.z -= center.z;
      node.fx = node.x;
      node.fy = node.y;
      node.fz = node.z;
    });
  }

  return { nodes, links, unresolvedLinks: unresolved };
}

// ──────────────────────────────────────────────────────────────
// Concept quotient graph: merge all snapshots into a recurrent directed graph.
// Same label+category across entries -> single concept vertex.
// ──────────────────────────────────────────────────────────────

interface ConceptMeta {
  id: string;
  label: string;
  category: string;
  frequency: number;
  firstDay: string;
  lastDay: string;
  totalIntensity: number;
  confidence: number;
  allDays: string[];
}

interface ConceptEdgeMeta {
  sourceKey: string;
  targetKey: string;
  type: string;
  frequency: number;
  totalConfidence: number;
}

export function buildConceptGraphData(snapshots: GraphSnapshot[]): GraphViewerData {
  const ordered = [...snapshots].sort((a, b) => a.day.localeCompare(b.day));
  const conceptMap = new Map<string, ConceptMeta>();
  const edgeMap = new Map<string, ConceptEdgeMeta>();

  for (const snapshot of ordered) {
    const nodeKeyMap = new Map<string, string>(); // node.id → concept key

    for (const node of safeArray(snapshot.nodes_json)) {
      const conceptKey = `${node.category}:${node.label.toLowerCase().trim()}`;
      nodeKeyMap.set(node.id, conceptKey);

      const intensity = typeof node.intensity === "number" ? node.intensity : 0.5;
      const confidence = typeof node.confidence === "number" ? node.confidence : 1.0;
      const existing = conceptMap.get(conceptKey);

      if (existing) {
        existing.frequency++;
        existing.lastDay = snapshot.day;
        existing.totalIntensity += intensity;
        if (!existing.allDays.includes(snapshot.day)) existing.allDays.push(snapshot.day);
      } else {
        conceptMap.set(conceptKey, {
          id: `c:${conceptKey}`,
          label: node.label,
          category: node.category,
          frequency: 1,
          firstDay: snapshot.day,
          lastDay: snapshot.day,
          totalIntensity: intensity,
          confidence,
          allDays: [snapshot.day],
        });
      }
    }

    for (const relation of safeArray(snapshot.relations_json)) {
      const sourceKey = nodeKeyMap.get(relationSourceId(relation) ?? "");
      const targetKey = nodeKeyMap.get(relationTargetId(relation) ?? "");
      if (!sourceKey || !targetKey || sourceKey === targetKey) continue;

      const type = relationType(relation);
      const edgeKey = `${sourceKey}→${targetKey}:${type}`;
      const confidence = typeof relation.confidence === "number" ? relation.confidence : 1.0;
      const existing = edgeMap.get(edgeKey);

      if (existing) {
        existing.frequency++;
        existing.totalConfidence += confidence;
      } else {
        edgeMap.set(edgeKey, { sourceKey, targetKey, type, frequency: 1, totalConfidence: confidence });
      }
    }
  }

  const nodes: GraphViewerNode[] = Array.from(conceptMap.values()).map((meta) => {
    const avgIntensity = meta.totalIntensity / meta.frequency;
    const color = CATEGORY_COLORS[meta.category] ?? "#94a3b8";
    // Concept recurrence controls vertex size and grows slowly to avoid visual dominance.
    const radius = Math.max(2.5, 2 + Math.cbrt(meta.frequency) * 2.8 + avgIntensity * 1.2);
    // Spread nodes on a sphere so the force sim doesn't start with a degenerate state
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 30 + Math.random() * 60;
    return {
      id: meta.id,
      originalId: meta.id,
      label: meta.label,
      category: meta.category as GraphViewerNode["category"],
      intensity: avgIntensity,
      confidence: meta.confidence,
      snapshotId: -1 as unknown as RecordId,
      snapshotDay: meta.lastDay,
      layerIndex: -1,
      // Random sphere surface — no fx/fy/fz so the force simulation runs freely
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.sin(phi) * Math.sin(theta),
      z: r * Math.cos(phi),
      color,
      radius,
      sourceKind: "current",
      frequency: meta.frequency,
      allDays: meta.allDays,
    };
  });

  const nodeByKey = new Map<string, GraphViewerNode>();
  nodes.forEach((n) => nodeByKey.set(`${n.category}:${n.label.toLowerCase().trim()}`, n));

  const links: GraphViewerLink[] = [];
  for (const [, meta] of edgeMap) {
    const source = nodeByKey.get(meta.sourceKey);
    const target = nodeByKey.get(meta.targetKey);
    if (!source || !target) continue;
    const style = resolveRelationStyle(meta.type);
    links.push({
      source,
      target,
      source_id: source.originalId,
      target_id: target.originalId,
      type: meta.type,
      confidence: meta.totalConfidence / meta.frequency,
      color: style.color,
      width: Math.max(0.8, style.width * Math.min(3.5, Math.sqrt(meta.frequency))),
      opacity: Math.min(0.95, style.opacity + meta.frequency * 0.04),
      dashed: style.dashed,
      layerIndex: -1,
      snapshotId: -1 as unknown as RecordId,
      snapshotDay: "",
      frequency: meta.frequency,
    });
  }

  return { nodes, links };
}

// ──────────────────────────────────────────────────────────────
// Node selection + explanation helpers
// ──────────────────────────────────────────────────────────────

function summarizeNodeRelations(
  node: GraphViewerNode,
  snapshot?: GraphSnapshot | null,
  explanation?: ExplanationPayload | null,
): string[] {
  const summaries: string[] = [];

  if (node.frequency && node.frequency > 1) {
    summaries.push(t.graph.role.recurring(node.frequency, node.allDays?.length ?? node.frequency));
  }

  const graphSummary = snapshot?.graph_summary_json;
  const keyRelations = explanation?.key_relations ?? graphSummary?.key_relations ?? [];

  if (graphSummary?.key_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push(t.graph.role.highSalience);
  }
  // `key_relations` and `changed_relations` are the extractor's own relation
  // dicts, passed through `build_graph_summary` and `build_temporal_graph_diff`
  // untouched — so they carry `source_node_id`, and reading `source_id` off
  // them matched nothing. Both badges were unreachable.
  if (keyRelations.some((relation) => relationSourceId(relation) === node.originalId || relationTargetId(relation) === node.originalId)) {
    summaries.push(t.graph.role.keyRelation);
  }

  const diff = snapshot?.temporal_diff_json;
  if (diff?.added_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push(t.graph.role.added);
  }
  if (diff?.removed_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push(t.graph.role.removed);
  }
  if (diff?.changed_relations?.some((relation) => relationSourceId(relation) === node.originalId || relationTargetId(relation) === node.originalId)) {
    summaries.push(t.graph.role.relationShifted);
  }
  if (node.category === "Event") summaries.push(t.graph.role.event);
  if (!summaries.length) summaries.push(t.graph.role.structural);

  return summaries;
}

export function buildNodeSelection(
  node: GraphViewerNode,
  snapshot?: GraphSnapshot | null,
  explanation?: ExplanationPayload | null,
): GraphNodeSelection {
  const relationSummary = summarizeNodeRelations(node, snapshot, explanation);
  const anomalySignals: string[] = [];

  const diff = snapshot?.temporal_diff_json;
  if (diff?.protective_decline?.drop_in_protective_nodes) {
    anomalySignals.push(t.graph.role.protectiveDecline(diff.protective_decline.drop_in_protective_nodes));
  }
  if (explanation?.triggered_rules_json?.length) {
    anomalySignals.push(...explanation.triggered_rules_json.map((rule) => rule.rule));
  }
  if (!anomalySignals.length) anomalySignals.push(t.graph.role.noRuleTrigger);

  const category = t.graph.category[node.category] ?? node.category;
  const roleSummary = node.frequency
    ? t.graph.role.conceptSummary(category, node.frequency, node.snapshotDay)
    : t.graph.role.nodeSummary(category, node.snapshotDay);

  return { node, roleSummary, relationSummary, anomalySignals };
}

export function getDebugFallbackData(): GraphViewerData {
  const node1: GraphViewerNode = {
    id: "fallback-1", originalId: "fallback-1", label: t.graph.fallback.stableState, category: "State",
    intensity: 0.8, confidence: 1.0, snapshotId: 999, snapshotDay: "2026-04-03", layerIndex: 0,
    x: -36, y: 0, z: 0, fx: -36, fy: 0, fz: 0, color: CATEGORY_COLORS.State, radius: 8.8, sourceKind: "current",
  };
  const node2: GraphViewerNode = {
    id: "fallback-2", originalId: "fallback-2", label: t.graph.fallback.eveningWalk, category: "Event",
    intensity: 0.6, confidence: 1.0, snapshotId: 999, snapshotDay: "2026-04-03", layerIndex: 0,
    x: 36, y: 0, z: 0, fx: 36, fy: 0, fz: 0, color: CATEGORY_COLORS.Event, radius: 7.6, sourceKind: "current",
  };
  const link: GraphViewerLink = {
    source: node1, target: node2, source_id: "fallback-1", target_id: "fallback-2",
    type: "co_occurs", confidence: 1.0,
    color: RELATION_STYLES.co_occurs.color, width: RELATION_STYLES.co_occurs.width,
    opacity: RELATION_STYLES.co_occurs.opacity, dashed: RELATION_STYLES.co_occurs.dashed,
    layerIndex: 0, snapshotId: 999, snapshotDay: "2026-04-03",
  };
  return { nodes: [node1, node2], links: [link] };
}
