"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Logo } from "./Logo";
import {
  IconGraph,
  IconHome,
  IconMeetings,
  IconMenu,
  IconMoon,
  IconPeople,
  IconReview,
  IconSearch,
  IconSun,
  IconUpload,
} from "./Icons";

export interface NavCounts {
  people: number;
  meetings: number;
  reviews: number;
}

const NAV = [
  { href: "/", label: "Overview", icon: IconHome, group: "Network" },
  { href: "/graph", label: "Graph", icon: IconGraph, group: "Network" },
  { href: "/search", label: "Ask", icon: IconSearch, group: "Network" },
  { href: "/people", label: "People & orgs", icon: IconPeople, group: "Records", count: "people" },
  { href: "/meetings", label: "Meetings", icon: IconMeetings, group: "Records", count: "meetings" },
  { href: "/ingest", label: "Add transcript", icon: IconUpload, group: "Pipeline" },
  { href: "/review", label: "Review queue", icon: IconReview, group: "Pipeline", count: "reviews" },
] as const;

export function Shell({ children, counts }: { children: ReactNode; counts: NavCounts }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  const groups = [...new Set(NAV.map((n) => n.group))];

  return (
    <div className="shell">
      <aside className="sidebar" data-open={open}>
        <Link href="/" className="brandRow">
          <Logo size={30} />
          <span>
            <span className="brandName" style={{ display: "block" }}>
              Network Waze
            </span>
            <span className="brandSub">relationship intelligence</span>
          </span>
        </Link>

        {groups.map((group) => (
          <div key={group}>
            <div className="navLabel">{group}</div>
            {NAV.filter((n) => n.group === group).map((item) => {
              const Icon = item.icon;
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              const count = "count" in item ? counts[item.count as keyof NavCounts] : undefined;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="navItem"
                  aria-current={active ? "page" : undefined}
                >
                  <Icon />
                  {item.label}
                  {count ? <span className="navCount tnum">{count}</span> : null}
                </Link>
              );
            })}
          </div>
        ))}

        <div className="sidebarFoot">
          <ThemeToggle />
          <span className="xsmall muted">Theme</span>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button
            className="btn btn--ghost btn--icon"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
            style={{ display: "none" }}
            data-mobile-only
          >
            <IconMenu />
          </button>
          <TopbarTitle pathname={pathname} />
          <div className="spacer" />
          <Link href="/search" className="btn btn--sm">
            <IconSearch size={13} />
            Ask the network
          </Link>
        </div>
        {children}
      </div>

      <style>{`
        @media (max-width: 860px) {
          [data-mobile-only] { display: inline-flex !important; }
        }
      `}</style>
    </div>
  );
}

function TopbarTitle({ pathname }: { pathname: string }) {
  const item = [...NAV].sort((a, b) => b.href.length - a.href.length).find((n) =>
    n.href === "/" ? pathname === "/" : pathname.startsWith(n.href),
  );
  const label = item?.label ?? (pathname.startsWith("/entity") ? "Profile" : "Network Waze");
  return <span style={{ fontWeight: 570, fontSize: 13.5 }}>{label}</span>;
}

/**
 * Three states, two of which are explicit. "System" is the default and stamps
 * nothing, so the page follows the OS until the user actually chooses.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");

  useEffect(() => {
    const stored = localStorage.getItem("waze-theme");
    if (stored === "light" || stored === "dark") setTheme(stored);
  }, []);

  const apply = (next: "light" | "dark" | "system") => {
    setTheme(next);
    const root = document.documentElement;
    if (next === "system") {
      root.removeAttribute("data-theme");
      localStorage.removeItem("waze-theme");
    } else {
      root.setAttribute("data-theme", next);
      localStorage.setItem("waze-theme", next);
    }
  };

  const resolved =
    theme === "system"
      ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  return (
    <button
      className="btn btn--ghost btn--icon"
      onClick={() => apply(resolved === "dark" ? "light" : "dark")}
      onContextMenu={(e) => {
        e.preventDefault();
        apply("system");
      }}
      aria-label={`Switch to ${resolved === "dark" ? "light" : "dark"} theme (right-click for system)`}
      title={`${resolved === "dark" ? "Light" : "Dark"} theme — right-click to follow system`}
    >
      {resolved === "dark" ? <IconSun /> : <IconMoon />}
    </button>
  );
}
