import type { SupabaseClient } from "@supabase/supabase-js";
import type { SafetyAssessment } from "@/api/models";
// Relative, with the extension, for the reason `safetyDispatch.ts` gives: the
// unit tests load these files directly under node, which does not resolve the
// `@/` alias for anything that is not a type-only import. `recentDisclosedRisk`
// below had no test at all while this specifier was aliased (#373).
import { assessSafety, escalateAssessment, SAFETY_ASSESSMENT_VERSION } from "../safety-assessment.ts";

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
  /*
   * Revised when escalation notifications shipped.
   *
   * The old wording ended "you never contact anyone on the student's behalf and
   * you cannot notify an adult yourself". That stopped being true the moment
   * `escalate()` was wired into this route: a crisis assessment now pages the
   * educators who already hold oversight consent, the same night.
   *
   * The guardrail's own first clause is "be accurate about privacy", and a
   * model told something false about who learns what will repeat it to a
   * student who is deciding whether to be honest. So the sentence describes
   * what the system does — including the part a student would most want to
   * know, which is that it is a fact about danger and not about the content.
   */
  "Be accurate about privacy. Raw journal and chat text is never visible to educators or counselors. A derived summary reaches an educator only when the student grants consent on the Sharing page, and that consent can be revoked at any time. If the conversation signals danger to the student or someone else, the educators who already oversee them are notified that a check-in is needed — they are told when and that it happened, never what was written. You never contact anyone yourself and you never choose who is told. Say this plainly if the student asks, and never say this conversation is completely private or that nothing is ever shared with anyone.",
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
 * How many of the other surfaces' audit rows one lookup reads.
 *
 * The number only means anything because the current surface is excluded in the
 * query rather than afterwards — see below. Twenty rows of *other* surfaces is
 * a day's worth; twenty rows before the exclusion was, on a talkative day,
 * twenty rows of the current surface and nothing else.
 */
const DISCLOSED_WINDOW_ROWS = 20;

/**
 * Surfaces are internal constants — `chat`, `voice`, `journal` — and the one
 * passed in is interpolated into the PostgREST filter string below, so anything
 * that is not a bare token is refused rather than sent.
 */
const BARE_SURFACE = /^[a-z0-9_]+$/;

/**
 * Highest risk assessed on the student's other surfaces in the last day, so a
 * disclosure written in the Record UI keeps shaping a conversation that never
 * repeats the words.
 *
 * ## The exclusion has to happen before the cut, not after (#373)
 *
 * This used to read the newest twenty `safety_assessment` rows and then drop the
 * current surface's own rows in JavaScript. With a quiet day the two are the
 * same answer, which is why it read as correct. They are not the same answer
 * once the student has talked: `recordSafetyAudit` writes one row per chat turn
 * and one per voice turn, unconditionally and whatever the risk level, so from
 * the twentieth turn of the day the newest twenty rows are *all* this surface's.
 * Every one was skipped, `none` was returned, and the journal entry written that
 * morning stopped reaching the conversation — on exactly the day the student was
 * writing most.
 *
 * So the filter goes into the query. `neq` alone would not do it: SQL's
 * `x <> 'chat'` is NULL rather than true when `x` is NULL, and PostgREST's
 * `not.eq` is the same shape, so either one would also drop every row with no
 * `surface` recorded at all — which is what the journal's own rows look like
 * until #372 lands, and they are the rows this function exists to find. Hence
 * "null OR not this surface".
 */
export async function recentDisclosedRisk(
  client: SupabaseClient,
  participantId: string,
  excludeSurface: string,
): Promise<SafetyAssessment["risk_level"]> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let query = client
    .from("model_runs")
    .select("retrieval_config_json")
    .eq("participant_id", participantId)
    .eq("artifact_type", "safety_assessment")
    .gte("created_at", since);

  if (BARE_SURFACE.test(excludeSurface)) {
    query = query.or(
      `retrieval_config_json->>surface.is.null,retrieval_config_json->>surface.neq.${excludeSurface}`,
    );
  } else {
    // A caller passing something else is a programming error, not input. The
    // loop below still excludes it, so the answer stays correct; what is lost is
    // the guarantee that the window holds twenty *other* rows.
    console.error(
      "[safety] recentDisclosedRisk was given a surface that cannot go into a filter; " +
        "falling back to excluding it after the window, which under-reads on a busy day.",
      { surface: excludeSurface },
    );
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(DISCLOSED_WINDOW_ROWS);

  if (error || !data) {
    // Loud, because the caller cannot tell this apart from "nothing was
    // disclosed elsewhere" and must not be stopped from replying either way.
    // `retentionPurge.purgedCount` refuses the same shape for the same reason:
    // "nothing found" and "the read did not happen" must not look alike.
    console.error(
      "[safety] could not read the other surfaces' assessments; treating this turn as if " +
        "nothing was disclosed elsewhere. A journal disclosure is not shaping this reply.",
      { participant: participantId, surface: excludeSurface, error: error?.message },
    );
    return "none";
  }

  let highest: SafetyAssessment["risk_level"] = "none";
  for (const row of data) {
    const config = (row.retrieval_config_json ?? {}) as { risk_level?: string; surface?: string };
    // Belt and braces. The query above already excludes these; re-reading this
    // surface's own rows would make a single elevated turn stick to the
    // participant for a day, and that is worth two lines of defence.
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
