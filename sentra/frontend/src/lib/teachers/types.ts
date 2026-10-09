/**
 * Blesc for Teachers の型。UI仕様書（役割別・全画面）に沿う。
 *
 * 記録は生徒も先生も同じ形（気分・タグ・本文・答えた質問）。違うのは
 * タグの種類だけ。ここに点数や判定の欄は無い。
 */

import type { EventCategory, Mood } from "@/lib/blesc/types";

/** 先生の記録のテーマのタグ（4-1）。 */
export type WorkTag = "lesson" | "admin" | "students" | "parents" | "club" | "workload" | "health" | "other";

/** 1日1件の記録。 */
export interface SelfRecord<Tag extends string = string> {
  /** YYYY-MM-DD */
  date: string;
  /** 保存した時刻 HH:MM */
  time: string;
  mood: Mood;
  tags: Tag[];
  /** 自由記述。空なら気分だけの記録。 */
  text: string;
  /** 「書くことが思いつかないとき」の質問に答えたなら、その質問。読む人にも見える。 */
  question?: string;
}

export type StudentRecord = SelfRecord<EventCategory>;
export type TeacherRecord = SelfRecord<WorkTag>;

export interface SchoolClass {
  id: string;
  grade: number;
  room: number;
  /** 「2年3組」 */
  name: string;
}

export interface Student {
  id: string;
  classId: string;
  /** 出席番号 */
  number: number;
  name: string;
  records: StudentRecord[];
}

export interface StaffMember {
  id: string;
  name: string;
  kana: string;
  /** 所属する学年。管理職・養護教諭などは null。 */
  grade: number | null;
  /** 担任しているクラス。担任なしは null。 */
  homeroom: string | null;
  /** 教科。無い人は null。 */
  subject: string | null;
  /** 役職（学年主任・教頭・校長・養護教諭）。ふつうの先生は null。 */
  position: string | null;
  records: TeacherRecord[];
}

/**
 * 権限（1章）。役割はこの組み合わせのプリセットにすぎない。
 * 持っている権限の分だけ、タブが出る。
 */
export interface Access {
  /** 自分の記録を書く */
  write: boolean;
  /** 生徒を読む：見られるクラス。タブの名前は、担任・学年主任は「クラス」、それ以外は「生徒」。 */
  students: { tab: "クラス" | "生徒"; classIds: string[]; grade: number | null } | null;
  /** 先生を読む：見られる先生 */
  teachers: { label: string; staffIds: string[] } | null;
}

export type PersonaId = "tanaka" | "takahashi" | "sato" | "suzuki" | "ito" | "endo" | "yamashita";

export interface Persona {
  id: PersonaId;
  /** 教職員としての記録があれば、その id。外部のスクールカウンセラーは null。 */
  staffId: string | null;
  name: string;
  /** 「2年3組 担任・英語」 */
  title: string;
  /** 「担任」「学年主任」など、切り替えの一覧に出す役割名 */
  role: string;
  access: Access;
}

/** 面談メモ（5-3）。書いた本人だけが読む。 */
export interface MeetingMemo {
  id: string;
  subjectId: string;
  date: string;
  body: string;
  /** 次回確認すること */
  nextCheck: string;
  author: PersonaId;
}
