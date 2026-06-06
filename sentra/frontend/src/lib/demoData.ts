import type {
  Entry,
  EntrySubmissionResponse,
  ExplanationPayload,
  ExtractionNode,
  ExtractionRelation,
  GraphLayerSummary,
  GraphSnapshot,
  TemporalGraphDiff,
} from "@/api/models";

const demoNodes: ExtractionNode[] = [
  { id: "state_cognitive_load", category: "State", label: "High cognitive load", intensity: 0.86, confidence: 0.94 },
  { id: "state_irritability", category: "State", label: "Irritability", intensity: 0.68, confidence: 0.88 },
  { id: "state_recovery", category: "State", label: "Evening recovery", intensity: 0.58, confidence: 0.82 },
  { id: "trigger_deadline_cluster", category: "Trigger", label: "Deadline cluster", intensity: 0.91, confidence: 0.96 },
  { id: "trigger_context_switching", category: "Trigger", label: "Context switching", intensity: 0.74, confidence: 0.9 },
  { id: "trigger_sleep_debt", category: "Trigger", label: "Sleep debt", intensity: 0.71, confidence: 0.86 },
  { id: "protective_peer_checkin", category: "Protective", label: "Peer check-in", intensity: 0.82, confidence: 0.93 },
  { id: "protective_walk", category: "Protective", label: "Morning walk", intensity: 0.64, confidence: 0.89 },
  { id: "protective_planning", category: "Protective", label: "Written next-step plan", intensity: 0.77, confidence: 0.91 },
  { id: "behavior_task_fragmentation", category: "Behavior", label: "Task fragmentation", intensity: 0.79, confidence: 0.9 },
  { id: "behavior_message_delay", category: "Behavior", label: "Delayed replies", intensity: 0.58, confidence: 0.81 },
  { id: "behavior_deep_work", category: "Behavior", label: "Deep work block", intensity: 0.61, confidence: 0.84 },
  {
    id: "event_morning_walk",
    category: "Event",
    label: "Morning walk before work",
    intensity: 0.55,
    confidence: 0.89,
    start_time: "2026-05-10T07:40:00",
    end_time: "2026-05-10T08:20:00",
    duration: 40,
  },
  {
    id: "event_client_review",
    category: "Event",
    label: "Client review meeting",
    intensity: 0.88,
    confidence: 0.94,
    start_time: "2026-05-10T14:00:00",
    end_time: "2026-05-10T15:15:00",
    duration: 75,
  },
  {
    id: "event_evening_debrief",
    category: "Event",
    label: "Evening debrief with friend",
    intensity: 0.69,
    confidence: 0.9,
    start_time: "2026-05-10T20:30:00",
    end_time: "2026-05-10T21:05:00",
    duration: 35,
  },
];

const demoRelations: ExtractionRelation[] = [
  { source_id: "trigger_deadline_cluster", target_id: "state_cognitive_load", type: "causes", confidence: 0.95 },
  { source_id: "trigger_context_switching", target_id: "state_cognitive_load", type: "escalates", confidence: 0.9 },
  { source_id: "trigger_sleep_debt", target_id: "state_irritability", type: "escalates", confidence: 0.84 },
  { source_id: "state_cognitive_load", target_id: "behavior_task_fragmentation", type: "causes", confidence: 0.88 },
  { source_id: "behavior_task_fragmentation", target_id: "behavior_message_delay", type: "co_occurs", confidence: 0.76 },
  { source_id: "event_client_review", target_id: "trigger_deadline_cluster", type: "precedes", confidence: 0.86 },
  { source_id: "event_client_review", target_id: "state_cognitive_load", type: "escalates", confidence: 0.89 },
  { source_id: "protective_walk", target_id: "state_cognitive_load", type: "buffers", confidence: 0.79 },
  { source_id: "event_morning_walk", target_id: "protective_walk", type: "precedes", confidence: 0.92 },
  { source_id: "protective_peer_checkin", target_id: "state_irritability", type: "buffers", confidence: 0.87 },
  { source_id: "event_evening_debrief", target_id: "protective_peer_checkin", type: "precedes", confidence: 0.91 },
  { source_id: "protective_planning", target_id: "behavior_task_fragmentation", type: "buffers", confidence: 0.83 },
  { source_id: "protective_planning", target_id: "behavior_deep_work", type: "causes", confidence: 0.78 },
  { source_id: "behavior_deep_work", target_id: "state_recovery", type: "precedes", confidence: 0.74 },
  { source_id: "protective_peer_checkin", target_id: "protective_planning", type: "causes", confidence: 0.82 },
  { source_id: "state_recovery", target_id: "behavior_message_delay", type: "avoids", confidence: 0.7 },
  { source_id: "trigger_sleep_debt", target_id: "behavior_deep_work", type: "avoids", confidence: 0.72 },
  { source_id: "event_client_review", target_id: "event_evening_debrief", type: "precedes", confidence: 0.93 },
];

function summaryFor(nodes: ExtractionNode[], relations: ExtractionRelation[]): GraphLayerSummary {
  const categoryCounts = nodes.reduce<Record<string, number>>((acc, node) => {
    acc[node.category] = (acc[node.category] ?? 0) + 1;
    return acc;
  }, {});

  return {
    node_count: nodes.length,
    relation_count: relations.length,
    event_count: categoryCounts.Event ?? 0,
    key_nodes: nodes.filter((node) => node.intensity >= 0.74).slice(0, 8),
    key_relations: relations.filter((relation) => relation.confidence >= 0.82).slice(0, 10),
    summary: `${nodes.length} nodes, ${relations.length} relations, ${categoryCounts.Protective ?? 0} protective nodes, ${categoryCounts.Trigger ?? 0} active triggers`,
  };
}

const demoTemporalDiff: TemporalGraphDiff = {
  added_nodes: demoNodes.filter((node) => ["trigger_deadline_cluster", "protective_planning", "event_client_review"].includes(node.id)),
  removed_nodes: [
    { id: "protective_weekend_recovery", category: "Protective", label: "Weekend recovery buffer", intensity: 0.56, confidence: 0.78 },
    { id: "behavior_social_availability", category: "Behavior", label: "Fast message response", intensity: 0.52, confidence: 0.74 },
  ],
  added_relations: demoRelations.filter((relation) => relation.confidence >= 0.88),
  removed_relations: [
    { source_id: "protective_weekend_recovery", target_id: "state_cognitive_load", type: "buffers", confidence: 0.72 },
  ],
  changed_relations: [
    { source_id: "trigger_deadline_cluster", target_id: "state_cognitive_load", previous_confidence: 0.58, current_confidence: 0.95 },
    { source_id: "protective_peer_checkin", target_id: "state_irritability", previous_confidence: 0.42, current_confidence: 0.87 },
    { source_id: "trigger_sleep_debt", target_id: "behavior_deep_work", previous_confidence: 0.31, current_confidence: 0.72 },
  ],
  relation_shift_summary: "3 high-salience nodes added, 2 stabilizers reduced, 8 relations strengthened, 1 relation removed",
  protective_decline: {
    drop_in_protective_nodes: 1,
    current_protective_nodes: 3,
    previous_protective_nodes: 4,
    strongest_remaining_buffer: "Peer check-in",
  },
  uncertainty: {
    level: "low",
    reasons: ["Dense graph coverage", "Multiple relation confirmations", "Temporal baseline available"],
  },
};

function snapshot(id: number, day: string, nodes: ExtractionNode[], relations: ExtractionRelation[]): GraphSnapshot {
  return {
    id,
    entry_id: 800 + id,
    user_id: "research_user_01",
    day,
    nodes_json: nodes,
    relations_json: relations,
    graph_summary_json: summaryFor(nodes, relations),
    temporal_diff_json: id === 904 ? demoTemporalDiff : {
      added_nodes: [],
      removed_nodes: [],
      added_relations: [],
      removed_relations: [],
      changed_relations: [],
      relation_shift_summary: "Baseline layer used for temporal comparison",
      protective_decline: { drop_in_protective_nodes: 0, current_protective_nodes: 4, previous_protective_nodes: 4 },
      uncertainty: { level: "low", reasons: ["Historical baseline sample"] },
    },
    created_at: `${day}T21:30:00`,
  };
}

const baselineNodes = demoNodes.filter((node) => !["trigger_deadline_cluster", "behavior_message_delay"].includes(node.id));
const baselineRelations = demoRelations.filter((relation) => relation.confidence < 0.9).slice(0, 10);

export const demoGraphSnapshots: GraphSnapshot[] = [
  snapshot(901, "2026-05-06", baselineNodes.slice(0, 10), baselineRelations.slice(0, 8)),
  snapshot(902, "2026-05-07", demoNodes.filter((node) => node.id !== "behavior_message_delay").slice(0, 12), demoRelations.slice(0, 12)),
  snapshot(903, "2026-05-09", demoNodes.filter((node) => node.id !== "state_recovery"), demoRelations.slice(0, 15)),
  snapshot(904, "2026-05-10", demoNodes, demoRelations),
];

export const demoExplanation: ExplanationPayload = {
  id: 1204,
  user_id: "research_user_01",
  day: "2026-05-10",
  triggered_rules_json: [
    { rule: "Deadline pressure cascade", evidence: "Deadline cluster escalates cognitive load and task fragmentation", weight: 0.34 },
    { rule: "Protective buffer retained", evidence: "Peer check-in and written planning reduce state escalation", weight: -0.21 },
    { rule: "Sleep debt interference", evidence: "Sleep debt weakens deep work and increases irritability", weight: 0.18 },
  ],
  baseline_deviation_json: {
    anomaly_score: 1.37,
    baseline_deviation_score: 0.82,
    temporal_shift_score: 0.55,
    relation_density_delta: 0.41,
  },
  changed_relations_json: demoTemporalDiff.changed_relations,
  protective_decline_json: demoTemporalDiff.protective_decline,
  uncertainty_json: demoTemporalDiff.uncertainty,
  evidence_summaries: [
    "Deadline cluster and client review form the strongest pressure path.",
    "Peer check-in remains a meaningful buffer against irritability.",
    "Planning converts social support into a next action and restores deep work.",
  ],
  graph_summary_json: summaryFor(demoNodes, demoRelations),
  score_breakdown_json: {
    trigger_load: 0.38,
    behavior_fragmentation: 0.24,
    protective_buffer: -0.19,
    recovery_signal: -0.06,
  },
  key_relations: summaryFor(demoNodes, demoRelations).key_relations,
  created_at: "2026-05-10T21:36:00",
};

export const demoSubmission: EntrySubmissionResponse = {
  entry: {
    id: 9901,
    user_id: "research_user_01",
    is_masked: true,
    created_at: "2026-05-10T21:36:00",
    expires_at: "2026-06-09T21:36:00",
  },
  extraction: {
    id: 7701,
    entry_id: 9901,
    nodes_json: demoNodes,
    relations_json: demoRelations,
    temporal_summary: demoTemporalDiff.relation_shift_summary,
    created_at: "2026-05-10T21:36:00",
    extractor_version: "demo-heavy-user-v1",
    extraction_provider: "demo",
    extraction_model: "demo-heavy-user-v1",
  },
  graph_snapshot: demoGraphSnapshots.at(-1)!,
  anomaly_result: {
    id: 6101,
    user_id: "research_user_01",
    day: "2026-05-10",
    anomaly_score: 1.37,
    z_scores_json: {
      trigger_count: 1.72,
      protective_count: -0.38,
      relation_density: 1.44,
      behavior_count: 1.1,
      temporal_shift_score: 0.55,
    },
    explanation_id: 1204,
  },
  explanation: demoExplanation,
};

export const demoEntries: Entry[] = Array.from({ length: 96 }, (_, index) => {
  const date = new Date("2026-05-10T21:36:00");
  date.setDate(date.getDate() - index);
  return {
    id: 9901 - index,
    user_id: "research_user_01",
    is_masked: true,
    created_at: date.toISOString(),
    expires_at: new Date(date.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
});
