"use client";

/**
 * 先生の画面の外枠（2章）。PC は左のサイドバー、タブレットは細い縦の帯、
 * スマホは下のタブバー。
 *
 * タブは最大で「自分の記録」「クラス（生徒）」「先生」「設定」の4つで、
 * 持っている権限の分だけ出す。権限のないタブは出さない（グレーアウトもしない）。
 *
 * デモでだけ、立場（権限の組み合わせ）を切り替えられる。本番では立場は
 * アカウントで決まり、切り替えは出さない。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { DisplaySettings } from "@/components/a11y/DisplaySettings";
import { Icon, type IconName } from "@/components/ui/Icon";
import { TransitionLink, useTransitionNavigate } from "@/components/ui/Transition";
import { useDemoMode } from "@/lib/demo";
import { PERSONAS, PERSONA_ORDER, SCHOOL_NAME, landingOf } from "@/lib/teachers/fixtures";
import { setPersona, usePersona } from "@/lib/teachers/store";
import type { Persona, PersonaId } from "@/lib/teachers/types";
import styles from "./teachers.module.css";

type Tab = { href: string; label: string; icon: IconName; active: (pathname: string) => boolean };

/** その人に出すタブ（左から順）。6-3 の表のとおり。 */
export function tabsFor(persona: Persona): Tab[] {
  const tabs: Tab[] = [];
  if (persona.access.write) {
    tabs.push({ href: "/educator", label: "自分の記録", icon: "edit_note", active: (p) => p === "/educator" || p.startsWith("/educator/my-records") });
  }
  if (persona.access.students) {
    tabs.push({ href: "/educator/class", label: persona.access.students.tab, icon: "groups", active: (p) => p.startsWith("/educator/class") });
  }
  if (persona.access.teachers) {
    tabs.push({ href: "/educator/staff", label: "先生", icon: "group", active: (p) => p.startsWith("/educator/staff") });
  }
  tabs.push({ href: "/educator/settings", label: "設定", icon: "settings", active: (p) => p.startsWith("/educator/settings") });
  return tabs;
}

/** 開いている間だけ、外側を押すか Esc で閉じる。 */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

/** 立場の一覧（デモ）。選ぶと、その立場の最初の画面を開く。 */
function PersonaList({ current, onPick }: { current: PersonaId; onPick: (id: PersonaId) => void }) {
  return (
    <div role="menu" aria-label="立場の切り替え（デモ）">
      <p>立場を切り替える（デモ）</p>
      {PERSONA_ORDER.map((id) => {
        const persona = PERSONAS[id];
        return (
          <button key={id} type="button" role="menuitemradio" aria-checked={current === id} className={styles.switchItem} onClick={() => onPick(id)}>
            <Icon name={current === id ? "check" : "person"} size={19} />
            <span>
              {persona.name}
              <small>
                {persona.role}・{persona.title}
              </small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function TeacherShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const navigate = useTransitionNavigate();
  const persona = usePersona();
  const demo = useDemoMode();
  const tabs = tabsFor(persona);

  const [switchOpen, setSwitchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const switchRef = useDismiss(switchOpen, () => setSwitchOpen(false));
  const menuRef = useDismiss(menuOpen, () => setMenuOpen(false));

  const pick = (id: PersonaId) => {
    setSwitchOpen(false);
    setMenuOpen(false);
    setPersona(id);
    navigate(landingOf(PERSONAS[id]));
  };

  const brand = (
    <TransitionLink href={landingOf(persona)} className={styles.brand} aria-label="blesc for Teachers">
      <Image src="/flower-teachers.png" alt="" width={30} height={30} className={styles.brandMark} priority />
      <span className={styles.wordmark}>
        <strong>blesc</strong>
        <span>for Teachers</span>
      </span>
    </TransitionLink>
  );

  const demoPill = demo && (
    <span className={styles.demoPill}>
      <Icon name="visibility" size={13} />
      デモデータ
    </span>
  );

  return (
    <div className={styles.shell}>
      <aside className={styles.side}>
        {brand}
        <p className={styles.org}>{SCHOOL_NAME}</p>

        <nav className={styles.navList} aria-label="メインナビゲーション">
          {tabs.map((tab) => {
            const active = tab.active(pathname);
            return (
              <TransitionLink key={tab.href} href={tab.href} className={styles.navItem} data-active={active} aria-current={active ? "page" : undefined}>
                <Icon name={tab.icon} size={22} fill={active} weight={active ? 600 : 400} />
                <span>{tab.label}</span>
              </TransitionLink>
            );
          })}
        </nav>

        <div className={styles.sideFoot}>
          <div className={styles.who}>
            <strong>{persona.name}</strong>
            <span>{persona.title}</span>
          </div>
          {demo && (
            <div className={styles.switcher} ref={switchRef}>
              <button type="button" className={styles.sideLink} aria-expanded={switchOpen} onClick={() => setSwitchOpen(!switchOpen)}>
                <Icon name="group" size={18} />
                <span>立場を切り替える（デモ）</span>
              </button>
              {switchOpen && (
                <div className={styles.switchMenu}>
                  <PersonaList current={persona.id} onPick={pick} />
                </div>
              )}
            </div>
          )}
          <div className={styles.sideLinks}>
            <button type="button" className={styles.sideLink} onClick={() => setDisplayOpen(true)}>
              <Icon name="visibility" size={18} />
              <span>文字の大きさ・表示</span>
            </button>
            {demo && (
              <TransitionLink href="/" className={styles.sideLink}>
                <Icon name="person" size={18} />
                <span>生徒の画面へ（デモ）</span>
              </TransitionLink>
            )}
          </div>
          {demoPill}
        </div>
      </aside>

      <header className={styles.topbar}>
        {brand}
        <span className={styles.spacerFlex} />
        {demoPill}
        <div ref={menuRef}>
          <button type="button" className={styles.iconButton} aria-label="メニュー" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <Icon name={menuOpen ? "close" : "menu"} size={24} />
          </button>
          {menuOpen && (
            <div className={styles.topbarMenu}>
              <div className={styles.who} style={{ padding: "4px 10px 10px" }}>
                <strong>{persona.name}</strong>
                <span>{persona.title}</span>
              </div>
              {demo && <PersonaList current={persona.id} onPick={pick} />}
              <button
                type="button"
                className={styles.switchItem}
                onClick={() => {
                  setMenuOpen(false);
                  setDisplayOpen(true);
                }}
              >
                <Icon name="visibility" size={19} />
                文字の大きさ・表示
              </button>
              {demo && (
                <TransitionLink href="/" className={styles.switchItem}>
                  <Icon name="person" size={19} />
                  生徒の画面へ（デモ）
                </TransitionLink>
              )}
            </div>
          )}
        </div>
      </header>

      <main id="bl-main" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      {/* スマホのタブバー。PC とタブレットでは隠れる（blesc.css の .bl-tabbar）。 */}
      <nav className="bl-tabbar" aria-label="メインナビゲーション">
        {tabs.map((tab) => {
          const active = tab.active(pathname);
          return (
            <TransitionLink key={tab.href} href={tab.href} className="bl-tabbar__tab" data-active={active} aria-current={active ? "page" : undefined}>
              <Icon name={tab.icon} size={23} fill={active} weight={active ? 600 : 400} />
              <span>{tab.label}</span>
            </TransitionLink>
          );
        })}
      </nav>

      <DisplaySettings open={displayOpen} onClose={() => setDisplayOpen(false)} />
    </div>
  );
}
