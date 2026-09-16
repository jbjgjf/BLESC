"use client";

/**
 * What the student is shown about notifications sent on their behalf.
 *
 * The consent screen promises this in so many words: 「誰にいつ連絡が行ったかは、
 * あなた自身が『記録の閲覧』画面で確認できます」. Without this component that
 * sentence is false, and a false sentence on a consent screen shown to a minor
 * is worse than the missing feature it describes.
 *
 * The argument for showing it at all is the same one that justifies the
 * notification: a product that tells an adult something about a student and
 * then hides that from the student has taught them not to be honest with it.
 * The chat guardrails say "never promise secrecy" for the same reason.
 *
 * Read through RLS — `safety_escalations_select_own` and the deliveries policy
 * — so this component holds no authorisation logic. If a row reaches it, the
 * database decided the viewer may see it.
 */

import { useEffect, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { supabase } from "@/lib/supabase/client";
import { t } from "@/lib/i18n";

type Row = {
  id: string;
  risk_level: "elevated" | "crisis";
  surface: string;
  detected_at: string;
  status: "pending" | "delivered" | "failed" | "no_recipient";
  safety_escalation_deliveries: Array<{ channel: string; status: string; attempted_at: string }>;
};

export function SafetyNoticeLog() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("safety_escalations")
      .select("id, risk_level, surface, detected_at, status, safety_escalation_deliveries(channel, status, attempted_at)")
      .order("detected_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setFailed(true);
          return;
        }
        setRows((data ?? []) as Row[]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Nothing to say is the common case and the good one. A heading followed by
  // "no records" on every visit turns a rare event into a looming one.
  if (failed || !rows || rows.length === 0) return null;

  return (
    <section className="bl-card bl-stack bl-rise">
      <div className="bl-card-head">
        <Icon name="notifications_active" size={21} />
        <h2 className="bl-h2">{t.audit.safetyNoticeTitle}</h2>
      </div>

      <p className="bl-body">{t.audit.safetyNoticeIntro}</p>

      <ul className="bl-stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 12 }}>
        {rows.map((row) => {
          const reached = row.safety_escalation_deliveries.filter((d) => d.status === "delivered");
          return (
            <li key={row.id} className="bl-stack" style={{ gap: 3 }}>
              <span className="bl-body">
                {new Date(row.detected_at).toLocaleString("ja-JP")} ・{" "}
                {t.audit.safetyNoticeSurface[row.surface] ?? row.surface}
              </span>
              <span className="bl-micro">
                {reached.length > 0
                  ? t.audit.safetyNoticeDelivered(reached.length)
                  : t.audit.safetyNoticeNotDelivered}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="bl-micro">{t.audit.safetyNoticeFooter}</p>
    </section>
  );
}
