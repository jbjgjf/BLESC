/**
 * Direct-identifier detection over retained journal text, and the review queue
 * it feeds (#167).
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 *
 * This is not anonymisation, and a cleared queue is not a guarantee that an
 * entry is safe to hand to a third party. It is a triage tool: it finds the
 * identifiers that are *shaped* like identifiers, so that a human reviewer
 * spends their attention on the entries that are not obvious.
 *
 * `PII_SCANNER_LIMITS` below is the list of things it cannot find, and it is
 * exported rather than left in prose so the export response and the operator
 * documentation carry the same list rather than two versions of it. The
 * protocol requires that limit statement (#167: 自動匿名化の限界を明記する).
 * ===========================================================================
 *
 * Two design decisions worth stating, because both look like omissions:
 *
 *   1. **A finding never carries the matched text.** A queue row holds the kind
 *      of identifier, where it starts and how long it is — enough to triage,
 *      to count, and to redact. It does not hold the email address it found.
 *      A review queue that quotes what it found is a second copy of the
 *      participant's text in a table with different access rules, which is
 *      precisely the leak the queue exists to prevent. A reviewer who needs to
 *      read the passage goes through the audited export, under the export
 *      allowlist, and that access is logged.
 *
 *   2. **The scanner is deliberately over-eager on names and places.** A
 *      Japanese journal entry that says 田中さん is probably naming a
 *      classmate; one that says お母さん is not naming anybody. Both match.
 *      A false positive costs a reviewer ten seconds; a false negative puts a
 *      classmate's name in a research dataset. The queue is sized for the first
 *      cost.
 *
 * Pure: no network, no database, no environment. Everything here is testable
 * against synthetic text, which is the only text it is ever run against in
 * development (#167: サンプルは合成データだけで作り).
 */

/**
 * Bump when a pattern is added, removed, or its severity changes. Stored on
 * every queue row, so a reviewer can tell which scanner cleared an entry — and
 * so a re-scan after a pattern is added is identifiable as a re-scan.
 */
export const PII_SCANNER_VERSION = "pii-scan-ja-v1";

export type PiiKind =
  | "email"
  | "phone_jp"
  | "my_number"
  | "student_id"
  | "postal_code_jp"
  | "address_jp"
  | "school_name"
  | "person_name_honorific"
  | "sns_handle"
  | "url";

/**
 * `high` is a direct identifier: on its own it names a person or reaches them.
 * `medium` identifies in combination — a school and a first name together are
 * usually enough. `low` is context a reviewer should see and will usually pass.
 */
export type PiiSeverity = "high" | "medium" | "low";

export type PiiFinding = {
  kind: PiiKind;
  severity: PiiSeverity;
  /** Character offset into the scanned text, inclusive. */
  start: number;
  /** Character offset, exclusive. */
  end: number;
  /** `end - start`. Stored so a reviewer can judge scale without the text. */
  length: number;
};

export type PiiSummary = {
  scanner_version: string;
  finding_count: number;
  /** Null when nothing matched. */
  max_severity: PiiSeverity | null;
  /** Distinct kinds, sorted, for a dashboard that groups by kind. */
  kinds: PiiKind[];
  findings: PiiFinding[];
};

/**
 * What this scanner does not find. Read by the export route and by
 * `docs/pilot/pii-review.md`, so an operator is told the same thing in both
 * places.
 */
export const PII_SCANNER_LIMITS: readonly string[] = [
  "氏名だけが書かれている場合（敬称や肩書きを伴わない「ゆうた」「Tanaka」など）は検出しない。",
  "ひらがなだけの氏名（「さくらさん」など）は検出しない。敬称の前が漢字・カタカナの場合のみ検出する。",
  "あだ名・イニシャル・部内での呼び名は検出しない。",
  "固有名詞を伴わない間接的な特定（「3年の生徒会長」「隣のクラスの転校生」）は検出しない。",
  "複数のエントリを突き合わせて初めて特定できる情報は、1件ずつ見る本scannerの対象外。",
  "手書き画像・音声・添付ファイルは対象外（本pilotでは収集しない）。",
  "検出は日本語と半角英数字を前提とする。他言語の住所・氏名は取りこぼす。",
  "検出できたことは匿名化の完了を意味しない。exportの可否は人のreviewが決める。",
] as const;

/**
 * Full-width → half-width for the character classes that appear inside
 * identifiers, as a **length-preserving** map.
 *
 * A student typing on a Japanese IME writes ０９０−１２３４−５６７８ as often
 * as 090-1234-5678, and a scanner that only knows half-width digits misses the
 * first one entirely. NFKC normalisation would handle it but changes string
 * length for other characters (ﾞ, ㍻, ligatures), which would make every offset
 * in a finding point at the wrong place in the original text.
 *
 * Each character below maps to exactly one character, so offsets survive.
 */
const WIDE_TO_NARROW: Record<string, string> = {
  "－": "-", "ー": "-", "―": "-", "‐": "-", "−": "-",
  "＠": "@", "．": ".", "＿": "_", "／": "/", "：": ":", "＃": "#",
};

function narrow(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0)!;
    // Full-width digits ０-９, uppercase Ａ-Ｚ, lowercase ａ-ｚ.
    if (code >= 0xff10 && code <= 0xff19) out += String.fromCharCode(code - 0xff10 + 0x30);
    else if (code >= 0xff21 && code <= 0xff3a) out += String.fromCharCode(code - 0xff21 + 0x41);
    else if (code >= 0xff41 && code <= 0xff5a) out += String.fromCharCode(code - 0xff41 + 0x61);
    else if (WIDE_TO_NARROW[char]) out += WIDE_TO_NARROW[char];
    // A surrogate pair (an emoji) is one `for...of` step but two code units, so
    // it is copied as-is and keeps its length.
    else out += char;
  }
  return out;
}

/**
 * The patterns, in the order they are applied.
 *
 * Order is the overlap rule: an earlier pattern wins a contested span. `email`
 * precedes `url` and `sns_handle` so that `taro@example.com` is reported once,
 * as an email, rather than three times.
 */
const PATTERNS: Array<{ kind: PiiKind; severity: PiiSeverity; re: RegExp }> = [
  {
    kind: "email",
    severity: "high",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    // +81 and the domestic forms, separated or run together. Deliberately loose
    // about the separator: a reviewer sorting out a date from a phone number is
    // cheaper than a missed number.
    kind: "phone_jp",
    severity: "high",
    re: /(?:\+81[-\s]?\d{1,4}[-\s]?\d{2,4}[-\s]?\d{3,4}|\b0\d{1,4}-\d{1,4}-\d{3,4}\b|\b0[789]0\d{8}\b)/g,
  },
  {
    // マイナンバー: exactly twelve digits, not part of a longer run.
    kind: "my_number",
    severity: "high",
    re: /(?<!\d)\d{12}(?!\d)/g,
  },
  {
    // 学籍番号 / 生徒番号 / 出席番号 followed by its value, with or without a
    // separator. The label is what makes the digits an identifier: a bare "12"
    // in a sentence is not one.
    kind: "student_id",
    severity: "high",
    re: /(?:学籍番号|生徒番号|出席番号|学生証番号)\s*(?:は|:|：)?\s*[A-Za-z0-9-]{1,16}/g,
  },
  {
    kind: "postal_code_jp",
    severity: "medium",
    re: /〒\s?\d{3}-?\d{4}\b/g,
  },
  {
    // 都道府県 followed by a 市区町村 within a short span. Requiring both halves
    // keeps "東京はよかった" out of the queue while catching a written address.
    kind: "address_jp",
    severity: "medium",
    re: /[一-鿿]{2,4}[都道府県][一-鿿぀-ゟ゠-ヿ]{1,8}[市区町村]/g,
  },
  {
    // The body excludes ひらがな for the same reason the name pattern does, and
    // for a sharper one: 「東京都渋谷区の桜丘高校」 with ひらがな allowed
    // matches from 東 through 桜丘, swallowing the address that the previous
    // pattern already reported and losing both findings to the overlap rule.
    kind: "school_name",
    severity: "medium",
    re: /[一-鿿゠-ヿA-Za-z0-9]{2,12}(?:小学校|中学校|高等学校|高校|学園|学院|大学)/g,
  },
  {
    // A name-shaped token followed by an honorific.
    //
    // The body is 漢字/カタカナ only. Allowing ひらがな there makes the match
    // swallow the particle in front of it — 「今日は田中さん」 comes back as
    // one seven-character name — and a finding whose offsets are wrong cannot
    // be redacted correctly. The cost is that an all-ひらがな name is missed;
    // that is in `PII_SCANNER_LIMITS`, where a reviewer will read it.
    kind: "person_name_honorific",
    severity: "medium",
    re: /[一-鿿゠-ヿ][一-鿿゠-ヿ]{0,5}(?:さん|くん|君|ちゃん|先生|先輩|部長|校長|教頭)/g,
  },
  {
    kind: "sns_handle",
    severity: "medium",
    // The leading delimiter stops an email local part from being reported a
    // second time as a handle. 。 and 、 are in the class because a Japanese
    // sentence ends before the handle without a space.
    re: /(?:^|[\s。、，,.（(【「])@[A-Za-z0-9_.]{3,30}\b/g,
  },
  {
    kind: "url",
    severity: "low",
    re: /https?:\/\/[^\s「」（）()【】]+/g,
  },
];

/**
 * Honorific matches that are almost always a relation and not a name.
 *
 * Kept as an exact-match list rather than a pattern: "お母さん" is a false
 * positive every single time, and a reviewer who sees it in every entry stops
 * reading the queue. Anything ambiguous stays in.
 */
const RELATION_WORDS = new Set([
  "お母さん", "母さん", "おかあさん", "お父さん", "父さん", "おとうさん",
  "お姉さん", "姉さん", "お兄さん", "兄さん", "おばあちゃん", "おじいちゃん",
  "妹ちゃん", "弟くん", "みんなさん",
]);

function overlaps(a: PiiFinding, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Every direct identifier the patterns can see, in document order.
 *
 * Offsets index the text as given. `narrow` is applied to a copy for matching
 * only, and it preserves length character-for-character, so a finding's
 * `[start, end)` is valid against the original string too — which is what makes
 * `redactFindings` able to cut the right span out of the text a reviewer holds.
 */
export function scanForPii(text: string): PiiFinding[] {
  if (!text) return [];
  const haystack = narrow(text);
  const findings: PiiFinding[] = [];

  for (const { kind, severity, re } of PATTERNS) {
    // Fresh lastIndex per call: the RegExp objects are module-level and `g`
    // regexes carry state between `exec` loops.
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(haystack)) !== null) {
      let start = match.index;
      const end = start + match[0].length;
      // The sns_handle pattern captures a leading delimiter so it can require
      // one; the delimiter is not part of the identifier.
      if (kind === "sns_handle") {
        const at = haystack.indexOf("@", start);
        if (at >= 0) start = at;
      }
      if (kind === "person_name_honorific" && RELATION_WORDS.has(haystack.slice(start, end))) continue;
      // Zero-length matches would loop forever; none of the patterns can
      // produce one, and this makes that true rather than assumed.
      if (end <= start) {
        re.lastIndex = start + 1;
        continue;
      }
      const candidate = { start, end };
      if (findings.some((existing) => overlaps(existing, candidate))) continue;
      findings.push({ kind, severity, start, end, length: end - start });
    }
  }

  return findings.sort((a, b) => a.start - b.start);
}

const SEVERITY_ORDER: Record<PiiSeverity, number> = { low: 0, medium: 1, high: 2 };

/** The queue row's shape: counts and kinds, and not one character of text. */
export function summarizeFindings(findings: PiiFinding[]): PiiSummary {
  let max: PiiSeverity | null = null;
  const kinds = new Set<PiiKind>();
  for (const finding of findings) {
    kinds.add(finding.kind);
    if (!max || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[max]) max = finding.severity;
  }
  return {
    scanner_version: PII_SCANNER_VERSION,
    finding_count: findings.length,
    max_severity: max,
    kinds: Array.from(kinds).sort(),
    findings,
  };
}

/**
 * The text with every finding replaced by a typed placeholder.
 *
 * Used when an operator has decided an entry may be exported with its
 * identifiers removed. Placeholders are typed (`[[PII:email]]`) rather than
 * blanked so that a reader of the redacted text can tell that a name was
 * removed from a sentence that now reads strangely — an unmarked gap looks like
 * a participant who trailed off.
 *
 * Replacing back-to-front keeps the offsets of the not-yet-replaced findings
 * valid, since a placeholder is not the same length as what it replaces.
 */
export function redactFindings(text: string, findings: PiiFinding[]): string {
  let out = text;
  for (const finding of [...findings].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, finding.start)}[[PII:${finding.kind}]]${out.slice(finding.end)}`;
  }
  return out;
}
