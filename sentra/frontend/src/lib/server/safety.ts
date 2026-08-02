import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafetyAssessment } from "@/api/models";
import { assessSafety, escalateAssessment, SAFETY_ASSESSMENT_VERSION } from "@/lib/safety-assessment";

/**
 * Safety rules shared by every conversational surface.
 *
 * These lived inside /api/chat while /api/voice/realtime-session carried a
 * single sentence of its own. Two surfaces with different safety text is the
 * same shape of bug as chat having no safety handling at all — whichever one
 * gets edited, the other silently falls behind. One copy, imported by both.
 */
export const SAFETY_GUARDRAILS = [
  "Safety comes before every other goal in this conversation.",
  // Emergency contacts live in RISK_DIRECTIVES, not here. Reciting them from an
  // always-on instruction leaks the crisis path into unrelated answers.
  "If the student signals possible danger to themselves or someone else — including ambiguous phrasing such as wanting to disappear, being tired of everything, or not feeling safe — name the concern gently, ask about their immediate safety, and point them to a real person such as a trusted adult or a school counselor. Keep doing this in later turns; mentioning it once and moving on is a failure.",
  "Never promise secrecy, exclusivity, or permanence. Do not say you will always be there, that the student needs only you, or that you will keep something from a trusted adult.",
  "Be accurate about privacy. Raw journal and chat text is never visible to educators or counselors. A derived summary reaches an educator only when the student grants consent on the Sharing page, and that consent can be revoked at any time. You never contact anyone on the student's behalf and you cannot notify an adult yourself — when there is risk you encourage the student toward a real person, you do not route around them. Never say this conversation is completely private, and never say nothing is ever shared with anyone.",
  "Do not confirm beliefs the student cannot verify, such as a group conspiring against them. Stay warm, keep the uncertainty open, and never diagnose.",
];

export const RISK_DIRECTIVES: Record<SafetyAssessment["risk_level"], string> = {
  crisis: "The recent turns contain explicit danger signals. Lead with immediate safety, keep the reply short and concrete, name local emergency services and a crisis line alongside a trusted adult, and do not bury those routes.",
  elevated: "The recent turns contain possible danger signals, which may be ambiguous. Err toward support: check on their safety and offer a real-person route even if you are unsure, and name local emergency services if the risk could be immediate.",
  low: "The recent turns show distress without an explicit danger signal. Stay supportive; do not manufacture a crisis response.",
  // Deliberately empty. The rules layer is a floor, never a ceiling: telling the
  // model that no danger was detected talks it out of responding to danger it
  // can see for itself, and a lexicon miss then costs a real escalation.
  none: "",
};

/** Student turns the safety assessment reads, on every surface. */
export const SAFETY_WINDOW_TURNS = 12;

const RISK_ORDER: SafetyAssessment["risk_level"][] = ["none", "low", "elevated", "crisis"];

type ChatMessageRow = { role: string; content_redacted: string | null };

/**
 * Highest risk assessed on the student's other surfaces in the last day, so a
 * disclosure written in the Record UI keeps shaping a conversation that never
 * repeats the words.
 */
export async function recentDisclosedRisk(
  client: SupabaseClient,
  participantId: string,
  excludeSurface: string,
): Promise<SafetyAssessment["risk_level"]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await client
    .from("model_runs")
    .select("retrieval_config_json")
    .eq("participant_id", participantId)
    .eq("artifact_type", "safety_assessment")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error || !data) return "none";

  let highest: SafetyAssessment["risk_level"] = "none";
  for (const row of data) {
    const config = (row.retrieval_config_json ?? {}) as { risk_level?: string; surface?: string };
    // Skip this surface's own audit rows; re-reading them would make a single
    // elevated turn stick to the participant for a day.
    if (config.surface === excludeSurface) continue;
    const level = config.risk_level as SafetyAssessment["risk_level"] | undefined;
    if (level && RISK_ORDER.indexOf(level) > RISK_ORDER.indexOf(highest)) highest = level;
  }
  return highest;
}

/**
 * The assessment a surface should act on: this conversation's window, raised by
 * anything disclosed elsewhere.
 */
export async function assessConversation(
  client: SupabaseClient,
  participantId: string,
  surface: string,
  recentMessages: ChatMessageRow[],
  message: string,
): Promise<SafetyAssessment> {
  const windowText = [
    ...recentMessages
      .slice(-SAFETY_WINDOW_TURNS)
      .filter((row) => row.role === "user")
      .map((row) => row.content_redacted ?? ""),
    message,
  ].join("\n");
  const disclosed = await recentDisclosedRisk(client, participantId, surface);
  return escalateAssessment(assessSafety(windowText), disclosed, "risk_disclosed_on_another_surface");
}

/**
 * Best-effort audit row. A missing audit must never cost the student a reply,
 * so failures are logged and swallowed.
 */
export async function recordSafetyAudit(
  client: SupabaseClient,
  options: {
    ownerUserId: string;
    participantId: string;
    artifactId: string;
    surface: string;
    pipelineVersion: string;
    safety: SafetyAssessment;
  },
): Promise<void> {
  const { error } = await client.from("model_runs").insert({
    owner_user_id: options.ownerUserId,
    participant_id: options.participantId,
    artifact_type: "safety_assessment",
    artifact_id: options.artifactId,
    provider: "rules",
    model: SAFETY_ASSESSMENT_VERSION,
    prompt_version: SAFETY_ASSESSMENT_VERSION,
    schema_version: SAFETY_ASSESSMENT_VERSION,
    pipeline_version: options.pipelineVersion,
    temperature: 0,
    retrieval_config_json: {
      risk_level: options.safety.risk_level,
      escalation_required: options.safety.escalation_required,
      reasons: options.safety.reasons,
      policy_refs: options.safety.policy_refs,
      surface: options.surface,
    },
    input_provenance_json: { artifact_id: options.artifactId, window_turns: SAFETY_WINDOW_TURNS },
    status: "completed",
  });
  if (error) console.warn(`[${options.surface}] safety model_runs insert skipped`, error.message);
}
