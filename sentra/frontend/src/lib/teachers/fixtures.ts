/**
 * Blesc for Teachers のデモ用データ。
 *
 * 生徒33人と教職員12人の、8週間ぶんの自己申告の記録。乱数は名簿の番号を
 * 種にしているので、何度読み込んでも同じ記録になる。
 *
 * 何人かは、「変化あり」のそれぞれの理由が画面で見られるように作ってある
 * （気分の平均・記録した日数・文字数・話題の入れ替わり）。どの理由でも、
 * 画面に出る札は同じ「変化あり」。重さの違いは作らない。
 *
 * 値の import を持たない（node のテストからそのまま読めるように）。
 * 日付の基準 AS_OF は、生徒側の TODAY（lib/blesc/labels.ts）と同じ日にしてあり、
 * テストが両者の一致を確かめている。
 */

import type { EventCategory, Mood } from "@/lib/blesc/types";
import type { ClassStudent, MeetingMemo, SelfRecord, StaffMember, TeacherRecord, TeacherRole, WorkTag } from "./types";

export const AS_OF = "2026-08-07";
const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** 名簿の番号を種にした乱数（mulberry32）。 */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(random: () => number, list: readonly T[]) => list[Math.floor(random() * list.length)];

/* ── 生徒 ─────────────────────────────────────────────────── */

const STUDENT_NAMES = [
  "青木 結衣", "石川 大和", "井上 陽向", "上田 芽依", "遠藤 蓮",
  "大西 咲希", "岡本 悠斗", "小野 陽菜", "加藤 心春", "木村 湊",
  "工藤 莉子", "小林 颯太", "斎藤 澪", "坂本 千尋", "佐々木 岳",
  "清水 結菜", "杉山 大翔", "鈴木 海斗", "髙橋 芽衣", "田村 美咲",
  "中島 陸", "中村 花音", "西田 翔", "野口 涼", "長谷川 蒼",
  "林 彩葉", "原田 健太", "藤井 奏太", "松本 玲奈", "村上 蓮司",
  "森 陽太", "山口 詩織", "吉田 桜",
];

const STUDENT_TEXTS: Record<EventCategory, readonly string[]> = {
  club: [
    "部活で新しいメニューをやった。きつかったけど楽しかった。",
    "試合に向けて練習が増えてきた。",
    "先輩にフォームをほめられた。",
    "部活のあと、足がだるい。",
    "後輩に教える番がまわってきて、うまく説明できなかった。",
  ],
  friends: [
    "昼休みに友だちと話していて、ずっと笑っていた。",
    "友だちと帰り道に寄り道した。",
    "グループの話についていけないときがある。",
    "友だちに相談したら少し楽になった。",
  ],
  study: [
    "数学の小テストがあった。思ったよりできた。",
    "英語の単語を覚えるのが追いつかない。",
    "テストの点が思ったより低くて落ちこんだ。",
    "授業で発表した。緊張したけど言いたいことは言えた。",
  ],
  family: [
    "家で弟とけんかした。",
    "夕飯の手伝いをした。",
    "家に帰っても、なんとなく落ち着かない。",
    "週末は家族で出かけた。",
  ],
  future: ["進路のことを少し考えた。", "オープンキャンパスの案内をもらって、行ってみたい大学ができた。"],
  health: ["あまり眠れなかった。", "朝起きるのがつらかった。", "よく寝られて、すっきりしている。", "少し頭が痛かった。"],
  other: ["特に何もない一日だった。", "雨で外に出られなかった。", "好きな曲を見つけた。"],
};

const SHORT_TEXTS = ["ふつう。", "疲れた。", "特になし。", "眠い。", "まあまあ。"];

const STUDENT_FAVORITES: ReadonlyArray<readonly EventCategory[]> = [
  ["club", "friends", "study"],
  ["study", "friends", "future"],
  ["friends", "club", "other"],
  ["study", "family", "health"],
];

type Plan = {
  /** 1日あたりの記録する確率（前の4週 / 直近4週） */
  rate: [number, number];
  /** 気分の重み（とても良い, 良い, ふつう, 少しつらい, つらい）（前 / 直近） */
  mood: [number[], number[]];
  /** よく選ぶ話題（前 / 直近） */
  topics?: [readonly EventCategory[], readonly EventCategory[]];
  /** 本文を短い言葉だけにする（直近のみ） */
  short?: boolean;
  /** 前の4週は、何文か続けて長めに書いていた */
  long?: boolean;
  /** この日数より前の記録は無い（転入など） */
  startsDaysAgo?: number;
};

const STEADY_MOOD = [2, 5, 4, 1, 0.3];
const STEADY: Plan = { rate: [0.75, 0.72], mood: [STEADY_MOOD, STEADY_MOOD] };

/**
 * 出席番号ごとの作り。書かれていない番号は、ふだんどおり。
 * 4 番は気分、9 番は記録した日数、13 番は文字数、18 番は話題が動く。
 * 27 番は気分が上がる — 上がっても札は同じ「変化あり」になる。
 * 22 番は3週前に転入してきたので、比べる元が無い。
 */
const STUDENT_PLANS: Record<number, Plan> = {
  4: { rate: [0.75, 0.75], mood: [[2, 6, 3, 0.5, 0], [0, 1, 4, 5, 2]] },
  9: { rate: [0.8, 0.22], mood: [STEADY_MOOD, STEADY_MOOD] },
  13: { rate: [0.72, 0.72], mood: [STEADY_MOOD, STEADY_MOOD], short: true, long: true },
  18: { rate: [0.75, 0.75], mood: [STEADY_MOOD, STEADY_MOOD], topics: [["club", "friends", "study"], ["family", "health", "other"]] },
  22: { rate: [0.75, 0.7], mood: [STEADY_MOOD, STEADY_MOOD], startsDaysAgo: 20 },
  27: { rate: [0.7, 0.75], mood: [[0, 1, 4, 4, 1], [3, 6, 2, 0, 0]] },
};

const MOODS_ORDER: Mood[] = ["very_good", "good", "neutral", "low", "hard"];
const weighted = (random: () => number, weights: number[]) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
};

function studentRecords(number: number): Array<SelfRecord<EventCategory>> {
  const random = seeded(number * 7919);
  const plan = STUDENT_PLANS[number] ?? STEADY;
  const favorites = STUDENT_FAVORITES[number % STUDENT_FAVORITES.length];
  const records: Array<SelfRecord<EventCategory>> = [];

  for (let ago = 55; ago >= 0; ago -= 1) {
    if (plan.startsDaysAgo !== undefined && ago > plan.startsDaysAgo) continue;
    const recent = ago < 28;
    const date = daysBefore(ago);
    // 週末は少し書きにくい。
    const rate = plan.rate[recent ? 1 : 0] * (weekday(date) === 0 || weekday(date) === 6 ? 0.7 : 1);
    if (random() > rate) continue;

    const mood = MOODS_ORDER[weighted(random, plan.mood[recent ? 1 : 0])];
    const topics = plan.topics?.[recent ? 1 : 0] ?? favorites;
    const first = topics[weighted(random, [5, 3, 2])];
    const tags: EventCategory[] = random() < 0.25 ? [first, pick(random, topics.filter((t) => t !== first))] : [first];
    const text =
      plan.short && recent
        ? pick(random, SHORT_TEXTS)
        : plan.long && !recent
          ? [first, ...topics.filter((t) => t !== first)].map((t) => pick(random, STUDENT_TEXTS[t])).join("")
          : random() < 0.15
          ? ""
          : `${pick(random, STUDENT_TEXTS[first])}${random() < 0.4 ? pick(random, ["今日はわりと早く寝たい。", "明日もがんばる。", "少しほっとした。", "また明日。"]) : ""}`;
    records.push({ date, mood, text, tags });
  }
  return records;
}

export const CLASS_NAME = "2年A組";

export const CLASS_STUDENTS: ClassStudent[] = STUDENT_NAMES.map((name, index) => ({
  id: `s-${String(index + 1).padStart(2, "0")}`,
  number: index + 1,
  name,
  records: studentRecords(index + 1),
}));

export function getClassStudent(id: string): ClassStudent | null {
  return CLASS_STUDENTS.find((student) => student.id === id) ?? null;
}

/* ── 先生自身の記録（A） ──────────────────────────────────── */

export const WORK_TAGS: ReadonlyArray<{ value: WorkTag; label: string }> = [
  { value: "lesson", label: "授業" },
  { value: "admin", label: "校務" },
  { value: "students", label: "生徒対応" },
  { value: "club", label: "部活動" },
  { value: "parents", label: "保護者対応" },
  { value: "other", label: "その他" },
];

/**
 * 本文が思いつかないときの質問（A-2）。
 * 先生の気分を探る質問ではなく、その日の仕事を思い出すきっかけにする。
 */
export const PROMPTS: ReadonlyArray<{ id: string; text: string }> = [
  { id: "p-time", text: "今日いちばん時間を使った仕事は？" },
  { id: "p-glad", text: "今日うれしかった生徒とのやりとりは？" },
  { id: "p-stuck", text: "今日、少し手が止まった場面は？" },
  { id: "p-next", text: "明日の自分に引き継ぎたいことは？" },
  { id: "p-help", text: "今日、だれかに助けられたことは？" },
  { id: "p-lesson", text: "授業で、生徒の反応が印象に残った場面は？" },
];

export const TEXT_LIMIT = 1000;

const TEACHER_TEXTS: Record<WorkTag, readonly string[]> = {
  lesson: [
    "3限の授業で、生徒の質問から話が広がった。",
    "授業準備が思ったより時間がかかった。",
    "小テストの採点がまだ半分残っている。",
  ],
  admin: ["行事の資料づくりで放課後がほぼ終わった。", "会議が2つ続いた。", "成績処理の締め切りが近い。"],
  students: [
    "放課後に生徒の話を聞いた。",
    "休み時間に声をかけてくれた生徒がいて、うれしかった。",
    "欠席が続いている生徒の家に連絡した。",
  ],
  club: ["大会前で部活の練習が長くなった。", "部活の引率で土曜が終わった。"],
  parents: ["保護者から電話があり、30分ほど話した。", "面談の日程調整のメールを返した。"],
  other: ["研修のレポートを書いた。", "職員室で雑談して、少し気が晴れた。"],
};

type StaffPlan = { rate: [number, number]; mood: [number[], number[]]; tags: readonly WorkTag[]; startsDaysAgo?: number };
const STAFF_STEADY_MOOD = [1, 4, 5, 1.5, 0.3];

function staffRecords(seed: number, plan: StaffPlan): Array<SelfRecord<WorkTag>> {
  const random = seeded(seed * 104729);
  const records: Array<SelfRecord<WorkTag>> = [];
  for (let ago = 55; ago >= 1; ago -= 1) {
    if (plan.startsDaysAgo !== undefined && ago > plan.startsDaysAgo) continue;
    const date = daysBefore(ago);
    if (weekday(date) === 0 || weekday(date) === 6) continue;
    const recent = ago < 28;
    if (random() > plan.rate[recent ? 1 : 0]) continue;
    const mood = MOODS_ORDER[weighted(random, plan.mood[recent ? 1 : 0])];
    const first = plan.tags[weighted(random, [5, 3, 2])];
    const tags: WorkTag[] = random() < 0.45 ? [first, pick(random, plan.tags.filter((t) => t !== first))] : [first];
    const text = random() < 0.2 ? "" : pick(random, TEACHER_TEXTS[first]);
    records.push({ date, mood, text, tags });
  }
  return records;
}

export const ME = { id: "t-yamamoto", name: "山本 直樹", kana: "やまもと なおき", duty: "2年A組 担任" };

/** 山本先生自身の記録。今日（AS_OF）はまだ書いていない。 */
export const MY_RECORDS: TeacherRecord[] = staffRecords(12, {
  rate: [0.82, 0.8],
  mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD],
  tags: ["lesson", "students", "admin"],
}).map((record, index) => ({
  ...record,
  promptId: index % 4 === 1 && record.text ? PROMPTS[index % PROMPTS.length].id : undefined,
  // 保存した時刻。同じ日に一度書き直した記録もある。
  edits: index % 5 === 2 ? ["17:48", "18:22"] : [index % 2 === 0 ? "17:55" : "18:40"],
}));

/* ── 教職員（C） ──────────────────────────────────────────── */

const STAFF_PLANS: ReadonlyArray<Omit<StaffMember, "records"> & { plan: StaffPlan }> = [
  { id: "t-aoki", name: "青木 健太", kana: "あおき けんた", duty: "1年A組 担任", plan: { rate: [0.8, 0.78], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "students", "club"] } },
  { id: "t-ishikawa", name: "石川 美穂", kana: "いしかわ みほ", duty: "1年B組 担任", plan: { rate: [0.85, 0.82], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "parents", "students"] } },
  { id: "t-ueda", name: "上田 翔", kana: "うえだ しょう", duty: "1年 学年主任", plan: { rate: [0.7, 0.72], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["admin", "lesson", "parents"] } },
  { id: "t-endo", name: "遠藤 由紀", kana: "えんどう ゆき", duty: "養護教諭", plan: { rate: [0.8, 0.8], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["students", "admin", "parents"] } },
  { id: "t-okamoto", name: "岡本 隆", kana: "おかもと たかし", duty: "2年B組 担任", plan: { rate: [0.75, 0.76], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "club", "students"] } },
  { id: "t-kato", name: "加藤 さくら", kana: "かとう さくら", duty: "3年A組 担任", plan: { rate: [0.8, 0.8], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "students", "parents"] } },
  // 大会と行事が重なり、気分の平均が下がっている。
  { id: "t-kimura", name: "木村 大輔", kana: "きむら だいすけ", duty: "3年B組 担任・陸上部顧問", plan: { rate: [0.8, 0.8], mood: [[1.5, 5, 4, 1, 0.3], [0, 0.5, 3, 5, 3]], tags: ["club", "lesson", "admin"] } },
  // 着任したばかりで、比べる元がまだ無い。
  { id: "t-kobayashi", name: "小林 恵", kana: "こばやし めぐみ", duty: "国語科", plan: { rate: [0.8, 0.8], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "other", "admin"], startsDaysAgo: 18 } },
  { id: "t-sasaki", name: "佐々木 誠", kana: "ささき まこと", duty: "2年 学年主任", plan: { rate: [0.75, 0.74], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["admin", "parents", "lesson"] } },
  { id: "t-takahashi", name: "高橋 あゆみ", kana: "たかはし あゆみ", duty: "英語科", plan: { rate: [0.78, 0.8], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "other", "students"] } },
  // 記録する日が減っている。
  { id: "t-nakamura", name: "中村 亮", kana: "なかむら りょう", duty: "数学科", plan: { rate: [0.85, 0.25], mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD], tags: ["lesson", "admin", "other"] } },
];

export const STAFF: StaffMember[] = [
  ...STAFF_PLANS.map(({ plan, ...person }, index) => ({ ...person, records: staffRecords(index + 1, plan) })),
  { ...ME, records: MY_RECORDS.map(({ date, mood, text, tags }) => ({ date, mood, text, tags })) },
];

export function getStaffMember(id: string): StaffMember | null {
  return STAFF.find((member) => member.id === id) ?? null;
}

/* ── 立場と、誰が誰の記録を読むか（D-1 / A-5） ────────────────── */

export const PERSONAS: Record<TeacherRole, { name: string; title: string }> = {
  homeroom: { name: ME.name, title: ME.duty },
  manager: { name: "佐藤 恵子", title: "教頭" },
  admin: { name: "鈴木 一郎", title: "学校管理者（情報担当）" },
};

/** 管理職の顔ぶれ。先生の記録を誰が読むかの設定に使う。 */
export const MANAGERS = {
  gradeHead: { name: "佐々木 誠", title: "2年 学年主任" },
  vicePrincipal: { name: "佐藤 恵子", title: "教頭" },
  principal: { name: "田中 博", title: "校長" },
} as const;

/** 生徒の記録を、担任のほかに読める人（D-1）。 */
export const STUDENT_READERS = {
  gradeHead: { name: "佐々木 誠", title: "学年主任" },
  nurse: { name: "遠藤 由紀", title: "養護教諭" },
  counselor: { name: "山下 遥", title: "スクールカウンセラー" },
} as const;

/* ── 面談メモ（B-4 / C-4） ───────────────────────────────── */

export const MEETING_MEMOS: MeetingMemo[] = [
  {
    id: "m-1",
    subject: { kind: "student", id: "s-04", name: "上田 芽依" },
    date: "2026-07-28",
    body: "部活の人間関係のことを少し話してくれた。本人は「自分で何とかしたい」とのこと。こちらからは急がせず、聞くだけにした。",
    nextCheck: "部活の雰囲気がその後どうか、本人のペースで聞く。",
    author: ME.name,
  },
  {
    id: "m-2",
    subject: { kind: "student", id: "s-09", name: "加藤 心春" },
    date: "2026-08-03",
    body: "最近の様子を雑談のなかで聞いた。夏期講習が始まって、家に帰るのが遅いとのこと。",
    nextCheck: "講習が終わる来週、もう一度声をかける。",
    author: ME.name,
  },
  {
    id: "m-3",
    subject: { kind: "staff", id: "t-kimura", name: "木村 大輔" },
    date: "2026-07-30",
    body: "大会と学年行事の準備が重なっている時期。業務の分け方を相談したいとのこと。",
    nextCheck: "大会のあとに、担当している仕事を一緒に書き出す。",
    author: PERSONAS.manager.name,
  },
];

/* ── 利用状況（D-5） ──────────────────────────────────────── */

/** 学期ごとの記録率。クラス単位と、先生全体の集計値だけを持つ（個人別は持たない）。 */
export const USAGE_REPORT = {
  terms: [
    {
      term: "2025年度 3学期（1/8〜3/24）",
      classes: [
        { name: "1年A組", rate: 0.76 },
        { name: "1年B組", rate: 0.71 },
        { name: "2年A組", rate: 0.7 },
        { name: "2年B組", rate: 0.66 },
        { name: "3年A組", rate: 0.6 },
        { name: "3年B組", rate: 0.64 },
      ],
      teachers: 0.67,
    },
    {
      term: "2026年度 1学期（4/7〜7/18）",
      classes: [
        { name: "1年A組", rate: 0.79 },
        { name: "1年B組", rate: 0.8 },
        { name: "2年A組", rate: 0.72 },
        { name: "2年B組", rate: 0.7 },
        { name: "3年A組", rate: 0.58 },
        { name: "3年B組", rate: 0.61 },
      ],
      teachers: 0.68,
    },
  ],
} as const;

/* ── 学校の設定（D） ──────────────────────────────────────── */

export type Retention = "3m" | "6m" | "1y" | "3y";

export const RETENTION_LABEL: Record<Retention, string> = {
  "3m": "3か月後に削除",
  "6m": "6か月後に削除",
  "1y": "1年後に削除",
  "3y": "3年後に削除",
};

export interface SchoolSettings {
  /** 生徒の記録を、担任のほかに読める人（D-1） */
  studentReaders: Record<keyof typeof STUDENT_READERS, boolean>;
  /** 先生の記録を読む管理職（D-1）。学年主任は自分の学年の先生だけ。 */
  staffReaders: Record<keyof typeof MANAGERS, boolean>;
  /** 帰りのHRの時刻と、記録のお知らせ（A-6 / D-3） */
  reminder: { time: string; enabled: boolean };
  /** 卒業・転出・異動・退職のあとの記録の扱い（D-4） */
  retention: { graduation: Retention; transferOut: Retention; transfer: Retention; retirement: Retention };
  /** 担任が替わるとき、生徒の面談メモを後任へ引き継ぐか（B-4） */
  studentMemoHandover: boolean;
  /** 先生が異動するとき、管理職の面談メモを引き継ぐか（C-4。既定は引き継がない） */
  staffMemoHandover: boolean;
}

export const DEFAULT_SETTINGS: SchoolSettings = {
  studentReaders: { gradeHead: false, nurse: false, counselor: false },
  staffReaders: { gradeHead: false, vicePrincipal: true, principal: false },
  reminder: { time: "15:40", enabled: true },
  retention: { graduation: "1y", transferOut: "6m", transfer: "1y", retirement: "6m" },
  studentMemoHandover: true,
  staffMemoHandover: false,
};

/**
 * 山本先生の記録を読める人（A-5）。設定（D-1）から決まる。
 * 設定を変えれば、記録の画面の表示もその場で変わる。
 */
export function readersOfTeacherRecords(settings: SchoolSettings): Array<{ name: string; title: string }> {
  return (Object.keys(MANAGERS) as Array<keyof typeof MANAGERS>)
    .filter((key) => settings.staffReaders[key])
    .map((key) => MANAGERS[key]);
}

/** 生徒の記録を読める人（担任と、設定で足した人）。 */
export function readersOfStudentRecords(settings: SchoolSettings): Array<{ name: string; title: string }> {
  return [
    { name: ME.name, title: "担任" },
    ...(Object.keys(STUDENT_READERS) as Array<keyof typeof STUDENT_READERS>)
      .filter((key) => settings.studentReaders[key])
      .map((key) => STUDENT_READERS[key]),
  ];
}
