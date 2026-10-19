"use client";

import { CHILD_SOS_DIAL, EMERGENCY_NUMBERS } from "@/lib/crisisContacts";
import { t } from "@/lib/i18n";

/**
 * The support response, with numbers a student can tap (#465).
 *
 * Shown on the journal after an entry the deterministic layer graded crisis or
 * elevated. Before this, the journal showed the student nothing: the response
 * existed only in the stored card, on a screen students do not open.
 */
export function SupportNotice({ message }: { message: string }) {
  if (!message) return null;
  const contacts = [CHILD_SOS_DIAL, EMERGENCY_NUMBERS.ambulance, EMERGENCY_NUMBERS.police];
  return (
    <section
      role="alert"
      aria-live="assertive"
      className="bl-card bl-stack"
      style={{ border: "2px solid var(--terracotta)", textAlign: "left" }}
    >
      <h2 className="bl-h2">{t.safety.supportNoticeTitle}</h2>
      <p className="bl-body">{message}</p>
      <ul className="bl-stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {contacts.map((contact) => (
          <li key={contact.tel}>
            <a className="bl-btn bl-btn--secondary" href={contact.tel}>
              {t.safety.callLink(contact.name, contact.number)}
            </a>
          </li>
        ))}
      </ul>
      <p className="bl-meta">{t.common.notClinicalService}</p>
    </section>
  );
}
