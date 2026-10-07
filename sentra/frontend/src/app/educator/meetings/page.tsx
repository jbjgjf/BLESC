"use client";

/**
 * 面談メモの一覧（B-4 / C-4）。
 *
 * 見られるのは、自分が書いたメモだけ。担任は生徒との面談、管理職は先生との
 * 面談のメモが並ぶ。「次回確かめたいこと」を並べておくと、次に話すときの
 * 手がかりになる。
 *
 * 管理職のメモは先生についての記録なので、書き出し・印刷はできない（C-5）。
 */

import Link from "next/link";
import { formatDate } from "@/lib/blesc/labels";
import { PERSONAS } from "@/lib/teachers/fixtures";
import { useTeacherRole } from "@/lib/teachers/store";
import { NoExport, NoExportNote, PageHead, RoleGate, styles } from "@/components/teachers/parts";
import { useMemos } from "@/components/teachers/MemoPanel";

export default function MeetingsPage() {
  return (
    <RoleGate allow={["homeroom", "manager"]}>
      <Meetings />
    </RoleGate>
  );
}

function Meetings() {
  const role = useTeacherRole();
  const me = PERSONAS[role];
  const memos = useMemos(me.name);
  const staff = role === "manager";

  const list = (
    <div className={styles.page}>
      <PageHead
        kicker={staff ? "先生との面談" : "生徒との面談"}
        title="面談メモ"
        lede={`${me.name}さんが書いたメモだけが並びます。${staff ? "先生" : "生徒"}本人には表示されません。`}
      >
        {staff && <NoExportNote />}
      </PageHead>

      <section className={styles.section}>
        {memos.length === 0 ? (
          <p className={styles.note}>まだ面談メモはありません。{staff ? "教職員" : "クラス"}の一覧から、本人の画面を開いて書けます。</p>
        ) : (
          <ol className={styles.records}>
            {memos.map((memo) => (
              <li key={memo.id} className={styles.record}>
                <span className={styles.recordDate}>{formatDate(memo.date)}</span>
                <div className={styles.recordBody}>
                  <Link
                    href={memo.subject.kind === "student" ? `/educator/student/${memo.subject.id}` : `/educator/staff/${memo.subject.id}`}
                    className={styles.rowLink}
                  >
                    {memo.subject.name}
                  </Link>
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
      </section>
    </div>
  );

  return staff ? <NoExport>{list}</NoExport> : list;
}
