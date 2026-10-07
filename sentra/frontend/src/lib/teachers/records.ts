/**
 * 自己申告の記録から言えること — 「変化あり」の決め方と、面談前サマリー。
 *
 * 1つのファイルにまとめてあるのは、ブラウザ無しで（node のテストから）
 * そのまま読めるようにするため。別ファイルから値を import すると、node と
 * tsc で拡張子の扱いが割れて、どちらかが通らない。
 */

/**
 * 「変化あり」の決め方（B-1 / C-1）。
 *
 * 自動判定はしない、という設計原則と矛盾しないよう、ここで比べるのは本人が
 * 自分で書いた・選んだものの推移だけにする。本文の意味を読んで「つらそう」と
 * 推し量ることはしない。結果も「変化あり／なし」の2つだけで、重さの段階は
 * 持たない — 段階を持った瞬間に、それは危険度になる。
 *
 * 決め方は数値で固定し、画面からも読めるようにしてある（生徒個別の画面に、
 * どの数字がどう動いたかをそのまま出す）。ここが曖昧だと、実質的にリスク
 * 検知の道具に見えてしまう。
 *
 *   直近4週と、その前の4週を比べる。次のどれかに当てはまれば「変化あり」。
 *   - 気分の平均が 1 段階以上動いた
 *   - 記録した日数が半分以下か 1.5 倍以上になり、差が 3 日以上ある
 *   - 1件あたりの文字数が半分以下か 1.5 倍以上になり、差が 40 字以上ある
 *   - よく選ぶタグの上位3つのうち、2つ以上が入れ替わった
 *   前の4週に記録が4件未満なら、比べる元が無いので判定しない。
 *   直近の4週が4件未満のときは、記録した日数だけを比べる
 *   （記録が減ったこと自体が、変化だから）。
 *
 * どちらの向きの変化も同じ「変化あり」になる。気分が上がっても、記録が
 * 増えても、出す札は同じ。良し悪しは付けない。
 */

import type { Mood } from "@/lib/blesc/types";
import type { SelfRecord } from "./types";

export const CHANGE_RULE = {
  /** 比べる期間の長さ（日） */
  windowDays: 28,
  /** 判定に要る記録の数（それぞれの期間に） */
  minRecords: 4,
  /** 気分の平均の差（段階） */
  moodDelta: 1,
  /** 記録した日数の比と、最低限の差（日） */
  frequency: { low: 0.5, high: 1.5, minDiff: 3 },
  /** 1件あたりの文字数の比と、最低限の差（字） */
  length: { low: 0.5, high: 1.5, minDiff: 40 },
  /** 上位いくつのタグを比べるか、何個入れ替わったら変化か */
  tags: { top: 3, swapped: 2 },
} as const;

/**
 * 気分を 1〜5 の段階に。5 が「とても良い」、1 が「つらい」。
 * 平均を取るための数で、画面には出さない。
 */
export const MOOD_LEVEL: Record<Mood, number> = {
  very_good: 5,
  good: 4,
  neutral: 3,
  low: 2,
  hard: 1,
};

export type ChangeSignal =
  | { kind: "mood"; before: number; after: number }
  | { kind: "frequency"; before: number; after: number }
  | { kind: "length"; before: number; after: number }
  | { kind: "tags"; before: string[]; after: string[] };

export type ChangeResult =
  /** 比べる元が足りない。札は出さない。 */
  | { status: "insufficient"; previous: number; recent: number }
  | { status: "steady"; previous: number; recent: number }
  | { status: "changed"; previous: number; recent: number; signals: ChangeSignal[] };

const DAY = 86_400_000;
const toTime = (date: string) => Date.parse(`${date}T00:00:00Z`);

/** asOf を含む直近 n 日と、その前の n 日に分ける。 */
function windows<Tag extends string>(records: ReadonlyArray<SelfRecord<Tag>>, asOf: string) {
  const end = toTime(asOf);
  const span = CHANGE_RULE.windowDays * DAY;
  const recent = records.filter((r) => toTime(r.date) <= end && toTime(r.date) > end - span);
  const previous = records.filter((r) => toTime(r.date) <= end - span && toTime(r.date) > end - span * 2);
  return { recent, previous };
}

const average = (values: number[]) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length);

/** 文字数。空白は数えない（改行や字下げで量が変わって見えないように）。 */
export const textLength = (text: string) => [...text.replace(/\s+/g, "")].length;

/**
 * よく選ぶタグの上位。数が同じなら、先に出てきた順。
 * 並びを毎回同じにしておかないと、同じ記録から違う「入れ替わり」が出る。
 */
export function topTags<Tag extends string>(records: ReadonlyArray<SelfRecord<Tag>>, top: number = CHANGE_RULE.tags.top): Tag[] {
  const counts = new Map<Tag, number>();
  for (const record of records) for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([tag]) => tag);
}

const crossed = (before: number, after: number, rule: { low: number; high: number; minDiff: number }) => {
  if (Math.abs(after - before) < rule.minDiff) return false;
  if (before === 0) return after > 0;
  const ratio = after / before;
  return ratio <= rule.low || ratio >= rule.high;
};

export function compareRecentWindows<Tag extends string>(
  records: ReadonlyArray<SelfRecord<Tag>>,
  asOf: string,
): ChangeResult {
  const { recent, previous } = windows(records, asOf);
  const counts = { previous: previous.length, recent: recent.length };
  if (previous.length < CHANGE_RULE.minRecords) return { status: "insufficient", ...counts };

  const signals: ChangeSignal[] = [];

  if (crossed(previous.length, recent.length, CHANGE_RULE.frequency)) {
    signals.push({ kind: "frequency", before: previous.length, after: recent.length });
  }

  // 気分・量・タグは、直近にも比べられるだけの記録があるときだけ見る。
  if (recent.length >= CHANGE_RULE.minRecords) {
    const moodBefore = average(previous.map((r) => MOOD_LEVEL[r.mood]));
    const moodAfter = average(recent.map((r) => MOOD_LEVEL[r.mood]));
    if (Math.abs(moodAfter - moodBefore) >= CHANGE_RULE.moodDelta) {
      signals.push({ kind: "mood", before: round1(moodBefore), after: round1(moodAfter) });
    }

    const lengthBefore = average(previous.map((r) => textLength(r.text)));
    const lengthAfter = average(recent.map((r) => textLength(r.text)));
    if (crossed(lengthBefore, lengthAfter, CHANGE_RULE.length)) {
      signals.push({ kind: "length", before: Math.round(lengthBefore), after: Math.round(lengthAfter) });
    }

    const tagsBefore = topTags(previous);
    const tagsAfter = topTags(recent);
    const swapped = tagsAfter.filter((tag) => !tagsBefore.includes(tag)).length;
    if (tagsBefore.length > 0 && swapped >= CHANGE_RULE.tags.swapped) {
      signals.push({ kind: "tags", before: tagsBefore, after: tagsAfter });
    }
  }

  return signals.length > 0 ? { status: "changed", ...counts, signals } : { status: "steady", ...counts };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/* ── 面談前サマリー ─────────────────────────────────────────── */

/**
 * 面談前サマリー（B-3 / C-3）。
 *
 * 出すのは3つだけ — よく出てくる話題、気分の推移、本人の記述の抜粋。
 * どれも記録をそのまま数えたり並べたりしたもので、ここには解釈が入らない。
 *
 * 言葉にまとめる部分を LLM に任せるときは、出てきた文章を画面に出す前に
 * summaryViolations() を通す。診断・推測・評価の言い回しがあれば出さない。
 * 本人の記述からの引用が1つも無ければ出さない（記録に無いことを言い始めた
 * 要約を、引用の有無で見分ける）。画面には必ず「AIによる要約」と書く。
 */

export interface Summary<Tag extends string> {
  from: string;
  to: string;
  /** よく出てくる話題（多い順）と回数 */
  topics: Array<{ tag: Tag; count: number }>;
  /** 気分の推移（古い順） */
  moods: Array<Pick<SelfRecord<Tag>, "date" | "mood">>;
  /** 本人の記述の抜粋（新しい順）。言葉は変えない。 */
  excerpts: Array<{ date: string; text: string }>;
}

const EXCERPT_LIMIT = 4;
const EXCERPT_CHARS = 90;

/**
 * 期間を指定して、記録から集計する。
 *
 * 抜粋は新しいものから、本文のある記録だけ。長いものは途中で切るが、
 * 書き換えはしない — 先生が読むのは本人の言葉であって、要約者の言葉ではない。
 */
export function buildSummary<Tag extends string>(
  records: ReadonlyArray<SelfRecord<Tag>>,
  { from, to }: { from: string; to: string },
): Summary<Tag> {
  const inRange = records.filter((r) => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date));

  const counts = new Map<Tag, number>();
  for (const record of inRange) for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const ordered = topTags(inRange, CHANGE_RULE.tags.top + 2);

  return {
    from,
    to,
    topics: ordered.map((tag) => ({ tag, count: counts.get(tag) ?? 0 })),
    moods: inRange.map(({ date, mood }) => ({ date, mood })),
    excerpts: inRange
      .filter((r) => r.text.trim().length > 0)
      .reverse()
      .slice(0, EXCERPT_LIMIT)
      .map((r) => ({ date: r.date, text: clip(r.text.trim(), EXCERPT_CHARS) })),
  };
}

const clip = (text: string, limit: number) => {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
};

/**
 * AI に書かせた要約で、出してはいけない言い回し。
 *
 * 診断（病名・状態の名指し）、推測（〜と思われる、〜の可能性）、評価
 * （心配、問題、傾向がある）の3種類。本人が書いた言葉の引用の中に出てくる
 * ぶんは問題にしない — 「つらい」と書いたのは本人で、要約者ではない。
 */
export const FORBIDDEN_IN_SUMMARY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /傾向が(ある|あります|見られ)/, reason: "傾向の断定（評価）" },
  { pattern: /心配/, reason: "評価" },
  { pattern: /懸念/, reason: "評価" },
  { pattern: /問題が(ある|あります)/, reason: "評価" },
  { pattern: /注意が必要/, reason: "評価" },
  { pattern: /リスク|危険/, reason: "危険度の表現" },
  { pattern: /可能性/, reason: "推測" },
  { pattern: /(と|も)?思われ/, reason: "推測" },
  { pattern: /考えられ/, reason: "推測" },
  { pattern: /示唆/, reason: "推測" },
  { pattern: /疑い|疑われ/, reason: "推測" },
  { pattern: /うつ|鬱|障害|症状|診断|病/, reason: "診断" },
  { pattern: /ストレスを抱え/, reason: "推測" },
];

/** 「」で括られた部分（引用）。 */
const QUOTED = /「([^」]+)」/g;

export type SummaryViolation =
  | { kind: "forbidden"; phrase: string; reason: string }
  | { kind: "no-quote" }
  | { kind: "unfaithful-quote"; quote: string };

/**
 * AI に書かせた要約が、そのまま画面に出せるか。
 *
 * 引用は、本人の記録のどれかにそのまま含まれていなければならない。言葉を
 * 少し変えた「引用」は、本人が言っていないことを本人の口から言わせることに
 * なるので、ずれていれば出さない。
 */
export function summaryViolations<Tag extends string>(
  text: string,
  records: ReadonlyArray<SelfRecord<Tag>>,
): SummaryViolation[] {
  const problems: SummaryViolation[] = [];
  const quotes = [...text.matchAll(QUOTED)].map((m) => m[1]);
  const outsideQuotes = text.replace(QUOTED, "「」");

  for (const { pattern, reason } of FORBIDDEN_IN_SUMMARY) {
    const hit = outsideQuotes.match(pattern);
    if (hit) problems.push({ kind: "forbidden", phrase: hit[0], reason });
  }

  if (quotes.length === 0) problems.push({ kind: "no-quote" });
  for (const quote of quotes) {
    if (!records.some((r) => r.text.includes(quote))) problems.push({ kind: "unfaithful-quote", quote });
  }

  return problems;
}
