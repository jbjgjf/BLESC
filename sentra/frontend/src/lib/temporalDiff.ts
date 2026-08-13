/**
 * Day-over-day graph diff for the production write path (#106).
 *
 * Production previously wrote this, unconditionally, on every submission:
 *
 *     added_nodes: extraction.nodes,        // i.e. all of them
 *     removed_nodes: [],
 *     changed_relations: [],
 *     relation_shift_summary: "production submission baseline snapshot"
 *
 * It never read the previous snapshot, so every day was a "baseline": nothing
 * ever recurred, disappeared, or changed. The temporal view coloured every
 * relation as newly added (`graphAdapter.ts`), on every day, forever, and the
 * amber "changed" state was unreachable. The field was named for a diff and
 * contained none.
 *
 * The backend (`app/analytics/graph_features.py:build_temporal_graph_diff`) had
 * the correct implementation the whole time. This is a deliberate port of it,
 * not a reinterpretation — the two are pinned to the same fixtures in
 * `sentra/shared/temporal_diff_conformance.json`, checked by
 * `tests/temporal-diff.test.mjs` here and `tests/test_temporal_diff_conformance.py`
 * in the backend. Two implementations of one contract is the condition that
 * produced this bug; a shared fixture set is what stops it recurring.
 */

import type { ExtractedNode, ExtractedRelation } from "./extraction";

export type SnapshotShape = {
  nodes: ExtractedNode[];
  relations: ExtractedRelation[];
};

export const EMPTY_SNAPSHOT: SnapshotShape = { nodes: [], relations: [] };

export type ChangedRelation = {
  source_id: string;
  target_id: string;
  type: string;
  previous_confidence: number;
  current_confidence: number;
  confidence_delta: number;
};

export type TemporalDiff = {
  added_nodes: ExtractedNode[];
  removed_nodes: ExtractedNode[];
  added_relations: ExtractedRelation[];
  removed_relations: ExtractedRelation[];
  changed_relations: ChangedRelation[];
};

/**
 * Minimum confidence movement before a shared relation counts as "changed".
 *
 * 0.15 matches the backend constant. It is an engineering choice, not a
 * measured threshold: below it, day-to-day model jitter on the same observation
 * would render as amber "this changed" in the student's view.
 */
export const CONFIDENCE_CHANGE_THRESHOLD = 0.15;

function nodeKey(node: Partial<ExtractedNode> & { node_id?: string }): string {
  return String(node?.id ?? node?.node_id ?? "");
}

function relationKey(relation: Partial<ExtractedRelation> & {
  source_node_id?: string;
  target_node_id?: string;
}): string {
  const source = String(relation?.source_id ?? relation?.source_node_id ?? "");
  const target = String(relation?.target_id ?? relation?.target_node_id ?? "");
  const type = String(relation?.type ?? "co_occurs");
  // A tuple key, flattened. U+001F (unit separator) is a control character that
  // cannot occur in a label-derived id, so this cannot collide the way a "-"
  // separator could against a label that itself contains one.
  return `${source}\u001f${target}\u001f${type}`;
}

function confidenceOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 1.0;
}

/**
 * `previous` is the participant's most recent snapshot strictly before this
 * one. Pass `EMPTY_SNAPSHOT` for a genuine first entry — and only then. Passing
 * it because the previous snapshot was not looked up is what #106 was.
 */
export function buildTemporalDiff(current: SnapshotShape, previous: SnapshotShape): TemporalDiff {
  const currentNodes = new Map<string, ExtractedNode>();
  for (const node of current.nodes ?? []) {
    const key = nodeKey(node);
    if (key) currentNodes.set(key, node);
  }
  const previousNodes = new Map<string, ExtractedNode>();
  for (const node of previous.nodes ?? []) {
    const key = nodeKey(node);
    if (key) previousNodes.set(key, node);
  }

  const currentRelations = new Map<string, ExtractedRelation>();
  for (const relation of current.relations ?? []) currentRelations.set(relationKey(relation), relation);
  const previousRelations = new Map<string, ExtractedRelation>();
  for (const relation of previous.relations ?? []) previousRelations.set(relationKey(relation), relation);

  const changed_relations: ChangedRelation[] = [];
  for (const [key, currentRelation] of currentRelations) {
    const previousRelation = previousRelations.get(key);
    if (!previousRelation) continue;
    const currentConfidence = confidenceOf(currentRelation.confidence);
    const previousConfidence = confidenceOf(previousRelation.confidence);
    if (Math.abs(currentConfidence - previousConfidence) >= CONFIDENCE_CHANGE_THRESHOLD) {
      const [source_id, target_id, type] = key.split("\u001f");
      changed_relations.push({
        source_id,
        target_id,
        type,
        previous_confidence: previousConfidence,
        current_confidence: currentConfidence,
        confidence_delta: Number((currentConfidence - previousConfidence).toFixed(10)),
      });
    }
  }

  return {
    added_nodes: [...currentNodes].filter(([key]) => !previousNodes.has(key)).map(([, node]) => node),
    removed_nodes: [...previousNodes].filter(([key]) => !currentNodes.has(key)).map(([, node]) => node),
    added_relations: [...currentRelations].filter(([key]) => !previousRelations.has(key)).map(([, r]) => r),
    removed_relations: [...previousRelations].filter(([key]) => !currentRelations.has(key)).map(([, r]) => r),
    changed_relations,
  };
}

/**
 * Human-readable shift line, replacing the hard-coded
 * "production submission baseline snapshot" string.
 *
 * `hadPrevious` is carried explicitly so that a real first entry and a lookup
 * that returned nothing are distinguishable in stored data. They were not
 * before, which is why the defect survived: every row claimed to be a baseline
 * and no row could contradict it.
 */
export function relationShiftSummary(diff: TemporalDiff, hadPrevious: boolean): string {
  if (!hadPrevious) return "first snapshot for this participant; no previous day to compare";
  const parts = [
    `${diff.added_nodes.length} node(s) added`,
    `${diff.removed_nodes.length} removed`,
    `${diff.added_relations.length} relation(s) added`,
    `${diff.removed_relations.length} removed`,
    `${diff.changed_relations.length} changed`,
  ];
  return parts.join(", ");
}
