"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Check, GitBranch, Link2, LockKeyhole, Plus, Search, Unlink, X } from "lucide-react";
import { connectLoops, dependencyBlockers, downstreamLoops, type LoopItem, type LoopPath } from "@/lib/loops";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type DependencyContextValue = {
  items: LoopItem[];
  toolbar: ReactNode;
  target: string | null;
  invalid: boolean;
  start: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  choose: (id: string) => void;
  remove: (source: string, target: string) => void;
  hover: (id: string | null) => void;
};
const DependencyContext = createContext<DependencyContextValue | null>(null);
type Wire = { key: string; x1: number; y1: number; x2: number; y2: number; released: boolean; vertical?: boolean; color: string };

const CHAIN_COLORS = ["#6875d9", "#269b94", "#c36996", "#bc8736", "#8c6bc5", "#378cb6"];

// A chain includes branches and merges: every connected task shares its color.
function chainColors(items: LoopItem[]) {
  const neighbors = new Map(items.map(item => [item.id, new Set<string>()]));
  for (const item of items) for (const source of item.dependsOn) {
    neighbors.get(item.id)?.add(source);
    neighbors.get(source)?.add(item.id);
  }
  const colors = new Map<string, string>();
  let index = 0;
  for (const id of [...neighbors.keys()].sort()) {
    if (colors.has(id) || !neighbors.get(id)?.size) continue;
    const color = index < CHAIN_COLORS.length ? CHAIN_COLORS[index] : `hsl(${(index * 137.508) % 360} 48% 48%)`;
    index++;
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (colors.has(current)) continue;
      colors.set(current, color);
      for (const neighbor of neighbors.get(current) ?? []) pending.push(neighbor);
    }
  }
  return colors;
}
type ConnectionDrag = { source: string; x: number; y: number; originX: number; originY: number; target: string | null };

export function LoopDependencies({ paths, onChange, children }: { paths: LoopPath[]; onChange: (paths: LoopPath[]) => boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<ConnectionDrag | null>(null);
  const dragRef = useRef<ConnectionDrag | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [chooser, setChooser] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [wires, setWires] = useState<Wire[]>([]);
  const items = paths.flatMap(path => path.items);
  const latestPaths = useRef(paths); latestPaths.current = paths;
  const save = useRef(onChange); save.current = onChange;

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);

  function connect(source: string, target: string) {
    const result = connectLoops(latestPaths.current, source, target);
    if (result.error) { setNotice(result.error); return false; }
    if (!save.current(result.paths)) return false;
    const all = result.paths.flatMap(path => path.items);
    setNotice(`Connected: ${all.find(i => i.id === source)?.title} → ${all.find(i => i.id === target)?.title}`);
    return true;
  }
  function choose(id: string) { setChooser(id); setQuery(""); }
  function start(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const value = { source: id, x: event.clientX, y: event.clientY, originX: event.clientX, originY: event.clientY, target: null };
    dragRef.current = value; setDrag(value); setNotice("");
  }
  useEffect(() => {
    if (!drag?.source) return;
    const move = (event: PointerEvent) => {
      const current = dragRef.current; if (!current) return;
      const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-loop-id]");
      const target = hit && root.current?.contains(hit) ? hit.dataset.loopId ?? null : null;
      const next = { ...current, x: event.clientX, y: event.clientY, target };
      dragRef.current = next; setDrag(next);
      if (event.clientY > window.innerHeight - 55) window.scrollBy(0, 15);
      else if (event.clientY < 80) window.scrollBy(0, -15);
    };
    const cancel = () => { dragRef.current = null; setDrag(null); };
    const end = () => {
      const current = dragRef.current; if (!current) return;
      if (Math.hypot(current.x - current.originX, current.y - current.originY) < 5) choose(current.source);
      else if (current.target) connect(current.source, current.target);
      cancel();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel); window.removeEventListener("keydown", key); window.removeEventListener("blur", cancel);
    };
  }, [drag?.source]);

  useEffect(() => {
    if (!show && !hovered && !drag) { setWires([]); return; }
    let frame = 0;
    const colors = chainColors(items);
    const update = () => {
      const rects = new Map<string, DOMRect>();
      root.current?.querySelectorAll<HTMLElement>("[data-loop-id]").forEach(element => {
        if (element.getClientRects().length) rects.set(element.dataset.loopId!, element.getBoundingClientRect());
      });
      const next: Wire[] = [];
      for (const item of items) for (const source of item.dependsOn) {
        if (!show && source !== hovered && item.id !== hovered && source !== drag?.source) continue;
        const from = rects.get(source), to = rects.get(item.id);
        if (from && to) {
          const vertical = to.top >= from.bottom + 8 || from.top >= to.bottom + 8;
          const forward = vertical ? to.top > from.top : to.left > from.left;
          next.push({ key: `${source}:${item.id}`, vertical, color: colors.get(source) ?? CHAIN_COLORS[0],
            x1: vertical ? from.left + from.width / 2 : forward ? from.right : from.left,
            y1: vertical ? forward ? from.bottom : from.top : from.top + 25,
            x2: vertical ? to.left + to.width / 2 : forward ? to.left : to.right,
            y2: vertical ? forward ? to.top : to.bottom : to.top + 25,
            released: !!items.find(i => i.id === source)?.resolved });
        }
      }
      const from = drag && rects.get(drag.source);
      if (drag && from) next.push({ key: "drawing", x1: from.right - 4, y1: from.top + 25, x2: drag.x, y2: drag.y, released: false, color: colors.get(drag.source) ?? CHAIN_COLORS[0] });
      setWires(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      frame = requestAnimationFrame(update);
    };
    update(); return () => cancelAnimationFrame(frame);
  }, [paths, drag, hovered, show]);
  const blocked = items.filter(i => !i.resolved && dependencyBlockers(i, items).length);
  const bottlenecks = items.filter(i => !i.resolved).map(item => ({ item, count: downstreamLoops(item.id, items).length })).filter(entry => entry.count).sort((a, b) => b.count - a.count);
  const invalid = drag?.target ? connectLoops(paths, drag.source, drag.target).error : undefined;
  const toolbar = <>
      <div className="loops-dependency-toolbar">
        <button aria-pressed={show} onClick={() => setShow(v => !v)}><GitBranch size={14} /> Connections{items.some(i => i.dependsOn.length) && <span className="connection-total">{items.reduce((sum, i) => sum + i.dependsOn.length, 0)}</span>}</button>
        {show && <span className="connection-legend">Colors identify chains · Dashed = released</span>}{!!blocked.length && <span className="connection-blocked-total"><LockKeyhole size={11} />{blocked.length} blocked</span>}
        {!!bottlenecks.length && <details><summary>Bottlenecks · {bottlenecks.length}</summary><div>{bottlenecks.map(({ item, count }) => <p key={item.id}><strong>{item.title}</strong><span>Holds up {count} {count === 1 ? "task" : "tasks"}</span></p>)}</div></details>}
        {notice && <span role="status">{notice}<button aria-label="Dismiss connection update" onClick={() => setNotice("")}><X size={12} /></button></span>}
      </div>
  </>;
  return <DependencyContext.Provider value={{ items, toolbar, target: drag?.target ?? null, invalid: !!invalid, start, choose, hover: setHovered, remove: (source, target) => {
    if (onChange(paths.map(path => ({ ...path, items: path.items.map(item => item.id === target ? { ...item, dependsOn: item.dependsOn.filter(id => id !== source) } : item) })))) setNotice("Connection removed.");
  } }}>
    <div ref={root} className={`loops-dependency-surface ${drag ? "is-connecting" : ""}`} data-connection-target={drag?.target ?? ""}>

      {children}
      {drag && <div className={`loop-connect-hint ${invalid ? "is-invalid" : ""}`} role="status">{invalid || "Drop on the task that should wait · Esc to cancel"}</div>}
      {!!wires.length && <svg className="loop-dependency-wires" aria-hidden="true">{wires.map(wire => {
        const drawing = wire.key === "drawing";
        const bend = Math.max(35, Math.abs(wire.vertical ? wire.y2 - wire.y1 : wire.x2 - wire.x1) / 2);
        const direction = (wire.vertical ? wire.y2 >= wire.y1 : wire.x2 >= wire.x1) ? 1 : -1;
        const d = wire.vertical
          ? `M ${wire.x1} ${wire.y1} C ${wire.x1} ${wire.y1 + bend * direction}, ${wire.x2} ${wire.y2 - bend * direction}, ${wire.x2} ${wire.y2}`
          : `M ${wire.x1} ${wire.y1} C ${wire.x1 + bend * direction} ${wire.y1}, ${wire.x2 - bend * direction} ${wire.y2}, ${wire.x2} ${wire.y2}`;
        const angle = wire.vertical ? direction * 90 : direction > 0 ? 0 : 180;
        return <g key={wire.key} style={{ color: drawing && invalid ? "var(--primary)" : wire.color }} className={`${wire.released ? "is-released" : "is-waiting"} ${drawing ? "is-drawing" : ""} ${drawing && invalid ? "is-invalid" : ""}`}><path className="wire-halo" d={d} /><path className="wire-line" d={d} /><path className="wire-arrow" d="M -7 -4 L 0 0 L -7 4" transform={`translate(${wire.x2} ${wire.y2}) rotate(${angle})`} /><circle cx={wire.x1} cy={wire.y1} r="3" /></g>;
      })}</svg>}
    </div>
    <Dialog open={!!chooser} onOpenChange={open => { if (!open) setChooser(null); }}><DialogContent><DialogHeader><DialogTitle>Connect the next task</DialogTitle><DialogDescription>When “{items.find(i => i.id === chooser)?.title}” is done, the selected task can start. All of its prerequisites must be complete.</DialogDescription></DialogHeader><div className="connection-search-field"><Search size={15} /><input className="loop-dependency-search" aria-label="Find a task to connect" placeholder="Find a task…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="loop-dependency-picker">{!items.some(i => i.id !== chooser && !i.resolved && i.title.toLowerCase().includes(query.toLowerCase())) && <p className="connection-empty">No matching open tasks.</p>}{items.filter(i => i.id !== chooser && !i.resolved && i.title.toLowerCase().includes(query.toLowerCase())).map(item => {
      const error = chooser ? connectLoops(paths, chooser, item.id).error : undefined;
      return <button key={item.id} disabled={!!error} title={error} onClick={() => { if (chooser && connect(chooser, item.id)) setChooser(null); }}><ArrowRight size={14} /><span><strong>{item.title}</strong><small>{error || paths.find(path => path.items.some(i => i.id === item.id))?.name}</small></span></button>;
    })}</div></DialogContent></Dialog>
  </DependencyContext.Provider>;
}

export function LoopDependencyControls({ item }: { item: LoopItem }) {
  const context = useContext(DependencyContext);
  const menu = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && menu.current) menu.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  if (!context) return null;
  const { items } = context;
  const prerequisites = items.filter(i => item.dependsOn.includes(i.id));
  const blockers = dependencyBlockers(item, items);
  const dependents = items.filter(i => i.dependsOn.includes(item.id));
  const downstream = downstreamLoops(item.id, items);
  const blocked = !item.resolved && blockers.length > 0;
  const total = prerequisites.length + dependents.length;
  const status = item.resolved ? "Completed" : blocked ? "Blocked" : "Ready";
  const connectionRow = (other: LoopItem, incoming: boolean) => <div className="connection-entry" key={other.id}>
    <span className={`connection-entry-icon ${other.resolved ? "is-complete" : ""}`}>{other.resolved ? <Check size={13} /> : incoming ? <LockKeyhole size={12} /> : <ArrowRight size={13} />}</span>
    <span className="connection-entry-copy"><strong>{other.title}</strong><small>{other.resolved ? "Completed" : incoming ? "Must finish first" : "Starts after this task"}</small></span>
    <button className="connection-remove" aria-label={incoming ? `Remove dependency on ${other.title}` : `Remove connection to ${other.title}`} title="Remove connection" onClick={() => context.remove(incoming ? other.id : item.id, incoming ? item.id : other.id)}><Unlink size={14} /></button>
  </div>;
  return <div className="loop-dependency-controls" onMouseEnter={() => context.hover(item.id)} onMouseLeave={() => { if (!open) context.hover(null); }} onFocus={() => context.hover(item.id)} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) context.hover(null); }}>
    <button className="loop-connect-handle" title="Drag to connect · Click to choose the next task" aria-label={`Connect after ${item.title}`} onPointerDown={e => context.start(e, item.id)} onClick={e => { if (e.detail === 0) context.choose(item.id); }}><Link2 size={14} /></button>
    {total > 0 && <details ref={menu} onToggle={e => { setOpen(e.currentTarget.open); context.hover(e.currentTarget.open ? item.id : null); }}>
      <summary aria-label={`Connections for ${item.title}: ${status}, ${total} connections`} title={`${status} · ${total} connections`} className={blocked ? "is-blocked" : "is-ready"}><span>{total}</span></summary>
      <div className="loop-dependency-list">
        <header className="connection-panel-heading"><span>Connections</span><span className={`connection-state ${blocked ? "is-blocked" : "is-ready"}`}>{blocked ? <LockKeyhole size={11} /> : <Check size={11} />}{status}</span></header>
        {prerequisites.length > 0 && <section className="connection-section"><h4>Waiting for <span>{prerequisites.length}</span></h4>{prerequisites.map(other => connectionRow(other, true))}</section>}
        {dependents.length > 0 && <section className="connection-section"><h4>Unlocks <span>{dependents.length}</span></h4>{dependents.map(other => connectionRow(other, false))}</section>}
        {downstream.length > 0 && !item.resolved && <p className="connection-impact"><GitBranch size={13} />{downstream.length} {downstream.length === 1 ? "task follows" : "tasks follow"} this task in the chain</p>}
        <button className="connection-add-next" onClick={() => { if (menu.current) menu.current.open = false; context.choose(item.id); }}><Plus size={13} />Connect next task</button>
      </div>
    </details>}
  </div>;
}

export function useDependencyTarget(id: string) {
  const context = useContext(DependencyContext);
  return context?.target === id ? context.invalid ? "invalid" : "valid" : undefined;
}

export function LoopDependencyToolbar() {
  return useContext(DependencyContext)?.toolbar ?? null;
}
