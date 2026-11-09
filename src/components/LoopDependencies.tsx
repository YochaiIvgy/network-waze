"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Check, GitBranch, Link2, LockKeyhole, Plus, Search, Unlink, X } from "lucide-react";
import { connectLoops, dependencyBlockers, downstreamLoops, type LoopItem, type LoopPath } from "@/lib/loops";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

type DependencyContextValue = {
  paths: LoopPath[];
  items: LoopItem[];
  toolbar: ReactNode;
  target: string | null;
  invalid: boolean;
  start: (event: ReactPointerEvent<HTMLButtonElement>, id: string) => void;
  choose: (id: string) => void;
  remove: (source: string, target: string) => void;
  hover: (id: string | null) => void;
  inspect: (id: string) => void;
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
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function hover(id: string | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    if (id) setHovered(id);
    else hoverTimer.current = setTimeout(() => setHovered(null), 250);
  }
  useEffect(() => () => { if (hoverTimer.current) clearTimeout(hoverTimer.current); }, []);
  const [visibility, setVisibility] = useState<"off" | "hover" | "all">("hover");
  const show = visibility === "all";
  const [chainView, setChainView] = useState<string | null>(null);
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
      if (Math.hypot(current.x - current.originX, current.y - current.originY) < 5) setChainView(current.source);
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
    if (!show && (!hovered || visibility === "off") && !drag) { setWires([]); return; }
    let frame = 0;
    const colors = chainColors(items);
    const update = () => {
      const origin = root.current?.getBoundingClientRect();
      if (!origin) return;
      const rects = new Map<string, DOMRect>();
      root.current?.querySelectorAll<HTMLElement>("[data-loop-id]").forEach(element => {
        if (element.getClientRects().length) {
          const rect = element.getBoundingClientRect();
          rects.set(element.dataset.loopId!, new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height));
        }
      });
      const next: Wire[] = [];
      for (const item of items) for (const source of item.dependsOn) {
        if (!show && !(visibility === "hover" && hovered && colors.get(source) === colors.get(hovered)) && source !== drag?.source) continue;
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
      if (drag && from) next.push({ key: "drawing", x1: from.right - 4, y1: from.top + 25, x2: drag.x - origin.left, y2: drag.y - origin.top, released: false, color: colors.get(drag.source) ?? CHAIN_COLORS[0] });
      setWires(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      frame = requestAnimationFrame(update);
    };
    update(); return () => cancelAnimationFrame(frame);
  }, [paths, drag, hovered, show, visibility]);
  const blocked = items.filter(i => !i.resolved && dependencyBlockers(i, items).length);
  const bottlenecks = items.filter(i => !i.resolved).map(item => ({ item, count: downstreamLoops(item.id, items).length })).filter(entry => entry.count).sort((a, b) => b.count - a.count);
  const invalid = drag?.target ? connectLoops(paths, drag.source, drag.target).error : undefined;
  const toolbar = <>
      <div className="loops-dependency-toolbar">
        <div className="connection-display-control" role="group" aria-label="Connection line visibility"><GitBranch size={14} /><span>Lines</span>{(["off", "hover", "all"] as const).map(mode => <button key={mode} aria-pressed={visibility === mode} onClick={() => setVisibility(mode)}>{mode === "off" ? "Off" : mode === "hover" ? "On hover" : "All"}</button>)}</div>
        {!!blocked.length && <span className="connection-blocked-total"><LockKeyhole size={11} />{blocked.length} blocked</span>}
        {!!bottlenecks.length && <details><summary>Bottlenecks · {bottlenecks.length}</summary><div>{bottlenecks.map(({ item, count }) => <p key={item.id}><strong>{item.title}</strong><span>Holds up {count} {count === 1 ? "task" : "tasks"}</span></p>)}</div></details>}
        {notice && <span role="status">{notice}<button aria-label="Dismiss connection update" onClick={() => setNotice("")}><X size={12} /></button></span>}
      </div>
  </>;
  return <DependencyContext.Provider value={{ paths, items, toolbar, target: drag?.target ?? null, invalid: !!invalid, start, choose, inspect: setChainView, hover, remove: (source, target) => {
    if (onChange(paths.map(path => ({ ...path, items: path.items.map(item => item.id === target ? { ...item, dependsOn: item.dependsOn.filter(id => id !== source) } : item) })))) setNotice("Connection removed.");
  } }}>
    <div ref={root} className={`loops-dependency-surface ${drag ? "is-connecting" : ""}`} data-connection-target={drag?.target ?? ""}>

      {children}
      {drag && <div className={`loop-connect-hint ${invalid ? "is-invalid" : ""}`} role="status">{invalid || "Drop on the task that should wait · Esc to cancel"}</div>}
      {!!wires.length && <svg className="loop-dependency-wires">{wires.map(wire => {
        const drawing = wire.key === "drawing";
        const bend = Math.max(35, Math.abs(wire.vertical ? wire.y2 - wire.y1 : wire.x2 - wire.x1) / 2);
        const direction = (wire.vertical ? wire.y2 >= wire.y1 : wire.x2 >= wire.x1) ? 1 : -1;
        // Give the arrow a straight approach instead of bending through its tip.
        const tipX = wire.x2 - (wire.vertical ? 0 : direction * 3);
        const tipY = wire.y2 - (wire.vertical ? direction * 3 : 0);
        const baseX = tipX - (wire.vertical ? 0 : direction * 6);
        const baseY = tipY - (wire.vertical ? direction * 6 : 0);
        const lead = Math.min(12, Math.abs(wire.vertical ? wire.y2 - wire.y1 : wire.x2 - wire.x1) / 5);
        const approachX = baseX - (wire.vertical ? 0 : direction * lead);
        const approachY = baseY - (wire.vertical ? direction * lead : 0);
        const d = wire.vertical
          ? `M ${wire.x1} ${wire.y1} C ${wire.x1} ${wire.y1 + bend * direction}, ${approachX} ${approachY - bend * direction}, ${approachX} ${approachY} L ${baseX} ${baseY}`
          : `M ${wire.x1} ${wire.y1} C ${wire.x1 + bend * direction} ${wire.y1}, ${approachX - bend * direction} ${approachY}, ${approachX} ${approachY} L ${baseX} ${baseY}`;
        const angle = wire.vertical ? direction * 90 : direction > 0 ? 0 : 180;
        return <g key={wire.key} style={{ color: drawing && invalid ? "var(--primary)" : wire.color }} className={`${wire.released ? "is-released" : "is-waiting"} ${drawing ? "is-drawing" : ""} ${drawing && invalid ? "is-invalid" : ""}`}><path className="wire-halo" d={d} /><path className="wire-line" d={d} /><path className="wire-arrow" d="M -6 -3 L 0 0 L -6 3 Z" transform={`translate(${tipX} ${tipY}) rotate(${angle})`} /><circle cx={wire.x1} cy={wire.y1} r="3" />{!drawing && !drag && <ConnectionHitArea d={d} source={items.find(item => item.id === wire.key.split(":")[0])!} target={items.find(item => item.id === wire.key.split(":")[1])!} onHover={hover} onRemove={(source, target) => { if (onChange(paths.map(path => ({ ...path, items: path.items.map(item => item.id === target ? { ...item, dependsOn: item.dependsOn.filter(id => id !== source) } : item) })))) setNotice("Connection removed."); }} />}</g>;
      })}</svg>}
    </div>
    <ChainExplorer paths={paths} focus={chainView} onClose={() => setChainView(null)} onConnect={id => { setChainView(null); choose(id); }} onRemove={(source, target) => {
      onChange(paths.map(path => ({ ...path, items: path.items.map(item => item.id === target ? { ...item, dependsOn: item.dependsOn.filter(id => id !== source) } : item) })));
    }} />
    <Dialog open={!!chooser} onOpenChange={open => { if (!open) setChooser(null); }}><DialogContent><DialogHeader><DialogTitle>Connect the next task</DialogTitle><DialogDescription>When “{items.find(i => i.id === chooser)?.title}” is done, the selected task can start. All of its prerequisites must be complete.</DialogDescription></DialogHeader><div className="connection-search-field"><Search size={15} /><input className="loop-dependency-search" aria-label="Find a task to connect" placeholder="Find a task…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="loop-dependency-picker">{!items.some(i => i.id !== chooser && !i.resolved && i.title.toLowerCase().includes(query.toLowerCase())) && <p className="connection-empty">No matching open tasks.</p>}{items.filter(i => i.id !== chooser && !i.resolved && i.title.toLowerCase().includes(query.toLowerCase())).map(item => {
      const error = chooser ? connectLoops(paths, chooser, item.id).error : undefined;
      return <button key={item.id} disabled={!!error} title={error} onClick={() => { if (chooser && connect(chooser, item.id)) setChooser(null); }}><ArrowRight size={14} /><span><strong>{item.title}</strong><small>{error || paths.find(path => path.items.some(i => i.id === item.id))?.name}</small></span></button>;
    })}</div></DialogContent></Dialog>
  </DependencyContext.Provider>;
}

function ConnectionHitArea({ d, source, target, onRemove, onHover }: {
  d: string; source: LoopItem; target: LoopItem;
  onRemove: (source: string, target: string) => void;
  onHover?: (id: string | null) => void;
}) {
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const trigger = useRef<SVGPathElement>(null);
  const popup = useRef<SVGForeignObjectElement>(null);
  const open = !!position;
  const hoverRef = useRef(onHover); hoverRef.current = onHover;
  useEffect(() => {
    if (!open) return;
    const close = () => { setPosition(null); hoverRef.current?.(null); };
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); trigger.current?.focus(); close(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key, true); window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [open]);
  if (!source || !target) return null;
  const show = (x?: number, y?: number) => {
    const element = trigger.current;
    const matrix = element?.getScreenCTM();
    if (!element || !matrix) return;
    const middle = element.getPointAtLength(element.getTotalLength() / 2).matrixTransform(matrix);
    const point = new DOMPoint(Math.max(8, Math.min((x ?? middle.x) - 85, window.innerWidth - 188)), Math.max(8, Math.min((y ?? middle.y) + 10, window.innerHeight - 52))).matrixTransform(matrix.inverse());
    onHover?.(source.id); setPosition({ x: point.x, y: point.y });
  };
  return <>
    <path ref={trigger} className="connection-hit-area" d={d} role="button" tabIndex={0} aria-label={`Manage connection from ${source.title} to ${target.title}`} aria-expanded={open} onPointerEnter={() => onHover?.(source.id)} onPointerLeave={() => { if (!open) onHover?.(null); }} onFocus={() => onHover?.(source.id)} onBlur={() => { if (!open) onHover?.(null); }} onClick={e => { e.stopPropagation(); show(e.clientX, e.clientY); }} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); show(); } }}><title>Click to remove connection</title></path>
    {position && <foreignObject ref={popup} x={position.x} y={position.y} width="180" height="44" className="connection-inline-action"><button ref={element => { element?.focus({ preventScroll: true }); }} className="connection-inline-remove" title={`${source.title} → ${target.title}`} onClick={e => { e.stopPropagation(); onRemove(source.id, target.id); setPosition(null); onHover?.(null); }}><Unlink size={14} />Remove connection</button></foreignObject>}
  </>;
}

function ChainExplorer({ paths, focus, onClose, onConnect, onRemove, inline = false }: {
  inline?: boolean;
  paths: LoopPath[]; focus: string | null; onClose: () => void;
  onConnect: (id: string) => void; onRemove: (source: string, target: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(focus === "all" ? null : focus), [focus]);
  const items = paths.flatMap(path => path.items);
  const colors = chainColors(items);
  const groups = [...new Set(colors.values())].filter(color => focus === "all" || color === colors.get(focus ?? ""));
  const active = items.find(item => item.id === selected);
  const content = <>
    {inline ? <p className="chains-view-description">Follow what unlocks what, across every board. Select a task to manage its connections. Dashed lines are released.</p> : <DialogHeader><DialogTitle>{focus === "all" ? "Chains" : "Full chain"}</DialogTitle><DialogDescription>Follow what unlocks what, across every board. Select a task to manage its connections. Dashed lines are released.</DialogDescription></DialogHeader>}
    <div className="chain-explorer-body"><div className="chain-explorer-canvas">
      {!groups.length && <div className="chain-empty"><GitBranch size={28} /><h3>{focus === "all" ? "No chains yet" : "This task isn't connected yet"}</h3><p>Connect tasks to see the sequence here.</p>{active && <button onClick={() => onConnect(active.id)}><Plus size={14} />Connect next task</button>}</div>}
      {groups.map((color, index) => {
        const members = items.filter(item => colors.get(item.id) === color);
        const ids = new Set(members.map(item => item.id));
        const levels = new Map<string, number>();
        // Topological layers preserve forks and joins without duplicating tasks.
        for (let pass = 0; pass < members.length; pass++) {
          let changed = false;
          for (const item of members) {
            if (levels.has(item.id)) continue;
            const parents = item.dependsOn.filter(id => ids.has(id));
            if (parents.every(id => levels.has(id))) {
              levels.set(item.id, parents.length ? Math.max(...parents.map(id => levels.get(id)!)) + 1 : 0);
              changed = true;
            }
          }
          if (!changed) break;
        }
        const counts = new Map<number, number>();
        const positions = new Map(members.map(item => {
          const level = levels.get(item.id) ?? 0;
          const row = counts.get(level) ?? 0; counts.set(level, row + 1);
          return [item.id, { x: 20 + level * 280, y: 20 + row * 140 }];
        }));
        const width = (Math.max(0, ...levels.values()) + 1) * 280;
        const height = Math.max(1, ...counts.values()) * 140 + 20;
        return <section key={color} className="chain-map-section"><header><i style={{ background: color }} /><strong>{members.filter(item => !item.dependsOn.some(id => ids.has(id))).map(item => item.title).join(" + ") || `Chain ${index + 1}`}</strong><span>{members.length} tasks</span></header>
          <div className="chain-map-scroll"><div className="chain-map" style={{ width, height }}>
            <svg width={width} height={height}>{members.flatMap(item => item.dependsOn.map(source => {
              const from = positions.get(source), to = positions.get(item.id); if (!from || !to) return null;
              const x1 = from.x + 220, y1 = from.y + 52, x2 = to.x, y2 = to.y + 52;
              return <g key={`${source}:${item.id}`} fill="none" stroke={color} strokeWidth="1.8" opacity={items.find(i => i.id === source)?.resolved ? .5 : 1}><path strokeDasharray={items.find(i => i.id === source)?.resolved ? "5 4" : undefined} d={`M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`} /><path d={`M ${x2 - 7} ${y2 - 4} L ${x2} ${y2} L ${x2 - 7} ${y2 + 4}`} /><ConnectionHitArea d={`M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`} source={items.find(i => i.id === source)!} target={item} onRemove={onRemove} /></g>;
            }))}</svg>
            {members.map(item => { const position = positions.get(item.id)!; const blocked = dependencyBlockers(item, items).length > 0; return <button key={item.id} className="chain-task" aria-pressed={selected === item.id} style={{ left: position.x, top: position.y, borderTopColor: color }} onClick={() => setSelected(item.id)}><small>{paths.find(path => path.items.some(i => i.id === item.id))?.name}</small><strong>{item.title}</strong><span>{item.resolved ? <Check size={12} /> : blocked ? <LockKeyhole size={12} /> : <ArrowRight size={12} />}{item.resolved ? "Completed" : blocked ? "Blocked" : "Ready"}</span></button>; })}
          </div></div></section>;
      })}
    </div>{active && <aside className="chain-inspector"><h3>{active.title}</h3>{([true, false] as const).map(incoming => {
      const related = items.filter(item => incoming ? active.dependsOn.includes(item.id) : item.dependsOn.includes(active.id));
      return <section key={String(incoming)}><h4>{incoming ? "Waiting for" : "Unlocks"}</h4>{!related.length && <p>{incoming ? "No prerequisites" : "No following tasks"}</p>}{related.map(item => <div className="chain-inspector-row" key={item.id}><button onClick={() => setSelected(item.id)}>{item.title}</button><button aria-label={`Remove connection ${incoming ? item.title : active.title} to ${incoming ? active.title : item.title}`} title="Remove connection" onClick={() => onRemove(incoming ? item.id : active.id, incoming ? active.id : item.id)}><Unlink size={14} /></button></div>)}</section>;
    })}<button className="connection-add-next" onClick={() => onConnect(active.id)}><Plus size={14} />Connect next task</button></aside>}</div>
  </>;
  return inline ? <section className="chains-page-view" aria-label="All chains">{content}</section> : <Dialog open={!!focus} onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="chain-explorer">{content}</DialogContent></Dialog>;
}

export function LoopChainsView() {
  const context = useContext(DependencyContext);
  if (!context) return null;
  return <ChainExplorer inline paths={context.paths} focus="all" onClose={() => {}} onConnect={context.choose} onRemove={context.remove} />;
}

export function LoopDependencyControls({ item }: { item: LoopItem }) {
  const context = useContext(DependencyContext);
  if (!context) return null;
  const total = item.dependsOn.length + context.items.filter(other => other.dependsOn.includes(item.id)).length;
  const blocked = !item.resolved && dependencyBlockers(item, context.items).length > 0;
  return <div className="loop-dependency-controls">
    <button className={`loop-connect-handle ${total > 0 ? "has-connections" : ""}`} title="Click to explore chain · Drag to connect" aria-label={`Explore chain for ${item.title}${total ? `, ${total} connections` : ""}`} onPointerDown={e => context.start(e, item.id)} onClick={e => { if (e.detail === 0) context.inspect(item.id); }}><Link2 size={14} />{total > 0 && <span className={`loop-chain-count ${blocked ? "is-blocked" : ""}`}>{total}</span>}</button>
  </div>;
}

export function useDependencyTarget(id: string) {
  const context = useContext(DependencyContext);
  return context?.target === id ? context.invalid ? "invalid" : "valid" : undefined;
}

export function useDependencyHover() {
  return useContext(DependencyContext)?.hover;
}

export function LoopDependencyToolbar() {
  return useContext(DependencyContext)?.toolbar ?? null;
}
