import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * Password recovery for the pilot.
 *
 * Until this shipped there was none: a student who forgot their password was
 * locked out of the study, and because enrollment is keyed on an invitation
 * code redeemed once, making a new account does not get their place back.
 *
 * Asserted against the source. The flow is Supabase Auth end to end — the part
 * worth protecting is not our arithmetic but the handful of decisions layered
 * on top of it, and every one of those is a line someone could delete without
 * noticing what it was for.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(HERE, path), "utf8");

/**
 * Source with comments removed.
 *
 * Several of these files explain what they deliberately do *not* call, naming
 * it — the operator route's header says it uses `generateLink` rather than
 * `resetPasswordForEmail`, and why. An assertion that the name is absent would
 * fail on the sentence explaining its absence, which is the wrong thing to
 * delete to make a test pass.
 */
const code = (path) =>
  read(path).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const LOGIN = read("../src/app/login/page.tsx");
const RESET = read("../src/app/reset-password/page.tsx");
const OPERATOR = read("../src/app/api/pilot/admin/password-reset/route.ts");
const OPERATOR_CODE = code("../src/app/api/pilot/admin/password-reset/route.ts");
const CATALOGUE = read("../src/lib/i18n/ja.ts");
const MIGRATION = read("../../supabase/migrations/20260918000000_pilot_password_resets.sql");

describe("the reset page is reachable without a session", () => {
  it("is on the public route list", () => {
    // The person opening it cannot sign in — that is what they came to fix.
    // Before this, the auth shell bounced them to /login, which is the loop the
    // whole feature exists to break. Found by loading the page, not by reading.
    const shell = read("../src/components/AuthShell.tsx");
    assert.ok(/PUBLIC_ROUTES = \[[^\]]*"\/reset-password"/.test(shell));
  });
});

describe("there is a way in at all", () => {
  it("offers the reset from the sign-in form", () => {
    assert.ok(LOGIN.includes('data-testid="login-forgot"'));
    assert.ok(CATALOGUE.includes("パスワードをお忘れですか"));
  });

  it("sends the link to a page that can receive it", () => {
    assert.ok(LOGIN.includes("resetPasswordForEmail"));
    assert.ok(LOGIN.includes("/reset-password"));
  });

  it("has that page", () => {
    assert.ok(RESET.includes("updateUser({ password })"));
  });
});

describe("it does not say who has an account", () => {
  it("answers the same whether or not the address is registered", () => {
    // "No account for this address" is a way to test addresses one at a time
    // against a roster of minors.
    const body = LOGIN.slice(LOGIN.indexOf('if (mode === "reset")'));
    const branch = body.slice(0, body.indexOf("const result ="));
    assert.ok(branch.includes("t.login.resetSent"));
    // The only error surfaced is the rate limit, which the student can act on.
    assert.ok(branch.includes("rate limit|too many"));
  });

  it("uses wording that promises nothing about the address", () => {
    assert.ok(CATALOGUE.includes("登録されていれば"));
  });

  it("the operator route answers 404 for both 'no user' and a provider error", () => {
    assert.ok(OPERATOR.includes('return jsonError("Not found.", 404)'));
    assert.ok(!OPERATOR.includes("generated.error.message }"));
  });
});

describe("the link that cannot be redeemed", () => {
  it("gives up rather than spinning forever", () => {
    // PKCE puts the verifier in the browser that asked. Requested on a school
    // laptop, opened on a phone, the exchange fails and the default behaviour
    // is a page that looks like it is still loading.
    assert.ok(RESET.includes("EXCHANGE_TIMEOUT_MS"));
    assert.ok(RESET.includes('setStage("unusable")'));
  });

  it("explains it in one message and offers the way out", () => {
    assert.ok(CATALOGUE.includes("違う端末やブラウザで開いた可能性があります"));
    assert.ok(RESET.includes("t.resetPassword.requestAgain"));
  });

  it("redeems the fragment the client ignores", () => {
    /*
     * The PKCE browser client redeems `?code=` and silently ignores
     * `#access_token=…&type=recovery` — which is precisely what
     * `auth.admin.generateLink` returns, because there was no PKCE challenge to
     * match. That is the coordinator path, and without this the page sat on
     * "verifying" until the timeout and then told the student their link was
     * broken when it was not. Caught in a browser, not in review.
     */
    assert.ok(RESET.includes("setSession({ access_token, refresh_token })"));
    assert.ok(RESET.includes("type=recovery"));
    assert.ok(RESET.includes("onAuthStateChange"), "the ?code= path still arrives this way");
  });

  it("takes the token out of the address bar", () => {
    // An access token left in `location.hash` survives in back-button history.
    assert.ok(RESET.includes("history.replaceState"));
  });
});

describe("setting the new password", () => {
  it("asks for it twice", () => {
    // The recovery link is single-use: a typo here locks them out again, with a
    // password they do not know.
    assert.ok(RESET.includes("confirmPassword"));
    assert.ok(RESET.includes("t.resetPassword.mismatch"));
  });

  it("enforces the same minimum the sign-up form does", () => {
    assert.ok(RESET.includes("password.length < 6"));
    assert.ok(RESET.includes('minLength={6}'));
  });
});

describe("the coordinator path, for when mail does not work", () => {
  it("is behind the operator allowlist, not a role", () => {
    assert.ok(OPERATOR.includes("requireOperator"));
  });

  it("returns the link to the coordinator and never mails it", () => {
    // `generateLink`, not `resetPasswordForEmail`: sending is the thing that
    // did not work, and a server-generated link carries no PKCE verifier, so it
    // opens on whatever device the student actually has.
    assert.ok(OPERATOR_CODE.includes("admin.generateLink"));
    assert.ok(!OPERATOR_CODE.includes("resetPasswordForEmail"));
  });

  it("accepts the pseudonym, so a coordinator never needs the address", () => {
    assert.ok(OPERATOR.includes("research_code"));
    assert.ok(OPERATOR.includes('.eq("research_code", researchCode)'));
  });

  it("tells whoever is about to paste it what it is", () => {
    assert.ok(OPERATOR.includes("ログインと同じ強さ"));
  });

  it("refuses to return a link it could not record", () => {
    const logged = OPERATOR.indexOf("const logged = await audit(\"issued\"");
    const refusal = OPERATOR.indexOf("no link was issued", logged);
    assert.ok(logged !== -1 && refusal > logged);
  });

  it("records the misses too", () => {
    assert.ok(OPERATOR.includes('audit("not_found"'));
    assert.ok(OPERATOR.includes('audit("failed"'));
  });
});

describe("the audit table", () => {
  it("lets the account holder see that someone reset their password", () => {
    assert.ok(MIGRATION.includes("pilot_password_resets_select_own"));
    assert.ok(MIGRATION.includes("target_user_id = (select auth.uid())"));
  });

  it("does not show them which coordinator", () => {
    // The student sees the fact and the time. Naming staff to a student starts
    // a different conversation than this is for.
    const grant = MIGRATION.match(/grant select \(([^)]*)\)/);
    assert.ok(grant, "expected a column-scoped select grant");
    assert.ok(!grant[1].includes("issued_by"));
  });

  it("stores a hash of the address rather than the address", () => {
    assert.ok(MIGRATION.includes("target_email_hash"));
    assert.ok(!/target_email\b(?!_hash)/.test(MIGRATION));
  });

  it("revokes the stock grants before granting what it means", () => {
    assert.ok(MIGRATION.includes("revoke all on public.pilot_password_resets from anon, authenticated"));
  });

  it("nobody but the service role writes", () => {
    assert.ok(MIGRATION.includes("grant select, insert on public.pilot_password_resets to service_role"));
    assert.ok(!/grant[^;]*insert[^;]*to authenticated/.test(MIGRATION));
  });
});
