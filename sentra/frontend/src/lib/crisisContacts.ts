/**
 * The phone numbers a student is given when they write something that suggests
 * danger (#465).
 *
 * One place, because three surfaces show them — the chat reply, the journal's
 * crisis card, and the spoken voice reply — and blesc.jp promises the same
 * number on its 「安全とプライバシー」 page (`BLESC-website` `src/lib/trust.ts`,
 * `SOS_DIAL`). Before this, no surface named any number at all.
 *
 * The response text in `safety-assessment.ts` is built from these values, and
 * `sentra/shared/safety_assessment_conformance.json` carries that text to the
 * FastAPI path, so a number changed here fails the conformance test until the
 * contract is regenerated.
 *
 * **Checking the numbers.** `checkedOn` is the last date someone compared these
 * against the official source and found them unchanged. The issue asks a named
 * person to do that from the official page; until they have, `confirmedBy` is
 * null and the check below is only the one recorded here.
 */

export type CrisisContact = {
  /** As a student should read it. */
  name: string;
  /** As written on the official page, hyphens included. */
  number: string;
  /** For a `tel:` link: digits only. */
  tel: string;
  hours: string;
};

export const CHILD_SOS_DIAL: CrisisContact = {
  name: "24時間子供SOSダイヤル",
  number: "0120-0-78310",
  tel: "tel:0120078310",
  hours: "24時間・無料",
};

/** When the danger is happening now. */
export const EMERGENCY_NUMBERS = {
  ambulance: { name: "救急", number: "119", tel: "tel:119", hours: "24時間" },
  police: { name: "警察", number: "110", tel: "tel:110", hours: "24時間" },
} as const satisfies Record<string, CrisisContact>;

export const CRISIS_CONTACTS_PROVENANCE = {
  /** 文部科学省「24時間子供SOSダイヤル」(なやみ言おう). */
  source: "https://www.mext.go.jp/a_menu/shotou/seitoshidou/06112216.html",
  checkedOn: "2026-10-19",
  /** The person who confirmed the numbers from the official page. */
  confirmedBy: null as string | null,
} as const;

/** Digits only, after width folding, so 「０１２０－０－７８３１０」 still counts. */
function digits(text: string): string {
  return text.normalize("NFKC").replace(/\D/g, "");
}

/**
 * Whether `text` already gives the student the child SOS line. Used by the
 * chat and voice floors: a model reply that says "talk to a trusted adult" but
 * names no number has not given the student what the canned response gives.
 */
export function mentionsChildSosDial(text: string): boolean {
  return digits(text).includes(digits(CHILD_SOS_DIAL.number));
}
