// Opens every screen in a real browser and reports what a reader would see.
//
// The message-catalogue work (#116) can be checked by reading source: the
// `Japanese UI` test does exactly that. What reading cannot check is the half
// that Japanese actually breaks — a translated label is longer or shorter than
// the English it replaced, so it wraps where nothing wrapped before, clips
// inside a fixed-width button, or pushes a row past the viewport on a phone.
// The review matrix calls that step 実機での確認, and it is the one thing
// standing between every screen's 文脈 and 完了.
//
// This is the runner for it. It is deliberately not a test: it reports, and a
// person reads the report and decides. A clipped label may be intended
// (`text-overflow: ellipsis` on a name column is a design decision); an
// unlabelled icon button is not.
//
//   node scripts/ui-display-qa.mjs --base-url http://localhost:3000
//
// Add `--json` for machine-readable output.

import { chromium } from "playwright";

/**
 * The screens, and who reads them.
 *
 * Every one is visited with `?demo=1`. Without it an unauthenticated visit to
 * `/journal` or `/educator/roster` renders the login gate, and the run reports
 * a clean bill of health for 24 screens it never actually opened — which is
 * exactly what the first version of this script did. Demo mode fills each
 * screen with the fixed data, so the layout under measurement is a populated
 * one. What it does not cover is the states only real data produces: long
 * free-text entries, an empty roster, a school name that does not fit. Those
 * still need a person with an account.
 */
const SCREENS = [
  { path: "/", audience: "生徒" },
  { path: "/journal", audience: "生徒" },
  { path: "/reflect", audience: "生徒" },
  { path: "/chat", audience: "生徒" },
  { path: "/timeline", audience: "生徒" },
  { path: "/insights", audience: "生徒" },
  { path: "/graph", audience: "生徒" },
  { path: "/recall", audience: "生徒" },
  { path: "/research", audience: "生徒" },
  { path: "/support-summary", audience: "生徒" },
  { path: "/sharing", audience: "生徒" },
  { path: "/audit", audience: "生徒" },
  { path: "/login", audience: "生徒・教員" },
  { path: "/demo", audience: "デモ" },
  { path: "/educator", audience: "教員" },
  { path: "/educator/roster", audience: "教員" },
  { path: "/educator/alerts", audience: "教員（デモ専用）" },
  { path: "/educator/class", audience: "教員（デモ専用）" },
  { path: "/educator/meetings", audience: "教員（デモ専用）" },
  { path: "/school", audience: "教員（デモ専用）" },
  { path: "/oversight", audience: "支援担当" },
  { path: "/guardian", audience: "保護者" },
  { path: "/evaluation", audience: "レビュー担当" },
  { path: "/pilot/join", audience: "参加者" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

/**
 * Runs inside the page. Everything here is measured from what was laid out,
 * not from what the source says, which is the whole point of the exercise.
 */
function inspect() {
  const findings = [];

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };

  // Text wider than the box drawn around it. With `ellipsis` the reader at
  // least sees that something was cut; with `clip` or `hidden` the sentence
  // simply ends.
  //
  // The scan is over the element that *does* the clipping, not over the text
  // element inside it. An inline `<span>` reports `clientWidth` 0 whatever it
  // contains, so measuring the span — the obvious thing to write, and the
  // first version of this file — silently finds nothing. Clipping is a
  // property of the box with `overflow` on it, which is usually the parent.
  //
  // Two things overflow a hidden box without anything being wrong, and both
  // showed up on the first real run:
  //
  //   - A visually-hidden label: 1px square with a `clip` rect, present so a
  //     screen reader can announce a state the sighted user reads from an
  //     icon. Reporting it would train the reader of this report to skim.
  //   - A layout root whose decorative background — an absolutely positioned
  //     SVG wider than the page — is what `scrollWidth` is measuring, not its
  //     text. Only boxes whose own text is what overflows are of interest, so
  //     the scan asks for a leaf, or for an element that has declared it
  //     handles long text (`nowrap` / `text-overflow`).
  for (const el of document.querySelectorAll("*")) {
    if (!visible(el)) continue;
    const style = getComputedStyle(el);
    if (style.overflowX !== "hidden" && style.overflowX !== "clip") continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) continue; // visually hidden

    const isTextBox =
      el.childElementCount === 0 ||
      style.whiteSpace === "nowrap" ||
      style.textOverflow === "ellipsis";
    if (!isTextBox) continue;

    const text = (el.textContent ?? "").trim();
    if (!text) continue;
    findings.push({
      kind: style.textOverflow === "ellipsis" ? "ellipsis" : "clipped",
      tag: el.tagName.toLowerCase(),
      text: text.slice(0, 60),
      overflowBy: el.scrollWidth - el.clientWidth,
    });
  }

  // An interactive element a screen reader cannot announce. An icon-only
  // button reads as "button" and nothing else.
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea")) {
    if (!visible(el)) continue;
    const name =
      (el.getAttribute("aria-label") ?? "") ||
      (el.getAttribute("title") ?? "") ||
      (el.textContent ?? "").trim() ||
      (el.getAttribute("placeholder") ?? "") ||
      (el.labels?.length ? Array.from(el.labels).map((l) => l.textContent).join(" ").trim() : "");
    if (name) continue;
    findings.push({ kind: "unlabelled", tag: el.tagName.toLowerCase(), text: el.outerHTML.slice(0, 80) });
  }

  // Text a reader would see in English. Latin letters are normal inside
  // product names and identifiers, so this looks for runs of English words
  // rather than for any Latin character at all.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const english = new Set();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !visible(parent)) continue;
    if (["SCRIPT", "STYLE", "CODE", "PRE"].includes(parent.tagName)) continue;
    const text = (node.textContent ?? "").trim();
    if (!text || /[ぁ-んァ-ン一-龥]/.test(text)) continue;
    if (/\b[A-Za-z]{3,}\b(\s+\b[A-Za-z]{2,}\b){2,}/.test(text)) english.add(text.slice(0, 80));
  }
  for (const text of english) findings.push({ kind: "english", text });

  return {
    lang: document.documentElement.lang,
    title: document.title,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    findings,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const baseUrl = args.includes("--base-url") ? args[args.indexOf("--base-url") + 1] : "http://localhost:3000";
  const asJson = args.includes("--json");

  // `CHROMIUM_PATH` is for environments that ship a browser rather than let
  // Playwright download one; without it, Playwright resolves its own.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const report = [];

  for (const screen of SCREENS) {
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport, locale: "ja-JP" });
      const consoleErrors = [];
      page.on("pageerror", (error) => consoleErrors.push(String(error.message)));

      const url = `${baseUrl}${screen.path}?demo=1`;
      let result;
      try {
        const response = await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(300);
        result = { status: response?.status() ?? 0, ...(await page.evaluate(inspect)) };
        // The login gate renders cleanly at every width, so a run that hit it
        // would report success without having measured the screen.
        result.gated = await page.evaluate(() => document.body.innerText.includes("ログインしてはじめる"));
      } catch (error) {
        result = { status: 0, error: String(error.message).split("\n")[0], findings: [] };
      }

      report.push({ ...screen, viewport: viewport.name, url, consoleErrors, ...result });
      await page.close();
    }
  }

  await browser.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  let problems = 0;
  for (const row of report) {
    const notes = [];
    if (row.error) notes.push(`load failed: ${row.error}`);
    if (row.status && row.status >= 400) notes.push(`HTTP ${row.status}`);
    if (row.gated) notes.push("not measured: the login gate rendered instead of the screen");
    if (row.lang && row.lang !== "ja") notes.push(`lang="${row.lang}"`);
    if (row.horizontalOverflow) notes.push("horizontal overflow");
    for (const finding of row.findings ?? []) {
      if (finding.kind === "clipped") notes.push(`clipped ${finding.tag} (+${finding.overflowBy}px): ${finding.text}`);
      if (finding.kind === "ellipsis") notes.push(`ellipsis ${finding.tag}: ${finding.text}`);
      if (finding.kind === "unlabelled") notes.push(`unlabelled ${finding.tag}: ${finding.text}`);
      if (finding.kind === "english") notes.push(`english: ${finding.text}`);
    }
    for (const error of row.consoleErrors ?? []) notes.push(`page error: ${error}`);

    if (notes.length === 0) continue;
    problems += notes.length;
    console.log(`\n${row.path} [${row.viewport}] — ${row.audience}`);
    for (const note of notes) console.log(`  - ${note}`);
  }

  console.log(`\n${report.length} screen/viewport combinations, ${problems} things to look at.`);
}

await main();
