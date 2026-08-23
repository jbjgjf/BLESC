"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
} from "react";
import { prefersReducedMotion, useScrollRevealFallback } from "@/lib/motion";

/**
 * 画面遷移のアニメーション。
 *
 * React 19.2 に <ViewTransition> はまだ入っていないので、View Transitions
 * API を直接叩く。対応していないブラウザや「視差効果を減らす」設定では
 * 通常の遷移にそのまま落ちる。
 *
 * 仕組み: startViewTransition は渡したコールバックの Promise が解決する
 * まで旧画面の静止画を表示し続ける。ルーターの push は描画完了を待って
 * くれないので、pathname が実際に変わった時点で解決する。
 */

type Navigate = (href: string) => void;

const NavigateContext = createContext<Navigate | null>(null);

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => unknown) => { finished: Promise<void> };
};

/** 遷移先の描画が詰まっても、静止画のまま固まらないようにする上限。 */
const HOLD_LIMIT_MS = 500;

export function TransitionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const release = useRef<(() => void) | null>(null);

  // 新しい経路が描画された時点で静止画を解放する。
  useEffect(() => {
    release.current?.();
    release.current = null;
  }, [pathname]);

  // スクロール連動に非対応のブラウザでは、経路ごとに .bl-reveal を拾い直す。
  useScrollRevealFallback(pathname);

  const navigate = useCallback<Navigate>(
    (href) => {
      const doc = document as ViewTransitionDocument;

      if (!doc.startViewTransition || prefersReducedMotion()) {
        router.push(href);
        return;
      }

      doc.startViewTransition(() => {
        router.push(href);
        return new Promise<void>((resolve) => {
          release.current = resolve;
          window.setTimeout(resolve, HOLD_LIMIT_MS);
        });
      });
    },
    [router],
  );

  return <NavigateContext.Provider value={navigate}>{children}</NavigateContext.Provider>;
}

type TransitionLinkProps = ComponentProps<typeof Link> & { href: string };

/**
 * next/link と同じ使い方で、遷移だけ View Transition に載せ替える。
 *
 * onNavigate は同一オリジンのクライアント遷移でしか呼ばれない。修飾キー
 * 付きのクリック、外部リンク、download 属性つきのリンクは最初から対象外
 * なので、その判定を自前で持たなくてよい。
 */
export function TransitionLink({ href, onNavigate, ...rest }: TransitionLinkProps) {
  const navigate = useContext(NavigateContext);
  const pathname = usePathname();

  return (
    <Link
      href={href}
      onNavigate={(event) => {
        // この event は preventDefault しか持たないので、呼び出し側が遷移を
        // 止めたかどうかは包んで見張る。
        let cancelled = false;
        onNavigate?.({
          preventDefault: () => {
            cancelled = true;
            event.preventDefault();
          },
        });

        if (cancelled || !navigate) return;
        // 同じ画面への遷移では pathname が変わらず、解放の合図も来ない。
        if (href === pathname) return;

        // Next 側の遷移を止めて、View Transition の中で自分で進める。
        event.preventDefault();
        navigate(href);
      }}
      {...rest}
    />
  );
}
