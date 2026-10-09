"use client";

import { usePathname } from "next/navigation";
import { TransitionLink } from "@/components/ui/Transition";
import { styles } from "./parts";

/** 「自分の記録」の中の2つの画面（今日を書く・これまで）。生徒版と同じ並び。 */
export function OwnTabs() {
  const pathname = usePathname();
  const items = [
    { href: "/educator", label: "今日を書く", active: pathname === "/educator" },
    { href: "/educator/my-records", label: "これまで", active: pathname.startsWith("/educator/my-records") },
  ];
  return (
    <nav className={`${styles.tabs} ${styles.ownTabs}`} aria-label="自分の記録">
      {items.map((item) => (
        <TransitionLink
          key={item.href}
          href={item.href}
          className={styles.tab}
          data-active={item.active}
          aria-current={item.active ? "page" : undefined}
          style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}
        >
          {item.label}
        </TransitionLink>
      ))}
    </nav>
  );
}
