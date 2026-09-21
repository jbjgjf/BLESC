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
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteVerified, setInviteVerified] = useState(false);
  const [isChecking, setIsChecking] = useState(false);

  /*
   * 招待制デプロイでは、コードを確認するまでアカウントを作らせない（#223）。
   *
   * `protocol.md` §2 は「招待コードのみ。公開 signup からは参加できない」と
   * 定めているが、画面はそれを担保していなかった。収集ゲートが /journal を
   * 守っているので研究データは汚れないものの、未招待のアカウントは無制限に
   * 増え、説明文と挙動が食い違っていた。
   *
   * **これは認可ではない。** 本当の関門は `/api/pilot/redeem` と収集ゲートで、
   * どちらもサーバ側にある。ここが担保するのは「画面が説明どおりに振る舞う」
   * ことと、無関係な人がアカウントを作ってしまわないこと。
   */
  const invitePilot = process.env.NEXT_PUBLIC_PILOT_MODE === "1";
  const needsInvite = invitePilot && mode === "signup" && !inviteVerified;

  const checkInvite = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/pilot/invite/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: inviteCode }),
      });
      if (response.status === 429) {
        setMessage(t.login.error.rateLimited);
        return;
      }
      if (!response.ok) {
        setMessage(t.login.inviteCheckFailed);
        return;
      }
      const { valid } = (await response.json()) as { valid: boolean };
      if (!valid) {
        setMessage(t.login.inviteInvalid);
        return;
      }
      setInviteVerified(true);
      setMessage(t.login.inviteAccepted);
    } catch {
      setMessage(t.login.inviteCheckFailed);
    } finally {
      setIsChecking(false);
    }
  };
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    // 押せない状態のボタンを経由しない送信（Enterキーなど）も同じ場所で止める。
    if (needsInvite) {
      setMessage(t.login.inviteInvalid);
      return;
    }
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
              {needsInvite
                ? t.login.inviteRequiredLead
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
        {needsInvite && (
          <form onSubmit={checkInvite} className={styles.form}>
            <p className="bl-body">{t.login.inviteRequiredIntro}</p>
            <div>
              <label className="bl-label" htmlFor="invite-code">
                <Icon name="lock" size={19} />
                {t.login.inviteCode}
              </label>
              <input
                id="invite-code"
                data-testid="login-invite-code"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                required
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                className="bl-input"
                placeholder="ABCDE-FGHJK-MNPQR-STVWX"
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
              data-testid="login-invite-check"
              disabled={isChecking || !inviteCode.trim()}
              className="bl-btn bl-btn--primary bl-btn--block bl-btn--lg"
            >
              {isChecking && <span className={styles.spinner} aria-hidden="true" />}
              {t.login.inviteCheck}
            </button>
          </form>
        )}

        <form onSubmit={handleSubmit} className={styles.form} hidden={needsInvite}>
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
            // 「ログインへ戻る」で確認済みを持ち越さない。次に signup を選んだ
            // ときはもう一度コードを聞く。
            setInviteVerified(false);
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
