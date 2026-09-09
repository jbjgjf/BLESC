/**
 * Finding personal information in free text (#167).
 *
 * ## What this is not
 *
 * **This is not anonymisation, and a cleared text is not a safe text.** The
 * scanner finds shapes — an address-like string, a run of digits, an `@` with a
 * domain after it. A diary entry can identify its author perfectly without
 * containing any of them: 「昨日の県大会で負けた」 plus a school name in the
 * enrollment record is an identification, and no regular expression will ever
 * see it. What the scanner buys is that the *obvious* cases stop reaching a
 * reviewer's screen by surprise, and that the reviewer's attention goes to
 * everything else.
 *
 * So its output is a **review queue**, never an automatic redaction. A human
 * decides. `docs/pilot/incident-runbook.md` owns what they do about it.
 *
 * ## Why precision over recall
 *
 * A scanner that flags every entry is a scanner nobody reads, and the failure
 * mode of an unread queue is worse than the failure mode of a short one: it
 * converts "a person looked at this" into "a person was supposed to look at
 * this". Every pattern here is one where a match is nearly always the thing it
 * looks for. The patterns deliberately left out are recorded at the bottom,
 * because the argument for excluding them has to survive the next person who
 * notices they are missing.
 *
 * ## Spans, not text
 *
 * A finding carries a type and the offsets it covers, never the matched
 * substring. The queue is read by an operator dashboard that must not display
 * journal text, and a finding that carried the match would put the most
 * sensitive fragment of the entry into exactly the surface built to avoid
 * showing any of it.
 */

export type PiiKind =
  | "email"
  | "phone_jp"
  | "url"
  | "postal_jp"
  | "long_digit_run"
  | "honorific_name"
  | "school_year_class";

export type PiiFinding = {
  kind: PiiKind;
  /** Character offsets into the scanned string. Never the matched text. */
  start: number;
  end: number;
};

type Detector = { kind: PiiKind; pattern: RegExp };

/**
 * Order matters only for readability; every detector runs over the whole
 * string and findings are returned in positional order.
 *
 * Each pattern is written to match the shape *and* enough context to make a
 * false positive unlikely — `\d{10,}` alone would flag a long number in a
 * maths homework complaint, so the digit-run detector requires a separator
 * pattern that a written-out phone or student number has and prose does not.
 */
const DETECTORS: Detector[] = [
  {
    kind: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // 090-1234-5678 / 09012345678 / 03-1234-5678 and the full-width forms
    // students actually type. A leading 0, then 10 or 11 digits in total, with
    // at most one separator between any two.
    //
    // Whitespace is deliberately **not** a separator. An earlier version
    // allowed it, and 「2026 1500 98765」 — a year, a race distance and a score,
    // which is ordinary diary prose — matched as a phone number. A separator
    // class that spans spaces lets the pattern run across unrelated numbers.
    kind: "phone_jp",
    pattern: /(?<![\d０-９])0[\d０-９](?:[-－ー–—]?[\d０-９]){8,9}(?![\d０-９])/g,
  },
  {
    kind: "url",
    pattern: /https?:\/\/[^\s、。」）)]+/g,
  },
  {
    // 〒123-4567, or the bare form when preceded by the postal mark.
    kind: "postal_jp",
    pattern: /〒\s?[\d０-９]{3}\s?[-－ー]?\s?[\d０-９]{4}/g,
  },
  {
    // A run long enough to be an identifier and not a quantity. Twelve is
    // above any year, price or score a diary plausibly contains, and at or
    // below the length of a student number.
    kind: "long_digit_run",
    pattern: /(?<![\d０-９])[\d０-９]{12,}(?![\d０-９])/g,
  },
  {
    // A name with an honorific. Two to four kanji or katakana before さん /
    // くん / ちゃん / 先生, which is how a classmate or a teacher gets named.
    // Deliberately not matching hiragana-only: あのさん is not a name, and
    // hiragana before さん is usually a word.
    kind: "honorific_name",
    pattern: /[一-鿿゠-ヿ]{2,4}(?:さん|くん|君|ちゃん|先生)/g,
  },
  {
    // 3年2組, 2年B組 — the granularity at which a cohort of 50 becomes a
    // person. The dictionary lists class as never-collected; this finds it
    // when a participant writes it in prose anyway.
    kind: "school_year_class",
    pattern: /[1-6１-６]\s?年\s?[0-9０-９A-Za-zＡ-Ｚ]{1,2}\s?組/g,
  },
];

/**
 * Every finding in the text, in positional order.
 *
 * Overlapping findings are all reported: a phone number inside a URL is both,
 * and deciding which one "wins" would hide information from the reviewer for
 * the sake of a tidier list.
 */
export function scanForPii(text: string): PiiFinding[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const findings: PiiFinding[] = [];
  for (const detector of DETECTORS) {
    // A fresh regex per call: a `g` flag carries `lastIndex` between calls,
    // and a shared instance would skip findings in every second scan.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      findings.push({ kind: detector.kind, start: match.index, end: match.index + match[0].length });
      // A zero-length match would loop forever. None of the patterns can
      // produce one, and this costs nothing if that stops being true.
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** A count per kind, for a queue row that must not carry offsets either. */
export function summarizePii(findings: PiiFinding[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const finding of findings) {
    summary[finding.kind] = (summary[finding.kind] ?? 0) + 1;
  }
  return summary;
}

export function hasPii(text: string): boolean {
  return scanForPii(text).length > 0;
}

/**
 * What this scanner does not look for, and why. Kept in code because it is the
 * list a reader needs when they ask "did anyone think about X".
 *
 * - **Personal names without an honorific.** 「ゆうとと帰った」 names someone.
 *   Matching bare given names needs a name list, and a name list over Japanese
 *   given names collides with ordinary vocabulary (優, 愛, 光) badly enough
 *   that the queue would fill with false positives and stop being read.
 * - **Place names.** Same problem, worse: 「駅前」 is not identifying, a small
 *   town's name is. This needs a gazetteer and a judgement about population.
 * - **Dates of birth.** The study collects no birthdate, and a date in prose
 *   is usually an event, not an identifier.
 * - **Anything identifying by combination.** A sport, a position, a result and
 *   a week is an identification with no PII token in it at all. This is the
 *   category the human review exists for, and the reason a cleared text is not
 *   a safe text.
 */
export const PII_SCANNER_LIMITS = [
  "personal_names_without_honorific",
  "place_names",
  "dates_of_birth",
  "identification_by_combination",
] as const;
