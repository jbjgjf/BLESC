/**
 * The support lines a student sees when the safety assessment returns crisis
 * or elevated (#465).
 *
 * blesc.jp promises that a student who writes about self-harm or immediate
 * danger sees a support line on screen, naming 文部科学省「24時間子供SOSダイヤル」
 * 0120-0-78310. The canned responses used to say 「緊急サービス（emergency
 * services）」 and 「信頼できる大人（trusted adult）」 — no name, no number, and
 * half of it in English — so the promise was not kept on any of the three
 * surfaces that carry them (chat, the journal's crisis card, voice).
 *
 * Kept in one place because three things must agree with it:
 *
 * - `sentra/shared/crisis_contacts.json`, which the FastAPI path and
 *   jbjgjf/BLESC-website's CI read. `tests/crisis-contacts.test.mjs` compares
 *   the two field by field.
 * - The crisis and elevated responses in `safety-assessment.ts`, which are
 *   built from these values rather than retyped.
 * - The journal's support panel, which renders the `tel:` links.
 *
 * The number and hours have to be read off the official page by a person;
 * `verification` in the shared file records who did and when.
 */

export interface CrisisLine {
  readonly name: string;
  readonly number: string;
  readonly tel: string;
}

export const SOS_DIAL = {
  name: "24時間子供SOSダイヤル",
  operator: "文部科学省",
  number: "0120-0-78310",
  tel: "tel:0120078310",
  hours: "24時間",
  fee: "無料",
} as const;

/** For immediate danger. Listed after the dial in the panel, first in the crisis text. */
export const EMERGENCY_LINES: readonly CrisisLine[] = [
  { name: "救急", number: "119", tel: "tel:119" },
  { name: "警察", number: "110", tel: "tel:110" },
];

/** 「24時間子供SOSダイヤル（0120-0-78310、24時間・無料）」 — how the responses name the dial. */
export const SOS_DIAL_PHRASE = `${SOS_DIAL.name}（${SOS_DIAL.number}、${SOS_DIAL.hours}・${SOS_DIAL.fee}）`;

/** 「119（救急）か110（警察）」 */
export const EMERGENCY_PHRASE = EMERGENCY_LINES.map((line) => `${line.number}（${line.name}）`).join("か");

/**
 * Whether a reply already gives the student the dial's number.
 *
 * The chat and voice floors used to skip the canned response whenever the
 * model's reply mentioned any real person — 「信頼できる大人」 was enough. That
 * is a route, but not the one the site promises, so a model that said "talk to
 * a trusted adult" silenced the only text carrying a number. The floor now
 * steps aside only when the number itself is already there. Hyphens, spaces
 * and full-width digits are ignored, since a model writes the number however
 * it likes.
 */
export function namesSosDial(text: string): boolean {
  const digits = text.normalize("NFKC").replace(/[\s\-‐‑–—―ー－]/g, "");
  return digits.includes(SOS_DIAL.tel.slice("tel:".length));
}
