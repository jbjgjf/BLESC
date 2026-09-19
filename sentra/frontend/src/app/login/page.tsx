"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import { localizeAuthError } from "@/lib/i18n/authError";
import styles from "./login.module.css";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    const authRedirectUrl = `${window.location.origin}/login`;

    if (mode === "reset") {
      /*
       * The outcome is not reported.
       *
       * Supabase already answers the same way for a registered and an
       * unregistered address, and this keeps that true on our side: the message
       * below is set whether the call succeeded or failed. Telling someone
       * "there is no account for this address" is a way to test addresses one
       * at a time against a roster of minors.
       *
       * The one thing worth surfacing is a rate limit, because the student can
       * act on it — waiting is the fix, and silence would have them retyping
       * their address believing they got it wrong.
       */
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      setIsSubmitting(false);
      if (error && /rate limit|too many/i.test(error.message)) {
        setMessage(localizeAuthError(error.message));
        return;
      }
      if (error) {
        console.warn("[login] password reset request failed", error.message);
      }
      setMessage(t.login.resetSent);
      return;
    }

    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: authRedirectUrl },
          });

    setIsSubmitting(false);

    if (result.error) {
      setMessage(localizeAuthError(result.error.message));
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage(t.login.confirmationSent);
      return;
    }

    router.replace(searchParams.get("next") || "/");
  };

  return (
    <main className={styles.page}>
      <section className={`${styles.card} bl-pop`}>
        <div className={styles.brand}>
          <Image src="/flower.png" width={44} height={44} unoptimized alt="" className={styles.flower} />
          <div>
            <h1 className="bl-h2">blesc</h1>
            <p className="bl-meta">
              {mode === "reset"
                ? t.login.resetLead
                : mode === "signin"
                  ? t.login.signinLead
                  : t.login.signupLead}
            </p>
          </div>
        </div>

        <p className="bl-meta" style={{ marginBottom: 16 }}>
          <Link href="/legal" target="_blank" rel="noopener noreferrer">利用規約・プライバシーポリシーの確認用草案（別タブ）</Link>
          <br />未施行の案です。登録操作をこの草案への同意として記録しません。
        </p>
        <form onSubmit={handleSubmit} className={styles.form}>
          <div>
            <label className="bl-label" htmlFor="email">
              <Icon name="person" size={19} />
              {t.login.email}
            </label>
              <input
                id="email"
                data-testid="login-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="bl-input"
              placeholder="you@example.com"
            />
          </div>

          {mode === "reset" ? (
            <p className="bl-body">{t.login.resetIntro}</p>
          ) : (
            <div>
              <label className="bl-label" htmlFor="password">
                <Icon name="lock" size={19} />
                {t.login.password}
              </label>
              <input
                id="password"
                data-testid="login-password"
                type="password"
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                required
                minLength={6}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="bl-input"
                placeholder={mode === "signup" ? t.login.passwordHint : ""}
              />
            </div>
          )}

          {message && (
            <div className="bl-notice bl-notice--watch" role="alert">
              <Icon name="info" size={19} />
              <span>{message}</span>
            </div>
          )}

          <button type="submit" data-testid="login-submit" disabled={isSubmitting} className="bl-btn bl-btn--primary bl-btn--block bl-btn--lg">
            {isSubmitting && <span className={styles.spinner} aria-hidden="true" />}
            {mode === "reset"
              ? t.login.sendResetLink
              : mode === "signin"
                ? t.login.signin
                : t.login.signup}
          </button>
        </form>

        {/*
          * Only on the sign-in form. Offering "forgot your password" beside a
          * sign-up form is an invitation to reset an account that does not
          * exist yet, and the neutral reply would leave them waiting for a mail
          * that never comes.
          */}
        {mode === "signin" && (
          <button
            type="button"
            data-testid="login-forgot"
            onClick={() => {
              setMode("reset");
              setMessage(null);
            }}
            className="bl-btn bl-btn--ghost bl-btn--block"
            style={{ marginTop: 10 }}
          >
            {t.login.forgotPassword}
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage(null);
          }}
          className="bl-btn bl-btn--ghost bl-btn--block"
          style={{ marginTop: 10 }}
        >
          {mode === "reset"
            ? t.login.backToSignin
            : mode === "signin"
              ? t.login.toSignup
              : t.login.toSignin}
        </button>

        {/*
          * The way out when the mail never arrives.
          *
          * Not a footnote: no production SMTP is configured for this project, so
          * the built-in sender is rate limited and a fifty-student pilot will
          * have students for whom self-service simply does not work. The
          * operator path (`/api/pilot/admin/password-reset`) is the answer, and
          * a student cannot use it without being told it exists.
          */}
        {mode === "reset" && (
          <p className="bl-micro" style={{ marginTop: 12 }}>
            {t.login.resetHelpdesk}
          </p>
        )}

        <p className="bl-disclaimer" style={{ marginTop: 18, justifyContent: "center" }}>
          <Icon name="shield" size={15} />
          {t.login.notClinicalService}
        </p>
      </section>
    </main>
  );
}
