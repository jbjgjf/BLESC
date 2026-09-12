/**
 * The demo participant's history, in the shapes the API returns (#17).
 *
 * `fixtures.ts` holds the demo data in this app's own vocabulary — diary
 * entries, roster rows, meeting records — and the screens that read it work
 * with no login. The screens that read `ApiClient` did not: timeline,
 * insights, graph, audit, the support summary, sharing, the educator dashboard
 * and the roster all reached Supabase, so a demo without credentials stopped
 * at "ログインが必要です" on exactly the steps #17 asks to demonstrate.
 *
 * This module closes that gap by deriving those API shapes from the same
 * diary. One story, one source: change an entry and the graph, the timeline,
 * the audit trail and what the educator sees all move with it. Two hand-kept
 * copies of a story is how a demo ends up contradicting itself in front of an
 * audience.
 *
 * ## What the demo is careful not to claim
 *
 * The diary is 21 days, and that number is doing work. A signal compares a day
 * against the participant's own previous `RAMP_UP_DAYS`, so the first 14 days
 * carry no score at all — `status: "not_enough_data"`, which is what the
 * product really does and what a school should see it doing. Only the last
 * seven days carry a reading. A demo built on six days could only ever show
 * the empty state; one that showed a score on day two would be demonstrating
 * something the product refuses to do.
 *
 * Nothing here is a real student. Every string is written for this file.
 */

import type {
  AiAuditEvent,
  ChatResponse,
  AnomalyResult,
  CounselorSupportSummary,
  EducatorStudentStatus,
  Entry,
  ExtractionNode,
  ExtractionRelation,
  GraphSnapshot,
  ExplanationPayload,
  OrgCounselor,
  OversightRequest,
  ReflectionAuditTrail,
  SharedSupportSummary,
  StudentAccessRecord,
} from "@/api/models";
import { RAMP_UP_DAYS } from "../baseline.ts";
import { assessSafety } from "../safety-assessment.ts";
import { t } from "../i18n/index.ts";
import { CLASS_ROSTER, CURRENT_STUDENT, MY_ENTRIES } from "./fixtures.ts";
import type { DiaryEntry, EventCategory, Mood } from "./types";

export const DEMO_ORG_ID = "demo-org";
export const DEMO_ORG_NAME = "広尾学園 中学校・高等学校";
export const DEMO_PARTICIPANT_ID = "demo-participant";
//: 34th on a roster of 33 classmates. Not one of their numbers — a code that
//: collides puts two different students behind one label on the roster.
export const DEMO_PARTICIPANT_CODE = "2A-34";

/** Oldest first. Every derivation below reads days in this order. */
const DAYS: DiaryEntry[] = [...MY_ENTRIES].reverse();

/* ── the concept graph one entry produces ─────────────────────────────── */

type Concept = { id: string; category: ExtractionNode["category"]; label: string };

/** What a mood becomes on the graph. */
const MOOD_CONCEPT: Record<Mood, Concept> = {
  very_good: { id: "state_settled", category: "State", label: "落ち着いた気持ち" },
  good: { id: "state_settled", category: "State", label: "落ち着いた気持ち" },
  neutral: { id: "state_ordinary", category: "State", label: "ふだんの気持ち" },
  low: { id: "state_low", category: "State", label: "気持ちの落ち込み" },
  hard: { id: "state_low", category: "State", label: "気持ちの落ち込み" },
};

/**
 * What a category becomes. `friends` and `health` are the two that change
 * meaning with the mood, which is the whole point of the demo's middle stretch:
 * time with friends is a support, and not being able to join in is a trigger,
 * and the same word covers both.
 */
function categoryConcepts(category: EventCategory, mood: Mood): Concept[] {
  const strained = mood === "low" || mood === "hard";
  switch (category) {
    case "study":
      return [{ id: "trigger_workload", category: "Trigger", label: "課題とテストの負担" }];
    case "friends":
      return strained
        ? [{ id: "trigger_left_out", category: "Trigger", label: "友だちの輪に入れない感じ" }]
        : [{ id: "protective_friends", category: "Protective", label: "友だちとの時間" }];
    case "club":
      return [{ id: "protective_club", category: "Protective", label: "部活動" }];
    case "family":
      return [{ id: "protective_family", category: "Protective", label: "家族との時間" }];
    case "future":
      return [{ id: "trigger_path", category: "Trigger", label: "進路の迷い" }];
    case "health":
      return [{ id: "state_sleep", category: "State", label: "眠りの乱れ" }];
    default:
      return [{ id: "event_other", category: "Event", label: "そのほかの出来事" }];
  }
}

function nodesFor(entry: DiaryEntry): ExtractionNode[] {
  const concepts = [MOOD_CONCEPT[entry.mood], ...entry.categories.flatMap((c) => categoryConcepts(c, entry.mood))];
  const seen = new Set<string>();
  return concepts
    .filter((concept) => !seen.has(concept.id) && seen.add(concept.id))
    .map((concept) => ({
      id: concept.id,
      category: concept.category,
      label: concept.label,
      intensity: concept.category === "Protective" ? 0.55 : entry.mood === "low" || entry.mood === "hard" ? 0.78 : 0.45,
      confidence: 0.82,
    }));
}

function relationsFor(nodes: ExtractionNode[]): ExtractionRelation[] {
  const ids = new Set(nodes.map((node) => node.id));
  const state = nodes.find((node) => node.category === "State" && node.id !== "state_sleep");
  if (!state) return [];

  const relations: ExtractionRelation[] = [];
  for (const node of nodes) {
    if (node.id === state.id) continue;
    if (node.category === "Trigger") {
      relations.push({ source_id: node.id, target_id: state.id, type: "escalates", confidence: 0.74 });
    } else if (node.category === "Protective") {
      relations.push({ source_id: node.id, target_id: state.id, type: "buffers", confidence: 0.7 });
    } else if (node.category === "Event") {
      relations.push({ source_id: node.id, target_id: state.id, type: "precedes", confidence: 0.6 });
    }
  }
  // The two-hop chain the demo talks about: not sleeping is what carries a
  // strained day into the next one, so it is drawn as a cause rather than as
  // one more thing that happened.
  if (ids.has("state_sleep")) {
    relations.push({ source_id: "state_sleep", target_id: state.id, type: "causes", confidence: 0.68 });
    if (ids.has("trigger_workload")) {
      relations.push({ source_id: "trigger_workload", target_id: "state_sleep", type: "escalates", confidence: 0.66 });
    }
  }
  return relations;
}

/* ── entries, snapshots, timeline ─────────────────────────────────────── */

export function demoEntries(): Entry[] {
  return DAYS.map((entry, index) => ({
    id: `demo-entry-${index + 1}`,
    user_id: DEMO_PARTICIPANT_CODE,
    raw_text: entry.body,
    is_masked: false,
    created_at: entry.submittedAt,
  })).reverse();
}

export function demoGraphSnapshots(): GraphSnapshot[] {
  let previous: ExtractionNode[] = [];
  return DAYS.map((entry, index) => {
    const nodes = nodesFor(entry);
    const relations = relationsFor(nodes);
    const previousIds = new Set(previous.map((node) => node.id));
    const currentIds = new Set(nodes.map((node) => node.id));
    const added = nodes.filter((node) => !previousIds.has(node.id));
    const removed = previous.filter((node) => !currentIds.has(node.id));
    previous = nodes;

    return {
      id: `demo-snapshot-${index + 1}`,
      entry_id: `demo-entry-${index + 1}`,
      user_id: DEMO_PARTICIPANT_CODE,
      day: entry.date,
      nodes_json: nodes,
      relations_json: relations,
      graph_summary_json: {
        node_count: nodes.length,
        relation_count: relations.length,
        event_count: nodes.filter((node) => node.category === "Event").length,
        key_nodes: nodes.slice(0, 3),
        key_relations: relations.slice(0, 3),
        summary: `${entry.date} の記録から ${nodes.length} 件の内容と ${relations.length} 件の関係を取り出しました。`,
      },
      temporal_diff_json: {
        added_nodes: added,
        removed_nodes: removed,
        added_relations: [],
        removed_relations: [],
        changed_relations: [],
        relation_shift_summary: t.extraction.shift(added.length, removed.length, 0, 0, 0),
        protective_decline: {
          drop_in_protective_nodes:
            previousIds.size === 0
              ? 0
              : Math.max(
                  0,
                  [...previousIds].filter((id) => id.startsWith("protective")).length -
                    [...currentIds].filter((id) => id.startsWith("protective")).length,
                ),
        },
        uncertainty: {},
      },
      extraction_provider: "demo",
      extraction_model: "fixture",
      created_at: entry.submittedAt,
    };
  });
}

/**
 * Which rules a day trips, from the day itself.
 *
 * Deliberately only the rules the entry can actually support: a day with no
 * strain trips nothing, and a score with no rule behind it is the thing the
 * educator display policy exists to prevent.
 */
function rulesFor(entry: DiaryEntry) {
  const rules: Array<{ rule: string; evidence: string; weight: number }> = [];
  const strained = entry.mood === "low" || entry.mood === "hard";
  if (strained && entry.categories.includes("friends")) {
    rules.push({ rule: "isolation_spike", evidence: t.signal.ruleEvidence.isolation_spike, weight: 0.45 });
  }
  if (strained && entry.categories.includes("health")) {
    rules.push({ rule: "state_trigger_inflation", evidence: t.signal.ruleEvidence.state_trigger_inflation, weight: 0.25 });
  }
  if (strained && !entry.categories.some((c) => c === "club" || c === "family" || c === "friends")) {
    rules.push({ rule: "protective_decline", evidence: t.signal.ruleEvidence.protective_decline, weight: 0.4 });
  }
  return rules;
}

/** Day index (1-based, oldest first) at which a reading becomes possible. */
const FIRST_SCORED_DAY = RAMP_UP_DAYS + 1;

function scoreFor(entry: DiaryEntry, rules: ReturnType<typeof rulesFor>): number {
  const base = rules.reduce((total, rule) => total + rule.weight, 0);
  const moodWeight = entry.mood === "hard" ? 1.4 : entry.mood === "low" ? 1.0 : entry.mood === "neutral" ? 0.4 : 0.15;
  return Math.round((base * 2 + moodWeight) * 100) / 100;
}

export function demoTimeline(): AnomalyResult[] {
  return DAYS.map((entry, index) => {
    const dayNumber = index + 1;
    const scored = dayNumber >= FIRST_SCORED_DAY;
    const rules = rulesFor(entry);
    return {
      id: `demo-insight-${dayNumber}`,
      user_id: DEMO_PARTICIPANT_CODE,
      day: entry.date,
      anomaly_score: scored ? scoreFor(entry, rules) : null,
      z_scores_json: {},
      explanation_id: `demo-explanation-${dayNumber}`,
    };
  });
}

export function demoExplanation(explanationId?: string | number | null): ExplanationPayload {
  const index = Number(String(explanationId ?? "").replace("demo-explanation-", "")) || DAYS.length;
  const entry = DAYS[Math.min(Math.max(index, 1), DAYS.length) - 1];
  const scored = index >= FIRST_SCORED_DAY;
  const rules = rulesFor(entry);
  const nodes = nodesFor(entry);
  const relations = relationsFor(nodes);

  return {
    id: `demo-explanation-${index}`,
    user_id: DEMO_PARTICIPANT_CODE,
    day: entry.date,
    triggered_rules_json: scored ? rules : [],
    baseline_deviation_json: scored
      ? { status: "ok", baseline_available: true, baseline_type: "user", baseline_day_count: index - 1, score: scoreFor(entry, rules) }
      : {
          status: "not_enough_data",
          baseline_available: false,
          baseline_type: "none",
          baseline_day_count: index - 1,
          required_baseline_days: RAMP_UP_DAYS,
          score: null,
        },
    changed_relations_json: [],
    protective_decline_json: {},
    uncertainty_json: scored
      ? { level: nodes.length >= 4 ? "low" : "medium", status: "ok", reasons: [t.signal.coverageAdequate, t.signal.comparedWithPrevious] }
      : {
          level: "high",
          status: "not_enough_data",
          reasons: [t.signal.notEnoughDataReason(RAMP_UP_DAYS), t.signal.observedDays(index - 1)],
          missing_signals: [t.signal.missingPersonalBaseline],
        },
    evidence_summaries: scored ? rules.map((rule) => rule.evidence) : [t.signal.noBaselineYet],
    graph_summary_json: {
      node_count: nodes.length,
      relation_count: relations.length,
      event_count: nodes.filter((node) => node.category === "Event").length,
      key_nodes: nodes.slice(0, 3),
      key_relations: relations.slice(0, 3),
      summary: `${entry.date} の記録から ${nodes.length} 件の内容と ${relations.length} 件の関係を取り出しました。`,
    },
    score_breakdown_json: scored ? { status: "ok", rule_score: rules.reduce((total, rule) => total + rule.weight, 0) } : { status: "not_enough_data" },
    key_relations: relations,
    created_at: entry.submittedAt,
  };
}

export function demoAnomaly(): AnomalyResult {
  const timeline = demoTimeline();
  return timeline[timeline.length - 1];
}

/* ── the AI audit trail ───────────────────────────────────────────────── */

/**
 * One trail per entry: what ran, in what order, with what model.
 *
 * Hashes rather than content, because that is what the real trail carries —
 * the point of the screen is that a student can see the pipeline without the
 * screen becoming a second copy of their diary.
 */
function fakeHash(seed: string): string {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(4).slice(0, 32);
}

export function demoAuditTrails(): ReflectionAuditTrail[] {
  return [...DAYS].reverse().map((entry, reverseIndex) => {
    const index = DAYS.length - reverseIndex;
    const strained = entry.mood === "low" || entry.mood === "hard";
    const nodes = nodesFor(entry);
    const at = entry.submittedAt;
    const shared = {
      status: "completed",
      provider: "demo",
      model: "fixture",
      prompt_version: "demo-v1",
      pipeline_version: "demo-pipeline-v1",
    };

    const events: AiAuditEvent[] = [
      {
        ...shared,
        id: `demo-audit-${index}-extraction`,
        stage: "extraction",
        label: "記録からの抽出",
        occurred_at: at,
        temperature: 0.2,
        evidence_refs: nodes.map((node) => node.id),
        output_hash: fakeHash(`${entry.id}:extraction`),
      },
      {
        ...shared,
        id: `demo-audit-${index}-safety`,
        stage: "safety_assessment",
        label: "安全性の確認",
        occurred_at: at,
        safety_decision: {
          risk_level: strained && entry.categories.includes("friends") ? "elevated" : "none",
          escalation_required: false,
          reasons: strained && entry.categories.includes("friends") ? ["distress_without_explicit_danger"] : [],
          policy_refs: ["docs/safety_escalation_policy.md"],
        },
        evidence_refs: [],
        output_hash: fakeHash(`${entry.id}:safety`),
      },
    ];

    return {
      correlation_id: `demo-correlation-${index}`,
      reflection_id: `demo-entry-${index}`,
      first_event_at: at,
      last_event_at: at,
      event_count: events.length,
      has_safety_flag: events.some((event) => event.safety_decision?.risk_level !== "none"),
      has_failure: false,
      events,
    };
  });
}

/* ── the summary a student can choose to share ────────────────────────── */

/** Days the deterministic safety layer had something to say about. */
function observedDays() {
  return DAYS.filter((entry) => (entry.mood === "low" || entry.mood === "hard") && entry.categories.includes("friends"));
}

export function demoCounselorSummary(): CounselorSupportSummary {
  const recent = DAYS.slice(-10);
  return {
    summary_id: "demo-summary",
    date_range: { from: recent[0].date, to: recent[recent.length - 1].date },
    reflection_count: recent.length,
    sections: [
      {
        key: "recent_themes",
        title: "最近くり返し出てくる話題",
        items: ["友だちの輪に入れない感じ", "眠りの乱れ", "課題とテストの負担"],
        evidence_event_ids: [],
      },
      {
        key: "recurring_triggers",
        title: "きっかけとして書かれていたこと",
        items: ["休み時間の会話に入れなかった日", "テスト範囲の発表"],
        evidence_event_ids: [],
      },
      {
        key: "intensity_trend",
        title: "強さの移り変わり",
        items: ["直近2週間で、つらい側の記録が3日ありました", "その3日はいずれも睡眠についての記述をともなっています"],
        evidence_event_ids: [],
      },
      {
        key: "support_needs",
        title: "本人が助かりそうなこと",
        items: ["話に入れなかったときの受け止め方について、誰かと話すこと", "テスト前の予定の立て方"],
        evidence_event_ids: [],
      },
      {
        key: "protective_factors",
        title: "支えになっていること",
        items: ["部活動", "家族との時間", "帰り道が同じ友だち"],
        evidence_event_ids: [],
      },
      {
        key: "suggested_discussion_points",
        title: "面談で触れるとよさそうなこと",
        items: ["眠れない日が続いていないか", "部活と勉強の時間の配分"],
        evidence_event_ids: [],
      },
    ],
    safety_flags: observedDays().map((entry, index) => ({
      level: "elevated",
      reasons: ["distress_without_explicit_danger"],
      timestamp: entry.submittedAt,
      event_id: `demo-safety-${index + 1}`,
    })),
    limitations:
      "このサマリーは本人が書いた記録から要点を取り出したものです。診断ではなく、日記やチャットの本文は含まれません。",
    generated_at: new Date(`${DAYS[DAYS.length - 1].date}T21:00:00`).toISOString(),
  };
}

/* ── sharing, and what the student can see about it ───────────────────── */

type ShareState = { consent: OversightRequest["consent_status"]; shares: SharedSupportSummary[] };

const SHARE_STATE_KEY = "blesc:demo:sharing";
const INITIAL_SHARE_STATE: ShareState = { consent: "active", shares: [] };

/**
 * What the demo has shared so far, kept in `sessionStorage`.
 *
 * A module-level variable would have been simpler and was wrong: a demo walks
 * from the student's screen to the counsellor's, each navigation reloads the
 * module, and the summary that had just been shared was gone by the time
 * anyone looked for it. The one thing the sharing step exists to show is that
 * the two screens agree.
 *
 * Session storage is the right lifetime — it survives the walk and dies with
 * the tab, so the next demo starts from nothing shared. Nothing reaches a
 * server; the same isolation `demo.ts` already relies on for the flag itself.
 */
function readShareState(): ShareState {
  if (typeof window === "undefined") return INITIAL_SHARE_STATE;
  try {
    const stored = window.sessionStorage.getItem(SHARE_STATE_KEY);
    return stored ? (JSON.parse(stored) as ShareState) : INITIAL_SHARE_STATE;
  } catch {
    // A blocked or full store must not take the demo down with it.
    return INITIAL_SHARE_STATE;
  }
}

function writeShareState(next: ShareState): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(SHARE_STATE_KEY, JSON.stringify(next));
  } catch {
    // Ignored for the same reason.
  }
}

export function demoOversightRequests(): OversightRequest[] {
  const state = readShareState();
  return [
    {
      roster_id: "demo-roster",
      org_id: DEMO_ORG_ID,
      org_name: DEMO_ORG_NAME,
      roster_status: "active",
      consent_status: state.consent,
      granted_at: state.consent === "active" ? `${DAYS[0].date}T08:00:00` : null,
      revoked_at: state.consent === "revoked" ? new Date().toISOString() : null,
    },
  ];
}

export function demoSetConsent(granted: boolean): void {
  // Revoking consent takes the shares with it, because that is what revoking
  // means here: the counsellor's screen must empty at the same moment.
  writeShareState({ consent: granted ? "active" : "revoked", shares: granted ? readShareState().shares : [] });
}

export function demoOrgCounselors(): OrgCounselor[] {
  return [
    { counselor_user_id: "demo-counsellor-1", display_label: "スクールカウンセラー（水曜）" },
    { counselor_user_id: "demo-counsellor-2", display_label: "学年の支援担当" },
  ];
}

export function demoShareSummary(summary: CounselorSupportSummary, counselorUserId: string | null): SharedSupportSummary {
  const state = readShareState();
  const share: SharedSupportSummary = {
    id: `demo-share-${state.shares.length + 1}`,
    participant_id: DEMO_PARTICIPANT_ID,
    org_id: DEMO_ORG_ID,
    org_name: DEMO_ORG_NAME,
    student_code: DEMO_PARTICIPANT_CODE,
    counselor_user_id: counselorUserId,
    summary_id: summary.summary_id,
    summary_json: summary,
    evidence_event_ids: summary.safety_flags.map((flag) => flag.event_id),
    reflection_count: summary.reflection_count,
    status: "active",
    shared_at: new Date().toISOString(),
    revoked_at: null,
  };
  writeShareState({ ...state, shares: [share, ...state.shares] });
  return share;
}

export function demoMySummaryShares(): SharedSupportSummary[] {
  return readShareState().shares;
}

export function demoRevokeShare(shareId: string): void {
  const state = readShareState();
  writeShareState({ ...state, shares: state.shares.filter((share) => share.id !== shareId) });
}

export function demoEducatorAccess(): StudentAccessRecord[] {
  return [
    { id: "demo-access-1", view_type: "roster", occurred_at: `${DAYS[DAYS.length - 2].date}T09:12:00`, org_name: DEMO_ORG_NAME },
    { id: "demo-access-2", view_type: "student_overview", occurred_at: `${DAYS[DAYS.length - 4].date}T16:40:00`, org_name: DEMO_ORG_NAME },
  ];
}

/* ── what an educator sees ────────────────────────────────────────────── */

/**
 * The roster, in the shape the educator screens read.
 *
 * `CLASS_ROSTER` no longer carries a `band`: the three-way classification was
 * deleted in #175, from the fixtures and the type as well as from the screens.
 * Nothing here is derived from one. `safety_level` is a record that the
 * deterministic layer matched something the student wrote — only the students
 * whose fixture actually describes such a day carry an observation, and every
 * one of them carries the reason and the surface with it, because an educator
 * must never see a flag they cannot trace.
 */
const OBSERVED: Record<string, { level: string; reasons: string[]; surface: string; dayOffset: number }> = {
  "s-08": {
    level: "elevated",
    reasons: ["possible_suicide_risk", "distress_without_explicit_danger"],
    surface: "journal",
    dayOffset: -2,
  },
  "s-14": {
    level: "elevated",
    reasons: ["distress_without_explicit_danger"],
    surface: "chat",
    dayOffset: -4,
  },
};

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00`);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

const TODAY_DEMO = DAYS[DAYS.length - 1].date;

export function demoCohortRoster(): EducatorStudentStatus[] {
  const classmates = CLASS_ROSTER.map((student) => {
    const observation = OBSERVED[student.id];
    return {
      participant_id: student.id,
      org_id: DEMO_ORG_ID,
      owner_user_id: `demo-owner-${student.id}`,
      code: `2A-${student.id.replace("s-", "")}`,
      display_name: student.name,
      last_active_day: student.lastEntry,
      // Internal only; never rendered. Present because the shape has it.
      latest_score: null,
      state_band: "unknown" as const,
      safety_level: observation ? observation.level : null,
      safety_at: observation ? `${shiftDay(TODAY_DEMO, observation.dayOffset)}T22:10:00` : null,
      safety_reasons: observation ? observation.reasons : [],
      safety_surface: observation ? observation.surface : null,
      baseline_is_provisional: student.missedDays > 0,
      baseline_days_remaining: student.missedDays > 0 ? student.missedDays : null,
      baseline_type: student.missedDays > 0 ? "none" : "user",
    };
  });

  // The student the whole demo follows, so the educator view and the student
  // view are looking at the same person rather than at two unrelated stories.
  const strained = observedDays().at(-1);
  return [
    {
      participant_id: DEMO_PARTICIPANT_ID,
      org_id: DEMO_ORG_ID,
      owner_user_id: "demo-owner",
      code: DEMO_PARTICIPANT_CODE,
      display_name: `${CURRENT_STUDENT.name}`,
      last_active_day: DAYS[DAYS.length - 1].date,
      latest_score: null,
      state_band: "unknown" as const,
      safety_level: strained ? "elevated" : null,
      safety_reasons: strained ? ["distress_without_explicit_danger"] : [],
      safety_at: strained ? strained.submittedAt : null,
      safety_surface: strained ? "journal" : null,
      baseline_is_provisional: false,
      baseline_days_remaining: null,
      baseline_type: "user",
    },
    ...classmates,
  ];
}

export function demoStudentOverview(participantId: string) {
  const student = demoCohortRoster().find((row) => row.participant_id === participantId);
  if (!student) return null;

  const isDemoParticipant = participantId === DEMO_PARTICIPANT_ID;
  const timeline = isDemoParticipant ? demoTimeline() : [];
  const themeCounts = new Map<string, number>();
  if (isDemoParticipant) {
    for (const entry of DAYS) {
      for (const node of nodesFor(entry).slice(0, 3)) {
        themeCounts.set(node.label, (themeCounts.get(node.label) ?? 0) + 1);
      }
    }
  }

  return {
    student,
    signals: [...timeline].reverse().map((row) => ({ day: row.day, score: row.anomaly_score })),
    themes: [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([label, count]) => ({ label, count })),
    safetyRuns: student.safety_at ? [{ level: student.safety_level ?? "unknown", occurred_at: student.safety_at }] : [],
  };
}

export function demoSharedSummaries(): SharedSupportSummary[] {
  // What the counsellor sees is exactly what the student shared, so the two
  // screens cannot disagree during a demo.
  return readShareState().shares;
}

/* ── the chat, with no model behind it ────────────────────────────────── */

/**
 * A reply for the demo when there is no API key.
 *
 * #17 asks for a mock AI path so a demo survives a missing or rate-limited
 * provider. The replies are fixed strings rather than anything generated: a
 * demo that quietly falls back to a weaker model shows a product nobody
 * shipped, and one that errors in front of a class shows nothing at all.
 *
 * The branch that matters is the last one. `assessSafety` is the same
 * deterministic layer production runs, so a demo can type a sentence that
 * worries a teacher and watch the product route to a person — the behaviour
 * worth showing a school, and the one that must not depend on a provider being
 * reachable.
 */
export function demoChatReply(message: string): ChatResponse {
  const assessment = assessSafety(message);
  const risky = assessment.risk_level === "crisis" || assessment.risk_level === "elevated";

  const answer = risky
    ? "話してくれてありがとうございます。いま安全でいられるかが気がかりです。" +
      "危ないと感じるときは、すぐに緊急の連絡先に電話してください。" +
      "そうでなくても、信頼できる大人やスクールカウンセラーに、いま書いてくれたことを話してみてください。" +
      "blesc は緊急時の対応をすることができません。"
    : message.length < 12
      ? "もう少しだけ教えてもらえますか。いつごろのことか、どんな場面だったかが分かると、一緒に整理しやすくなります。"
      : "書いてくれたことを読みました。" +
        "同じような場面が何度かあるようなら、それは「たまたま」ではないのかもしれません。" +
        "そのときに助かったこと、逆にしんどかったことを思い出せますか。";

  return {
    chat_session_id: "demo-chat-session",
    message_id: `demo-chat-${Date.now()}`,
    answer,
    evidence_refs: {},
    retrieval_context: { demo: true },
    // `mock_mode` in everything but name: a consumer reading `status` sees that
    // no model produced this, which is what #17's stub contract asks for.
    status: "demo_fixture",
    error_message: null,
  };
}
