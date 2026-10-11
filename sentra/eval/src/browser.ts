// Frontend-path driver. Every action goes through the same routes a real
// user takes: /login, the Record & Chat UI, /support-summary, /sharing,
// /oversight, /evaluation. No API shortcuts, no auth/consent/RLS bypasses.

import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import { ja } from "../../frontend/src/lib/i18n/ja.ts";

/**
 * The product did not reach the state the next observation depends on, within
 * the time it is allowed.
 *
 * Thrown rather than swallowed: an observation taken anyway is graded as if the
 * product had been seen, and the failure lands on the product (a "missed"
 * recall, an empty summary) or, worse, on nobody (an unloaded oversight page
 * contains no leaked sentinel, so the privacy check passes). The runner records
 * the case as an error with failure kind `observation_not_ready` (#305).
 */
export class ObservationNotReady extends Error {
  readonly step: string;

  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.step = step;
  }
}

/**
 * How long a journal submission may take. `/api/entries` runs extraction
 * in-request with a 25 s internal deadline (28 s cap) inside a 60 s route
 * budget (#268); 90 s leaves room for a cold start without hiding a hang.
 */
export const JOURNAL_PROCESSING_TIMEOUT_MS = 90_000;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function openSession(baseUrl: string, options?: { video?: string; bypassSecret?: string }): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
    recordVideo: options?.video ? { dir: options.video } : undefined,
    // Vercel "Protection Bypass for Automation": lets the runner through the
    // deployment-protection wall while the eval deployment stays non-public.
    extraHTTPHeaders: options?.bypassSecret
      ? { "x-vercel-protection-bypass": options.bypassSecret, "x-vercel-set-bypass-cookie": "true" }
      : undefined,
  });
  const page = await context.newPage();
  return { browser, context, page };
}

export async function closeSession(session: BrowserSession): Promise<void> {
  await session.context.close();
  await session.browser.close();
}

export async function loginThroughUi(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(email);
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  // AuthShell redirects home once the session lands.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 30000 });
}

/** A reflection card as the product returned it for this journal. */
export interface SubmittedCard {
  type: string;
  status: string;
}

export interface JournalSubmission {
  entryId: string;
  /** The cards the product returned to render for this entry (#311). */
  reflectionCards: SubmittedCard[];
}

/** The journal submission itself — not `/entries/followups` or any other sub-route. */
function isEntrySubmission(response: Response): boolean {
  return response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/entries");
}

export async function submitJournal(page: Page, text: string): Promise<JournalSubmission> {
  await page.goto("/");
  // Record is one box with two prompts, and it opens on the free recall — the
  // order the probe's construct requires. Selecting the journal tab is what a
  // student does before writing the journal, so the harness does it too.
  // Without this the fill would land in the recall field; `journal-input` only
  // resolves while the journal prompt is showing, so that failure is loud.
  await page.getByTestId("record-tab-journal_entry").click();
  await page.getByTestId("journal-input").fill(text);

  // Extraction runs inside the POST, so its response is the moment the journal
  // is processed. This used to "wait" with `isEnabled({ timeout })`, which is an
  // instant query (the timeout only bounds finding the element) whose answer
  // was discarded, then a fixed 1.5 s sleep: every later observation was taken
  // against a journal the product had not finished with (#305). The listener
  // is armed before the click, and both run under Promise.all so a failed
  // click cannot leave the wait's rejection unhandled.
  const [response] = await Promise.all([
    page.waitForResponse(isEntrySubmission, { timeout: JOURNAL_PROCESSING_TIMEOUT_MS }).catch((error: unknown) => {
      throw new ObservationNotReady("journal",
        `the journal submission did not finish within ${JOURNAL_PROCESSING_TIMEOUT_MS / 1000}s (${error instanceof Error ? error.message : String(error)})`);
    }),
    page.getByTestId("journal-submit").click(),
  ]);
  if (!response.ok()) {
    throw new ObservationNotReady("journal", `the journal submission returned HTTP ${response.status()}`);
  }
  const body = (await response.json().catch(() => null)) as {
    supabase_sync?: { entry_id?: string | null };
    extraction?: { reflection_cards_json?: Array<{ type?: unknown; status?: unknown }> };
  } | null;
  const entryId = body?.supabase_sync?.entry_id;
  if (!entryId) throw new ObservationNotReady("journal", "the product returned no saved entry id");
  const reflectionCards = (body?.extraction?.reflection_cards_json ?? []).map((card) => ({
    type: String(card.type ?? ""),
    status: String(card.status ?? ""),
  }));
  return { entryId, reflectionCards };
}

export async function sendChatAndRead(page: Page, message: string): Promise<string> {
  await page.goto("/");
  await page.getByTestId("chat-input").fill(message);
  await page.getByTestId("chat-submit").click();
  const response = page.getByTestId("chat-response");
  await response.waitFor({ state: "visible", timeout: 120000 });
  // Rendered DOM is the observation surface.
  const text = (await response.innerText()).trim();
  return text;
}

export async function openSupportSummary(page: Page): Promise<string> {
  await page.goto("/support-summary");
  await page.getByTestId("generate-summary").click();
  await page.getByTestId("copy-summary").waitFor({ state: "visible", timeout: 60000 });
  return (await page.locator("main, body").first().innerText()).trim();
}

/**
 * /sharing renders its loading line until requests, shares and the access log
 * have loaded. Counting buttons before that answers "none yet", not "none"
 * (#305). The line's text comes from the product's catalogue.
 */
async function sharingLoaded(page: Page): Promise<void> {
  await page.getByText(ja.sharing.loading).first().waitFor({ state: "hidden", timeout: 30000 }).catch((error: unknown) => {
    throw new ObservationNotReady("sharing", `/sharing did not finish loading (${error instanceof Error ? error.message : String(error)})`);
  });
}

export async function grantConsentIfRequested(page: Page): Promise<boolean> {
  await page.goto("/sharing");
  await sharingLoaded(page);
  const grant = page.locator('[data-testid^="grant-consent-"]').first();
  if (await grant.count()) {
    await grant.click();
    await page.waitForTimeout(1200);
    return true;
  }
  return false;
}

export async function shareSummaryThroughUi(page: Page): Promise<boolean> {
  await page.goto("/support-summary");
  await page.getByTestId("generate-summary").click();
  const orgSelect = page.getByTestId("share-org-select");
  await orgSelect.waitFor({ state: "visible", timeout: 60000 }).catch(() => undefined);
  if (!(await orgSelect.count())) return false;
  const options = await orgSelect.locator("option").all();
  if (options.length < 2) return false;
  await orgSelect.selectOption({ index: 1 });
  await page.getByTestId("share-summary-submit").click();
  await page.getByTestId("share-confirmation").waitFor({ state: "visible", timeout: 30000 });
  return true;
}

export async function revokeAllSharesThroughUi(page: Page): Promise<number> {
  await page.goto("/sharing");
  await sharingLoaded(page);
  let revoked = 0;
  while (true) {
    const revoke = page.locator('[data-testid^="revoke-share-"]').first();
    if (!(await revoke.count())) break;
    await revoke.click();
    await page.waitForTimeout(1200);
    revoked += 1;
    if (revoked > 20) break;
  }
  return revoked;
}

export async function counselorReadOversight(page: Page): Promise<string> {
  await page.goto("/oversight");
  // This page is where the privacy checks look for a leaked sentinel and a
  // refusing student's code. A page that never loaded contains neither, so
  // reading it anyway passed both checks without performing them (#305).
  await page
    .locator('[data-testid="oversight-student-list"], [data-testid="oversight-empty"], [data-testid="oversight-summary"]')
    .first().waitFor({ state: "visible", timeout: 30000 }).catch((error: unknown) => {
      throw new ObservationNotReady("oversight", `/oversight did not load (${error instanceof Error ? error.message : String(error)})`);
    });
  await page.waitForTimeout(500);
  return (await page.locator("main, body").first().innerText()).trim();
}

// The reviewer pass keeps a soft wait on purpose: the caller only looks for the
// run label or the dashboard heading, so a page that did not load fails that
// check and the run cannot be "ready". The fallback errs the safe way.
export async function reviewerReadEvaluation(page: Page): Promise<string> {
  await page.goto("/evaluation");
  await page
    .locator('[data-testid="evaluation-dashboard"], [data-testid="evaluation-denied"]')
    .first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return (await page.locator("main, body").first().innerText()).trim();
}

export async function screenshot(page: Page, path: string): Promise<void> {
  await page.screenshot({ path, fullPage: true });
}
