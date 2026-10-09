"use client";

/**
 * 画面の状態を持つところ。デモではサーバーに送らず、端末の中だけに置く。
 *
 *  - 立場（デモの切り替え）・今日書いた記録・面談メモ・面談の予定日は
 *    このタブの中（sessionStorage）。タブを閉じれば最初の状態に戻る。
 *  - 書きかけの下書き・週の確認・お知らせの設定は端末（localStorage）。
 *    下書きは通信が切れても消えないように（3-1）、週の確認は自分用の
 *    メモなので、次に開いたときも残っているように。
 */

import { useMemo, useSyncExternalStore } from "react";
import { MEETING_MEMOS, MEETING_PLANS, PERSONAS } from "./fixtures";
import type { MeetingMemo, Persona, PersonaId, TeacherRecord } from "./types";

type Area = "session" | "local";
const EVENT = "blesc:teachers-store";

const storage = (area: Area): Storage | null => {
  try {
    return area === "session" ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
};

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
};

export function readRaw(area: Area, key: string): string | null {
  try {
    return storage(area)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 書けたかどうかを返す。書けない環境では、このタブの表示が戻るだけ。 */
export function writeRaw(area: Area, key: string, value: string | null): boolean {
  let ok = false;
  try {
    const store = storage(area);
    if (store) {
      if (value === null) store.removeItem(key);
      else store.setItem(key, value);
      ok = true;
    }
  } catch {
    ok = false;
  }
  window.dispatchEvent(new Event(EVENT));
  return ok;
}

/** 文字列のまま比べるので、同じ中身なら同じスナップショットになる。 */
function useRaw(area: Area, key: string): string | null {
  return useSyncExternalStore(subscribe, () => readRaw(area, key), () => null);
}

function useJson<T>(area: Area, key: string, fallback: T): T {
  const raw = useRaw(area, key);
  return useMemo(() => {
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
    // fallback は呼ぶ側の定数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);
}

/* ── 立場（デモ） ─────────────────────────────────────────── */

const PERSONA_KEY = "blesc:teacher-persona";
const DEFAULT_PERSONA: PersonaId = "tanaka";

export function usePersona(): Persona {
  const raw = useRaw("session", PERSONA_KEY);
  return raw && raw in PERSONAS ? PERSONAS[raw as PersonaId] : PERSONAS[DEFAULT_PERSONA];
}

export const setPersona = (id: PersonaId) => writeRaw("session", PERSONA_KEY, id);

/* ── 自分の記録（このタブで書いたもの） ──────────────────────── */

const EMPTY_RECORDS: Record<string, TeacherRecord> = {};
const recordsKey = (persona: PersonaId) => `blesc:my-records:${persona}`;

/** このタブで書いた記録（日付 → 記録）。 */
export function useWrittenRecords(persona: PersonaId): Record<string, TeacherRecord> {
  return useJson("session", recordsKey(persona), EMPTY_RECORDS);
}

export function saveWrittenRecord(persona: PersonaId, record: TeacherRecord): boolean {
  let current: Record<string, TeacherRecord> = {};
  try {
    current = JSON.parse(readRaw("session", recordsKey(persona)) ?? "{}") as Record<string, TeacherRecord>;
  } catch {
    current = {};
  }
  return writeRaw("session", recordsKey(persona), JSON.stringify({ ...current, [record.date]: record }));
}

/** 書きかけ（端末に残す）。 */
export const draftKey = (persona: PersonaId, date: string) => `blesc:my-draft:${persona}:${date}`;

/* ── 面談メモと、次の面談予定日 ───────────────────────────── */

const MEMOS_KEY = "blesc:meeting-memos";
const PLANS_KEY = "blesc:meeting-plans";
const EMPTY_MEMOS: MeetingMemo[] = [];
const EMPTY_PLANS: Record<string, string> = {};

/** 書いた本人の面談メモ（新しい順）。 */
export function useMemos(author: PersonaId, subjectId?: string): MeetingMemo[] {
  const added = useJson("session", MEMOS_KEY, EMPTY_MEMOS);
  return useMemo(
    () =>
      [...MEETING_MEMOS, ...added]
        .filter((memo) => memo.author === author && (!subjectId || memo.subjectId === subjectId))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id)),
    [added, author, subjectId],
  );
}

export function addMemo(memo: MeetingMemo) {
  let current: MeetingMemo[] = [];
  try {
    current = JSON.parse(readRaw("session", MEMOS_KEY) ?? "[]") as MeetingMemo[];
  } catch {
    current = [];
  }
  writeRaw("session", MEMOS_KEY, JSON.stringify([...current, memo]));
}

/** 次の面談予定日（対象 → 日付）。このタブで書き換えたものが優先。空文字は「予定なし」。 */
export function useMeetingPlans(author: PersonaId): Record<string, string> {
  const changed = useJson("session", PLANS_KEY, EMPTY_PLANS);
  return useMemo(() => {
    const plans: Record<string, string> = {};
    for (const plan of MEETING_PLANS) if (plan.author === author) plans[plan.subjectId] = plan.date;
    for (const [key, date] of Object.entries(changed)) {
      const [who, subjectId] = key.split("|");
      if (who === author) plans[subjectId] = date;
    }
    return plans;
  }, [changed, author]);
}

export function setMeetingPlan(author: PersonaId, subjectId: string, date: string) {
  let current: Record<string, string> = {};
  try {
    current = JSON.parse(readRaw("session", PLANS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    current = {};
  }
  writeRaw("session", PLANS_KEY, JSON.stringify({ ...current, [`${author}|${subjectId}`]: date }));
}

/* ── 週の確認（自分用のメモ。管理職には送らない） ─────────────── */

const weeklyKey = (persona: PersonaId, scope: string) => `blesc:weekly-check:${persona}:${scope}`;

/** 確認した週の月曜日。まだなら null。 */
export function useWeeklyCheck(persona: PersonaId, scope: string): string | null {
  return useRaw("local", weeklyKey(persona, scope));
}

export const setWeeklyCheck = (persona: PersonaId, scope: string, week: string | null) =>
  writeRaw("local", weeklyKey(persona, scope), week);

/* ── お知らせの設定（8-1） ─────────────────────────────────── */

export interface NoticePrefs {
  /** 面談前日のお知らせ */
  beforeMeeting: boolean;
  /** 週の確認のお知らせ */
  weekly: boolean;
  /** 週の確認のお知らせを出す曜日（1=月 … 5=金） */
  weekday: number;
}

const DEFAULT_PREFS: NoticePrefs = { beforeMeeting: true, weekly: true, weekday: 5 };
const prefsKey = (persona: PersonaId) => `blesc:notice-prefs:${persona}`;

export function useNoticePrefs(persona: PersonaId): NoticePrefs {
  return useJson("local", prefsKey(persona), DEFAULT_PREFS);
}

export const setNoticePrefs = (persona: PersonaId, prefs: NoticePrefs) =>
  writeRaw("local", prefsKey(persona), JSON.stringify(prefs));
