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

/* ── 教員側 ─────────────────────────────────────────────────── */

/** 5-1 生徒の状態。緑 安定 / 黄 要注意 / 赤 高リスク */
export type RiskBand = "calm" | "watch" | "alert";

/** リスク傾向 */
export type Trend = "rising" | "falling" | "flat";

/** 対応ステータス */
export type SupportStatus =
  | "none"
  | "watching"
  | "meeting_scheduled"
  | "meeting_done"
  | "sharing"
  | "resolved";

/** 5-1 生徒一覧の1行 */
export interface StudentSummary {
  id: string;
  name: string;
  /** 例: 2年A組 */
  grade: string;
  className: string;
  band: RiskBand;
  trend: Trend;
  /** 最終日記提出日 YYYY-MM-DD */
  lastEntry: string | null;
  /** 未提出日数 */
  missedDays: number;
  /** 対話型AIによる補足の有無 */
  hasFollowUp: boolean;
  status: SupportStatus;
  /** 担当教員 */
  teacher: string;
  /** 5-2 主な分析観点 */
  topThemes: AnalysisTheme[];
  /** 7-5 緊急性が高い可能性のある内容 */
  urgent?: UrgentFlag;
}

/** 5-2 AIによる日記分析の観点 */
export type AnalysisTheme =
  | "academic"
  | "relationships"
  | "family"
  | "sleep"
  | "self_worth"
  | "mood_swing"
  | "missing"
  | "usage_drop";

/** 6-6 AIタイムラインの1項目 */
export interface TimelineItem {
  /** YYYY-MM-DD */
  date: string;
  text: string;
  /** その時点のリスク方向 */
  direction: "worse" | "better" | "neutral";
  /** 根拠となった日記／対話の出典 */
  source: "diary" | "followup" | "submission";
}

/** 6-3 面談記録 */
export interface MeetingRecord {
  id: string;
  studentId: string;
  studentName: string;
  /** ISO datetime */
  heldAt: string;
  /** 面談メモ */
  notes: string;
  /** 生徒の様子 */
  impression: string;
  /** 次回対応予定 YYYY-MM-DD */
  nextAction: string | null;
  nextActionNote: string;
  /** フォロー状況 */
  followUpState: "open" | "done" | "overdue";
  teacher: string;
}

/** 7-4 対応履歴タイムライン */
export interface SupportAction {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  kind: "ai_detect" | "meeting" | "guardian" | "counselor" | "observation" | "improvement";
  text: string;
  actor: string;
}

/** 7-3 支援アクション提案 */
export interface SuggestedAction {
  theme: AnalysisTheme;
  actions: string[];
}

/** 7-5 緊急性が高い可能性のある内容 */
export interface UrgentFlag {
  /** ISO datetime */
  detectedAt: string;
  /** 検知された具体的な記述の要約 */
  detail: string;
  /** どこで検知されたか */
  surface: "diary" | "followup";
  /** 根拠 — 何にマッチしたか */
  reasons: string[];
}

/** 6-2 クラス全体分析 */
export interface ClassBreakdown {
  theme: AnalysisTheme;
  /** 0–1 */
  share: number;
  /** 前週との差 */
  delta: number;
}

/** 6-5 未提出アラート */
export interface SubmissionAlert {
  studentId: string;
  studentName: string;
  className: string;
  kind: "missing_3d" | "unused_1w" | "streak_broken" | "rate_drop";
  detail: string;
  /** YYYY-MM-DD */
  since: string;
}

/** 7-2 フォローアップ管理 */
export interface FollowUpItem {
  studentId: string;
  studentName: string;
  className: string;
  /** 前回面談日 YYYY-MM-DD */
  lastMeeting: string;
  /** 経過日数 */
  daysSince: number;
  /** 次回面談日 YYYY-MM-DD */
  nextMeeting: string | null;
  state: "improving" | "unchanged" | "worsening";
  /** AIの所見 */
  note: string;
}

/* ── 生徒詳細 ───────────────────────────────────────────────── */

export interface StudentDetail extends StudentSummary {
  /** 感情の推移（古い順） */
  moodSeries: Array<{ date: string; mood: Mood }>;
  /** 出来事カテゴリの傾向 */
  categoryCounts: Array<{ category: EventCategory; count: number }>;
  timeline: TimelineItem[];
  meetings: MeetingRecord[];
  actions: SupportAction[];
  suggestions: SuggestedAction[];
  recentEntries: DiaryEntry[];
  /** 対話型AIによる補足内容の要約 */
  followUpSummaries: Array<{ date: string; summary: string }>;
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

/** 学校全体・学年全体の統計分析（個人非特定） */
export interface SchoolStats {
  scope: string;
  studentCount: number;
  submissionRate: number;
  breakdown: ClassBreakdown[];
  /** 学年ごとの傾向 */
  byGrade: Array<{ grade: string; studentCount: number; submissionRate: number; top: AnalysisTheme }>;
  /** 週ごとの推移 */
  trendWeeks: Array<{ label: string; academic: number; relationships: number; health: number }>;
  /** k-匿名性のしきい値 */
  minCellSize: number;
}

/** AIによる面談サポート */
export interface MeetingSupport {
  studentId: string;
  studentName: string;
  /** 面談時に確認したい質問案 */
  questions: Array<{ text: string; rationale: string }>;
  /** 面談前に押さえておきたい背景 */
  context: string[];
  /** 触れ方に注意したい点 */
  cautions: string[];
}
