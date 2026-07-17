// Frontend-path driver. Every action goes through the same routes a real
// user takes: /login, the Record & Chat UI, /support-summary, /sharing,
// /oversight, /evaluation. No API shortcuts, no auth/consent/RLS bypasses.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function openSession(baseUrl: string, options?: { video?: string }): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 1280, height: 900 },
    recordVideo: options?.video ? { dir: options.video } : undefined,
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

export async function submitJournal(page: Page, text: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("journal-input").fill(text);
  await page.getByTestId("journal-submit").click();
  // The Record flow runs extraction; wait for the submit button to re-enable
  // or the processing timeline to finish.
  await page.getByTestId("journal-submit").isEnabled({ timeout: 90000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
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

export async function grantConsentIfRequested(page: Page): Promise<boolean> {
  await page.goto("/sharing");
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
  await page
    .locator('[data-testid="oversight-student-list"], [data-testid="oversight-empty"], [data-testid="oversight-summary"]')
    .first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return (await page.locator("main, body").first().innerText()).trim();
}

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
