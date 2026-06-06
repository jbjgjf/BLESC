import type { ExplanationPayload, GraphSnapshot, RecordId } from "@/api/models";
import type { GraphMode, GraphViewerData, GraphViewerLink, GraphViewerNode, GraphNodeSelection } from "./graphTypes";

export const CATEGORY_COLORS: Record<string, string> = {
  State: "#c92a2a",
  Trigger: "#d97706",
  Event: "#0072b2",
  Protective: "#2f9e44",
  Behavior: "#6f42c1",
};

const CATEGORY_ORDER = ["State", "Trigger", "Behavior", "Event", "Protective"];

export const RELATION_STYLES: Record<string, { color: string; width: number; opacity: number; dashed: boolean }> = {
  causes: { color: "#f97316", width: 2.8, opacity: 0.95, dashed: false },
  escalates: { color: "#ef4444", width: 3.2, opacity: 0.95, dashed: false },
  buffers: { color: "#22c55e", width: 2.6, opacity: 0.9, dashed: false },
  avoids: { color: "#a855f7", width: 2.2, opacity: 0.8, dashed: true },
  co_occurs: { color: "#0ea5e9", width: 1.8, opacity: 0.72, dashed: false },
  precedes: { color: "#64748b", width: 2.0, opacity: 0.78, dashed: true },
};

function safeArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

export function resolveRelationStyle(type: string) {
  return RELATION_STYLES[type] ?? RELATION_STYLES.co_occurs;
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

  visibleSnapshots.forEach((snapshot, layerIndex) => {
    const z = mode === "temporal" ? (layerIndex - Math.max(0, visibleSnapshots.length - 1) / 2) * 90 : 0;
    const nodeMap = new Map<string, GraphViewerNode>();
    const categoryCounts = new Map<string, number>();

    // Pre-compute degree for size scaling
    const degreeCounts = new Map<string, number>();
    safeArray(snapshot.relations_json).forEach((rel) => {
      const r = rel as unknown as Record<string, string>;
      const src = rel.source_id ?? r["source_node_id"];
      const tgt = rel.target_id ?? r["target_node_id"];
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
      // Obsidian-style: small nodes — degree and intensity influence size but keep them tiny
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
      const style = resolveRelationStyle(relation.type);
      const source = nodeMap.get(relation.source_id) ?? nodes.find((item) => item.snapshotId === snapshot.id && item.originalId === relation.source_id);
      const target = nodeMap.get(relation.target_id) ?? nodes.find((item) => item.snapshotId === snapshot.id && item.originalId === relation.target_id);
      if (!source || !target) return;
      links.push({
        ...relation,
        source,
        target,
        color: style.color,
        width: style.width,
        opacity: style.opacity,
        dashed: style.dashed,
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

  return { nodes, links };
}

// ──────────────────────────────────────────────────────────────
// Concept graph: merge all snapshots into a persistent network
// Same label+category across entries → single growing node
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
      const r2 = relation as unknown as Record<string, string>;
      const srcRaw = relation.source_id ?? r2["source_node_id"] ?? "";
      const tgtRaw = relation.target_id ?? r2["target_node_id"] ?? "";
      const sourceKey = nodeKeyMap.get(srcRaw);
      const targetKey = nodeKeyMap.get(tgtRaw);
      if (!sourceKey || !targetKey || sourceKey === targetKey) continue;

      const edgeKey = `${sourceKey}→${targetKey}:${relation.type}`;
      const confidence = typeof relation.confidence === "number" ? relation.confidence : 1.0;
      const existing = edgeMap.get(edgeKey);

      if (existing) {
        existing.frequency++;
        existing.totalConfidence += confidence;
      } else {
        edgeMap.set(edgeKey, { sourceKey, targetKey, type: relation.type, frequency: 1, totalConfidence: confidence });
      }
    }
  }

  const nodes: GraphViewerNode[] = Array.from(conceptMap.values()).map((meta) => {
    const avgIntensity = meta.totalIntensity / meta.frequency;
    const color = CATEGORY_COLORS[meta.category] ?? "#94a3b8";
    // Obsidian-style: small glowing dots, size grows slowly with frequency
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
    summaries.push(`Recurring concept — appears in ${node.frequency} entries across ${node.allDays?.length ?? node.frequency} days`);
  }

  const graphSummary = snapshot?.graph_summary_json;
  const keyRelations = explanation?.key_relations ?? graphSummary?.key_relations ?? [];

  if (graphSummary?.key_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("High-salience node in the graph summary");
  }
  if (keyRelations.some((relation) => relation.source_id === node.originalId || relation.target_id === node.originalId)) {
    summaries.push("Participates in a key relation linked to the explanation");
  }

  const diff = snapshot?.temporal_diff_json;
  if (diff?.added_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("Added relative to the baseline graph");
  }
  if (diff?.removed_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("Removed relative to the baseline graph");
  }
  if (diff?.changed_relations?.some((relation) => relation.source_id === node.originalId || relation.target_id === node.originalId)) {
    summaries.push("Touches a relation that shifted against the baseline");
  }
  if (node.category === "Event") summaries.push("Event node contributing temporal structure");
  if (!summaries.length) summaries.push("Structural node used by the graph-native inference layer");

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
    anomalySignals.push(`Protective decline: ${diff.protective_decline.drop_in_protective_nodes}`);
  }
  if (explanation?.triggered_rules_json?.length) {
    anomalySignals.push(...explanation.triggered_rules_json.map((rule) => rule.rule));
  }
  if (!anomalySignals.length) anomalySignals.push("No direct rule trigger attached to this node");

  const roleSummary = node.frequency
    ? `${node.category} concept · seen ${node.frequency}× · last ${node.snapshotDay}`
    : `${node.category} node · snapshot ${node.snapshotDay} · layer ${node.layerIndex + 1}`;

  return { node, roleSummary, relationSummary, anomalySignals };
}

export function getDebugFallbackData(): GraphViewerData {
  const node1: GraphViewerNode = {
    id: "fallback-1", originalId: "fallback-1", label: "Mental State (Stable)", category: "State",
    intensity: 0.8, confidence: 1.0, snapshotId: 999, snapshotDay: "2026-04-03", layerIndex: 0,
    x: -36, y: 0, z: 0, fx: -36, fy: 0, fz: 0, color: CATEGORY_COLORS.State, radius: 8.8, sourceKind: "current",
  };
  const node2: GraphViewerNode = {
    id: "fallback-2", originalId: "fallback-2", label: "Evening Walk", category: "Event",
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
