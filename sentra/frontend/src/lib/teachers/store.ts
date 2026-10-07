"use client";

/**
 * 立場（担任・管理職・学校管理者）と、学校の設定を持つところ。
 *
 * デモでは端末のタブの中（sessionStorage）だけに置く。設定の画面で読める人を
 * 変えると、記録の画面の「この記録を読める人」がその場で変わる（D-1 の
 * 「本人の閲覧者表示に即時反映する」を、そのまま確かめられるように）。
 */

import { useSyncExternalStore } from "react";
import { DEFAULT_SETTINGS, type SchoolSettings } from "./fixtures";
import type { TeacherRole } from "./types";

const ROLE_KEY = "blesc:teacher-role";
const SETTINGS_KEY = "blesc:school-settings";
const EVENT = "blesc:teachers-store";

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  window.addEventListener("storage", notify);
  return () => {
    window.removeEventListener(EVENT, notify);
    window.removeEventListener("storage", notify);
  };
};

const read = (key: string): string | null => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 保存できない環境では、このタブの表示が戻るだけ。
  }
  window.dispatchEvent(new Event(EVENT));
};

const ROLES: TeacherRole[] = ["homeroom", "manager", "admin"];

export function useTeacherRole(): TeacherRole {
  return useSyncExternalStore(
    subscribe,
    () => {
      const stored = read(ROLE_KEY) as TeacherRole | null;
      return stored && ROLES.includes(stored) ? stored : "homeroom";
    },
    () => "homeroom",
  );
}

export const setTeacherRole = (role: TeacherRole) => write(ROLE_KEY, role);

/** 立場ごとの最初の画面（ナビの先頭）。学校管理者は自分の記録を付けない。 */
export const ROLE_HOME: Record<TeacherRole, string> = {
  homeroom: "/educator",
  manager: "/educator",
  admin: "/educator/settings",
};

// 同じ文字列からは同じオブジェクトを返す。毎回作り直すと useSyncExternalStore が
// 変化と取り違えて、描き直しが止まらなくなる。
let cachedRaw: string | null | undefined;
let cachedSettings: SchoolSettings = DEFAULT_SETTINGS;

function currentSettings(): SchoolSettings {
  const raw = read(SETTINGS_KEY);
  if (raw === cachedRaw) return cachedSettings;
  cachedRaw = raw;
  try {
    cachedSettings = raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<SchoolSettings>) } : DEFAULT_SETTINGS;
  } catch {
    cachedSettings = DEFAULT_SETTINGS;
  }
  return cachedSettings;
}

export function useSchoolSettings(): SchoolSettings {
  return useSyncExternalStore(subscribe, currentSettings, () => DEFAULT_SETTINGS);
}

export function updateSchoolSettings(patch: Partial<SchoolSettings>) {
  write(SETTINGS_KEY, JSON.stringify({ ...currentSettings(), ...patch }));
}
