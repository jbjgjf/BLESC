"use client";

/**
 * 設定（UI仕様書 8-1）。権限や名簿はここでは変えない — 学校からの依頼で
 * Blesc が代わりに設定する（8-2）。ここで見られるのは、自分の記録を読める人と、
 * 自分が読める範囲。変えられるのはお知らせだけで、記録を催促するお知らせは無い。
 */

import { useAuth } from "@/lib/auth";
import { Icon } from "@/components/ui/Icon";
import { CLASSES, classById, readersOfStaff, staffById } from "@/lib/teachers/fixtures";
import { setNoticePrefs, useNoticePrefs, usePersona } from "@/lib/teachers/store";
import type { Persona } from "@/lib/teachers/types";
import { PageHead, styles } from "@/components/teachers/parts";

const WEEKDAYS = ["月", "火", "水", "木", "金"];

function studentScope(persona: Persona): string {
  const scope = persona.access.students;
  if (!scope) return "なし";
  if (scope.classIds.length === CLASSES.length) return `全生徒（${scope.classIds.length * 38}名）`;
  if (scope.grade !== null) return `${scope.grade}年全体（${scope.classIds.length}クラス・${scope.classIds.length * 38}名）`;
  return scope.classIds.map((id) => `${classById(id)?.name}（38名）`).join("、");
}

export default function SettingsPage() {
  const persona = usePersona();
  const { signOut } = useAuth();
  const prefs = useNoticePrefs(persona.id);
  const me = persona.staffId ? staffById(persona.staffId) : null;
  const readers = me && persona.access.write ? readersOfStaff(me.id) : null;

  return (
    <div className={`${styles.page} ${styles.narrow}`}>
      <PageHead title="設定" />

      <dl className={styles.facts}>
        <dt>名前</dt>
        <dd>{persona.name}</dd>
        <dt>担当</dt>
        <dd>{persona.title}</dd>
        {readers && (
          <>
            <dt>私の記録を読める人</dt>
            <dd data-bl-term="私の記録を読める人">{readers.length === 0 ? "あなただけ" : readers.map((r) => `${r.name}（${r.title}）`).join("、")}</dd>
          </>
        )}
        <dt>私が読める範囲</dt>
        <dd data-bl-term="私が読める範囲">
          生徒：{studentScope(persona)}
          <br />
          先生：{persona.access.teachers ? `${persona.access.teachers.label}（${persona.access.teachers.staffIds.length}名）` : "なし"}
        </dd>
      </dl>
      <p className={styles.note}>名前・担当・読める範囲は、学校からの依頼をもとに Blesc が設定しています。変えたいときは学校の担当の先生にご相談ください。</p>

      <section className={styles.section} aria-labelledby="notice-title">
        <h2 id="notice-title" className={styles.h2}>
          お知らせ
        </h2>
        {(persona.access.students || persona.access.teachers) && (
          <>
            <label className={styles.toggle}>
              <input type="checkbox" checked={prefs.beforeMeeting} onChange={(e) => setNoticePrefs(persona.id, { ...prefs, beforeMeeting: e.target.checked })} />
              面談前日のお知らせ
            </label>
            <div className={styles.row}>
              <label className={styles.toggle}>
                <input type="checkbox" checked={prefs.weekly} onChange={(e) => setNoticePrefs(persona.id, { ...prefs, weekly: e.target.checked })} />
                週の確認のお知らせ
              </label>
              <select
                className={styles.select}
                aria-label="週の確認のお知らせを出す曜日"
                value={prefs.weekday}
                disabled={!prefs.weekly}
                onChange={(e) => setNoticePrefs(persona.id, { ...prefs, weekday: Number(e.target.value) })}
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i + 1}>
                    {w}曜日
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
        <p className={styles.note}>記録を催促するお知らせはありません。</p>
      </section>

      <section className={styles.section} aria-labelledby="docs-title">
        <h2 id="docs-title" className={styles.h2}>
          学校の資料
        </h2>
        {["記録の読み方ガイド", "気になる記述があったときの学校の手順"].map((title) => (
          <span key={title} className={styles.row} style={{ gap: 8 }}>
            <Icon name="description" size={20} />
            <span>{title}</span>
            <span className={styles.small}>（学校が登録した文書が開きます。デモには入っていません）</span>
          </span>
        ))}
      </section>

      <section className={styles.section}>
        <div>
          <button type="button" className={styles.button} onClick={() => void signOut().catch(() => undefined)}>
            <Icon name="logout" size={18} />
            ログアウト
          </button>
        </div>
      </section>
    </div>
  );
}
