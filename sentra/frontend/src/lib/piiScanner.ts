/**
 * PII detection for free-text journal entries (#167).
 *
 * This exists to build a review queue, not to anonymise anything. The
 * distinction matters enough to state before the code:
 *
 * **What this can do.** Find the shapes that are mechanically recognisable —
 * an email address, a phone number, a postal code, a URL, a school name, a
 * family name followed by an honorific. These are patterns, and patterns are
 * what a regular expression is for.
 *
 * **What this cannot do, and never will.** A student writes 「ゆいちゃんとけん
 * かした」. `ゆい` is a given name in hiragana; it is also an ordinary word
 * fragment. A student writes 「クラスで唯一オーボエを吹いている子」— no name at
 * all, and yet in a cohort of fifty that identifies exactly one person. A
 * student writes 「うちのお母さんの職場」. None of these are findable by shape,
 * and a scanner that claimed to catch them would be worse than one that admits
 * it cannot, because the claim is what lets someone skip the human read.
 *
 * So the contract is: every finding is a reason to look, no finding is a
 * guarantee of absence, and `scanForPii` never decides on its own that text is
 * safe to release. `redactFindings` exists for previews and logs — it is not a
 * de-identification step, and the export path does not call it to make text
 * exportable.
 *
 * Precision over recall on the high-confidence kinds, recall over precision on
 * the rest: a queue nobody trusts gets skipped, and a queue that misses the
 * obvious is worse than none. Findings therefore carry a confidence, and the
 * review UI can sort by it rather than treating a class number and an email
 * address as the same claim.
 */

export type PiiKind =
  | "email"
  | "phone"
  | "postal_code"
  | "url"
  | "social_handle"
  | "school_name"
  | "person_name_honorific"
  | "address"
  | "class_identifier"
  | "birth_date";

export type PiiConfidence = "high" | "medium" | "low";

export type PiiFinding = {
  kind: PiiKind;
  /** The matched substring, verbatim. */
  text: string;
  /** Index of the first character of the match in the scanned string. */
  start: number;
  /** Index one past the last character. */
  end: number;
  confidence: PiiConfidence;
};

type Detector = {
  kind: PiiKind;
  confidence: PiiConfidence;
  pattern: RegExp;
  /** Rejects a match the pattern accepted. Used where a shape is ambiguous. */
  reject?: (match: RegExpExecArray, source: string) => boolean;
};

/**
 * Japanese phone numbers, with or without hyphens.
 *
 * Anchored on a leading `0` because every domestic number starts with one, and
 * bounded so that a longer run of digits does not match a fragment of itself:
 * an order number like `08012345678901` is not a phone number, and matching
 * its first eleven digits would put a false finding in the queue every time.
 */
const PHONE = /0\d{1,4}-?\d{1,4}-?\d{3,4}/g;

/**
 * A date carrying a year. A bare 「9月6日」 is when something happened, which
 * is the entire point of a journal; only a year makes it a candidate birthdate.
 * Still `low`: 「2026年9月6日に体育祭があった」 is an event, not a birthday.
 */
const BIRTH_DATE = /(?:19|20)\d{2}\s*[年/\-.]\s*\d{1,2}\s*[月/\-.]\s*\d{1,2}\s*日?/g;

const DETECTORS: Detector[] = [
  {
    kind: "email",
    confidence: "high",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: "url",
    confidence: "high",
    pattern: /https?:\/\/[^\s、。」』）)]+/g,
  },
  {
    kind: "postal_code",
    confidence: "high",
    pattern: /〒\s*\d{3}-?\d{4}/g,
  },
  {
    kind: "phone",
    confidence: "high",
    pattern: PHONE,
    reject: (match, source) => {
      const digits = match[0].replace(/-/g, "");
      // Domestic numbers are 10 or 11 digits. Anything else that survived the
      // pattern is a year range, an order number, or a score.
      if (digits.length < 10 || digits.length > 11) return true;
      // A digit on either side means the match is a fragment of something
      // longer, and the something longer is not a phone number.
      const before = source[match.index - 1];
      const after = source[match.index + match[0].length];
      return /\d/.test(before ?? "") || /\d/.test(after ?? "");
    },
  },
  {
    kind: "social_handle",
    confidence: "high",
    // A LINE id or an @handle. Requires a letter somewhere so that a bare
    // 「@3」 or an email's domain part does not match.
    pattern: /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_.-]{3,30}\b/g,
    reject: (match) => !/[A-Za-z]/.test(match[0]),
  },
  {
    kind: "school_name",
    confidence: "medium",
    pattern:
      /[一-鿿぀-ゟ゠-ヿA-Za-z0-9ー]{1,12}(?:小学校|中学校|高等学校|高校|中等教育学校|大学)/g,
  },
  {
    kind: "address",
    confidence: "medium",
    pattern:
      /[一-鿿]{2,4}[都道府県][一-鿿぀-ゟ゠-ヿ]{1,8}[市区町村](?:[一-鿿぀-ゟ゠-ヿ0-9０-９\-ー]{0,12}(?:丁目|番地|番|号))?/g,
  },
  {
    kind: "person_name_honorific",
    confidence: "medium",
    // A family name is 1-4 kanji before an honorific. Katakana names are
    // included; hiragana is not, because 「そうさん」 matches far more ordinary
    // sentences than it does names.
    pattern: /[一-鿿゠-ヿ]{1,4}(?:先生|さん|くん|ちゃん|様|部長|監督|コーチ)/g,
    reject: (match) => {
      // Words that end in an honorific-looking suffix without being a name.
      // 「お母さん」 identifies a role, not a person, and flagging every one of
      // them would bury the queue.
      const KINSHIP_AND_ROLES =
        /^(?:お?母|お?父|おじい|おばあ|お?兄|お?姉|叔母|叔父|伯母|伯父|息子|娘|皆|みな|お客|店員|担任|校長|教頭|保健|用務)/;
      return KINSHIP_AND_ROLES.test(match[0]);
    },
  },
  {
    kind: "class_identifier",
    confidence: "low",
    pattern: /\d{1,2}\s*年\s*\d{1,2}\s*組|出席番号\s*\d{1,3}|\d{1,2}\s*年\s*\d{1,2}\s*番/g,
  },
  {
    kind: "birth_date",
    confidence: "low",
    pattern: BIRTH_DATE,
  },
];

/**
 * Every PII candidate in `text`, ordered by position.
 *
 * Overlapping findings are kept. 「〒150-0001 東京都渋谷区」 is both a postal
 * code and an address, and collapsing them to one would hide from the reviewer
 * that two different things are present.
 */
export function scanForPii(text: string): PiiFinding[] {
  if (!text) return [];
  const findings: PiiFinding[] = [];

  for (const detector of DETECTORS) {
    // Fresh regex per call: `lastIndex` on a shared global regex is state, and
    // sharing it across calls makes the second scan of the same string return
    // different results from the first.
    const pattern = new RegExp(detector.pattern.source, detector.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A zero-length match would loop forever.
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      if (detector.reject?.(match, text)) continue;
      findings.push({
        kind: detector.kind,
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: detector.confidence,
      });
    }
  }

  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Counts by kind, for a queue that shows what is in a row before opening it. */
export function summarizePii(findings: PiiFinding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
  kinds: Record<string, number>;
} {
  const kinds: Record<string, number> = {};
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const finding of findings) {
    kinds[finding.kind] = (kinds[finding.kind] ?? 0) + 1;
    if (finding.confidence === "high") high += 1;
    else if (finding.confidence === "medium") medium += 1;
    else low += 1;
  }
  return { total: findings.length, high, medium, low, kinds };
}

/**
 * `text` with every finding replaced by `[kind]`.
 *
 * For previews and operator screens. **Not** an anonymisation step: what it
 * removes is what `scanForPii` found, and the module docstring is a list of
 * the things it does not find. Redacted text is still participant text.
 */
export function redactFindings(text: string, findings: PiiFinding[]): string {
  if (findings.length === 0) return text;

  // Merge overlaps first, otherwise a postal code inside an address is
  // replaced twice and the offsets of the second replacement are wrong.
  const merged: Array<{ start: number; end: number; kinds: Set<PiiKind> }> = [];
  for (const finding of [...findings].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && finding.start < last.end) {
      last.end = Math.max(last.end, finding.end);
      last.kinds.add(finding.kind);
    } else {
      merged.push({ start: finding.start, end: finding.end, kinds: new Set([finding.kind]) });
    }
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start);
    out += `[${Array.from(span.kinds).sort().join("+")}]`;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
