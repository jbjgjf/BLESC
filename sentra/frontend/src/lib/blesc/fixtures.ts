import { TODAY, addDays } from "./labels";
import type {
  ClassBreakdown,
  DiaryEntry,
  FollowUpItem,
  GuardianView,
  MeetingRecord,
  MeetingSupport,
  SchoolStats,
  StudentDetail,
  StudentSummary,
  SubmissionAlert,
  SubmissionStats,
  SupportAction,
  SuggestedAction,
  TimelineItem,
} from "./types";

/**
 * デモ用の固定データ。企画書の各機能を一通り確認できる分量を持たせている。
 * 実在の生徒データではない。バックエンド接続後は data.ts 側で差し替える。
 */

/* ── 生徒側 ─────────────────────────────────────────────────── */

export const CURRENT_STUDENT = {
  name: "田中 悠真",
  grade: "2年",
  className: "A組",
};

export const MY_ENTRIES: DiaryEntry[] = [
  {
    id: "e-0806",
    date: addDays(TODAY, -1),
    mood: "good",
    categories: ["club", "study"],
    body: "部活の練習試合で、久しぶりにスタメンで出られた。数学の小テストも返ってきて、思ったより点が良かった。先輩が「今日の動き良かった」と声をかけてくれたのが嬉しかった。来週の実力テストの範囲がまだ全然終わっていないのは気になる。疲れたけど、今日はいい一日だった気がする。",
    submittedAt: `${addDays(TODAY, -1)}T21:14:00`,
  },
  {
    id: "e-0805",
    date: addDays(TODAY, -2),
    mood: "neutral",
    categories: ["study"],
    body: "授業が6時間あって、あまり印象に残ることがなかった。放課後は図書室で課題をやったけど、終わる気がしない。",
    submittedAt: `${addDays(TODAY, -2)}T22:02:00`,
  },
  {
    id: "e-0804",
    date: addDays(TODAY, -3),
    mood: "low",
    categories: ["friends", "health"],
    body: "昼休みにグループで話していたとき、自分だけ話題についていけなかった。みんなが盛り上がっているのを見て、少し距離を感じた。夜もあまり眠れなくて、最近寝つきが悪い。考えすぎかもしれない。",
    submittedAt: `${addDays(TODAY, -3)}T23:41:00`,
    followUp: {
      summary: "友人関係で疎外感を感じた出来事について確認。今日だけの出来事とのこと。睡眠についても言及あり。",
      turns: [
        { role: "ai", text: "特に気になった出来事はありましたか。" },
        { role: "student", text: "友人関係" },
        { role: "ai", text: "友人関係で、どのようなことがありましたか。話せる範囲で記録してください。" },
        { role: "student", text: "グループで話している時に、自分だけ話に入れなかった気がした" },
        { role: "ai", text: "そのように感じる出来事は今日だけでしたか。それとも最近も続いていますか。" },
        { role: "student", text: "今日だけ" },
      ],
    },
  },
  {
    id: "e-0803",
    date: addDays(TODAY, -4),
    mood: "good",
    categories: ["club"],
    body: "部活のあと、友達とコンビニに寄って帰った。何でもない時間だけど楽しかった。",
    submittedAt: `${addDays(TODAY, -4)}T20:30:00`,
  },
  {
    id: "e-0802",
    date: addDays(TODAY, -5),
    mood: "very_good",
    categories: ["family", "club"],
    body: "家族で出かけた。部活は休みだったので、久しぶりにゆっくりできた。また行きたい。",
    submittedAt: `${addDays(TODAY, -5)}T19:12:00`,
  },
  {
    id: "e-0801",
    date: addDays(TODAY, -6),
    mood: "neutral",
    categories: ["study", "future"],
    body: "進路希望調査の紙が配られた。まだ何も決まっていないなと思った。文理選択をどうするか迷っている。",
    submittedAt: `${addDays(TODAY, -6)}T21:50:00`,
  },
];

export const MY_STATS: SubmissionStats = {
  streak: 6,
  weekCount: 5,
  monthRate: 0.86,
  lastSubmitted: addDays(TODAY, -1),
  submittedDays: [1, 2, 3, 4, 5, 6].map((d) => addDays(TODAY, -d)),
};

/* ── 教員側：2年A組 ─────────────────────────────────────────── */

/** 2年A組の学級名簿（33名）。生徒側ペルソナの田中 悠真は含めない。 */
const ROSTER_NAMES = [
  "青木 結衣", "石川 大和", "井上 陽向", "上田 芽依", "遠藤 蓮",
  "大西 咲希", "岡本 悠斗", "小野 陽菜", "加藤 心春", "木村 湊",
  "工藤 莉子", "小林 颯太", "斎藤 澪", "坂本 千尋", "佐々木 岳",
  "清水 結菜", "杉山 大翔", "鈴木 海斗", "髙橋 芽衣", "田村 美咲",
  "中島 陸", "中村 花音", "西田 翔", "野口 涼",   "長谷川 蒼",
  "林 彩葉",   "原田 健太", "藤井 奏太", "松本 玲奈", "村上 蓮司",
  "森 陽太",   "山口 詩織", "吉田 桜",
];

const BAND_PLAN: Array<StudentSummary["band"]> = [
  "calm", "calm", "watch", "calm", "calm",
  "calm", "calm", "alert", "calm", "calm",
  "watch", "calm", "calm", "alert", "calm",
  "calm", "calm", "calm", "watch", "calm",
  "calm", "calm", "watch", "calm", "calm",
  "calm", "calm", "calm", "calm", "calm",
  "calm", "calm", "calm",
];

const THEME_PLAN: StudentSummary["topThemes"][] = [
  ["academic"], ["relationships"], ["academic", "sleep"], [], ["academic"],
  [], ["relationships"], ["relationships", "sleep", "self_worth"], [], ["academic"],
  ["family", "sleep"], [], [], ["academic", "self_worth", "mood_swing"], [],
  [], ["academic"], [], ["sleep", "missing"], [],
  [], ["relationships"], ["academic", "usage_drop"], [], [],
  ["academic"], [], [], ["relationships"], [],
  [], ["academic"], [],
];

/**
 * 未提出日数。未提出アラート（SUBMISSION_ALERTS）はこの値から導出するので、
 * 一覧とアラートで日数が食い違うことはない。
 */
const MISSED_PLAN: Record<number, number> = {
  2: 3,   // 井上 陽向 — 3日以上未提出
  10: 2,  // 工藤 莉子 — 連続提出が中断
  18: 7,  // 髙橋 芽衣 — 1週間未利用
  22: 5,  // 西田 翔   — 提出頻度が低下
};

function makeStudent(index: number): StudentSummary {
  const name = ROSTER_NAMES[index];
  const band = BAND_PLAN[index] ?? "calm";
  const themes = THEME_PLAN[index] ?? [];
  const missed = MISSED_PLAN[index] ?? 0;
  return {
    id: `s-${String(index + 1).padStart(2, "0")}`,
    name,
    grade: "2年",
    className: "A組",
    band,
    trend: band === "alert" ? "rising" : band === "watch" ? (index % 2 ? "rising" : "flat") : "flat",
    lastEntry: missed > 0 ? addDays(TODAY, -missed) : addDays(TODAY, -1),
    missedDays: missed,
    hasFollowUp: band !== "calm" || index % 7 === 0,
    status:
      band === "alert"
        ? index % 2 === 0
          ? "meeting_done"
          : "meeting_scheduled"
        : band === "watch"
          ? "watching"
          : "none",
    teacher: "山本 直樹",
    topThemes: themes,
  };
}

export const CLASS_ROSTER: StudentSummary[] = ROSTER_NAMES.map((_, index) => makeStudent(index));

/** 企画書 6-6 / 7-4 の例に対応する重点生徒 */
const FOCUS_ID = "s-08";

const focusIndex = CLASS_ROSTER.findIndex((student) => student.id === FOCUS_ID);
if (focusIndex >= 0) {
  CLASS_ROSTER[focusIndex] = {
    ...CLASS_ROSTER[focusIndex],
    name: "小野 陽菜",
    band: "alert",
    trend: "falling",
    status: "sharing",
    missedDays: 0,
    lastEntry: addDays(TODAY, -1),
    hasFollowUp: true,
    topThemes: ["relationships", "sleep", "self_worth"],
    urgent: {
      detectedAt: `${addDays(TODAY, -13)}T22:14:00`,
      detail: "自己否定的な表現が短期間に増加し、強い無力感を示す記述が含まれていた。",
      surface: "diary",
      reasons: [
        "「自分なんて」を含む記述が3日間で4回",
        "睡眠に関する記述が7日連続",
        "感情選択が「つらい」で5日継続",
      ],
    },
  };
}

const FOCUS_TIMELINE: TimelineItem[] = [
  { date: "2026-07-12", text: "友人関係に関するネガティブな記述が初めて出現", direction: "worse", source: "diary" },
  { date: "2026-07-18", text: "睡眠不足に関する発言が増加", direction: "worse", source: "followup" },
  { date: "2026-07-25", text: "自己否定的な表現が急増し、リスクが上昇", direction: "worse", source: "diary" },
  { date: "2026-07-29", text: "部活動について前向きな記述が増え、リスクがやや改善", direction: "better", source: "diary" },
  { date: "2026-08-04", text: "感情の選択が「ふつう」に戻る日が増加", direction: "better", source: "diary" },
];

const FOCUS_ACTIONS: SupportAction[] = [
  { id: "a1", date: "2026-07-25", kind: "ai_detect", text: "AIが高リスク傾向を検知", actor: "blesc" },
  { id: "a2", date: "2026-07-26", kind: "meeting", text: "担任が面談を実施", actor: "山本 直樹" },
  { id: "a3", date: "2026-07-27", kind: "guardian", text: "保護者へ連絡", actor: "山本 直樹" },
  { id: "a4", date: "2026-08-02", kind: "counselor", text: "スクールカウンセラーが面談を実施", actor: "西村 かおり" },
  { id: "a5", date: "2026-08-06", kind: "improvement", text: "日記内容と感情に改善傾向を確認", actor: "blesc" },
];

const FOCUS_MEETINGS: MeetingRecord[] = [
  {
    id: "m1",
    studentId: FOCUS_ID,
    studentName: "小野 陽菜",
    heldAt: "2026-07-26T15:40:00",
    notes: "部活の人間関係で、以前より話しかけにくくなったと感じているとのこと。具体的な出来事の指摘は避け、本人の言葉を待つ形で聞いた。",
    impression: "落ち着いて話せていたが、目を合わせる回数が少なかった。話の途中で長い沈黙が数回あった。",
    nextAction: "2026-08-02",
    nextActionNote: "スクールカウンセラー面談を設定。保護者への共有は本人の同意を得た。",
    followUpState: "done",
    teacher: "山本 直樹",
  },
  {
    id: "m2",
    studentId: FOCUS_ID,
    studentName: "小野 陽菜",
    heldAt: "2026-08-02T14:00:00",
    notes: "スクールカウンセラーによる面談。睡眠のリズムについて具体的に整理した。部活は続けたい意向。",
    impression: "前回より表情が和らいでいた。自分から話す場面があった。",
    nextAction: addDays(TODAY, 5),
    nextActionNote: "2週間後に経過確認。日記の感情推移を継続的に確認する。",
    followUpState: "open",
    teacher: "西村 かおり",
  },
];

const FOCUS_SUGGESTIONS: SuggestedAction[] = [
  {
    theme: "relationships",
    actions: [
      "クラスでの様子を確認",
      "グループ活動時の観察",
      "担任による声掛け",
      "スクールカウンセラーへの相談",
    ],
  },
  {
    theme: "sleep",
    actions: [
      "保健室で生活習慣を確認",
      "体調や睡眠についての面談",
      "家庭との情報共有",
      "継続的な経過観察",
    ],
  },
];

const FOCUS_ENTRIES: DiaryEntry[] = [
  {
    id: "f-1",
    date: addDays(TODAY, -1),
    mood: "neutral",
    categories: ["club"],
    body: "部活で新しいパートを任された。少し緊張したけど、やってみたいと思った。うまくできるか不安。",
    submittedAt: `${addDays(TODAY, -1)}T20:44:00`,
  },
  {
    id: "f-2",
    date: addDays(TODAY, -3),
    mood: "low",
    categories: ["health", "friends"],
    body: "夜眠れなくて、朝起きるのがつらかった。授業中もぼーっとしてしまった。生活のリズムが戻らない。",
    submittedAt: `${addDays(TODAY, -3)}T23:58:00`,
    followUp: {
      summary: "睡眠について確認。就寝時刻が遅くなる状態が2週間ほど続いているとの回答。友人関係の話題は「今は話したくない」を選択。",
      turns: [
        { role: "ai", text: "眠れない日は最近も続いていますか。" },
        { role: "student", text: "2週間くらい続いてる" },
        { role: "ai", text: "眠れないとき、頭に浮かんでいることはありますか。話せる範囲で大丈夫です。" },
        { role: "student", text: "今は話したくない" },
      ],
    },
  },
];

export const FOCUS_DETAIL: StudentDetail = {
  ...(CLASS_ROSTER[focusIndex] as StudentSummary),
  moodSeries: [
    { date: "2026-07-10", mood: "good" },
    { date: "2026-07-12", mood: "neutral" },
    { date: "2026-07-15", mood: "low" },
    { date: "2026-07-18", mood: "low" },
    { date: "2026-07-21", mood: "hard" },
    { date: "2026-07-24", mood: "hard" },
    { date: "2026-07-25", mood: "hard" },
    { date: "2026-07-27", mood: "low" },
    { date: "2026-07-29", mood: "low" },
    { date: "2026-08-01", mood: "neutral" },
    { date: "2026-08-03", mood: "neutral" },
    { date: addDays(TODAY, -3), mood: "low" },
    { date: addDays(TODAY, -1), mood: "neutral" },
  ],
  categoryCounts: [
    { category: "friends", count: 11 },
    { category: "health", count: 9 },
    { category: "club", count: 7 },
    { category: "study", count: 4 },
    { category: "family", count: 2 },
    { category: "future", count: 1 },
    { category: "other", count: 0 },
  ],
  timeline: FOCUS_TIMELINE,
  meetings: FOCUS_MEETINGS,
  actions: FOCUS_ACTIONS,
  suggestions: FOCUS_SUGGESTIONS,
  recentEntries: FOCUS_ENTRIES,
  followUpSummaries: [
    { date: addDays(TODAY, -3), summary: "睡眠について確認。就寝が遅い状態が2週間ほど継続との回答。友人関係の話題は回答を保留。" },
    { date: "2026-07-25", summary: "自己否定的な記述の背景を確認。「うまくいかないことが続いている」との回答。具体的な出来事の特定には至らず。" },
    { date: "2026-07-18", summary: "睡眠に関する記述について確認。就寝時刻が遅くなっているとの回答。" },
    { date: "2026-07-12", summary: "友人関係の記述について確認。グループ内での会話に入りにくさを感じているとの回答。" },
  ],
};

/**
 * 生徒詳細の取得。重点生徒は作り込んだデータを返し、それ以外は一覧の
 * 情報から妥当な詳細を組み立てる。バックエンド接続時はこの関数が
 * API 呼び出しに置き換わる。
 */
export function getStudentDetail(id: string): StudentDetail | null {
  if (id === FOCUS_ID) return FOCUS_DETAIL;

  const student = CLASS_ROSTER.find((row) => row.id === id);
  if (!student) return null;

  const moodByBand: Record<StudentSummary["band"], Array<StudentDetail["moodSeries"][number]["mood"]>> = {
    alert: ["neutral", "low", "low", "hard", "hard", "low", "low"],
    watch: ["good", "neutral", "neutral", "low", "neutral", "low", "neutral"],
    calm:  ["good", "good", "neutral", "good", "very_good", "good", "neutral"],
  };

  const moods = moodByBand[student.band];
  const moodSeries = moods.map((mood, index) => ({
    date: addDays(TODAY, -(moods.length - index) * 2),
    mood,
  }));

  const categoryCounts = CATEGORY_ORDER.map((category, index) => ({
    category,
    count: Math.max(0, 6 - index - (student.band === "calm" ? 2 : 0)),
  }));

  return {
    ...student,
    moodSeries,
    categoryCounts,
    timeline: student.topThemes.map((theme, index) => ({
      date: addDays(TODAY, -(student.topThemes.length - index) * 6),
      text: `${THEME_TEXT[theme]}に関する記述が確認されています`,
      direction: index === student.topThemes.length - 1 ? "neutral" : "worse",
      source: "diary" as const,
    })),
    meetings: ALL_MEETINGS.filter((meeting) => meeting.studentId === id),
    actions: [],
    suggestions: student.topThemes
      .map((theme) => SUGGESTION_LIBRARY[theme])
      .filter((entry): entry is SuggestedAction => Boolean(entry)),
    recentEntries: [],
    followUpSummaries: student.hasFollowUp
      ? [{ date: addDays(TODAY, -4), summary: "日記の記述について確認。話せる範囲での回答が得られています。" }]
      : [],
  };
}

const CATEGORY_ORDER = ["study", "friends", "club", "health", "family", "future", "other"] as const;

const THEME_TEXT: Record<string, string> = {
  academic: "学業",
  relationships: "友人関係",
  family: "家庭",
  sleep: "睡眠",
  self_worth: "自己否定的な表現",
  mood_swing: "感情の変化",
  missing: "日記の未提出",
  usage_drop: "利用頻度の低下",
};

/** 7-3 支援アクション提案のひな型 */
const SUGGESTION_LIBRARY: Partial<Record<string, SuggestedAction>> = {
  academic: {
    theme: "academic",
    actions: [
      "宿題量や課題の負担について確認",
      "担任との面談",
      "学習支援の紹介",
      "学習計画や進路不安についての相談",
    ],
  },
  relationships: {
    theme: "relationships",
    actions: [
      "クラスでの様子を確認",
      "グループ活動時の観察",
      "担任による声掛け",
      "スクールカウンセラーへの相談",
    ],
  },
  sleep: {
    theme: "sleep",
    actions: [
      "保健室で生活習慣を確認",
      "体調や睡眠についての面談",
      "家庭との情報共有",
      "継続的な経過観察",
    ],
  },
  family: {
    theme: "family",
    actions: ["家庭の状況について慎重に確認", "スクールソーシャルワーカーへの相談", "継続的な経過観察"],
  },
  self_worth: {
    theme: "self_worth",
    actions: ["担任による面談", "スクールカウンセラーへの相談", "保護者との情報共有", "継続的な経過観察"],
  },
  mood_swing: {
    theme: "mood_swing",
    actions: ["日々の様子を継続的に確認", "担任による声掛け", "スクールカウンセラーへの相談"],
  },
  missing: {
    theme: "missing",
    actions: ["自然な形での声掛け", "登校状況の確認", "家庭への状況確認"],
  },
  usage_drop: {
    theme: "usage_drop",
    actions: ["利用状況の確認", "本人への声掛け", "継続的な経過観察"],
  },
};

/* ── 6-2 クラス全体分析 ─────────────────────────────────────── */

export const CLASS_BREAKDOWN: ClassBreakdown[] = [
  { theme: "academic",      share: 0.42, delta: +0.05 },
  { theme: "relationships", share: 0.30, delta: -0.02 },
  { theme: "sleep",         share: 0.16, delta: +0.04 },
  { theme: "family",        share: 0.12, delta: -0.01 },
];

/* ── 6-5 未提出アラート ─────────────────────────────────────── */

const ALERT_KINDS: Record<number, { kind: SubmissionAlert["kind"]; detail: string }> = {
  2:  { kind: "missing_3d",     detail: "3日以上日記が提出されていません。" },
  10: { kind: "streak_broken",  detail: "21日続いていた連続提出が中断しました。" },
  18: { kind: "unused_1w",      detail: "1週間アプリが利用されていません。" },
  22: { kind: "rate_drop",      detail: "提出頻度が先週比で 60% 低下しています。" },
};

/** 一覧の missedDays から導出する。日数が二重管理にならないようにしている。 */
export const SUBMISSION_ALERTS: SubmissionAlert[] = Object.entries(ALERT_KINDS)
  .map(([rosterIndex, meta]) => {
    const student = CLASS_ROSTER[Number(rosterIndex)];
    return {
      studentId: student.id,
      studentName: student.name,
      className: `${student.grade}${student.className}`,
      kind: meta.kind,
      detail: meta.detail,
      since: addDays(TODAY, -student.missedDays),
    };
  })
  .sort((a, b) => a.since.localeCompare(b.since));

/* ── 7-2 フォローアップ管理 ─────────────────────────────────── */

export const FOLLOW_UPS: FollowUpItem[] = [
  {
    studentId: FOCUS_ID,
    studentName: "小野 陽菜",
    className: "2年A組",
    lastMeeting: "2026-08-02",
    daysSince: 5,
    nextMeeting: addDays(TODAY, 5),
    state: "improving",
    note: "今週は前回より感情が改善しています。",
  },
  {
    studentId: "s-14",
    studentName: ROSTER_NAMES[13],
    className: "2年A組",
    lastMeeting: "2026-07-20",
    daysSince: 18,
    nextMeeting: null,
    state: "worsening",
    note: "改善が見られません。追加面談を推奨します。",
  },
  {
    studentId: "s-03",
    studentName: ROSTER_NAMES[2],
    className: "2年A組",
    lastMeeting: "2026-07-29",
    daysSince: 9,
    nextMeeting: addDays(TODAY, 2),
    state: "unchanged",
    note: "大きな変化はありません。予定どおり経過を確認してください。",
  },
];

export const ALL_MEETINGS: MeetingRecord[] = [
  ...FOCUS_MEETINGS,
  {
    id: "m3",
    studentId: "s-14",
    studentName: ROSTER_NAMES[13],
    heldAt: "2026-07-20T16:10:00",
    notes: "学業の負担について。課題量が多く、家庭学習の時間が確保できていないとのこと。",
    impression: "疲れた様子だが、受け答えははっきりしていた。",
    nextAction: null,
    nextActionNote: "",
    followUpState: "overdue",
    teacher: "山本 直樹",
  },
  {
    id: "m4",
    studentId: "s-03",
    studentName: ROSTER_NAMES[2],
    heldAt: "2026-07-29T15:00:00",
    notes: "睡眠と学業の両方について確認。就寝が遅い理由は動画視聴とのこと。",
    impression: "落ち着いていた。改善の意欲あり。",
    nextAction: addDays(TODAY, 2),
    nextActionNote: "2週間後に生活リズムの変化を確認。",
    followUpState: "open",
    teacher: "山本 直樹",
  },
];

/* ── 追加機能 ───────────────────────────────────────────────── */

export const GUARDIAN_VIEW: GuardianView = {
  studentName: "田中 悠真",
  className: "2年A組",
  stats: MY_STATS,
  sharedMoodSeries: [
    { date: addDays(TODAY, -6), mood: "neutral" },
    { date: addDays(TODAY, -5), mood: "very_good" },
    { date: addDays(TODAY, -4), mood: "good" },
    { date: addDays(TODAY, -3), mood: "low" },
    { date: addDays(TODAY, -2), mood: "neutral" },
    { date: addDays(TODAY, -1), mood: "good" },
  ],
  notices: [
    {
      date: addDays(TODAY, -4),
      text: "8月の三者面談の日程調整を開始しました。担任までご希望をお知らせください。",
      from: "2年A組 担任",
    },
    {
      date: addDays(TODAY, -12),
      text: "夏季休業中の生活リズムについて、保健だよりを配布しました。",
      from: "保健室",
    },
  ],
  scopeNote:
    "学校の運用方針により、保護者の方には日記の提出状況と、お子さま本人が共有に同意した範囲の情報のみを表示しています。日記の本文、AIとの対話内容、AIの分析結果は表示されません。",
};

export const SCHOOL_STATS: SchoolStats = {
  scope: "広尾学園中学校・高等学校",
  studentCount: 1284,
  submissionRate: 0.78,
  breakdown: [
    { theme: "academic",      share: 0.38, delta: +0.03 },
    { theme: "relationships", share: 0.26, delta: -0.01 },
    { theme: "sleep",         share: 0.19, delta: +0.06 },
    { theme: "family",        share: 0.10, delta: 0 },
    { theme: "self_worth",    share: 0.07, delta: +0.01 },
  ],
  byGrade: [
    { grade: "中学1年", studentCount: 208, submissionRate: 0.86, top: "relationships" },
    { grade: "中学2年", studentCount: 213, submissionRate: 0.81, top: "relationships" },
    { grade: "中学3年", studentCount: 205, submissionRate: 0.79, top: "academic" },
    { grade: "高校1年", studentCount: 224, submissionRate: 0.77, top: "academic" },
    { grade: "高校2年", studentCount: 219, submissionRate: 0.74, top: "academic" },
    { grade: "高校3年", studentCount: 215, submissionRate: 0.69, top: "academic" },
  ],
  trendWeeks: [
    { label: "6週前", academic: 0.31, relationships: 0.28, health: 0.12 },
    { label: "5週前", academic: 0.33, relationships: 0.27, health: 0.13 },
    { label: "4週前", academic: 0.34, relationships: 0.29, health: 0.15 },
    { label: "3週前", academic: 0.36, relationships: 0.27, health: 0.16 },
    { label: "2週前", academic: 0.35, relationships: 0.26, health: 0.18 },
    { label: "先週",   academic: 0.38, relationships: 0.26, health: 0.19 },
  ],
  minCellSize: 10,
};

export const MEETING_SUPPORT: MeetingSupport = {
  studentId: FOCUS_ID,
  studentName: "小野 陽菜",
  questions: [
    {
      text: "最近、学校で過ごしていて一番ほっとする時間はどんなときですか。",
      rationale: "保護要因を先に確認することで、話しやすい入口をつくる。",
    },
    {
      text: "部活動で新しいパートを任されたと記録がありました。いまはどんな感じですか。",
      rationale: "前向きな変化として記録されている話題。本人の言葉で確認する。",
    },
    {
      text: "夜、眠れないことが続いていると記録がありました。いまはどうですか。",
      rationale: "7月18日以降、睡眠に関する記述が継続している。",
    },
    {
      text: "困ったときに話せる人は、学校の中と外にそれぞれいますか。",
      rationale: "相談先の有無を確認し、次の支援先につなげる判断材料にする。",
    },
  ],
  context: [
    "7月12日以降、友人関係に関する記述が継続して出現している。",
    "7月25日に自己否定的な表現が増加。8月に入ってからは減少傾向。",
    "8月2日のスクールカウンセラー面談以降、感情の選択が「ふつう」に戻る日が増えている。",
    "対話型AIでは、友人関係の話題について「今は話したくない」を選択している。",
  ],
  cautions: [
    "友人関係の具体的な出来事は、本人が話題を避けている。こちらから詳細を求めない。",
    "日記やAIとの対話の内容を読んだことを前提にした聞き方は避ける。",
    "AIの分析は診断ではない。面談での確認を経ずに判断しない。",
  ],
};
