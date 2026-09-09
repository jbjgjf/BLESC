import { expect, test, type Page } from "@playwright/test";

import { CODES, PASSWORD, USERS } from "./seed";

const evidence = (name: string) => `../docs/evidence/pilot-enrollment/${name}.png`;

/**
 * The enrollment gate, end to end (#164).
 *
 * Six paths, one per acceptance criterion:
 *
 *   adult       — no guardian step is imposed on someone who does not need one
 *   minor       — and cannot be skipped by someone who does
 *   decline     — saying no is accepted plainly, with no pressure and no error
 *   expired     — a dead code is refused, and refused the same way as any other
 *   withdrawal  — leaving stops the next submission
 *   direct URL  — the collection screen is unreachable without an enrollment
 *
 * These run against a real build, a real database and the real state machine.
 * The assertions are on what a participant sees, because the criteria in #164
 * are about what a participant experiences, not about which function returned
 * what.
 */

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByTestId("login-submit").click();
  // The app navigates away from /login once the session is established.
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

async function redeem(page: Page, code: string, { minor }: { minor: boolean }) {
  await page.goto("/pilot/join");
  await expect(page.getByRole("heading", { name: "招待コード" })).toBeVisible();
  await page.getByLabel("招待コード").fill(code);

  // The age band is the participant's own statement, and the guardian
  // requirement follows from it. Chosen explicitly in both directions rather
  // than relying on whichever radio the page defaults to.
  await page
    .getByRole("radio")
    .nth(minor ? 0 : 1)
    .check();

  await page.getByRole("button", { name: "確認する" }).click();
}

test.describe("adult", () => {
  test("is never asked for a guardian", async ({ page }) => {
    await login(page, USERS.adult);
    await redeem(page, CODES.adult, { minor: false });

    await expect(page.getByRole("heading", { name: "説明を読む" })).toBeVisible();
    await page.getByRole("button", { name: "読み終えました" }).click();

    await expect(page.getByRole("heading", { name: "あなたの同意" })).toBeVisible();
    await page.getByLabel(/研究の説明を読み、研究として分析されることに同意します/).check();
    await page.getByRole("button", { name: "同意して次へ" }).click();

    // The criterion: an adult goes straight from assent to the consent step.
    // `advance_pilot_enrollment` encodes the same rule —
    // `v.state = 'participant_assented' and p_to_state = 'enrolled' and not v.is_minor`.
    await expect(page.getByRole("heading", { name: "保護者の方の確認" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "参加登録を完了する" })).toBeVisible();
  });

  test("records consent and completes without asking for a guardian", async ({ page }) => {
    await login(page, USERS.adult);
    await page.goto("/pilot/join");
    await expect(page.getByRole("heading", { name: "参加登録を完了する" })).toBeVisible();

    await page.goto("/consent");
    // Wait for the consent and enrollment reads to finish before editing. If
    // the form is changed during its initial load, the stored values can race
    // the clicks and replace them.
    await expect(page.getByText("18歳以上の参加者は、本人の同意だけで研究利用に進めます。")).toBeVisible();
    await expect(page.getByText(/保護者が同意/)).toHaveCount(0);

    await page.goto("/pilot/join");
    await page.getByRole("button", { name: "登録を完了する" }).click();
    await expect(page.getByRole("heading", { name: "登録が完了しています" })).toBeVisible();
    await page.screenshot({ path: evidence("adult"), fullPage: true });
  });
});

test.describe("minor", () => {
  test("is held at guardian verification and cannot self-certify", async ({ page }) => {
    await login(page, USERS.minor);
    await redeem(page, CODES.minor, { minor: true });

    await page.getByRole("button", { name: "読み終えました" }).click();
    await page.getByLabel(/研究の説明を読み、研究として分析されることに同意します/).check();
    await page.getByRole("button", { name: "同意して次へ" }).click();

    await expect(page.getByRole("heading", { name: "保護者の方の確認" })).toBeVisible();
    // The screen must say plainly that the participant cannot stand in for
    // their guardian — the whole point of the separate token and device.
    await expect(
      page.getByText(/この端末から保護者の同意を入力することはできない仕組み/),
    ).toBeVisible();
    // And there must be no control on this screen that would let them.
    await expect(page.getByRole("button", { name: /保護者.*(確認しました|同意)/ })).toHaveCount(0);

    // Held short of collection means the collection screen stays shut.
    await page.goto("/journal");
    await expect(page).toHaveURL(/\/pilot\/join/);
    await page.screenshot({ path: evidence("minor-guardian-wait"), fullPage: true });
  });
});

test.describe("decline", () => {
  test("accepts no for an answer without pressure or a false error", async ({ page }) => {
    await login(page, USERS.decliner);
    await redeem(page, CODES.decliner, { minor: false });

    await page.getByRole("button", { name: "読み終えました" }).click();
    await expect(page.getByRole("heading", { name: "あなたの同意" })).toBeVisible();

    // Declining is offered as an equal choice, not as an escape hatch.
    await expect(page.getByRole("button", { name: "参加をやめる" })).toBeEnabled();
    await page.getByRole("button", { name: "参加をやめる" }).click();
    await page.getByRole("button", { name: "やめる", exact: true }).click();

    await expect(page.getByRole("heading", { name: "参加を終了しました" })).toBeVisible();
    // Nothing that reads as a failure: declining is a valid outcome, and
    // dressing it as an error is the pressure #164 forbids. The page keeps an
    // empty live region at all times, so the assertion is on its text rather
    // than on the element being absent.
    const announced = (await page.locator('[role="alert"]').allTextContents()).join("").trim();
    expect(announced).toBe("");
    // And no second ask.
    await expect(page.getByRole("button", { name: "同意して次へ" })).toHaveCount(0);
    await page.screenshot({ path: evidence("decline"), fullPage: true });

    await page.goto("/journal");
    await expect(page).toHaveURL(/\/pilot\/join/);
  });
});

test.describe("expired invitation", () => {
  test("is refused, and refused indistinguishably from any other bad code", async ({ page }) => {
    await login(page, USERS.stranger);
    await redeem(page, CODES.expired, { minor: false });

    // Still on the code screen, with no enrollment created.
    await expect(page.getByRole("heading", { name: "招待コード" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "説明を読む" })).toHaveCount(0);

    const expiredMessage = (await page.locator('[role="status"]').first().textContent()) ?? "";
    // "Expired" would confirm that the code existed, which turns a guess into
    // a probe. Every rejection has to read the same.
    expect(expiredMessage).not.toMatch(/期限|失効|expired/i);
    await page.screenshot({ path: evidence("expired-invite"), fullPage: true });
  });
});

test.describe("withdrawal", () => {
  test("stops the next submission", async ({ page }) => {
    await login(page, USERS.withdrawer);

    // Collecting, so the journal is reachable to begin with — otherwise this
    // test would pass for the wrong reason.
    await page.goto("/journal");
    await expect(page).toHaveURL(/\/journal/);

    await page.goto("/pilot/join");
    await page.getByRole("button", { name: "参加をやめる" }).click();
    await page.getByRole("button", { name: "やめる", exact: true }).click();
    await expect(page.getByRole("heading", { name: "参加を終了しました" })).toBeVisible();
    await page.screenshot({ path: evidence("withdrawal"), fullPage: true });

    // The screen is gone.
    await page.goto("/journal");
    await expect(page).toHaveURL(/\/pilot\/join/);

    // And so is the API behind it: a client that kept a token, or replayed the
    // request, is refused by the server rather than by the redirect.
    const refusal = await page.evaluate(async () => {
      const response = await fetch("/api/entries?user_id=research_user_01&observation_type=daily", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "撤回後の提出" }),
      });
      return { status: response.status, body: await response.text() };
    });
    expect(refusal.status).toBeGreaterThanOrEqual(400);
    expect(refusal.body).not.toContain("撤回後の提出");
  });
});

test.describe("direct URL", () => {
  test("does not open the collection screen for someone with no enrollment", async ({ page }) => {
    await login(page, USERS.stranger);

    // Typed into the address bar, not reached by clicking.
    await page.goto("/journal");
    await expect(page).toHaveURL(/\/pilot\/join/);
    await page.screenshot({ path: evidence("direct-url"), fullPage: true });
  });

  test("does not open it for a forged session cookie either", async ({ page, context }) => {
    await login(page, USERS.stranger);

    // Tampering with the token invalidates its signature; `getUser()` checks
    // the signature rather than trusting the payload, so this lands in the
    // same branch as having no session at all.
    const cookies = await context.cookies();
    const auth = cookies.filter((cookie) => /auth-token/.test(cookie.name));
    expect(auth.length).toBeGreaterThan(0);
    await context.clearCookies();
    await context.addCookies(
      auth.map((cookie) => ({ ...cookie, value: `${cookie.value}tampered` })),
    );

    await page.goto("/journal");
    await expect(page).toHaveURL(/\/pilot\/join|\/login/);
  });
});
