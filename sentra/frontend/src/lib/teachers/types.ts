/**
 * Blesc for Teachers のデータの形。
 *
 * 生徒の記録も先生の記録も、同じ「自己申告の記録」として扱う。気分・本文・
 * 本人が選んだタグの3つだけで、ここに AI の判定やリスクの段階は入らない
 * （設計原則 1）。画面に出る「変化あり」も、この3つの推移から決まる。
 */

import type { EventCategory, Mood } from "@/lib/blesc/types";

/** 先生の業務タグ（A-3）。本人が選ぶ。自動で分類はしない。 */
export type WorkTag = "lesson" | "admin" | "students" | "club" | "parents" | "other";

/** 1日1件の記録。生徒は話題、先生は業務をタグに持つ。 */
export interface SelfRecord<Tag extends string = string> {
  /** YYYY-MM-DD */
  date: string;
  mood: Mood;
  /** 任意。気分だけの日もある。 */
  text: string;
  tags: Tag[];
}

/** 先生自身の記録（A-1）。どの質問に答えたか（A-2）と、編集の履歴を持つ。 */
export interface TeacherRecord extends SelfRecord<WorkTag> {
  /** 質問プロンプトに答えた場合、その質問の id。 */
  promptId?: string;
  /** 保存した時刻（HH:MM）。同じ日のうちの書き直しも1つずつ残す。 */
  edits: string[];
}

/** クラスの生徒（B-1）。並びの既定は出席番号。 */
export interface ClassStudent {
  id: string;
  /** 出席番号 */
  number: number;
  name: string;
  records: Array<SelfRecord<EventCategory>>;
}

/** 教職員（C-1）。並びの既定は五十音順。 */
export interface StaffMember {
  id: string;
  name: string;
  /** 五十音順に並べるための読み */
  kana: string;
  /** 例: 2年A組 担任 */
  duty: string;
  records: Array<SelfRecord<WorkTag>>;
}

/** 面談メモ（B-4 / C-4）。書いた側だけが読む。 */
export interface MeetingMemo {
  id: string;
  subject: { kind: "student" | "staff"; id: string; name: string };
  /** 面談日 YYYY-MM-DD */
  date: string;
  body: string;
  /** 次回の面談で確かめたいこと */
  nextCheck: string;
  author: string;
}

/** 画面を見ている人の立場。デモでは切り替えて見られる。 */
export type TeacherRole = "homeroom" | "manager" | "admin";
