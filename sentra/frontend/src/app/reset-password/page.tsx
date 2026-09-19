"use client";

/**
 * Where a password reset link lands.
 *
 * Until this page existed there was no recovery at all: a student who forgot
 * their password was locked out of the study for good, and the only remedy was
 * a new account — which, in a pilot keyed on invitation codes and enrollment
 * state, means losing their place in it.
 *
 * ## The failure this page is mostly written around
 *
 * The browser client runs the PKCE flow, so the link carries a `code` that is
 * only exchangeable by the browser that asked for the reset: the verifier is in
 * that browser's storage. A student who requests the reset on a school laptop
 * and opens the mail on their phone gets a `code` nobody can redeem.
 *
 * That is not an edge case for this cohort — phone for mail, shared or school
 * machine for the app is the normal shape — and the failure is silent by
 * default: `detectSessionInUrl` tries the exchange, fails, and leaves a page
 * that looks like it is still loading. So this waits for the outcome and says
 * plainly that the link did not work and what to do instead.
 *
 * ## Two link shapes, and only one of them is handled for us
 *
 * `detectSessionInUrl` is on, and the browser client runs PKCE, so it redeems
 * the `?code=` form that `resetPasswordForEmail` produces. It does **not**
 * redeem `#access_token=…&type=recovery`, which is what Supabase returns for a
 * link generated server-side by `auth.admin.generateLink` — there was no PKCE
 * challenge to match, so the implicit form is used instead.
 *
 * That is the coordinator path, the one for students whose mail never arrives,
 * and it failed silently: the page loaded, the fragment sat in the URL, and no
 * session appeared. Verified in a browser against a local stack before this
 * branch was written. So the fragment is read here and exchanged explicitly,
 * and then removed from the URL — an access token in `location.hash` ends up in
 * back-button history and in anything that reads the address bar.
 */

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import { localizeAuthError } from "@/lib/i18n/authError";
import styles from "../login/login.module.css";

/** How long to wait for the client to redeem the link before calling it dead. */
const EXCHANGE_TIMEOUT_MS = 6000;

type Stage = "verifying" | "ready" | "unusable" | "done";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("verifying");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let settled = false;

    const accept = () => {
      if (settled) return;
      settled = true;
      setStage("ready");
    };

    /*
     * The implicit form, which the client ignores.
     *
     * Only acted on when `type=recovery` is present: this page is reached by
     * one kind of link, and consuming any stray fragment that happens to carry
     * tokens would turn it into a general-purpose session setter.
     */
    const consumeRecoveryFragment = async () => {
      const hash = window.location.hash;
      if (!hash.includes("access_token") || !hash.includes("type=recovery")) return;

      const params = new URLSearchParams(hash.slice(1));
      const access_token = params.get("access_token");
      const refresh_token = params.get("refresh_token");
      if (!access_token || !refresh_token) return;

      // Cleared before the await: whatever happens next, the token should not
      // still be in the address bar.
      window.history.replaceState(null, "", window.location.pathname);

      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) {
        console.warn("[reset-password] recovery token rejected", error.message);
        return;
      }
      accept();
    };

    void consumeRecoveryFragment();

    // Two ways the session can arrive, and which one fires depends on whether
    // the client had already finished the exchange before this effect ran.
    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (session && (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
        accept();
      }
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) accept();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      setStage("unusable");
    }, EXCHANGE_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
      subscription.subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setMessage(null);

    if (password.length < 6) {
      setMessage(t.resetPassword.tooShort);
      return;
    }
    // Checked because there is no way back: the recovery link is single-use, so
    // a typo committed here locks them out again with a password they do not
    // know.
    if (password !== confirmation) {
      setMessage(t.resetPassword.mismatch);
      return;
    }

    setIsSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setIsSubmitting(false);

    if (error) {
      setMessage(localizeAuthError(error.message));
      return;
    }

    // `updateUser` leaves the recovery session signed in, so there is nothing
    // to log into — send them where they were going.
    setStage("done");
    setTimeout(() => router.replace("/"), 1200);
  };

  return (
    <main className={styles.page}>
      <section className={`${styles.card} bl-pop`}>
        <div className={styles.brand}>
          <Image src="/flower.png" width={44} height={44} unoptimized alt="" className={styles.flower} />
          <div>
            <h1 className="bl-h2">blesc</h1>
            <p className="bl-meta">{t.resetPassword.title}</p>
          </div>
        </div>

        {stage === "verifying" && (
          <p className="bl-meta" style={{ padding: "12px 0" }}>
            {t.resetPassword.verifying}
          </p>
        )}

        {stage === "unusable" && (
          <>
            <div className="bl-notice bl-notice--watch" role="alert">
              <Icon name="info" size={19} />
              <span>{t.resetPassword.linkUnusable}</span>
            </div>
            <Link
              href="/login"
              className="bl-btn bl-btn--primary bl-btn--block"
              style={{ marginTop: 14 }}
            >
              {t.resetPassword.requestAgain}
            </Link>
          </>
        )}

        {stage === "done" && (
          <div className="bl-notice" role="status">
            <Icon name="check_circle" size={19} />
            <span>{t.resetPassword.done}</span>
          </div>
        )}

        {stage === "ready" && (
          <form onSubmit={handleSubmit} className={styles.form}>
            <p className="bl-body">{t.resetPassword.intro}</p>

            <div>
              <label className="bl-label" htmlFor="new-password">
                <Icon name="lock" size={19} />
                {t.resetPassword.newPassword}
              </label>
              <input
                id="new-password"
                data-testid="reset-password"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="bl-input"
                placeholder={t.login.passwordHint}
              />
            </div>

            <div>
              <label className="bl-label" htmlFor="confirm-password">
                <Icon name="lock" size={19} />
                {t.resetPassword.confirmPassword}
              </label>
              <input
                id="confirm-password"
                data-testid="reset-password-confirm"
                type="password"
                autoComplete="new-password"
                required
                minLength={6}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                className="bl-input"
              />
            </div>

            {message && (
              <div className="bl-notice bl-notice--watch" role="alert">
                <Icon name="info" size={19} />
                <span>{message}</span>
              </div>
            )}

            <button
              type="submit"
              data-testid="reset-submit"
              disabled={isSubmitting}
              className="bl-btn bl-btn--primary bl-btn--block bl-btn--lg"
            >
              {isSubmitting && <span className={styles.spinner} aria-hidden="true" />}
              {t.resetPassword.submit}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
