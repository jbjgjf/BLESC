"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { Icon } from "@/components/ui/Icon";
import { t } from "@/lib/i18n";
import styles from "./login.module.css";

/** Supabase の英語メッセージを、生徒にも読める日本語に置き換える。 */
function localizeAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) {
    return t.login.error.invalidCredentials;
  }
  if (lower.includes("email not confirmed")) {
    return t.login.error.emailNotConfirmed;
  }
  if (lower.includes("user already registered")) {
    return t.login.error.alreadyRegistered;
  }
  if (lower.includes("password should be at least")) {
    return t.login.error.passwordTooShort;
  }
  if (lower.includes("rate limit") || lower.includes("too many")) {
    return t.login.error.rateLimited;
  }
  if (lower.includes("fetch") || lower.includes("network")) {
    return t.login.error.network;
  }
  return message;
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage(null);

    const authRedirectUrl = `${window.location.origin}/login`;
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
              {mode === "signin" ? t.login.signinLead : t.login.signupLead}
            </p>
          </div>
        </div>

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

          {message && (
            <div className="bl-notice bl-notice--watch" role="alert">
              <Icon name="info" size={19} />
              <span>{message}</span>
            </div>
          )}

          <button type="submit" data-testid="login-submit" disabled={isSubmitting} className="bl-btn bl-btn--primary bl-btn--block bl-btn--lg">
            {isSubmitting && <span className={styles.spinner} aria-hidden="true" />}
            {mode === "signin" ? t.login.signin : t.login.signup}
          </button>
        </form>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setMessage(null);
          }}
          className="bl-btn bl-btn--ghost bl-btn--block"
          style={{ marginTop: 10 }}
        >
          {mode === "signin" ? t.login.toSignup : t.login.toSignin}
        </button>

        <p className="bl-disclaimer" style={{ marginTop: 18, justifyContent: "center" }}>
          <Icon name="shield" size={15} />
          {t.login.notClinicalService}
        </p>
      </section>
    </main>
  );
}
