/**
 * blesc ドメインモデル — 企画書に対応する型定義。
 *
 * バックエンドはまだこれらのエンドポイントを持たないため、いまは
 * src/lib/blesc/fixtures.ts が唯一の実装元になっている。API が入ったら
 * この境界（src/lib/blesc/data.ts）だけを差し替えれば画面は変更不要。
 */

/* ── 生徒側 ─────────────────────────────────────────────────── */

/** 4-2 感情の必須入力 */
export type Mood = "very_good" | "good" | "neutral" | "low" | "hard";

/** 4-3 出来事の必須入力 */
export type EventCategory =
  | "study"
  | "friends"
  | "club"
  | "family"
  | "future"
  | "health"
  | "other";

/** 4-1 日記の入力項目 */
export interface DiaryEntry {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  mood: Mood;
  categories: EventCategory[];
  /**
   * 日記の本文。出来事・印象に残ったこと・悩み・自由記述をひとつにまとめた
   * 自由記述欄。項目を分けると入力の負担が大きくなるため、1つにしている
   * （企画書 10-1「入力の心理的負担を最小限に抑える」）。
   */
  body: string;
  submittedAt: string;
  /** 4-6 対話型AIが補足した場合のみ */
  followUp?: DiaryFollowUp;
}

/** 4-6 対話型AIサポートの記録 */
export interface DiaryFollowUp {
  turns: Array<{ role: "ai" | "student"; text: string }>;
  /** 教員向けに表示する要約（会話全文は見せない — 5-3） */
  summary: string;
}

/** 4-4 日記提出状況・連続記録 */
export interface SubmissionStats {
  /** 連続提出日数 */
  streak: number;
  /** 今週の日記提出回数 */
  weekCount: number;
  /** 今月の日記提出率 0–1 */
  monthRate: number;
  /** 最終提出日 YYYY-MM-DD */
  lastSubmitted: string | null;
  /** 今月の提出日（カレンダー表示用） */
  submittedDays: string[];
}

/* ── 追加機能 ───────────────────────────────────────────────── */

/** 保護者向けダッシュボード */
export interface GuardianView {
  studentName: string;
  className: string;
  stats: SubmissionStats;
  /** 学校の運用方針で共有が許可された範囲のみ */
  sharedMoodSeries: Array<{ date: string; mood: Mood }>;
  /** 学校からのお知らせ */
  notices: Array<{ date: string; text: string; from: string }>;
  /** 保護者に開示される範囲の説明 */
  scopeNote: string;
}
