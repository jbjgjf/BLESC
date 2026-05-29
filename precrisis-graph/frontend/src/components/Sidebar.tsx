"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStoredUserId } from "@/lib/user";
import { useTheme } from "@/app/context/ThemeContext";
import { 
  FileText, 
  Calendar, 
  PieChart, 
  Moon, 
  Sun, 
  User, 
  ChevronLeft, 
  Menu,
  Sparkles
} from "lucide-react";
import { useState } from "react";

export function Sidebar() {
  const { userId, setUserId } = useStoredUserId();
  const { theme, toggleTheme } = useTheme();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(true);

  const navItems = [
    { name: "Log", path: "/", icon: FileText },
    { name: "Timeline", path: "/timeline", icon: Calendar },
    { name: "Insights", path: "/insights", icon: PieChart },
  ];

  return (
    <>
      {/* Mobile Toggle Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="fixed top-4 left-4 z-50 rounded-md border border-notion-border bg-notion-sidebar-bg p-2 text-notion-text md:hidden hover:bg-notion-hover-bg"
        aria-label="Toggle menu"
      >
        <Menu className="h-4 w-4" />
      </button>

      {/* Sidebar Container */}
      <aside
        className={`fixed top-0 bottom-0 left-0 z-40 flex w-[240px] flex-col border-r border-notion-sidebar-border bg-notion-sidebar-bg text-notion-text transition-transform duration-200 md:translate-x-0 ${
          isOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Workspace Header */}
        <div className="flex h-14 items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-notion-accent/15 text-notion-accent font-bold text-sm">
              S
            </span>
            <span className="text-sm font-semibold tracking-tight">Sentra Workspace</span>
          </div>
          <button 
            onClick={() => setIsOpen(false)}
            className="rounded p-1 hover:bg-notion-hover-bg md:hidden"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation Section */}
        <nav className="flex-1 space-y-[2px] px-2 py-4">
          <div className="px-3 py-1 text-xs font-semibold uppercase tracking-wider text-notion-muted">
            Private Pages
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.path;
            return (
              <Link
                key={item.path}
                href={item.path}
                className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-notion-hover-bg font-semibold text-notion-text"
                    : "text-notion-text hover:bg-notion-hover-bg"
                }`}
              >
                <Icon className="h-4 w-4 text-notion-muted" />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        {/* Bottom Section */}
        <div className="border-t border-notion-sidebar-border p-4 space-y-4">
          {/* Participant Selector */}
          <div className="space-y-1">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-notion-muted">
              <User className="h-3 w-3" />
              <span>PARTICIPANT ID</span>
            </label>
            <input
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="w-full rounded border border-notion-border bg-notion-card-bg px-2.5 py-1.5 text-xs text-notion-text outline-none transition focus:border-notion-accent"
              placeholder="Enter ID..."
            />
          </div>

          {/* Theme Toggle Button */}
          <button
            onClick={toggleTheme}
            className="flex w-full items-center justify-between rounded px-3 py-2 text-xs font-medium hover:bg-notion-hover-bg transition-colors"
          >
            <span className="flex items-center gap-2">
              {theme === "dark" ? (
                <>
                  <Sun className="h-3.5 w-3.5 text-notion-muted" />
                  <span>Light Mode</span>
                </>
              ) : (
                <>
                  <Moon className="h-3.5 w-3.5 text-notion-muted" />
                  <span>Dark Mode</span>
                </>
              )}
            </span>
            <span className="text-[10px] text-notion-muted bg-notion-select-bg px-1.5 py-0.5 rounded uppercase tracking-wider">
              {theme}
            </span>
          </button>
        </div>
      </aside>
    </>
  );
}
