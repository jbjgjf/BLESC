/**
 * Blesc for Teachers のデモ用の学校。UI仕様書の 7章の例に合わせてある。
 *
 * 教職員50人。記録は8週間ぶん、登校日だけ。乱数は名簿の位置を種にして
 * いるので、何度読み込んでも同じ記録になる。
 *
 * 何人かは「変化があった」ように作ってある（記録の間・気分・話題・
 * 記録の時間）。どれも同じ扱いで、重さの違いは作らない。
 *
 * Blesc for Teachers は先生自身の記録のためのサービスで、生徒の記録は
 * 扱わない（生徒を読むのは Blesc の教員の画面 /educator）。
 *
 * 値の import を持たない（node のテストからそのまま読めるように）。
 * 日付の基準 AS_OF は、生徒側の TODAY（lib/blesc/labels.ts）と同じ日。
 */

import type { Mood } from "@/lib/blesc/types";
import type { Access, MeetingMemo, Persona, PersonaId, SchoolClass, StaffMember, TeacherRecord, WorkTag } from "./types";

export const AS_OF = "2026-08-07";
export const SCHOOL_NAME = "広尾学園 中学校・高等学校";

const DAY = 86_400_000;
const daysBefore = (days: number) => new Date(Date.parse(`${AS_OF}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
const isSchoolDay = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/** 種から決まる乱数（mulberry32）。 */
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
const weighted = (random: () => number, weights: readonly number[]) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
};
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const MOODS_ORDER: Mood[] = ["very_good", "good", "neutral", "low", "hard"];

/** 文の手持ち。気分に合った文を選ぶ（つらい日に明るい文が並ばないように）。 */
type Pools = { up: readonly string[]; flat: readonly string[]; down: readonly string[] };
const TONE: Record<Mood, [number, number, number]> = {
  very_good: [8, 2, 0],
  good: [5, 5, 0],
  neutral: [1.5, 7, 1.5],
  low: [0, 3, 7],
  hard: [0, 1, 9],
};
const toned = (random: () => number, pools: Pools, mood: Mood) => {
  const bucket = (["up", "flat", "down"] as const)[weighted(random, TONE[mood])];
  return pick(random, pools[bucket].length > 0 ? pools[bucket] : pools.flat);
};

/* ── 記録の作り方 ─────────────────────────────────────────── */

type Plan<Tag extends string> = {
  /** 登校日に記録する確率（それまで / 直近2週間） */
  rate: [number, number];
  /** 気分の重み（とても良い, 良い, ふつう, 少しつらい, つらい）（それまで / 直近） */
  mood: [readonly number[], readonly number[]];
  /** よく選ぶタグ（それまで / 直近） */
  tags: [readonly Tag[], readonly Tag[]];
  /** 直近の本文を短い言葉だけにする */
  short?: boolean;
  /** それまでの本文を長めにする */
  long?: boolean;
  /** 直近のこの日数は記録しない（記録が空いている） */
  silentDays?: number;
  /** この日数より前の記録は無い（転入・着任したばかり） */
  startsDaysAgo?: number;
  /** 保存する時刻（分）。それまで / 直近 */
  minutes: [number, number];
  /** 直近の記録に必ず付けるタグ（続いている話題） */
  always?: Tag;
};

const RECENT = 14;
const SPAN = 56;

function makeRecords<Tag extends string>(
  seed: number,
  plan: Plan<Tag>,
  texts: Record<Tag, Pools>,
  fillers: Pools,
  questions: readonly string[],
  skip: (ago: number) => boolean = () => false,
): Array<{ date: string; time: string; mood: Mood; tags: Tag[]; text: string; question?: string }> {
  const random = seeded(seed);
  const out: Array<{ date: string; time: string; mood: Mood; tags: Tag[]; text: string; question?: string }> = [];
  for (let ago = SPAN - 1; ago >= 0; ago -= 1) {
    const date = daysBefore(ago);
    if (!isSchoolDay(date)) continue;
    if (plan.startsDaysAgo !== undefined && ago > plan.startsDaysAgo) continue;
    if (plan.silentDays !== undefined && ago < plan.silentDays) continue;
    if (skip(ago)) continue;
    const recent = ago < RECENT;
    if (random() > plan.rate[recent ? 1 : 0]) continue;

    const mood = MOODS_ORDER[weighted(random, plan.mood[recent ? 1 : 0])];
    const pool = plan.tags[recent ? 1 : 0];
    const first = pool[weighted(random, [5, 3, 2])];
    const tags: Tag[] = [first];
    if (random() < 0.3) tags.push(pick(random, pool.filter((t) => t !== first)));
    if (recent && plan.always && !tags.includes(plan.always)) tags.unshift(plan.always);

    const asked = random() < 0.12 ? pick(random, questions) : undefined;
    let text: string;
    if (plan.short && recent) text = pick(random, ["ふつう。", "特になし。", "疲れた。", "眠い。", "まあまあ。"]);
    else if (plan.long && !recent) text = tags.concat(pool.filter((t) => !tags.includes(t))).slice(0, 3).map((t) => toned(random, texts[t], mood)).join("");
    else if (random() < 0.14) text = "";
    else text = `${toned(random, texts[tags[0]], mood)}${random() < 0.35 ? toned(random, fillers, mood) : ""}`;

    const base = plan.minutes[recent ? 1 : 0];
    const time = clock(base + Math.floor(random() * 35) - 10);
    out.push({ date, time, mood, tags, text, ...(asked && text ? { question: asked } : {}) });
  }
  return out;
}

/* ── クラス（担任の担当を書くためだけ。生徒の名簿は持たない） ── */

export const CLASSES: SchoolClass[] = [1, 2, 3].flatMap((grade) =>
  [1, 2, 3, 4].map((room) => ({ id: `c-${grade}-${room}`, grade, room, name: `${grade}年${room}組` })),
);

export const classById = (id: string) => CLASSES.find((c) => c.id === id) ?? null;

/* ── 教職員 ───────────────────────────────────────────────── */

/** 先生の記録のテーマのタグ（4-1）。並びも仕様書のとおり。 */
export const WORK_TAGS: ReadonlyArray<{ value: WorkTag; label: string }> = [
  { value: "lesson", label: "授業" },
  { value: "admin", label: "校務" },
  { value: "students", label: "生徒対応" },
  { value: "parents", label: "保護者対応" },
  { value: "club", label: "部活動" },
  { value: "workload", label: "業務量" },
  { value: "health", label: "体調" },
  { value: "other", label: "その他" },
];

/** 面談前の要約で「業務に関する記述」として抜き出すタグ（6-2）。 */
export const WORK_RELATED: readonly WorkTag[] = ["workload", "admin", "parents"];

export const TEACHER_QUESTIONS = [
  "今日いちばん時間を使った仕事は？",
  "今日、うれしかった生徒とのやりとりは？",
  "今日、少し手が止まった場面は？",
  "明日の自分に引き継ぎたいことは？",
  "今日、だれかに助けられたことは？",
] as const;

const TEACHER_TEXTS: Record<WorkTag, Pools> = {
  lesson: {
    up: ["3限の授業で、生徒の質問から話が広がった。", "授業がうまくまとまった。"],
    flat: ["小テストの採点を進めた。"],
    down: ["授業準備が思ったより時間がかかった。", "小テストの採点がまだ半分残っている。"],
  },
  admin: {
    up: ["行事の準備が一区切りついた。"],
    flat: ["会議が2つ続いた。"],
    down: ["行事の資料づくりで放課後がほぼ終わった。", "成績処理の締め切りが近い。"],
  },
  students: {
    up: ["休み時間に声をかけてくれた生徒がいて、うれしかった。"],
    flat: ["放課後に生徒の話を聞いた。"],
    down: ["欠席が続いている生徒の家に連絡した。"],
  },
  parents: {
    up: ["保護者から、お礼の連絡をもらった。"],
    flat: ["面談の日程調整の連絡を返した。"],
    down: ["保護者から電話があり、30分ほど話した。", "保護者からの相談に、学年主任と一緒に対応した。"],
  },
  club: {
    up: ["部活の練習で、1年生が目に見えて上達していた。"],
    flat: ["部活の引率の準備をした。"],
    down: ["大会前で部活の練習が長くなった。"],
  },
  workload: {
    up: ["持ち帰りの仕事が、今日は無かった。"],
    flat: ["業務を整理して、明日に回した。"],
    down: ["仕事が終わらず、持ち帰りになった。", "業務が重なって、授業準備の時間が取れない。", "締め切りが3つ重なっている。"],
  },
  health: {
    up: ["よく眠れて、体が軽い。"],
    flat: ["少し喉が痛い。早めに休む。"],
    down: ["寝不足ぎみ。", "肩こりがひどい。"],
  },
  other: {
    up: ["職員室で雑談して、少し気が晴れた。"],
    flat: ["研修のレポートを書いた。"],
    down: ["なんとなく疲れが抜けない。"],
  },
};
const TEACHER_FILLERS: Pools = {
  up: ["少し落ち着いた。"],
  flat: ["週末はゆっくりする。"],
  down: ["明日は早めに帰りたい。"],
};

const STAFF_STEADY_MOOD = [1, 4, 5, 1.5, 0.3] as const;
const AFTER_HR = 16 * 60 + 20;

type StaffSeed = {
  id: string;
  name: string;
  kana: string;
  grade: number | null;
  homeroom: string | null;
  subject: string | null;
  position: string | null;
  tags: readonly WorkTag[];
  plan?: Partial<Plan<WorkTag>>;
  /** 書き忘れた日（ago の日数）。「昨日の分も書けます」を見せるため。 */
  missing?: number[];
};

/** 教職員50人。7章の例の5人（田中・高橋・佐藤・鈴木・校長）と、養護教諭の遠藤先生を含む。 */
const STAFF_SEEDS: StaffSeed[] = [
  { id: "t-ito", name: "伊藤 博", kana: "いとう ひろし", grade: null, homeroom: null, subject: null, position: "校長", tags: ["admin", "other", "parents"] },
  { id: "t-suzuki", name: "鈴木 一郎", kana: "すずき いちろう", grade: null, homeroom: null, subject: null, position: "教頭", tags: ["admin", "parents", "other"], missing: [0] },
  { id: "t-endo", name: "遠藤 由紀", kana: "えんどう ゆき", grade: null, homeroom: null, subject: null, position: "養護教諭", tags: ["students", "admin", "health"], missing: [0] },

  // 2年（佐藤先生の学年）
  { id: "t-sato", name: "佐藤 恵子", kana: "さとう けいこ", grade: 2, homeroom: null, subject: "国語", position: "学年主任", tags: ["admin", "parents", "lesson"], missing: [0],
    plan: { mood: [[1.5, 5, 4, 1, 0.3], [0, 0.5, 3, 5, 3]] } },
  { id: "t-okamoto", name: "岡本 隆", kana: "おかもと たかし", grade: 2, homeroom: "c-2-1", subject: "社会", position: null, tags: ["lesson", "students", "club"],
    plan: { tags: [["lesson", "students", "club"], ["lesson", "workload", "workload"]] } },
  { id: "t-kato", name: "加藤 さくら", kana: "かとう さくら", grade: 2, homeroom: "c-2-2", subject: "理科", position: null, tags: ["lesson", "students", "parents"] },
  { id: "t-tanaka", name: "田中 美咲", kana: "たなか みさき", grade: 2, homeroom: "c-2-3", subject: "英語", position: null, tags: ["lesson", "students", "admin"], missing: [0, 1] },
  { id: "t-nishida", name: "西田 浩二", kana: "にしだ こうじ", grade: 2, homeroom: "c-2-4", subject: "保健体育", position: null, tags: ["club", "lesson", "students"] },
  { id: "t-takahashi", name: "高橋 健一", kana: "たかはし けんいち", grade: 2, homeroom: null, subject: "数学", position: null, tags: ["lesson", "admin", "other"], missing: [0],
    plan: { minutes: [AFTER_HR, 19 * 60 + 5] } },
  { id: "t-mori", name: "森 綾", kana: "もり あや", grade: 2, homeroom: null, subject: "理科", position: null, tags: ["lesson", "students", "other"],
    plan: { always: "parents" } },
  { id: "t-hayashi", name: "林 拓也", kana: "はやし たくや", grade: 2, homeroom: null, subject: "英語", position: null, tags: ["lesson", "club", "other"] },
  { id: "t-sakamoto", name: "坂本 真理子", kana: "さかもと まりこ", grade: 2, homeroom: null, subject: "国語", position: null, tags: ["lesson", "admin", "students"] },
  { id: "t-miyazaki", name: "宮崎 聡", kana: "みやざき さとし", grade: 2, homeroom: null, subject: "数学", position: null, tags: ["lesson", "club", "admin"] },
  { id: "t-kudo", name: "工藤 香織", kana: "くどう かおり", grade: 2, homeroom: null, subject: "音楽", position: null, tags: ["lesson", "club", "other"] },
  { id: "t-yoshida", name: "吉田 達也", kana: "よしだ たつや", grade: 2, homeroom: null, subject: "技術", position: null, tags: ["lesson", "admin", "other"] },
  { id: "t-murakami", name: "村上 奈々", kana: "むらかみ なな", grade: 2, homeroom: null, subject: "美術", position: null, tags: ["lesson", "students", "other"] },

  // 1年
  { id: "t-ishikawa", name: "石川 美穂", kana: "いしかわ みほ", grade: 1, homeroom: null, subject: "英語", position: "学年主任", tags: ["admin", "parents", "lesson"] },
  { id: "t-aoki", name: "青木 健太", kana: "あおき けんた", grade: 1, homeroom: "c-1-1", subject: "数学", position: null, tags: ["lesson", "students", "club"] },
  { id: "t-ueda", name: "上田 翔", kana: "うえだ しょう", grade: 1, homeroom: "c-1-2", subject: "理科", position: null, tags: ["lesson", "students", "parents"] },
  { id: "t-uchida", name: "内田 修", kana: "うちだ おさむ", grade: 1, homeroom: "c-1-3", subject: "社会", position: null, tags: ["lesson", "club", "students"], plan: { silentDays: 7 } },
  { id: "t-oono", name: "小野 裕子", kana: "おの ゆうこ", grade: 1, homeroom: "c-1-4", subject: "国語", position: null, tags: ["lesson", "parents", "students"] },
  { id: "t-kawaguchi", name: "川口 学", kana: "かわぐち まなぶ", grade: 1, homeroom: null, subject: "保健体育", position: null, tags: ["club", "lesson", "other"] },
  { id: "t-shimizu", name: "清水 智子", kana: "しみず ともこ", grade: 1, homeroom: null, subject: "英語", position: null, tags: ["lesson", "students", "other"] },
  { id: "t-takagi", name: "高木 剛", kana: "たかぎ つよし", grade: 1, homeroom: null, subject: "数学", position: null, tags: ["lesson", "admin", "club"] },
  { id: "t-takeuchi", name: "竹内 明美", kana: "たけうち あけみ", grade: 1, homeroom: null, subject: "国語", position: null, tags: ["lesson", "students", "admin"] },
  { id: "t-tamura", name: "田村 洋平", kana: "たむら ようへい", grade: 1, homeroom: null, subject: "理科", position: null, tags: ["lesson", "club", "other"] },
  { id: "t-nakajima", name: "中島 典子", kana: "なかじま のりこ", grade: 1, homeroom: null, subject: "家庭", position: null, tags: ["lesson", "admin", "other"] },
  { id: "t-hasegawa", name: "長谷川 悟", kana: "はせがわ さとる", grade: 1, homeroom: null, subject: "社会", position: null, tags: ["lesson", "students", "club"] },
  { id: "t-harada", name: "原田 千夏", kana: "はらだ ちなつ", grade: 1, homeroom: null, subject: "音楽", position: null, tags: ["lesson", "club", "other"] },

  // 3年
  { id: "t-kimura", name: "木村 大輔", kana: "きむら だいすけ", grade: 3, homeroom: null, subject: "数学", position: "学年主任", tags: ["admin", "parents", "lesson"] },
  { id: "t-fujii", name: "藤井 和也", kana: "ふじい かずや", grade: 3, homeroom: "c-3-1", subject: "英語", position: null, tags: ["lesson", "students", "parents"] },
  { id: "t-maeda", name: "前田 千夏", kana: "まえだ ちなつ", grade: 3, homeroom: "c-3-2", subject: "国語", position: null, tags: ["lesson", "students", "admin"],
    plan: { mood: [[0, 1, 4, 4, 1], [3, 6, 2, 0, 0]] } },
  { id: "t-matsumoto", name: "松本 由美", kana: "まつもと ゆみ", grade: 3, homeroom: "c-3-3", subject: "理科", position: null, tags: ["lesson", "club", "students"] },
  { id: "t-yamaguchi", name: "山口 誠", kana: "やまぐち まこと", grade: 3, homeroom: "c-3-4", subject: "社会", position: null, tags: ["lesson", "parents", "students"] },
  { id: "t-saito", name: "斎藤 亮", kana: "さいとう りょう", grade: 3, homeroom: null, subject: "数学", position: null, tags: ["lesson", "admin", "club"] },
  { id: "t-sugiyama", name: "杉山 綾", kana: "すぎやま あや", grade: 3, homeroom: null, subject: "英語", position: null, tags: ["lesson", "students", "other"] },
  { id: "t-takeda", name: "竹田 修", kana: "たけだ おさむ", grade: 3, homeroom: null, subject: "保健体育", position: null, tags: ["club", "lesson", "students"] },
  { id: "t-nakamura", name: "中村 亮", kana: "なかむら りょう", grade: 3, homeroom: null, subject: "国語", position: null, tags: ["lesson", "admin", "other"] },
  { id: "t-noguchi", name: "野口 直樹", kana: "のぐち なおき", grade: 3, homeroom: null, subject: "理科", position: null, tags: ["lesson", "club", "admin"] },
  { id: "t-fukuda", name: "福田 恵", kana: "ふくだ めぐみ", grade: 3, homeroom: null, subject: "美術", position: null, tags: ["lesson", "other", "students"] },
  { id: "t-matsui", name: "松井 和子", kana: "まつい かずこ", grade: 3, homeroom: null, subject: "家庭", position: null, tags: ["lesson", "admin", "other"] },
  { id: "t-yasuda", name: "安田 剛", kana: "やすだ つよし", grade: 3, homeroom: null, subject: "技術", position: null, tags: ["lesson", "club", "other"] },

  // 学年に属さない先生
  { id: "t-kobayashi", name: "小林 恵", kana: "こばやし めぐみ", grade: null, homeroom: null, subject: "国語", position: null, tags: ["lesson", "other", "admin"], plan: { startsDaysAgo: 9 } },
  { id: "t-okada", name: "岡田 洋子", kana: "おかだ ようこ", grade: null, homeroom: null, subject: "書道", position: null, tags: ["lesson", "other", "admin"] },
  { id: "t-ogawa", name: "小川 聡", kana: "おがわ さとし", grade: null, homeroom: null, subject: "情報", position: null, tags: ["lesson", "admin", "other"] },
  { id: "t-kondo", name: "近藤 美和", kana: "こんどう みわ", grade: null, homeroom: null, subject: "学校司書", position: null, tags: ["students", "other", "admin"] },
  { id: "t-sasaki", name: "佐々木 誠", kana: "ささき まこと", grade: null, homeroom: null, subject: "特別支援", position: null, tags: ["students", "parents", "lesson"] },
  { id: "t-hirano", name: "平野 健", kana: "ひらの けん", grade: null, homeroom: null, subject: "保健体育", position: null, tags: ["club", "lesson", "other"] },
  { id: "t-watanabe", name: "渡辺 千尋", kana: "わたなべ ちひろ", grade: null, homeroom: null, subject: "音楽", position: null, tags: ["lesson", "club", "other"] },
  { id: "t-yamamoto", name: "山本 直樹", kana: "やまもと なおき", grade: null, homeroom: null, subject: "社会", position: null, tags: ["lesson", "students", "other"] },
];

export const STAFF: StaffMember[] = STAFF_SEEDS.map((seed, index) => {
  const plan: Plan<WorkTag> = {
    rate: [0.9, 0.9],
    mood: [STAFF_STEADY_MOOD, STAFF_STEADY_MOOD],
    tags: [seed.tags, seed.tags],
    minutes: [AFTER_HR, AFTER_HR],
    ...seed.plan,
  };
  const missing = new Set(seed.missing ?? []);
  return {
    id: seed.id,
    name: seed.name,
    kana: seed.kana,
    grade: seed.grade,
    homeroom: seed.homeroom,
    subject: seed.subject,
    position: seed.position,
    records: makeRecords(index * 104729 + 17, plan, TEACHER_TEXTS, TEACHER_FILLERS, TEACHER_QUESTIONS, (ago) => missing.has(ago)) as TeacherRecord[],
  };
});

export const staffById = (id: string) => STAFF.find((s) => s.id === id) ?? null;

/** 一覧に出す担当（「2年3組担任・英語」「数学・担任なし」）。 */
export function dutyOf(member: StaffMember): string {
  if (member.position && ["校長", "教頭", "養護教諭"].includes(member.position)) return member.position;
  const homeroom = member.homeroom ? classById(member.homeroom)?.name : null;
  const parts = [
    member.position ? `${member.grade}年 ${member.position}` : null,
    homeroom ? `${homeroom}担任` : null,
    member.subject,
    !member.position && !homeroom && member.grade !== null ? "担任なし" : null,
  ].filter(Boolean);
  return parts.join("・");
}

/* ── 立場（権限の組み合わせ） ─────────────────────────────── */

/** 先生を読む範囲。学年主任は自分の学年の先生（自分を除く）、教頭は校長と自分を除く全員、校長は自分を除く全員。 */
function staffScope(staffId: string): string[] {
  const me = staffById(staffId);
  if (!me) return [];
  if (me.position === "学年主任") return STAFF.filter((s) => s.grade === me.grade && s.id !== me.id).map((s) => s.id);
  if (me.position === "教頭") return STAFF.filter((s) => s.id !== me.id && s.position !== "校長").map((s) => s.id);
  if (me.position === "校長") return STAFF.filter((s) => s.id !== me.id).map((s) => s.id);
  return [];
}

const access = (a: Access) => a;

/** デモで切り替えられる6人。7章の例の5人に、養護教諭を足した。 */
export const PERSONAS: Record<PersonaId, Persona> = {
  tanaka: {
    id: "tanaka",
    staffId: "t-tanaka",
    name: "田中 美咲",
    title: "2年3組担任・英語",
    role: "担任",
    access: access({ write: true, teachers: null }),
  },
  takahashi: {
    id: "takahashi",
    staffId: "t-takahashi",
    name: "高橋 健一",
    title: "数学・担任なし",
    role: "担任なしの先生",
    access: access({ write: true, teachers: null }),
  },
  sato: {
    id: "sato",
    staffId: "t-sato",
    name: "佐藤 恵子",
    title: "2年 学年主任・国語",
    role: "学年主任",
    access: access({ write: true, teachers: { label: "2年の先生", staffIds: staffScope("t-sato") } }),
  },
  suzuki: {
    id: "suzuki",
    staffId: "t-suzuki",
    name: "鈴木 一郎",
    title: "教頭",
    role: "教頭",
    access: access({ write: true, teachers: { label: "全教職員", staffIds: staffScope("t-suzuki") } }),
  },
  ito: {
    id: "ito",
    staffId: "t-ito",
    name: "伊藤 博",
    title: "校長",
    role: "校長",
    // 校長が書くかは未決（9章）。デモでは書かず、読むだけにしている。
    access: access({ write: false, teachers: { label: "全教職員", staffIds: staffScope("t-ito") } }),
  },
  endo: {
    id: "endo",
    staffId: "t-endo",
    name: "遠藤 由紀",
    title: "養護教諭",
    role: "養護教諭",
    access: access({ write: true, teachers: null }),
  },
};

export const PERSONA_ORDER: PersonaId[] = ["tanaka", "takahashi", "sato", "suzuki", "ito", "endo"];

/** ログイン直後に開く画面（2章）。書く人は「自分の記録」、読むだけの人は「先生」。 */
export function landingOf(persona: Persona): string {
  if (persona.access.write) return "/teachers";
  if (persona.access.teachers) return "/teachers/staff";
  return "/teachers/settings";
}

type Reader = { name: string; title: string };
const surnameOf = (name: string) => name.split(" ")[0];
const readerTitle = (member: StaffMember) => (member.position === "学年主任" ? "学年主任" : (member.position ?? "先生"));

/** その先生の記録を読める人（4-1 の閲覧者の表示）。読む方向は一方通行で、同僚同士は読めない。 */
export function readersOfStaff(staffId: string): Reader[] {
  return STAFF.filter((reader) => reader.id !== staffId && staffScope(reader.id).includes(staffId))
    .sort((a, b) => rank(a) - rank(b))
    .map((reader) => ({ name: `${surnameOf(reader.name)}先生`, title: readerTitle(reader) }));
}
const rank = (member: StaffMember) => ({ 学年主任: 0, 教頭: 1, 校長: 2 })[member.position ?? ""] ?? 3;

/* ── 面談（5-3） ──────────────────────────────────────────── */

/** 次の面談予定日。書いた先生だけのもの。岡本先生の面談は次の登校日（前日のお知らせが出る）。 */
export const MEETING_PLANS: Array<{ subjectId: string; date: string; author: PersonaId }> = [
  { subjectId: "t-okamoto", date: "2026-08-10", author: "sato" },
  { subjectId: "t-mori", date: "2026-08-19", author: "sato" },
];

export const MEETING_MEMOS: MeetingMemo[] = [
  {
    id: "m-1",
    subjectId: "t-okamoto",
    date: "2026-07-24",
    body: "行事の準備と学年の会計が重なっている時期。仕事の分け方を相談したいとのこと。",
    nextCheck: "行事のあとに、担当している仕事を一緒に書き出す。",
    author: "sato",
  },
  {
    id: "m-2",
    subjectId: "t-mori",
    date: "2026-07-17",
    body: "保護者対応が続いている件。一人で抱えず、学年で分担できるところを一緒に確認した。",
    nextCheck: "対応の記録を学年で共有できているか。",
    author: "sato",
  },
];
