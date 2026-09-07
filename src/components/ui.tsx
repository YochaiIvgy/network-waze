import Link from "next/link";
import type { ReactNode } from "react";

export const TYPE_COLOR: Record<string, string> = {
  person: "var(--cat-person)",
  organization: "var(--cat-organization)",
  fund: "var(--cat-fund)",
  topic: "var(--cat-topic)",
  event: "var(--cat-event)",
};

export const TYPE_LABEL: Record<string, string> = {
  person: "Person",
  organization: "Organisation",
  fund: "Fund / LP",
  topic: "Topic",
  event: "Event",
};

export function TypeDot({ type }: { type: string }) {
  return <span className="dot" style={{ background: TYPE_COLOR[type] ?? "var(--ink-3)" }} />;
}

/** Colour is never the only carrier of type — the label rides along. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="badge">
      <TypeDot type={type} />
      {TYPE_LABEL[type] ?? type}
    </span>
  );
}

export function Avatar({ name, type = "person", large = false }: { name: string; type?: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      className={large ? "avatar avatar--lg" : "avatar"}
      style={{ background: TYPE_COLOR[type] ?? "var(--ink-3)" }}
      aria-hidden
    >
      {initials || "?"}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
}) {
  const inner = (
    <div className="stat">
      <span className="statLabel">{label}</span>
      <span className="statValue">{value}</span>
      {hint ? <span className="statHint">{hint}</span> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="card--hover" style={{ borderRadius: "var(--r-lg)", display: "block" }}>
      {inner}
    </Link>
  ) : (
    inner
  );
}

/**
 * A meter, not a chart. The word carries the meaning; the bar is a secondary
 * cue, so the value survives greyscale printing and colour-vision deficiency.
 */
export function Meter({ value, label, brand = false }: { value: number; label?: string; brand?: boolean }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className="meter" title={`${pct}%`}>
      <span className="meterTrack">
        <span
          className={brand ? "meterFill meterFill--brand" : "meterFill"}
          style={{ width: `${Math.max(3, pct)}%` }}
        />
      </span>
      {label ? <span className="meterLabel">{label}</span> : <span className="meterLabel">{pct}%</span>}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  tight = false,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  tight?: boolean;
}) {
  return (
    <section className="card">
      {title ? (
        <header className="cardHead">
          <h2 className="cardTitle">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={tight ? "cardBody cardBody--tight" : "cardBody"}>{children}</div>
    </section>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function relativeMonths(value: string | null | undefined): string {
  if (!value) return "never";
  const months = (Date.now() - new Date(value).getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months < 1) return "this month";
  if (months < 2) return "last month";
  if (months < 12) return `${Math.round(months)} months ago`;
  const years = months / 12;
  return years < 1.6 ? "a year ago" : `${Math.round(years)} years ago`;
}
