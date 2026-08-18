import type { SafetyAssessment } from "@/api/models";

export const SAFETY_ASSESSMENT_VERSION = "safety-assessment-v1";
export const SAFETY_POLICY_REFS = [
  "docs/safety_escalation_policy.md",
  "docs/static_safety_school_support_reference.md",
];

const crisisResponse = "まず、あなたの安全がいちばん大切です。blescは緊急時の対応をすることができません。いますぐ危ないと感じるときや、行動してしまいそうなときは、すぐに緊急の連絡先に電話してください。そして、信頼できる大人や安全な人のところへ行き、「いま助けが必要です」とはっきり伝えてください。";
const elevatedResponse = "これは、人に頼ったほうがいいことかもしれません。信頼できる大人、スクールカウンセラー、保護者など、安全だと思える人に、いま起きていることを話してみてください。危険が差し迫っていると感じたときは、緊急の連絡先に連絡してください。";

const selfHarmTerms = ["hurt myself", "harm myself", "self-harm", "self harm", "kill myself", "end my life", "want to die", "suicide", "suicidal", "overdose", "自殺", "死にたい", "消えたい", "自分を傷つけ", "自傷"];
const imminentTerms = ["tonight", "tomorrow", "right now", "now", "today", "have a plan", "made a plan", "cannot stay safe", "can't stay safe", "do not feel safe", "don't feel safe", "今すぐ", "今夜", "今日", "計画がある", "安全でいられない"];
const violenceTerms = ["hurt them", "kill them", "make them pay", "attack them", "shoot them", "あいつを殺", "相手を傷つけ", "襲う"];
const abuseTerms = ["abusing me", "hurting me", "hits me", "hit me", "domestic violence", "assaulted me", "sexual abuse", "暴力を受け", "殴られ", "虐待", "性的暴力"];
const concealmentTerms = ["don't tell anyone", "do not tell anyone", "keep this a secret", "keep it secret", "hide this", "誰にも言わないで", "秘密にして", "隠して"];
const passiveRiskTerms = ["don't want to be here anymore", "do not want to be here anymore", "wish i were dead", "no reason to live", "everyone would be better without me", "生きていたくない", "生きる意味がない"];
const distressTerms = ["panic", "panicking", "hopeless", "worthless", "trapped", "overwhelmed", "disappear", "パニック", "絶望", "つらい", "苦しい"];

function includesAny(content: string, terms: string[]) {
  return terms.some((term) => content.includes(term));
}

export function assessSafety(rawContent: string): SafetyAssessment {
  const content = rawContent.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  if (!content) {
    return { risk_level: "none", confidence: 1, escalation_required: false, reasons: [], safe_response: "", policy_refs: [] };
  }

  const selfHarm = includesAny(content, selfHarmTerms);
  const imminent = includesAny(content, imminentTerms);
  const violence = includesAny(content, violenceTerms);
  const abuse = includesAny(content, abuseTerms);
  const concealment = includesAny(content, concealmentTerms);
  const passive = includesAny(content, passiveRiskTerms);
  const distress = includesAny(content, distressTerms);
  const reasons: string[] = [];

  if (selfHarm && (imminent || includesAny(content, ["kill myself", "end my life", "want to die", "suicide", "自殺", "死にたい"]))) reasons.push("self_harm_or_suicide_risk");
  if (violence && imminent) reasons.push("imminent_violence_risk");
  if (abuse) reasons.push("abuse_or_violence_disclosure");
  if (includesAny(content, ["cannot stay safe", "can't stay safe", "安全でいられない"])) reasons.push("inability_to_stay_safe");
  if (passive) reasons.push("possible_suicide_risk");

  if (reasons.length) {
    return { risk_level: "crisis", confidence: imminent ? 0.98 : 0.92, escalation_required: true, reasons: [...new Set(reasons)], safe_response: crisisResponse, policy_refs: SAFETY_POLICY_REFS };
  }

  if (selfHarm) reasons.push("possible_self_harm_or_suicide_risk");
  if (abuse) reasons.push("abuse_or_violence_disclosure");
  if (concealment && (selfHarm || abuse || violence)) reasons.push("concealment_request_related_to_harm");
  if (violence) reasons.push("possible_violence_risk");
  if (reasons.length) {
    return { risk_level: "elevated", confidence: 0.85, escalation_required: false, reasons: [...new Set(reasons)], safe_response: elevatedResponse, policy_refs: SAFETY_POLICY_REFS };
  }

  if (distress) {
    return { risk_level: "low", confidence: 0.75, escalation_required: false, reasons: ["distress_without_explicit_danger"], safe_response: "", policy_refs: SAFETY_POLICY_REFS };
  }
  return { risk_level: "none", confidence: 0.95, escalation_required: false, reasons: [], safe_response: "", policy_refs: [] };
}
