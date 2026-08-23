"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * 画面が切り替わったことを読み上げる。
 *
 * ページ全体を読み込み直す普通のサイトと違い、この種のアプリは中身だけが
 * 差し替わるため、スクリーンリーダーには「何も起きていない」ように見える。
 * 移動先の見出しを読み上げて、どこへ来たのかを伝える。
 */
export function RouteAnnouncer() {
  const pathname = usePathname();
  const [message, setMessage] = useState("");
  const isFirstRender = useRef(true);

  useEffect(() => {
    // 開いた直後は読み上げない。移動していないのに喋られると邪魔になる。
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }

    // 新しい画面が描き終わってから見出しを拾う。
    const timer = window.setTimeout(() => {
      const heading = document.querySelector("#bl-main h1");
      const title = heading?.textContent?.trim();
      if (title) setMessage(`${title} に移動しました`);
    }, 150);

    return () => window.clearTimeout(timer);
  }, [pathname]);

  return (
    <p className="bl-sr" role="status" aria-live="polite">
      {message}
    </p>
  );
}
