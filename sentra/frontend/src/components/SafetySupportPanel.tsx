import { EMERGENCY_LINES, SOS_DIAL } from "@/lib/crisisContacts";
import type { SafetySupport } from "@/lib/safetySupport";

/**
 * The support lines, as text a student can read and links a phone can dial
 * (#465). The body is the assessment's response, which already names the
 * numbers; the links repeat them so they are one tap away rather than to be
 * copied out of a sentence.
 */
export function SafetySupportPanel({ support }: { support: SafetySupport }) {
  const lines = support.level === "crisis"
    ? [...EMERGENCY_LINES, SOS_DIAL]
    : [SOS_DIAL, ...EMERGENCY_LINES];
  return (
    <section
      role={support.level === "crisis" ? "alert" : "status"}
      aria-label="相談できるところ"
      className="bl-card"
      style={{ textAlign: "left", borderLeft: "3px solid var(--terracotta, #c0583f)", padding: "18px 20px", width: "100%", maxWidth: 520 }}
    >
      <p className="bl-body" style={{ margin: 0 }}>{support.body}</p>
      <ul style={{ listStyle: "none", margin: "14px 0 0", padding: 0, display: "grid", gap: 8 }}>
        {lines.map((line) => (
          <li key={line.tel}>
            <a href={line.tel} className="bl-btn bl-btn--secondary" style={{ width: "100%", justifyContent: "space-between" }}>
              <span>{line.name}</span>
              <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>{line.number}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
