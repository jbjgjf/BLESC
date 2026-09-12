import type {
  AnalysisTheme,
  EventCategory,
  Mood,
  SupportStatus,
} from "./types";
import type { IconName } from "@/components/ui/Icon";

/**
 * 表示ラベル・アイコン・色の一元定義。
 * 生徒側の感情スケールは意図的に赤を避けている — 企画書 10-1 の
 * 「生徒を評価・監視する印象を与えない」「安心感のある色」に従う。
 */

export const MOODS: Array<{
  value: Mood;
  label: string;
  icon: IconName;
  color: string;
  tint: string;
}> = [
  { value: "very_good", label: "とても良い", icon: "sentiment_very_satisfied",    color: "hsl(168 52% 42%)", tint: "hsl(168 50% 95%)" },
  { value: "good",      label: "良い",       icon: "sentiment_satisfied",         color: "hsl(190 58% 45%)", tint: "hsl(190 60% 95%)" },
  { value: "neutral",   label: "ふつう",     icon: "sentiment_neutral",           color: "hsl(206 62% 58%)", tint: "hsl(206 70% 95.5%)" },
  { value: "low",       label: "少しつらい", icon: "sentiment_dissatisfied",      color: "hsl(255 40% 60%)", tint: "hsl(255 55% 96%)" },
  { value: "hard",      label: "つらい",     icon: "sentiment_very_dissatisfied", color: "hsl(340 44% 58%)", tint: "hsl(340 60% 96%)" },
];

export const MOOD_BY_VALUE = Object.fromEntries(MOODS.map((m) => [m.value, m])) as Record<
  Mood,
  (typeof MOODS)[number]
>;

/** つらい側ほど大きい。感情の推移グラフの縦軸に使う。 */
export const MOOD_SCORE: Record<Mood, number> = {
  very_good: 0,
  good: 1,
  neutral: 2,
  low: 3,
  hard: 4,
};

export const CATEGORIES: Array<{ value: EventCategory; label: string; icon: IconName }> = [
  { value: "study",   label: "授業・勉強", icon: "school" },
  { value: "friends", label: "友人関係",   icon: "group" },
  { value: "club",    label: "部活動",     icon: "sports_basketball" },
  { value: "family",  label: "家庭",       icon: "house" },
  { value: "future",  label: "進路",       icon: "signpost" },
  { value: "health",  label: "健康・睡眠", icon: "bedtime" },
  { value: "other",   label: "その他",     icon: "more_horiz" },
];

export const CATEGORY_BY_VALUE = Object.fromEntries(
  CATEGORIES.map((c) => [c.value, c]),
) as Record<EventCategory, (typeof CATEGORIES)[number]>;

export const THEMES: Record<AnalysisTheme, { label: string; icon: IconName }> = {
  academic:      { label: "学業ストレス",       icon: "school" },
  relationships: { label: "人間関係",           icon: "group" },
  family:        { label: "家庭環境",           icon: "house" },
  sleep:         { label: "睡眠不足",           icon: "bedtime" },
  self_worth:    { label: "自己否定的な表現",   icon: "psychology_alt" },
  mood_swing:    { label: "感情の急激な変化",   icon: "monitoring" },
  missing:       { label: "日記未提出",         icon: "event_busy" },
  usage_drop:    { label: "利用頻度の低下",     icon: "trending_down" },
};

/*
 * 生徒ごとの三段階の色分けと、時間方向の傾向判定は、ここにあった（#175 で削除）。
 *
 * 消したのはモデルの精度が足りないからではない。有病率5%・感度80%／特異度90%
 * なら陽性的中率は約30%で、そう表示された生徒の7割が非該当になる。モデルを
 * 改善してもこの構造は変わらないので、精度が上がったときに戻せる種類のもの
 * ではない。`docs/educator_display_policy.md` 規則1。
 *
 * 定数を残さないのは、対応表があると1行で引けてしまうからである。型と色
 * トークンが揃って残っていると、次の画面で「既にあるもの」として使われ、
 * ポリシーは2度目の破られ方をする。`tests/educator-display-policy.test.mjs`
 * が語彙を走査して戻りを止める。
 */

export const STATUSES: Record<SupportStatus, { label: string; icon: IconName }> = {
  none:              { label: "未対応",     icon: "more_horiz" },
  watching:          { label: "経過観察",   icon: "visibility" },
  meeting_scheduled: { label: "面談予定",   icon: "event_note" },
  meeting_done:      { label: "面談実施済", icon: "check_circle" },
  sharing:           { label: "連携中",     icon: "support_agent" },
  resolved:          { label: "対応完了",   icon: "check" },
};

/* ── 日付ヘルパー ───────────────────────────────────────────── */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 2026-08-07 → 8月7日（金） */
export function formatDate(iso: string, withWeekday = true): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const base = `${date.getMonth() + 1}月${date.getDate()}日`;
  return withWeekday ? `${base}（${WEEKDAYS[date.getDay()]}）` : base;
}

/** 2026-08-07T14:30 → 8月7日 14:30 */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

/** 経過日数を「3日前」「今日」の形に */
export function relativeDays(iso: string | null, today = TODAY): string {
  if (!iso) return "記録なし";
  const days = daysBetween(iso, today);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  return `${days}日前`;
}

export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from.slice(0, 10)}T00:00:00`).getTime();
  const b = new Date(`${to.slice(0, 10)}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  date.setDate(date.getDate() + days);
  // Format from local parts — toISOString() would shift the day by the UTC offset.
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 曜日の記号。1文字表記。 */
export function weekdayOf(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00`);
  return WEEKDAYS[date.getDay()] ?? "";
}

/** デモデータの基準日。実データ接続時は new Date() に置き換わる。 */
/**
 * 「今日」。デモの日付はすべてここからの相対で組み立てる。
 *
 * 固定日ではなく実行日を読む。固定にすると、デモを見せる日が進むほど
 * 「最終提出：3週間前」「この7日間に記録あり 0」になり、動いていない製品に
 * 見える。学校に見せる画面で最初に目につくのがそこでは意味がない。
 *
 * ハイドレーションの差は出ない。固定データを読む画面はすべてクライアント
 * コンポーネントで、`AuthShell` がハイドレーション前は読み込み中の表示しか
 * 返さないため、サーバー側の HTML にこの日付由来の文字列は入らない。
 */
function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export const TODAY = todayIso();
