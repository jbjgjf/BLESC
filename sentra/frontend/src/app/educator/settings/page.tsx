"use client";

/**
 * 学校管理者向けの設定（D-1〜D-4）。
 *
 * 閲覧の権限を変えると、記録する本人の画面の「この記録を読める人」が
 * その場で変わる（D-1）。設定の画面にも、本人にどう見えるかをそのまま
 * 並べておく — 権限を変える人が、変えた結果を本人の目で確かめられるように。
 *
 * 先生の記録の書き出し（CSV・印刷・一括ダウンロード）を許す設定は、
 * 置いていない（C-5。学校の設定でも外せない決まり）。
 */

import { useState } from "react";
import {
  MANAGERS,
  RETENTION_LABEL,
  STUDENT_READERS,
  readersOfStudentRecords,
  readersOfTeacherRecords,
  type Retention,
  type SchoolSettings,
} from "@/lib/teachers/fixtures";
import { updateSchoolSettings, useSchoolSettings } from "@/lib/teachers/store";
import { PageHead, ReadersLine, RoleGate, styles } from "@/components/teachers/parts";

export default function SettingsPage() {
  return (
    <RoleGate allow={["admin"]}>
      <Settings />
    </RoleGate>
  );
}

const STAFF_READER_SCOPE: Record<keyof typeof MANAGERS, string> = {
  gradeHead: "自分の学年の先生",
  vicePrincipal: "すべての先生",
  principal: "すべての先生",
};

const EVENTS: Array<{ key: keyof SchoolSettings["retention"]; label: string }> = [
  { key: "graduation", label: "卒業" },
  { key: "transferOut", label: "転出" },
  { key: "transfer", label: "異動" },
  { key: "retirement", label: "退職" },
];

function Settings() {
  const settings = useSchoolSettings();

  return (
    <div className={styles.page}>
      <PageHead kicker="学校の設定" title="設定" lede="変更はこのタブの中にだけ保存されます（デモ）。" />

      {/* ── D-1 閲覧権限 ── */}
      <section className={styles.section}>
        <h2 className={styles.h2}>だれが記録を読めるか</h2>
        <p className={styles.note}>変更は、記録する本人の画面の「この記録を読める人」にすぐ反映されます。</p>

        <h3 className={styles.fieldLabel}>生徒の記録</h3>
        <div className={styles.checks}>
          <label>
            <input type="checkbox" checked disabled />
            担任（常に）
          </label>
          {(Object.keys(STUDENT_READERS) as Array<keyof typeof STUDENT_READERS>).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={settings.studentReaders[key]}
                onChange={(e) => updateSchoolSettings({ studentReaders: { ...settings.studentReaders, [key]: e.target.checked } })}
              />
              {STUDENT_READERS[key].title}（{STUDENT_READERS[key].name}）
            </label>
          ))}
        </div>
        <ReadersLine readers={readersOfStudentRecords(settings)} subject="生徒の画面では：自分の記録" />

        <h3 className={styles.fieldLabel} style={{ marginTop: 10 }}>
          先生の記録
        </h3>
        <div className={styles.checks}>
          {(Object.keys(MANAGERS) as Array<keyof typeof MANAGERS>).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={settings.staffReaders[key]}
                onChange={(e) => updateSchoolSettings({ staffReaders: { ...settings.staffReaders, [key]: e.target.checked } })}
              />
              {MANAGERS[key].title}（{MANAGERS[key].name}）が{STAFF_READER_SCOPE[key]}の記録を読む
            </label>
          ))}
        </div>
        <ReadersLine readers={readersOfTeacherRecords(settings)} subject="山本先生の画面では：この記録" />
        <p className={styles.note}>先生の記録・サマリー・面談メモの印刷・CSV出力・一括ダウンロードは、この設定では有効にできません。</p>
      </section>

      {/* ── 面談メモの引き継ぎ（B-4 / C-4） ── */}
      <section className={styles.section}>
        <h2 className={styles.h2}>面談メモの引き継ぎ</h2>
        <div className={styles.checks} style={{ flexDirection: "column", alignItems: "flex-start" }}>
          <label>
            <input
              type="checkbox"
              checked={settings.studentMemoHandover}
              onChange={(e) => updateSchoolSettings({ studentMemoHandover: e.target.checked })}
            />
            担任が替わるとき、生徒の面談メモを後任の担任へ引き継ぐ
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.staffMemoHandover}
              onChange={(e) => updateSchoolSettings({ staffMemoHandover: e.target.checked })}
            />
            先生が異動するとき、管理職の面談メモを異動先へ引き継ぐ（原則は引き継がない）
          </label>
        </div>
      </section>

      {/* ── D-2 名簿 ── */}
      <RosterImport />

      {/* ── D-3 記録の時間とお知らせ ── */}
      <section className={styles.section}>
        <h2 className={styles.h2}>記録の時間とお知らせ</h2>
        <div className={styles.saveRow}>
          <label className={styles.note}>
            帰りのHR{" "}
            <input
              type="time"
              className={styles.input}
              value={settings.reminder.time}
              onChange={(e) => updateSchoolSettings({ reminder: { ...settings.reminder, time: e.target.value } })}
            />
          </label>
          <label className={styles.checks}>
            <span>
              <input
                type="checkbox"
                checked={settings.reminder.enabled}
                onChange={(e) => updateSchoolSettings({ reminder: { ...settings.reminder, enabled: e.target.checked } })}
              />{" "}
              この時刻に1日1回お知らせする
            </span>
          </label>
        </div>
        <p className={styles.note}>記録しない日が続いても、管理職へのお知らせは送りません（この設定では変えられません）。</p>
      </section>

      {/* ── D-4 データの保持と削除 ── */}
      <section className={styles.section}>
        <h2 className={styles.h2}>データの保持と削除</h2>
        <dl className={styles.facts}>
          {EVENTS.map((event) => (
            <div key={event.key} style={{ display: "contents" }}>
              <dt>{event.label}のあと</dt>
              <dd>
                <select
                  className={styles.input}
                  value={settings.retention[event.key]}
                  onChange={(e) => updateSchoolSettings({ retention: { ...settings.retention, [event.key]: e.target.value as Retention } })}
                >
                  {(Object.keys(RETENTION_LABEL) as Retention[]).map((r) => (
                    <option key={r} value={r}>
                      {RETENTION_LABEL[r]}
                    </option>
                  ))}
                </select>
              </dd>
            </div>
          ))}
        </dl>
        <p className={styles.note}>契約が終わるときは、この学校のデータをすべて完全に削除します。手続きは Blesc の運用担当と一緒に行います。</p>
        <div>
          <button type="button" className="bl-btn bl-btn--secondary" disabled>
            一括削除の手続きを始める（デモでは押せません）
          </button>
        </div>
      </section>
    </div>
  );
}

/* ── D-2 名簿の取り込み ─────────────────────────── */

const ROSTERS = {
  students: { label: "生徒名簿", columns: ["学年", "組", "出席番号", "氏名"] },
  staff: { label: "教職員名簿", columns: ["氏名", "よみ", "担当"] },
} as const;

type RosterKind = keyof typeof ROSTERS;

function parseCsv(text: string): string[][] {
  return text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => line.split(",").map((cell) => cell.trim().replace(/^"(.*)"$/, "$1")));
}

function RosterImport() {
  const [kind, setKind] = useState<RosterKind>("students");
  const [preview, setPreview] = useState<{ name: string; rows: string[][]; missing: string[] } | null>(null);
  const expected = ROSTERS[kind].columns;

  return (
    <section className={styles.section}>
      <h2 className={styles.h2}>名簿の取り込み</h2>
      <div className={styles.segmented} role="group" aria-label="名簿の種類">
        {(Object.keys(ROSTERS) as RosterKind[]).map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={kind === key}
            onClick={() => {
              setKind(key);
              setPreview(null);
            }}
          >
            {ROSTERS[key].label}
          </button>
        ))}
      </div>
      <p className={styles.note}>
        CSV の1行目に「{expected.join("・")}」の列を置いてください。クラス替え・転出入・異動・退職に伴う更新は、Blesc の運用担当が代わりに行うこともできます。
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          const rows = parseCsv(await file.text());
          const header = rows[0] ?? [];
          setPreview({ name: file.name, rows, missing: expected.filter((column) => !header.includes(column)) });
        }}
      />
      {preview && (
        <div className="bl-stack" style={{ gap: 10 }}>
          {preview.missing.length > 0 ? (
            <p className={styles.note}>「{preview.missing.join("・")}」の列が見つかりません。1行目の見出しを確かめてください。</p>
          ) : (
            <p className={styles.note}>
              {preview.name}：{preview.rows.length - 1}件。最初の5件を表示しています。
            </p>
          )}
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {(preview.rows[0] ?? []).map((cell, i) => (
                    <th key={i} scope="col">
                      {cell}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(1, 6).map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <button type="button" className="bl-btn bl-btn--primary" disabled>
              取り込む（デモでは取り込みません）
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
