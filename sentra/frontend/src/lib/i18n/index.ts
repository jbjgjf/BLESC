/**
 * Message catalogue for the product UI (#116).
 *
 * The product ships to Japanese schools, so `ja-JP` is the source language and
 * every screen reads its copy from here rather than holding it inline. Two
 * things follow from that choice:
 *
 * - A second locale is a second object that has to satisfy `Messages`, so a
 *   missing key is a type error at build time rather than an English string
 *   appearing on a screen in front of a class.
 * - Wording that has to stay consistent across screens — the non-diagnostic
 *   notice, the consent language, the words in `docs/localization/glossary.csv`
 *   — is written once, so a change lands everywhere it is shown.
 *
 * Keys are named for where the text appears and who reads it, never for the
 * English that used to be there: `educator.roster.emptyNoConsent`, not
 * `noStudentsAreSharing`. The English original is not a stable identifier —
 * it is one translation among the ones we will add.
 */

import { ja } from "./ja.ts";

export type Messages = typeof ja;
export type Locale = "ja-JP";

export const DEFAULT_LOCALE: Locale = "ja-JP";

const CATALOGUES: Record<Locale, Messages> = {
  "ja-JP": ja,
};

/** The catalogue for one locale. Unknown locales fall back to the default. */
export function messages(locale: Locale = DEFAULT_LOCALE): Messages {
  return CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE];
}

/**
 * The default catalogue, for the common case of a component that renders in the
 * one locale the product currently ships. Read it as a namespace —
 * `t.educator.roster.title` — so the call site says which screen the text is on.
 */
export const t: Messages = messages();
