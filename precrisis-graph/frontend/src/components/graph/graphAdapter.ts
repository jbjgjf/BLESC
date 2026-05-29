import type { ExplanationPayload, GraphSnapshot } from "@/api/models";
import type { GraphMode, GraphViewerData, GraphViewerLink, GraphViewerNode, GraphNodeSelection } from "./graphTypes";

const CATEGORY_COLORS: Record<string, string> = {
  State: "#ef4444",
  Trigger: "#f59e0b",
  Event: "#06b6d4",
  Protective: "#22c55e",
  Behavior: "#8b5cf6",
};

const RELATION_STYLES: Record<string, { color: string; width: number; opacity: number; dashed: boolean }> = {
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

function resolveRelationStyle(type: string) {
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
    const z = mode === "temporal" ? layerIndex * 90 : 0;
    const nodeMap = new Map<string, GraphViewerNode>();

    safeArray(snapshot.nodes_json).forEach((node) => {
      const color = CATEGORY_COLORS[node.category] ?? "#94a3b8";
      const intensity = typeof node.intensity === "number" ? node.intensity : 0.5;
      const viewerNode: GraphViewerNode = {
        ...node,
        originalId: node.id,
        snapshotId: snapshot.id,
        snapshotDay: snapshot.day,
        layerIndex,
        z,
        color,
        radius: Math.max(4, 4 + Math.min(8, intensity * 6)),
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

  return { nodes, links };
}

function summarizeNodeRelations(
  node: GraphViewerNode,
  snapshot?: GraphSnapshot | null,
  explanation?: ExplanationPayload | null,
): string[] {
  const summaries: string[] = [];
  const graphSummary = snapshot?.graph_summary_json;
  const diff = snapshot?.temporal_diff_json;
  const keyRelations = explanation?.key_relations ?? graphSummary?.key_relations ?? [];

  if (graphSummary?.key_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("High-salience node in the graph summary");
  }

  if (keyRelations.some((relation) => relation.source_id === node.originalId || relation.target_id === node.originalId)) {
    summaries.push("Participates in a key relation linked to the explanation");
  }

  if (diff?.added_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("Added relative to the baseline graph");
  }

  if (diff?.removed_nodes?.some((item) => item.id === node.originalId)) {
    summaries.push("Removed relative to the baseline graph");
  }

  if (diff?.changed_relations?.some((relation) => relation.source_id === node.originalId || relation.target_id === node.originalId)) {
    summaries.push("Touches a relation that shifted against the baseline");
  }

  if (node.category === "Event") {
    summaries.push("Event node contributing temporal structure");
  }

  if (!summaries.length) {
    summaries.push("Structural node used by the graph-native inference layer");
  }

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

  if (!anomalySignals.length) {
    anomalySignals.push("No direct rule trigger attached to this node");
  }

  const roleSummary = [
    `${node.category} node`,
    `snapshot ${node.snapshotDay}`,
    `layer ${node.layerIndex + 1}`,
  ].join(" · ");

  return {
    node,
    roleSummary,
    relationSummary,
    anomalySignals,
  };
}


export function getDebugFallbackData(): GraphViewerData {
  const node1: GraphViewerNode = {
    id: "fallback-1",
    originalId: "fallback-1",
    label: "Mental State (Stable)",
    category: "State",
    intensity: 0.8,
    confidence: 1.0,
    snapshotId: 999,
    snapshotDay: "2026-04-03",
    layerIndex: 0,
    z: 0,
    color: CATEGORY_COLORS.State,
    radius: 8.8,
    sourceKind: "current",
  };

  const node2: GraphViewerNode = {
    id: "fallback-2",
    originalId: "fallback-2",
    label: "Evening Walk",
    category: "Event",
    intensity: 0.6,
    confidence: 1.0,
    snapshotId: 999,
    snapshotDay: "2026-04-03",
    layerIndex: 0,
    z: 0,
    color: CATEGORY_COLORS.Event,
    radius: 7.6,
    sourceKind: "current",
  };

  const link: GraphViewerLink = {
    source: node1,
    target: node2,
    source_id: "fallback-1",
    target_id: "fallback-2",
    type: "co_occurs",
    confidence: 1.0,
    color: RELATION_STYLES.co_occurs.color,
    width: RELATION_STYLES.co_occurs.width,
    opacity: RELATION_STYLES.co_occurs.opacity,
    dashed: RELATION_STYLES.co_occurs.dashed,
    layerIndex: 0,
    snapshotId: 999,
    snapshotDay: "2026-04-03",
  };

  return {
    nodes: [node1, node2],
    links: [link],
  };
}
