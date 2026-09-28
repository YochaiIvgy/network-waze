"use client";
import { useId, useState } from "react";
import type { ViewEntity } from "@/lib/view-model";
import type { LoopPerson } from "@/lib/loops";
export function PersonPicker({ people, attached, onAttach, refreshPeople }: { people: ViewEntity[]; attached: LoopPerson[]; onAttach: (p: LoopPerson) => void; refreshPeople: () => Promise<void> }) {
  const pickerId = useId();
  const [query, setQuery] = useState(""); const [focused, setFocused] = useState(false); const [active, setActive] = useState(0); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const matches = people.filter(p => !attached.some(a => a.id === p.id) && `${p.name} ${p.role}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);
  const canCreate = !!query.trim() && ![...people, ...attached].some(p => p.name.toLowerCase() === query.trim().toLowerCase());
  function choose(person: LoopPerson) { onAttach(person); setQuery(""); setActive(0); setFocused(false); }
  async function create() {
    if (busy || !canCreate) return;
    setBusy(true); setError("");
    try {
      const name = query.trim(); const response = await fetch("/api/entities", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create", type: "person", name }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "Could not create person.");
      choose({ id: data.id, name }); await refreshPeople();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const count = matches.length + (canCreate ? 1 : 0);
  return <div className="loop-person-picker" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}>
    <input role="combobox" aria-label="Attach a person" aria-autocomplete="list" aria-expanded={focused && count > 0} aria-controls={`${pickerId}-options`} aria-activedescendant={focused && count > 0 ? `${pickerId}-option-${active}` : undefined} placeholder="Find or add a person…" maxLength={200} value={query} disabled={busy} onFocus={() => setFocused(true)} onChange={e => { setQuery(e.target.value); setActive(0); setFocused(true); }} onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); setFocused(false); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setFocused(true); setActive(n => Math.max(0, Math.min(count - 1, n + (e.key === "ArrowDown" ? 1 : -1)))); }
      if (e.key === "Enter") { e.preventDefault(); if (focused && matches[active]) choose(matches[active]); else if (focused && canCreate) void create(); }
    }} />
    {focused && count > 0 && <div className="loop-person-options" id={`${pickerId}-options`} role="listbox">{matches.map((p, i) => <button id={`${pickerId}-option-${i}`} type="button" role="option" aria-selected={active === i} key={p.id} onMouseDown={e => e.preventDefault()} onClick={() => choose(p)}><strong>{p.name}</strong><small>{p.role || "Person"}</small></button>)}{canCreate && <button id={`${pickerId}-option-${matches.length}`} type="button" role="option" aria-selected={active === matches.length} onMouseDown={e => e.preventDefault()} onClick={() => void create()}>+ Add “{query.trim()}” to People</button>}</div>}
    {busy && <small>Adding to People…</small>}{error && <small role="alert">{error}</small>}
  </div>;
}
