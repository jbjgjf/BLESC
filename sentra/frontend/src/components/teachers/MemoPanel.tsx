"use client";

/**
 * 面談メモ（B-4 / C-4）。
 *
 * 書いた側だけが読む。生徒（先生）本人には表示しない。引き継ぎの扱いは
 * 学校の設定に従い、その設定をメモの欄のすぐ上に書いておく — 誰の手に
 * 渡るメモなのかを、書く前に分かるように。
 *
 * デモでは、足したメモはこのタブの中（sessionStorage）にだけ残る。
 */

import { useState, useSyncExternalStore } from "react";
import { formatDate } from "@/lib/blesc/labels";
import { AS_OF, MEETING_MEMOS } from "@/lib/teachers/fixtures";
import { useSchoolSettings } from "@/lib/teachers/store";
import type { MeetingMemo } from "@/lib/teachers/types";
import { styles } from "./parts";

const KEY = "blesc:meeting-memos";
const EVENT = "blesc:meeting-memos";

let cachedRaw: string | null | undefined;
let cached: MeetingMemo[] = [];

function added(): MeetingMemo[] {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    cached = raw ? (JSON.parse(raw) as MeetingMemo[]) : [];
  } catch {
    cached = [];
  }
  return cached;
}

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify);
  return () => window.removeEventListener(EVENT, notify);
};

const EMPTY: MeetingMemo[] = [];

/** 書いた人ごとの面談メモ。fixtures と、このタブで足したもの。 */
export function useMemos(author: string): MeetingMemo[] {
  const extra = useSyncExternalStore(subscribe, added, () => EMPTY);
  return [...MEETING_MEMOS, ...extra].filter((memo) => memo.author === author).sort((a, b) => b.date.localeCompare(a.date));
}

function save(memo: MeetingMemo) {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify([...added(), memo]));
  } catch {
    // 保存できなくても、画面の操作は止めない。
  }
  window.dispatchEvent(new Event(EVENT));
}

export function MemoPanel({
  subject,
  author,
}: {
  subject: MeetingMemo["subject"];
  author: string;
}) {
  const settings = useSchoolSettings();
  const memos = useMemos(author).filter((memo) => memo.subject.id === subject.id);
  const [date, setDate] = useState(AS_OF);
  const [body, setBody] = useState("");
  const [nextCheck, setNextCheck] = useState("");

  const handover =
    subject.kind === "student"
      ? settings.studentMemoHandover
        ? "担任が替わるときは、後任の担任へ引き継がれます（学校の設定）。"
        : "担任が替わっても、後任へは引き継がれません（学校の設定）。"
      : settings.staffMemoHandover
        ? "この先生が異動するときは、異動先の管理職へ引き継がれます（学校の設定）。"
        : "この先生が異動しても、メモは引き継がれません（学校の設定）。";

  return (
    <div className="bl-stack" style={{ gap: 18 }}>
      <p className={styles.note}>
        {subject.kind === "student" ? "生徒" : "先生"}本人には表示されません。{handover}
      </p>

      {memos.length === 0 ? (
        <p className={styles.note}>まだ面談メモはありません。</p>
      ) : (
        <ol className={styles.records}>
          {memos.map((memo) => (
            <li key={memo.id} className={styles.record}>
              <span className={styles.recordDate}>{formatDate(memo.date)}</span>
              <div className={styles.recordBody}>
                <p className={styles.recordText}>{memo.body}</p>
                {memo.nextCheck && (
                  <p className={styles.recordMeta}>
                    <span className={styles.fieldLabel} style={{ fontSize: "0.8rem" }}>
                      次回確かめたいこと
                    </span>
                    {memo.nextCheck}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <form
        className="bl-stack"
        style={{ gap: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!body.trim()) return;
          save({ id: `m-${Date.now()}`, subject, date, body: body.trim(), nextCheck: nextCheck.trim(), author });
          setBody("");
          setNextCheck("");
        }}
      >
        <h3 className={styles.fieldLabel}>面談メモを書く</h3>
        <label className="bl-stack" style={{ gap: 6 }}>
          <span className={styles.note}>面談日</span>
          <input type="date" className={styles.input} value={date} max={AS_OF} onChange={(e) => setDate(e.target.value)} style={{ maxWidth: 200 }} />
        </label>
        <label className="bl-stack" style={{ gap: 6 }}>
          <span className={styles.note}>メモ</span>
          <textarea className={styles.textarea} style={{ minHeight: 110 }} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label className="bl-stack" style={{ gap: 6 }}>
          <span className={styles.note}>次回の面談で確かめたいこと</span>
          <input className={styles.input} value={nextCheck} onChange={(e) => setNextCheck(e.target.value)} />
        </label>
        <div className={styles.saveRow}>
          <button type="submit" className="bl-btn bl-btn--primary" disabled={!body.trim()}>
            メモを保存
          </button>
        </div>
      </form>
    </div>
  );
}
