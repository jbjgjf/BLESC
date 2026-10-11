/**
 * Building a matcher from a bilingual term list.
 *
 * The boundary rule was written for the safety lexicon first; the fallback
 * extraction needed the same thing and had been using a bare alternation
 * instead, which matched `help` inside `helpless` and `rest` inside `restless`
 * — the opposite of the signal it was looking for. `safety-assessment.ts` keeps
 * its own copy since #388, because it folds kana and width before matching.
 */

/**
 * ASCII terms match on word boundaries so "now" cannot fire on "know" or
 * "nowhere"; Japanese has no word boundaries, so those terms stay substrings.
 */
export function lexicon(terms: string[]): RegExp {
  const alternatives = terms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return /^[\x20-\x7e]+$/.test(term) ? `\\b${escaped}\\b` : escaped;
  });
  return new RegExp(alternatives.join("|"), "i");
}
