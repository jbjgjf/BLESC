"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { TransitionLink } from "@/components/ui/Transition";
import { contextForPath } from "@/lib/blesc/context";
import { DisplaySettings } from "@/components/a11y/DisplaySettings";
import { useAuth } from "@/lib/auth";
import { Icon, type IconName } from "@/components/ui/Icon";

type NavItem = { href: string; label: string; icon: IconName; exact?: boolean };

const STUDENT_NAV: NavItem[] = [
  { href: "/",         label: "今日",     icon: "home",        exact: true },
  { href: "/journal",  label: "日記",     icon: "edit_note" },
  { href: "/reflect",  label: "振り返り", icon: "insights" },
  { href: "/chat",     label: "相談",     icon: "chat_bubble" },
];

const EDUCATOR_NAV: NavItem[] = [
  { href: "/educator",          label: "ホーム",   icon: "dashboard", exact: true },
  { href: "/educator/roster",   label: "生徒",     icon: "groups" },
  { href: "/educator/alerts",   label: "アラート", icon: "notifications_active" },
  { href: "/educator/class",    label: "クラス",   icon: "grid_view" },
  { href: "/educator/meetings", label: "面談",     icon: "event_note" },
  { href: "/school",            label: "学校全体", icon: "apartment" },
];

const GUARDIAN_NAV: NavItem[] = [
  { href: "/guardian", label: "ホーム", icon: "home", exact: true },
];

/** Secondary surfaces, reachable from the account menu rather than the tab bar. */
const MORE_LINKS: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/research",        label: "研究用の記録",   icon: "description" },
  { href: "/graph",           label: "関係グラフ",     icon: "graphic_eq" },
  { href: "/timeline",        label: "タイムライン",   icon: "timeline" },
  { href: "/support-summary", label: "支援サマリー",   icon: "summarize" },
  { href: "/sharing",         label: "共有の設定",     icon: "shield" },
  { href: "/audit",           label: "AI処理の記録",   icon: "history" },
];

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}

export function AppNav() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const menuRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Remember which route the menu was opened on rather than closing it from an
  // effect — navigating changes `pathname`, which closes the menu by derivation.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const menuOpen = openedAt === pathname;
  const setMenuOpen = (open: boolean) => setOpenedAt(open ? pathname : null);

  const context = contextForPath(pathname);

  const items =
    context === "educator" ? EDUCATOR_NAV : context === "guardian" ? GUARDIAN_NAV : STUDENT_NAV;

  // 少しでも動いたらバーを締める。閾値を置くのは、慣性スクロールの
  // 揺り戻しで境界を何度もまたがないようにするため。
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setOpenedAt(null);
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <>
      <header className="bl-nav" data-scrolled={scrolled}>
        <div className="bl-nav__inner">
          <TransitionLink href={context === "educator" ? "/educator" : "/"} className="bl-nav__brand">
            <Image src="/flower.png" alt="" width={30} height={30} priority />
            <span className="bl-nav__wordmark">blesc</span>
            {context === "educator" && <span className="bl-nav__role">教員</span>}
            {context === "guardian" && <span className="bl-nav__role">保護者</span>}
          </TransitionLink>

          <nav className="bl-nav__tabs" aria-label="メインナビゲーション">
            {items.map((item) => {
              const active = isActive(pathname, item);
              return (
                <TransitionLink
                  key={item.href}
                  href={item.href}
                  className="bl-nav__tab"
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon name={item.icon} size={20} fill={active} weight={active ? 600 : 400} />
                  <span>{item.label}</span>
                </TransitionLink>
              );
            })}
          </nav>

          <div className="bl-nav__account" ref={menuRef}>
            <button
              type="button"
              className="bl-icon-btn"
              aria-label="アカウントとその他のページ"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? "close" : "menu"} size={22} />
            </button>

            {menuOpen && (
              <div className="bl-menu bl-pop" role="menu">
                {user?.email && (
                  <div className="bl-menu__identity">
                    <Icon name="person" size={18} />
                    <span className="bl-menu__email">{user.email}</span>
                  </div>
                )}

                <div className="bl-menu__group">画面の切り替え</div>
                {context !== "student" && (
                  <TransitionLink href="/" className="bl-menu__item" role="menuitem">
                    <Icon name="person" size={19} />
                    生徒画面
                  </TransitionLink>
                )}
                {context !== "educator" && (
                  <TransitionLink href="/educator" className="bl-menu__item" role="menuitem">
                    <Icon name="dashboard" size={19} />
                    教員ダッシュボード
                  </TransitionLink>
                )}
                {context !== "guardian" && (
                  <TransitionLink href="/guardian" className="bl-menu__item" role="menuitem">
                    <Icon name="escalator_warning" size={19} />
                    保護者ダッシュボード
                  </TransitionLink>
                )}

                <div className="bl-menu__group">その他</div>
                {MORE_LINKS.map((link) => (
                  <TransitionLink key={link.href} href={link.href} className="bl-menu__item" role="menuitem">
                    <Icon name={link.icon} size={19} />
                    {link.label}
                  </TransitionLink>
                ))}

                <hr className="bl-hr" />
                <button
                  type="button"
                  className="bl-menu__item bl-menu__item--button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <Icon name="settings" size={19} />
                  表示設定
                </button>
                <button
                  type="button"
                  className="bl-menu__item bl-menu__item--button"
                  role="menuitem"
                  onClick={() => void signOut().catch(() => undefined)}
                >
                  <Icon name="logout" size={19} />
                  ログアウト
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <DisplaySettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {/* Mobile tab bar — the tabs above collapse to icons off-screen below 640px. */}
      <nav className="bl-tabbar" aria-label="メインナビゲーション">
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <TransitionLink
              key={item.href}
              href={item.href}
              className="bl-tabbar__tab"
              data-active={active}
              aria-current={active ? "page" : undefined}
            >
              <Icon name={item.icon} size={23} fill={active} weight={active ? 600 : 400} />
              <span>{item.label}</span>
            </TransitionLink>
          );
        })}
      </nav>
    </>
  );
}
