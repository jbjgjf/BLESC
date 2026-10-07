"use client";

/**
 * 利用状況（D-5）。
 *
 * 学期ごとに、クラスごとの記録率と、先生全体の記録率（集計値ひとつ）だけを
 * 出す。個人別の記録率は出さない。クラスはクラスの順に並べ、記録率で
 * 並べ替えたり、高い・低いを色で示したりしない — 並べた瞬間に順位になる。
 */

import { USAGE_REPORT } from "@/lib/teachers/fixtures";
import { PageHead, RoleGate, styles } from "@/components/teachers/parts";

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export default function UsagePage() {
  return (
    <RoleGate allow={["admin"]}>
      <div className={styles.page}>
        <PageHead
          kicker="学校の設定"
          title="利用状況"
          lede="記録率は、記録できた日のうち記録があった日の割合です。個人別の記録率は出しません。クラスの順位も付けません。"
        />

        {USAGE_REPORT.terms.map((term) => (
          <section key={term.term} className={styles.section}>
            <h2 className={styles.h2}>{term.term}</h2>
            <div className={styles.tableWrap}>
              <table className={styles.table} style={{ minWidth: 320 }}>
                <thead>
                  <tr>
                    <th scope="col">クラス</th>
                    <th scope="col">記録率</th>
                  </tr>
                </thead>
                <tbody>
                  {term.classes.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td style={{ fontVariantNumeric: "tabular-nums" }}>{percent(row.rate)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td>先生（全体）</td>
                    <td style={{ fontVariantNumeric: "tabular-nums" }}>{percent(term.teachers)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </RoleGate>
  );
}
