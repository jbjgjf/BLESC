import type { SafetyAssessment } from "@/api/models";

/**
 * Bump when a detector is added, removed, or a verdict changes.
 *
 * Stored on every `model_runs` safety row and on `pilot_crisis_reviews
 * .assessor_version`, so a reviewer can tell which lexicon cleared an entry —
 * and so the rows to re-assess after a detector changes are exactly the ones
 * whose version is behind. A clean assessment under an older version is not
 * the same assurance as a clean one under this version. (The same argument
 * `piiScanner.ts` makes for `PII_SCANNER_VERSION`.)
 *
 * v2 reads the spelling variants a Japanese keyboard produces (#388). Under v1
 * only the kanji spelling of each Japanese term was matched, so 「しにたい」
 * assessed as `none` where 「死にたい」 assessed as `crisis`.
 */
export const SAFETY_ASSESSMENT_VERSION = "safety-assessment-v2";
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

const crisisResponse = "まず、あなたの安全がいちばん大切です。blescは緊急時の対応をすることができません。いますぐ危ないと感じるときや、行動してしまいそうなときは、すぐに緊急サービス（emergency services）に電話してください。そして、信頼できる大人（trusted adult）や安全な人のところへ行き、「いま助けが必要です」とはっきり伝えてください。";
const elevatedResponse = "これは、人に頼ったほうがいいことかもしれません。信頼できる大人（trusted adult）、スクールカウンセラー、保護者など、安全だと思える人に、いま起きていることを話してみてください。危険が差し迫っていると感じたときは、緊急サービス（emergency services）に連絡してください。";

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

/** Every lexicon's terms, for the test that keeps `KANA_SPELLINGS` honest. */
export const ALL_SAFETY_TERMS: readonly string[] = [
  ...selfHarmTerms, ...imminentTerms, ...violenceTerms, ...abuseTerms,
  ...concealmentTerms, ...passiveRiskTerms, ...ambiguousRiskTerms, ...distressTerms,
];

/**
 * Writing-system folding, applied to the text and to every term alike.
 *
 * A Japanese keyboard offers more than one spelling of the same word, and the
 * lexicons above were written in one of them. 「死にたい」 was matched;
 * 「しにたい」 — the same sentence when the student does not press the
 * conversion key — was not. `risk_level: "none"` is not a weaker answer than
 * `"crisis"`: it is the absence of the whole escalation path, so the crisis
 * card, the `safety_escalations` row, the educator notification and the §4.4
 * review band all turned on whether a conversion key was pressed.
 *
 * NFKC folds the width variants — 全角英数 and ｶﾞ reach their canonical shapes.
 * Katakana is then mapped onto hiragana, which is what carries 「シニタイ」 to
 * 「しにたい」.
 *
 * **Terms are folded too, not only the text.** Without that, `パニック` —
 * written in katakana in `distressTerms` — would stop matching the moment the
 * text was folded. Folding both sides means a lexicon may be written in
 * whichever spelling reads best.
 *
 * Unlike `piiScanner.ts`, nothing here records an offset into the text, so a
 * fold that changes length (ﾊﾞ → バ) costs nothing.
 */
function foldWriting(value: string): string {
  return value
    .normalize("NFKC")
    // Katakana ァ-ヶ onto hiragana ぁ-ゖ. ヷ-ヺ are left alone: they have no
    // hiragana form, so there is nothing to fold them onto.
    .replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .toLocaleLowerCase();
}

/**
 * Kana spellings of the terms written with kanji.
 *
 * Folding cannot reach these: 「死」 and 「し」 are different characters, not two
 * encodings of one. So each kanji term a student might send unconverted carries
 * its reading here.
 *
 * **A reading is listed only when it is not also an ordinary word.** Two are
 * deliberately absent:
 *
 *   `自傷` → じしょう   also 「自称」; a diary saying 自称 discloses nothing.
 *   `襲う` → おそう     a prefix of 「おそうじ」(お掃除).
 *
 * Both would fire on sentences with nothing to do with danger, and a queue that
 * cries wolf is one §4.4's reviewers learn to click past. The kanji spellings
 * of those two stay matched; only the readings are left out.
 *
 * `imminentTerms` is deliberately not given readings. 「今日」 already raises a
 * false imminence signal (#290), and widening it before that is settled would
 * only make the same mistake louder.
 */
const KANA_SPELLINGS: Readonly<Record<string, readonly string[]>> = {
  "自殺": ["じさつ"],
  "死にたい": ["しにたい"],
  "消えたい": ["きえたい"],
  "自分を傷つけ": ["じぶんをきずつけ"],
  "あいつを殺": ["あいつをころ"],
  "相手を傷つけ": ["あいてをきずつけ"],
  "暴力を受け": ["ぼうりょくをうけ"],
  "殴られ": ["なぐられ"],
  "虐待": ["ぎゃくたい"],
  "性的暴力": ["せいてきぼうりょく"],
  "誰にも言わないで": ["だれにもいわないで"],
  "秘密にして": ["ひみつにして"],
  "生きていたくない": ["いきていたくない"],
  "生きる意味がない": ["いきるいみがない"],
  "消えてしまいたい": ["きえてしまいたい"],
  "全部どうでもいい": ["ぜんぶどうでもいい"],
  "もう限界": ["もうげんかい"],
  "絶望": ["ぜつぼう"],
  "苦しい": ["くるしい"],
  "安全でいられない": ["あんぜんでいられない"],
};

/** The keys above, so a test can check each one still names a live term. */
export const KANA_SPELLING_KEYS: readonly string[] = Object.keys(KANA_SPELLINGS);

/** Every spelling of `terms`: the written one, plus any reading listed above. */
function spellings(terms: readonly string[]): string[] {
  return terms.flatMap((term) => [term, ...(KANA_SPELLINGS[term] ?? [])]);
}

/**
 * ASCII terms match on word boundaries so "now" cannot fire on "know" or
 * "nowhere"; Japanese has no word boundaries, so those terms stay substrings.
 *
 * Terms arrive here folded by `foldWriting`, the same way the text is, so the
 * two are compared in one spelling rather than in whichever each was written
 * in. The ASCII test therefore runs on the folded form — which is still ASCII
 * for an ASCII term, since NFKC and lowercasing leave it alone.
 */
function lexicon(terms: readonly string[]): RegExp {
  const alternatives = terms.map((term) => {
    const folded = foldWriting(term);
    const escaped = folded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[\x20-\x7e]+$/.test(folded) ? `\\b${escaped}\\b` : escaped;
  });
  return new RegExp(alternatives.join("|"), "i");
}

const LEXICONS = {
  selfHarm: lexicon(spellings(selfHarmTerms)),
  // No readings: see KANA_SPELLINGS on #290.
  imminent: lexicon(imminentTerms),
  violence: lexicon(spellings(violenceTerms)),
  abuse: lexicon(spellings(abuseTerms)),
  concealment: lexicon(spellings(concealmentTerms)),
  passive: lexicon(spellings(passiveRiskTerms)),
  ambiguous: lexicon(spellings(ambiguousRiskTerms)),
  distress: lexicon(spellings(distressTerms)),
  explicitLethal: lexicon(spellings(["kill myself", "killing myself", "end my life", "ending my life", "want to die", "suicide", "自殺", "死にたい"])),
  cannotStaySafe: lexicon(spellings(["cannot stay safe", "can't stay safe", "安全でいられない"])),
} as const;

const RISK_ORDER: SafetyAssessment["risk_level"][] = ["none", "low", "elevated", "crisis"];

/**
 * Raises an assessment to at least `level`, carrying in the canned response for
 * that level. Used when risk was disclosed on another surface (a journal entry)
 * and must keep shaping a conversation that never repeats the words.
 */
export function escalateAssessment(
  base: SafetyAssessment,
  level: SafetyAssessment["risk_level"],
  reason: string,
): SafetyAssessment {
  if (RISK_ORDER.indexOf(level) <= RISK_ORDER.indexOf(base.risk_level)) return base;
  const safe_response = level === "crisis" ? crisisResponse : level === "elevated" ? elevatedResponse : base.safe_response;
  return {
    risk_level: level,
    confidence: 0.7,
    escalation_required: level === "crisis",
    reasons: [...new Set([...base.reasons, reason])],
    safe_response,
    policy_refs: SAFETY_POLICY_REFS,
  };
}

export function assessSafety(rawContent: string): SafetyAssessment {
  // Folded, not merely lowercased: the lexicons are compared in one spelling.
  // See `foldWriting`.
  const content = foldWriting(rawContent).replace(/\s+/g, " ").trim();
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
