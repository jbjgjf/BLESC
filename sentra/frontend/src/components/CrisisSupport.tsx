/**
 * The hotlines a student is shown when what they wrote reads as crisis or
 * elevated (#465).
 *
 * The site promises this in so many words — 「生徒の画面に、相談窓口がすぐに表示
 * されます（例：文部科学省「24時間子供SOSダイヤル」0120-0-78310）」 — and the
 * journal, the main way a student writes, used to show nothing at all: the
 * assessment ran, the escalation was recorded, and the student saw the
 * ordinary "thank you" screen.
 *
 * Every number is a `tel:` link, so a student on a phone reaches it in one tap.
 * The list comes from `CRISIS_HOTLINES`, the same constant the chat and voice
 * responses are tested against, so the three surfaces cannot drift apart.
 */

import { Icon } from "@/components/ui/Icon";
import { CRISIS_HOTLINES } from "@/lib/safety-assessment";
import { t } from "@/lib/i18n";

export function CrisisSupport({ level }: { level: "crisis" | "elevated" }) {
  return (
    <section className="bl-notice bl-notice--alert" role="alert" style={{ textAlign: "left", width: "100%" }}>
      <Icon name="call" size={19} fill />
      <div className="bl-stack" style={{ gap: 8 }}>
        <strong>{level === "crisis" ? t.safety.support.crisisTitle : t.safety.support.elevatedTitle}</strong>
        <span>{level === "crisis" ? t.safety.support.crisisLead : t.safety.support.elevatedLead}</span>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
          {CRISIS_HOTLINES.map((hotline) => (
            <li key={hotline.id}>
              <a href={hotline.tel} style={{ color: "inherit", fontWeight: 700 }}>
                {hotline.name} {hotline.number}
              </a>
              <span>
                {" "}
                （{hotline.hours}・{hotline.when}）
              </span>
            </li>
          ))}
        </ul>
        <span className="bl-micro">{t.common.notClinicalService}</span>
      </div>
    </section>
  );
}
