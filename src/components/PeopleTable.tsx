"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { EntityListRow } from "@/lib/queries";
import { Avatar, Meter, TypeDot, TYPE_LABEL, relativeMonths } from "./ui";
import { IconSearch } from "./Icons";

const TABS = [
  { key: "all", label: "Everyone" },
  { key: "person", label: "People" },
  { key: "organization", label: "Organisations" },
  { key: "fund", label: "Funds & LPs" },
  { key: "topic", label: "Topics" },
] as const;

export function PeopleTable({ rows, selfId }: { rows: EntityListRow[]; selfId: string | null }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<string>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== "all" && r.entity_type !== tab) return false;
      if (!needle) return true;
      const hay = `${r.canonical_name} ${r.attributes?.title ?? ""} ${r.attributes?.org ?? ""} ${
        (r.attributes?.expertise ?? []).join(" ")
      } ${(r.attributes?.sector ?? []).join(" ")}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, q, tab]);

  const maxDegree = Math.max(1, ...rows.map((r) => r.degree));

  return (
    <>
      <div className="row row--wrap" style={{ gap: 10, marginBottom: 14 }}>
        <div className="searchField" style={{ flex: "1 1 260px", maxWidth: 380 }}>
          <IconSearch size={14} />
          <input
            className="input"
            placeholder="Filter by name, title, org, expertise…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="row row--wrap" style={{ gap: 6 }}>
          {TABS.map((t) => (
            <button key={t.key} className="chip" aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
              {t.key !== "all" ? <TypeDot type={t.key} /> : null}
              {t.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="xsmall muted tnum">{filtered.length} shown</span>
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Role</th>
                <th style={{ width: 140 }}>Connectedness</th>
                <th className="tnum">Meetings</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/entity/${r.id}`} className="row" style={{ gap: 10, minWidth: 0 }}>
                      <Avatar name={r.canonical_name} type={r.entity_type} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ fontWeight: 555, display: "block" }} className="truncate">
                          {r.canonical_name}
                          {r.id === selfId ? <span className="badge badge--brand" style={{ marginLeft: 8 }}>You</span> : null}
                          {r.status === "needs_review" ? (
                            <span className="badge badge--warn" style={{ marginLeft: 8 }}>
                              Review
                            </span>
                          ) : null}
                        </span>
                        {r.attributes?.org ? (
                          <span className="xsmall muted truncate" style={{ display: "block" }}>
                            {r.attributes.org}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </td>
                  <td>
                    <span className="row xsmall dim" style={{ gap: 6 }}>
                      <TypeDot type={r.entity_type} />
                      {TYPE_LABEL[r.entity_type] ?? r.entity_type}
                    </span>
                  </td>
                  <td className="small dim truncate" style={{ maxWidth: 260 }}>
                    {r.attributes?.title ?? r.attributes?.description ?? "—"}
                  </td>
                  <td>
                    <Meter value={r.degree / maxDegree} label={`${r.degree}`} />
                  </td>
                  <td className="tnum small dim">{r.source_count}</td>
                  <td className="small dim">{relativeMonths(r.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 ? <div className="empty">No matches.</div> : null}
      </div>
    </>
  );
}
