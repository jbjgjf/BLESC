"use client";

/**
 * 担当教職員の一覧（C-1）。生徒のクラス一覧（B-1）と同じ組み立てで、対象が
 * 先生になる。並びの既定は五十音順。「変化あり」の決め方も生徒と同じで、
 * リスクの表現は使わない。
 *
 * 業務タグの比率は、本人がその日に選んだタグを数えただけのもの。自動で
 * 分類はしていない。
 *
 * 先生の記録なので、印刷・CSV出力・一括ダウンロードはできない（C-5）。
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { AS_OF, MANAGERS, PERSONAS, STAFF } from "@/lib/teachers/fixtures";
import { compareRecentWindows } from "@/lib/teachers/records";
import { useSchoolSettings } from "@/lib/teachers/store";
import { ChangeMark, ChangeRuleNote, LastRecord, NoExport, NoExportNote, PageHead, RoleGate, Sparkline, styles } from "@/components/teachers/parts";
import { WorkLegend, WorkRatio } from "@/components/teachers/WorkRatio";

type Sort = "kana" | "recent";

export default function StaffPage() {
  return (
    <RoleGate allow={["manager"]}>
      <NoExport>
        <StaffList />
      </NoExport>
    </RoleGate>
  );
}

function StaffList() {
  const settings = useSchoolSettings();
  const [sort, setSort] = useState<Sort>("kana");
  const rows = useMemo(() => {
    const withData = STAFF.map((member) => ({
      member,
      last: member.records.at(-1)?.date ?? null,
      change: compareRecentWindows(member.records, AS_OF),
    }));
    return [...withData].sort((a, b) =>
      sort === "kana"
        ? a.member.kana.localeCompare(b.member.kana, "ja")
        : (b.last ?? "").localeCompare(a.last ?? "") || a.member.kana.localeCompare(b.member.kana, "ja"),
    );
  }, [sort]);

  const me = PERSONAS.manager;
  if (!settings.staffReaders.vicePrincipal) {
    return (
      <div className={styles.page}>
        <PageHead
          kicker="先生の記録"
          title="担当教職員"
          lede={`学校の閲覧の設定で、${MANAGERS.vicePrincipal.title}は先生の記録を読まないことになっています。いま読める記録はありません。`}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <PageHead
        kicker="先生の記録"
        title="担当教職員"
        lede={`${me.name}（${me.title}）が読める先生の記録です。本人の画面には、あなたが読めることが常に表示されています。`}
      >
        <NoExportNote />
      </PageHead>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <ChangeRuleNote />
          <span className={styles.spacer} />
          <label className={styles.note} data-bl-term="並び">
            並び{" "}
            <select className={styles.input} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="kana">五十音順</option>
              <option value="recent">直近の記録日が新しい順</option>
            </select>
          </label>
        </div>
        <WorkLegend />

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">名前</th>
                <th scope="col">担当</th>
                <th scope="col">直近の記録</th>
                <th scope="col">気分（8週）</th>
                <th scope="col">業務タグ（本人の申告）</th>
                <th scope="col">変化</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ member, last, change }) => (
                <tr key={member.id}>
                  <td>
                    <Link href={`/educator/staff/${member.id}`} className={styles.rowLink}>
                      {member.name}
                    </Link>
                  </td>
                  <td className={styles.muted}>{member.duty}</td>
                  <td className={styles.muted}><LastRecord date={last} /></td>
                  <td>
                    <Sparkline records={member.records} label={member.name} />
                  </td>
                  <td>
                    <WorkRatio records={member.records} label={member.name} />
                  </td>
                  <td>
                    <ChangeMark result={change} />
                    {change.status === "insufficient" && <span className={styles.muted}>判定なし</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
