import type { SafetyAssessment } from "@/api/models";

/**
 * What the journal shows after a submission the safety assessment flagged
 * (#465).
 *
 * `/api/entries` has always returned the assessment and a support card in the
 * extraction it echoes back, and the journal screen never read either: a
 * crisis entry ended on the same 「書いてくれてありがとう」 screen as any other,
 * with no line to call. This picks the support out of the response so the
 * screen can put it first.
 *
 * Only crisis and elevated carry one. The text is the assessment's own
 * `safe_response`, so the journal says what chat and voice say.
 */
export interface SafetySupport {
  level: "crisis" | "elevated";
  body: string;
}

export function safetySupportFrom(
  extraction: { safety_assessment_json?: SafetyAssessment } | null | undefined,
): SafetySupport | null {
  const assessment = extraction?.safety_assessment_json;
  if (!assessment) return null;
  if (assessment.risk_level !== "crisis" && assessment.risk_level !== "elevated") return null;
  const body = assessment.safe_response?.trim();
  if (!body) return null;
  return { level: assessment.risk_level, body };
}
