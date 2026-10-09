/**
 * 記録の読み方の決まり。UI仕様書の 5-1「変化があった生徒」と 5-3「面談前の要約」。
 *
 * どれも本人が書いた・選んだものを数えるだけで、点数・平均値・順位は
 * 画面に出さない（気分の平均は比べるために中で使うだけ）。変化は「何が
 * どう動いたか」を一文で言い、重さの段階は持たない。良い方向の変化も
 * 同じ扱いで出す。
 *
 * 判定の数値は仕様書で「研究結果を待って確定」の未決事項。いまの値は仮置きで、
 * CHANGE_RULE の一か所にまとめてある。
 *
 * 値の import を持たない（node のテストからそのまま読めるように）。
 */

import type { Mood } from "@/lib/blesc/types";
import type { SelfRecord } from "./types";

const DAY = 86_400_000;
const dayIndex = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY);

export const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

/** 土日は帰りのHRが無いので、記録しないのがふつうの日。 */
export const isSchoolDay = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/** その日を含めて、さかのぼった登校日 count 日ぶん（古い順）。 */
export function schoolDaysUntil(asOf: string, count: number): string[] {
  const days: string[] = [];
  for (let date = asOf; days.length < count; date = addDays(date, -1)) {
    if (isSchoolDay(date)) days.unshift(date);
  }
  return days;
}

/** その週の月曜日。週の確認（5-1）の区切りに使う。 */
export function weekStart(iso: string): string {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

/** 比べるために中で使う、気分の並び。画面には出さない。 */
export const MOOD_LEVEL: Record<Mood, number> = { very_good: 5, good: 4, neutral: 3, low: 2, hard: 1 };

/** 仮置きの判定基準（未決事項）。 */
export const CHANGE_RULE = {
  /** 直近（この日数）と、それまで（その前の baselineDays 日）を比べる */
  recentDays: 14,
  baselineDays: 28,
  /** 比べるのに要る記録の数。足りなければ判定しない */
  minRecent: 4,
  minBaseline: 6,
  /** 気分：5段階の並びの平均が、これだけ動いたら */
  moodShift: 1,
  /**
   * 話題が増えた：それまでは少なかった（割合が topicWasAtMost 以下の）タグが、
   * 直近では半分以上（topicNowAtLeast）の記録に付き、topicMinCount 回以上
   */
  topicWasAtMost: 0.15,
  topicNowAtLeast: 0.5,
  topicMinCount: 4,
  /** 続いている：直近の記録が、このタグで topicStreak 件続いている（それまでは割合が streakWasAtMost 以下） */
  topicStreak: 5,
  streakWasAtMost: 0.3,
  /** 記述の長さ：1件あたりの文字数が半分以下か2倍以上になり、差が lengthMinDiff 字以上 */
  lengthRatio: 2,
  lengthMinDiff: 25,
  /** 記録の間：記録の無い登校日が、この日数以上続いている */
  gapDays: 3,
  /** 記録の時間：保存した時刻の平均が、これだけずれた（先生の記録だけ） */
  timeShiftMinutes: 45,
} as const;

export type Change<Tag extends string = string> =
  | { kind: "gap"; days: number }
  | { kind: "mood"; direction: "down" | "up" }
  | { kind: "streak"; tag: Tag }
  | { kind: "topic"; tag: Tag }
  | { kind: "length"; direction: "shorter" | "longer" }
  | { kind: "time"; direction: "later" | "earlier" };

export type ChangeResult<Tag extends string = string> =
  | { status: "insufficient" }
  | { status: "steady" }
  | { status: "changed"; changes: Array<Change<Tag>> };

export const textLength = (text: string) => [...text.replace(/\s+/g, "")].length;
const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** 最後に記録した日のあと、記録の無い登校日がいくつ続いているか（今日は数えない）。 */
export function missedSchoolDays<Tag extends string>(records: ReadonlyArray<SelfRecord<Tag>>, asOf: string): number {
  const last = records.reduce<string | null>((latest, r) => (r.date <= asOf && (!latest || r.date > latest) ? r.date : latest), null);
  if (!last) return 0;
  let missed = 0;
  for (let date = addDays(last, 1); date < asOf; date = addDays(date, 1)) if (isSchoolDay(date)) missed += 1;
  return missed;
}

const share = <Tag extends string>(records: ReadonlyArray<SelfRecord<Tag>>, tag: Tag) =>
  records.filter((r) => r.tags.includes(tag)).length / records.length;

/**
 * 直近2週間と、それまでを比べる。
 *
 * 並びは、一行で見せるときに先に出すもの順（記録の間・気分・続いている話題・
 * 増えた話題・記述の長さ・記録の時間）。どれも同じ扱いで、重さの順ではない。
 */
export function detectChanges<Tag extends string>(
  records: ReadonlyArray<SelfRecord<Tag>>,
  asOf: string,
  { time = false }: { time?: boolean } = {},
): ChangeResult<Tag> {
  const now = dayIndex(asOf);
  const age = (r: SelfRecord<Tag>) => now - dayIndex(r.date);
  const sorted = [...records].filter((r) => age(r) >= 0).sort((a, b) => a.date.localeCompare(b.date));
  const recent = sorted.filter((r) => age(r) < CHANGE_RULE.recentDays);
  const baseline = sorted.filter((r) => age(r) >= CHANGE_RULE.recentDays && age(r) < CHANGE_RULE.recentDays + CHANGE_RULE.baselineDays);

  const changes: Array<Change<Tag>> = [];

  // 記録の間は、比べる元が無くても言える。
  const missed = missedSchoolDays(sorted, asOf);
  if (missed >= CHANGE_RULE.gapDays) changes.push({ kind: "gap", days: missed });

  if (baseline.length < CHANGE_RULE.minBaseline || recent.length < CHANGE_RULE.minRecent) {
    return changes.length > 0 ? { status: "changed", changes } : { status: "insufficient" };
  }

  const moodShift = mean(recent.map((r) => MOOD_LEVEL[r.mood])) - mean(baseline.map((r) => MOOD_LEVEL[r.mood]));
  if (moodShift <= -CHANGE_RULE.moodShift) changes.push({ kind: "mood", direction: "down" });
  if (moodShift >= CHANGE_RULE.moodShift) changes.push({ kind: "mood", direction: "up" });

  const latest = recent.slice(-CHANGE_RULE.topicStreak);
  const tags = [...new Set(recent.flatMap((r) => r.tags))];
  const streak =
    latest.length === CHANGE_RULE.topicStreak
      ? tags.find((tag) => latest.every((r) => r.tags.includes(tag)) && share(baseline, tag) <= CHANGE_RULE.streakWasAtMost)
      : undefined;
  if (streak) changes.push({ kind: "streak", tag: streak });

  const risen = tags
    .filter((tag) => tag !== streak)
    .map((tag) => ({
      tag,
      count: recent.filter((r) => r.tags.includes(tag)).length,
      before: share(baseline, tag),
      now: share(recent, tag),
    }))
    .filter((t) => t.before <= CHANGE_RULE.topicWasAtMost && t.now >= CHANGE_RULE.topicNowAtLeast && t.count >= CHANGE_RULE.topicMinCount)
    .sort((a, b) => b.now - b.before - (a.now - a.before))[0];
  if (risen) changes.push({ kind: "topic", tag: risen.tag });

  const lengthBefore = mean(baseline.map((r) => textLength(r.text)));
  const lengthNow = mean(recent.map((r) => textLength(r.text)));
  if (Math.abs(lengthBefore - lengthNow) >= CHANGE_RULE.lengthMinDiff) {
    if (lengthBefore >= lengthNow * CHANGE_RULE.lengthRatio) changes.push({ kind: "length", direction: "shorter" });
    if (lengthNow >= lengthBefore * CHANGE_RULE.lengthRatio) changes.push({ kind: "length", direction: "longer" });
  }

  if (time) {
    const shift = mean(recent.map((r) => minutes(r.time))) - mean(baseline.map((r) => minutes(r.time)));
    if (shift >= CHANGE_RULE.timeShiftMinutes) changes.push({ kind: "time", direction: "later" });
    if (shift <= -CHANGE_RULE.timeShiftMinutes) changes.push({ kind: "time", direction: "earlier" });
  }

  return changes.length > 0 ? { status: "changed", changes } : { status: "steady" };
}

/**
 * 変化を一文にする。生徒の話題は「部活動の話題」、先生の話題は
 * 「『業務量』の話題」と書く（仕様書の例のとおり）。
 */
export function describeChange<Tag extends string>(
  change: Change<Tag>,
  label: (tag: Tag) => string,
  subject: "student" | "teacher",
): string {
  const topic = (tag: Tag) => (subject === "teacher" ? `『${label(tag)}』` : label(tag));
  switch (change.kind) {
    case "gap":
      return `記録が${change.days}日空いています`;
    case "mood":
      return change.direction === "down" ? "この2週間、気分が下がり気味です" : "この2週間、気分が上向きです";
    case "streak":
      return subject === "teacher" ? `${topic(change.tag)}が続いています` : `${topic(change.tag)}の話題が続いています`;
    case "topic":
      return `${topic(change.tag)}の話題が増えています`;
    case "length":
      return change.direction === "shorter" ? "記述が短くなっています" : "記述が長くなっています";
    case "time":
      return change.direction === "later" ? "記録の時間が遅くなっています" : "記録の時間が早くなっています";
  }
}

/* ── 面談前の要約（5-3 / 6-2） ─────────────────────────────── */

export const SUMMARY_RULE = {
  /** 直近この日数ぶんから作る */
  days: 60,
  /** これより少なければ作らない */
  minRecords: 5,
  topics: 3,
  quotes: 3,
  quoteChars: 80,
  workItems: 5,
} as const;

export interface Summary<Tag extends string = string> {
  from: string;
  to: string;
  count: number;
  /** よく出てくる話題（上位3つと回数） */
  topics: Array<{ tag: Tag; count: number }>;
  /** 気分の流れ（1文） */
  moodFlow: string;
  /** 本人の言葉。記録からそのまま切り出したもの */
  quotes: Array<{ date: string; text: string }>;
  /** 業務に関する記述（先生の要約だけ） */
  work: Array<{ date: string; tags: Tag[]; text: string }>;
}

const clip = (text: string, limit: number) => {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
};

const firstSentence = (text: string) => {
  const stop = text.indexOf("。");
  return (stop > 0 ? text.slice(0, stop + 1) : text).trim();
};

/** いちばん多い気分。同数なら並びの先（良い側）を取る — どちらに寄せても判断にはしない。 */
function commonest(moods: Mood[]): Mood | null {
  const order: Mood[] = ["very_good", "good", "neutral", "low", "hard"];
  let best: Mood | null = null;
  let top = 0;
  for (const mood of order) {
    const count = moods.filter((m) => m === mood).length;
    if (count > top) {
      top = count;
      best = mood;
    }
  }
  return best;
}

/**
 * 記録から要約を組み立てる。記録が足りなければ null（作らない）。
 *
 * 気分の流れは、期間の前半と後半でいちばん多かった気分を並べるだけ。
 * 本人の言葉は、本文の最初の一文をそのまま使う。言い換えはしない。
 */
export function buildSummary<Tag extends string>(
  records: ReadonlyArray<SelfRecord<Tag>>,
  {
    asOf,
    moodLabel,
    workTags = [],
  }: { asOf: string; moodLabel: (mood: Mood) => string; workTags?: readonly Tag[] },
): Summary<Tag> | null {
  const from = addDays(asOf, -(SUMMARY_RULE.days - 1));
  const inRange = records.filter((r) => r.date >= from && r.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  if (inRange.length < SUMMARY_RULE.minRecords) return null;

  const counts = new Map<Tag, number>();
  for (const record of inRange) for (const tag of record.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  const topics = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUMMARY_RULE.topics)
    .map(([tag, count]) => ({ tag, count }));

  const half = Math.ceil(inRange.length / 2);
  const before = commonest(inRange.slice(0, half).map((r) => r.mood));
  const after = commonest(inRange.slice(half).map((r) => r.mood));
  const moodFlow =
    !before || !after || before === after
      ? `期間を通して『${moodLabel(before ?? after ?? "neutral")}』の日がいちばん多くなっています。`
      : `前半は『${moodLabel(before)}』の日が多く、後半は『${moodLabel(after)}』の日が多くなっています。`;

  const seen = new Set<string>();
  const quotes: Summary<Tag>["quotes"] = [];
  for (const record of [...inRange].reverse()) {
    const sentence = firstSentence(record.text);
    if ([...sentence].length < 6 || seen.has(sentence)) continue;
    seen.add(sentence);
    quotes.push({ date: record.date, text: clip(sentence, SUMMARY_RULE.quoteChars) });
    if (quotes.length === SUMMARY_RULE.quotes) break;
  }

  const work = [...inRange]
    .reverse()
    .filter((r) => r.text.trim() && r.tags.some((t) => workTags.includes(t)))
    .slice(0, SUMMARY_RULE.workItems)
    .map((r) => ({ date: r.date, tags: r.tags.filter((t) => workTags.includes(t)), text: clip(r.text.trim(), SUMMARY_RULE.quoteChars) }));

  return { from, to: asOf, count: inRange.length, topics, moodFlow, quotes, work };
}

/**
 * AI に書かせた要約で、出してはいけない言い回し。
 *
 * 診断（病名・状態の名指し）、推測（〜と思われる、〜の可能性）、評価
 * （心配、問題、傾向がある）、助言（〜しましょう）。本人の言葉の引用の中に
 * 出てくるぶんは問題にしない — 「つらい」と書いたのは本人で、要約者ではない。
 */
export const FORBIDDEN_IN_SUMMARY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /傾向が(ある|あります|見られ)/, reason: "傾向の断定（評価）" },
  { pattern: /心配/, reason: "評価" },
  { pattern: /懸念/, reason: "評価" },
  { pattern: /問題が(ある|あります)/, reason: "評価" },
  { pattern: /注意が必要/, reason: "評価" },
  { pattern: /リスク|危険|要注意/, reason: "危険度の表現" },
  { pattern: /可能性/, reason: "推測" },
  { pattern: /(と|も)?思われ/, reason: "推測" },
  { pattern: /考えられ/, reason: "推測" },
  { pattern: /示唆/, reason: "推測" },
  { pattern: /疑い|疑われ/, reason: "推測" },
  { pattern: /うつ|鬱|障害|症状|診断|病/, reason: "診断" },
  { pattern: /ストレスを抱え/, reason: "推測" },
  { pattern: /声をかけ(ましょう|てください|るとよい)|しましょう/, reason: "助言" },
];

/** 「」で括られた部分（引用）。 */
const QUOTED = /「([^」]+)」/g;

export type SummaryViolation = { kind: "forbidden"; phrase: string; reason: string } | { kind: "unfaithful-quote"; quote: string };

/**
 * AI に書かせた要約の文が、そのまま画面に出せるか。
 *
 * 引用（「」）は、本人の記録のどれかにそのまま含まれていなければならない。
 * 少し言い換えた「引用」は、本人が言っていないことを本人の口から言わせる
 * ことになるので、ずれていれば出さない。
 */
export function summaryViolations<Tag extends string>(text: string, records: ReadonlyArray<SelfRecord<Tag>>): SummaryViolation[] {
  const problems: SummaryViolation[] = [];
  const quotes = [...text.matchAll(QUOTED)].map((m) => m[1]);
  const outsideQuotes = text.replace(QUOTED, "「」");
  for (const { pattern, reason } of FORBIDDEN_IN_SUMMARY) {
    const hit = outsideQuotes.match(pattern);
    if (hit) problems.push({ kind: "forbidden", phrase: hit[0], reason });
  }
  for (const quote of quotes) {
    if (!records.some((r) => r.text.includes(quote))) problems.push({ kind: "unfaithful-quote", quote });
  }
  return problems;
}
