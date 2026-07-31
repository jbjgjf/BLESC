import type { SafetyAssessment } from "@/api/models";

export const SAFETY_ASSESSMENT_VERSION = "safety-assessment-v1";
export const SAFETY_POLICY_REFS = [
  "docs/safety_escalation_policy.md",
  "docs/static_safety_school_support_reference.md",
];

/** Phrases that show a reply already points the student at a real person. */
const REAL_PERSON_ROUTES = ["trusted adult", "school counselor", "counselor", "emergency service", "crisis line", "crisis", "hotline", "988", "信頼できる大人", "相談窓口"];

export function routesToRealPerson(text: string): boolean {
  const lowered = text.toLocaleLowerCase();
  return REAL_PERSON_ROUTES.some((route) => lowered.includes(route));
}

const crisisResponse = "Your immediate safety comes first. BLESC cannot provide emergency or crisis care. If you may act now or are in immediate danger, call your local emergency service now. Move toward a trusted adult or another safe person and tell them clearly that you need immediate help.";
const elevatedResponse = "This may need support from a real person. Consider telling a trusted adult, counselor, guardian, or another safe person what is happening. If the danger becomes immediate, contact local emergency services.";

const selfHarmTerms = ["hurt myself", "hurting myself", "harm myself", "harming myself", "self-harm", "self harm", "kill myself", "killing myself", "end my life", "ending my life", "want to die", "suicide", "suicidal", "overdose", "自殺", "死にたい", "消えたい", "自分を傷つけ", "自傷"];
const imminentTerms = ["tonight", "tomorrow", "right now", "now", "today", "have a plan", "made a plan", "cannot stay safe", "can't stay safe", "do not feel safe", "don't feel safe", "not safe tonight", "not safe right now", "今すぐ", "今夜", "今日", "計画がある", "安全でいられない"];
const violenceTerms = ["hurt them", "kill them", "make them pay", "attack them", "shoot them", "あいつを殺", "相手を傷つけ", "襲う"];
const abuseTerms = ["abusing me", "hurting me", "hits me", "hit me", "domestic violence", "assaulted me", "sexual abuse", "暴力を受け", "殴られ", "虐待", "性的暴力"];
const concealmentTerms = ["don't tell anyone", "do not tell anyone", "keep this a secret", "keep it secret", "hide this", "誰にも言わないで", "秘密にして", "隠して"];
const passiveRiskTerms = ["don't want to be here anymore", "do not want to be here anymore", "wish i were dead", "no reason to live", "everyone would be better without me", "生きていたくない", "生きる意味がない"];
// Language that may describe withdrawal from life without naming self-harm.
// Kept apart from ordinary distress because ambiguity must err toward support.
const ambiguousRiskTerms = ["disappear", "disappearing", "disappeared", "vanish", "stop existing", "not be here", "tired of everything", "tired of being here", "everything is grey", "everything is gray", "what's the point", "what is the point", "no point in anything", "give up on everything", "can't go on", "cannot go on", "not safe", "not be safe", "いなくなりたい", "消えてしまいたい", "全部どうでもいい", "もう限界"];
const distressTerms = ["panic", "panicking", "hopeless", "worthless", "trapped", "overwhelmed", "パニック", "絶望", "つらい", "苦しい"];

/**
 * ASCII terms match on word boundaries so "now" cannot fire on "know" or
 * "nowhere"; Japanese has no word boundaries, so those terms stay substrings.
 */
function lexicon(terms: string[]): RegExp {
  const alternatives = terms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[\x20-\x7e]+$/.test(term) ? `\\b${escaped}\\b` : escaped;
  });
  return new RegExp(alternatives.join("|"), "i");
}

const LEXICONS = {
  selfHarm: lexicon(selfHarmTerms),
  imminent: lexicon(imminentTerms),
  violence: lexicon(violenceTerms),
  abuse: lexicon(abuseTerms),
  concealment: lexicon(concealmentTerms),
  passive: lexicon(passiveRiskTerms),
  ambiguous: lexicon(ambiguousRiskTerms),
  distress: lexicon(distressTerms),
  explicitLethal: lexicon(["kill myself", "killing myself", "end my life", "ending my life", "want to die", "suicide", "自殺", "死にたい"]),
  cannotStaySafe: lexicon(["cannot stay safe", "can't stay safe", "安全でいられない"]),
} as const;

export function assessSafety(rawContent: string): SafetyAssessment {
  const content = rawContent.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!content) {
    return { risk_level: "none", confidence: 1, escalation_required: false, reasons: [], safe_response: "", policy_refs: [] };
  }

  const selfHarm = LEXICONS.selfHarm.test(content);
  const imminent = LEXICONS.imminent.test(content);
  const violence = LEXICONS.violence.test(content);
  const abuse = LEXICONS.abuse.test(content);
  const concealment = LEXICONS.concealment.test(content);
  const passive = LEXICONS.passive.test(content);
  const ambiguous = LEXICONS.ambiguous.test(content);
  const distress = LEXICONS.distress.test(content);
  const reasons: string[] = [];

  if (selfHarm && (imminent || LEXICONS.explicitLethal.test(content))) reasons.push("self_harm_or_suicide_risk");
  if (violence && imminent) reasons.push("imminent_violence_risk");
  if (abuse) reasons.push("abuse_or_violence_disclosure");
  if (LEXICONS.cannotStaySafe.test(content)) reasons.push("inability_to_stay_safe");
  if (passive) reasons.push("possible_suicide_risk");

  if (reasons.length) {
    return { risk_level: "crisis", confidence: imminent ? 0.98 : 0.92, escalation_required: true, reasons: [...new Set(reasons)], safe_response: crisisResponse, policy_refs: SAFETY_POLICY_REFS };
  }

  if (selfHarm) reasons.push("possible_self_harm_or_suicide_risk");
  if (abuse) reasons.push("abuse_or_violence_disclosure");
  if (concealment && (selfHarm || abuse || violence)) reasons.push("concealment_request_related_to_harm");
  if (violence) reasons.push("possible_violence_risk");
  // Ambiguity about wanting to be gone is graded as elevated rather than
  // crisis: it earns a supportive response with real-person routes, but not
  // the reflection-card suppression that escalation_required drives.
  if (ambiguous) reasons.push("ambiguous_withdrawal_signal");
  if (reasons.length) {
    const ambiguousOnly = reasons.length === 1 && reasons[0] === "ambiguous_withdrawal_signal";
    return { risk_level: "elevated", confidence: ambiguousOnly ? 0.6 : 0.85, escalation_required: false, reasons: [...new Set(reasons)], safe_response: elevatedResponse, policy_refs: SAFETY_POLICY_REFS };
  }

  if (distress) {
    return { risk_level: "low", confidence: 0.75, escalation_required: false, reasons: ["distress_without_explicit_danger"], safe_response: "", policy_refs: SAFETY_POLICY_REFS };
  }
  return { risk_level: "none", confidence: 0.95, escalation_required: false, reasons: [], safe_response: "", policy_refs: [] };
}
