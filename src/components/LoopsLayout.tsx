"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Layers, Plus, Settings2 } from "lucide-react";
import { type LoopPath, pathDisplayColor } from "@/lib/loops";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type Layout = { height: number; expanded: Record<string, boolean> };

function BoardSlot({ path, children }: { path: LoopPath; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [naturalHeight, setNaturalHeight] = useState(0);
  useLayoutEffect(() => {
    const slot = root.current;
    const content = slot?.querySelector<HTMLElement>(".loop-path-content");
    const region = slot?.querySelector<HTMLElement>(".loop-path-items");
    const header = slot?.querySelector<HTMLElement>(".loop-path-header");
    if (!slot || !content || !region || !header) return;
    const measure = () => {
      if (!slot.offsetHeight) return; // A closed stack has no measurable layout.
      const style = getComputedStyle(region);
      const height = content.offsetHeight + header.offsetHeight + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + 2;
      const hidden = height > slot.clientHeight + 1;
      setOverflow(hidden);
      setNaturalHeight(Math.ceil(height));
      if (!hidden) setExpanded(false);
    };
    const observer = new ResizeObserver(measure);
    [slot, content, header].forEach(element => observer.observe(element));
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const leave = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setExpanded(false);
    };
    document.addEventListener("pointerdown", leave, true);
    document.addEventListener("focusin", leave, true);
    document.addEventListener("wheel", leave, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", leave, true);
      document.removeEventListener("focusin", leave, true);
      document.removeEventListener("wheel", leave, true);
    };
  }, [expanded]);
  const activate = () => { if (overflow) setExpanded(true); };
  return <div ref={root} data-layout-unit={path.id} className={`loops-board-slot${overflow ? " has-overflow" : ""}${expanded ? " is-board-expanded" : ""}`} style={{ "--board-natural-height": `${naturalHeight}px` } as CSSProperties}
    onPointerDownCapture={activate} onFocusCapture={activate} onWheelCapture={activate} onTouchMoveCapture={activate}
    onKeyDownCapture={event => { if (event.key === "Escape") setExpanded(false); else if (event.key !== "Tab") activate(); }}>
    {children}
  </div>;
}

export function LoopsLayout({ paths, storageKey, onChange, previewMatches, children }: {
  paths: LoopPath[]; storageKey: string; onChange: (paths: LoopPath[]) => boolean;
  previewMatches: (item: LoopPath["items"][number]) => boolean;
  children: (path: LoopPath, index: number, organize: () => void) => ReactNode;
}) {
  const [layout, setLayout] = useState<Layout>({ height: 360, expanded: {} });
  const [ready, setReady] = useState(false);
  const [editor, setEditor] = useState<{ id: string; name: string; selected: string[] } | null>(null);
  const [destination, setDestination] = useState<LoopPath | null>(null);
  const anchors = useRef(new Map<string, HTMLElement>());
  const board = useRef<HTMLDivElement>(null);
  const previousRects = useRef(new Map<string, DOMRect>());
  const motion = useRef<Animation[]>([]);
  const opening = useRef<string | null>(null);
  useEffect(() => () => { motion.current.forEach(animation => animation.cancel()); }, []);
  useLayoutEffect(() => {
    if (!previousRects.current.size || !board.current) return;
    motion.current.forEach(animation => animation.cancel());
    motion.current = [];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const element of Array.from(board.current.children) as HTMLElement[]) {
      const before = previousRects.current.get(element.dataset.layoutUnit ?? "");
      if (!before || reduced) continue;
      const after = element.getBoundingClientRect();
      if (!after.width || !after.height) continue;
      motion.current.push(element.animate([
        { transform: `translate(${before.left - after.left}px, ${before.top - after.top}px) scale(${before.width / after.width}, ${before.height / after.height})` },
        { transform: "translate(0, 0) scale(1, 1)" },
      ], { duration: 380, easing: "cubic-bezier(.22, 1, .36, 1)" }));
    }
    if (opening.current && !reduced) {
      const slots = anchors.current.get(opening.current)?.querySelectorAll<HTMLElement>(".loops-board-slot");
      slots?.forEach((slot, index) => {
        motion.current.push(slot.animate([
          { opacity: 0, transform: "translateX(-18px)" },
          { opacity: 1, transform: "translateX(0)" },
        ], { duration: 300, delay: 65 + Math.min(index, 5) * 35, fill: "backwards", easing: "cubic-bezier(.22, 1, .36, 1)" }));
      });
    }
    previousRects.current.clear();
    opening.current = null;
  }, [layout.expanded]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved && typeof saved.height === "number" && saved.expanded && typeof saved.expanded === "object") {
        setLayout({ height: Math.max(260, Math.min(640, saved.height)), expanded: Object.fromEntries(Object.entries(saved.expanded).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean> });
      }
    } catch { /* Use the default layout if browser storage is unavailable. */ }
    setReady(true);
  }, [storageKey]);
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Layout is still usable for this session. */ }
  }, [layout, ready, storageKey]);

  const stacks = [...new Map(paths.filter(p => p.stack).map(p => [p.stack!.id, p.stack!])).values()];
  const units = paths.filter((path, index) => !path.stack || paths.findIndex(p => p.stack?.id === path.stack!.id) === index);
  function toggle(id: string) {
    previousRects.current = new Map(Array.from(board.current?.children ?? []).map(element => [(element as HTMLElement).dataset.layoutUnit ?? "", element.getBoundingClientRect()]));
    opening.current = layout.expanded[id] ? null : id;
    setLayout(current => ({ ...current, expanded: { ...current.expanded, [id]: !current.expanded[id] } }));
  }
  function saveStack() {
    if (!editor || !editor.name.trim() || !editor.selected.length) return;
    const stack = { id: editor.id, name: editor.name.trim() };
    if (onChange(paths.map(p => editor.selected.includes(p.id) ? { ...p, stack } : p.stack?.id === editor.id ? { ...p, stack: undefined } : p))) setEditor(null);
  }
  function moveStack(id: string, direction: number) {
    const index = units.findIndex(p => p.stack?.id === id);
    const target = units[index + direction];
    if (!target) return;
    const ordered = [...units]; const [unit] = ordered.splice(index, 1); ordered.splice(index + direction, 0, unit);
    onChange(ordered.flatMap(p => p.stack ? paths.filter(child => child.stack?.id === p.stack!.id) : [p]));
  }

  return <>
    <div className="loops-layout-toolbar">
      <button className="loops-quiet" onClick={() => setEditor({ id: crypto.randomUUID(), name: "", selected: [] })}><Layers size={15} /> New stack</button>
      <label className="loops-height-control">Board height <input aria-label="Board height" type="range" min="260" max="640" step="20" value={layout.height} onChange={event => setLayout(current => ({ ...current, height: Number(event.target.value) }))} /><span>{layout.height < 340 ? "Compact" : layout.height > 480 ? "Tall" : "Comfortable"}</span></label>
    </div>
    <div ref={board} className="loops-board loops-spatial-board" style={{ "--board-height": `${layout.height}px` } as CSSProperties}>
      {units.map((unit, unitIndex) => {
        if (!unit.stack) return <BoardSlot key={unit.id} path={unit}>{children(unit, paths.indexOf(unit), () => setDestination(unit))}</BoardSlot>;
        const stack = unit.stack; const members = paths.filter(p => p.stack?.id === stack.id); const expanded = !!layout.expanded[stack.id];
        return <section key={stack.id} data-layout-unit={stack.id} ref={element => { if (element) anchors.current.set(stack.id, element); else anchors.current.delete(stack.id); }} className={`loops-stack ${expanded ? "is-expanded" : "is-collapsed"}`} style={{ "--stack-width": `${members.length * 325 + (members.length - 1) * 16 + 26}px` } as CSSProperties}>
          <header className="loops-stack-header">
            <button className="loops-stack-toggle" aria-expanded={expanded} aria-controls={`stack-${stack.id}`} onClick={() => toggle(stack.id)}><Layers size={16} /><strong>{stack.name}</strong><span>{members.length} boards</span><ChevronDown size={15} /></button>
            <button className="loops-stack-settings" aria-label={`Manage ${stack.name} stack`} onClick={() => setEditor({ ...stack, selected: members.map(p => p.id) })}><Settings2 size={15} /></button>
          </header>
          <div id={`stack-${stack.id}`} className="loops-stack-children" hidden={!expanded}>
            {members.map(path => <BoardSlot key={path.id} path={path}>{children(path, paths.indexOf(path), () => setDestination(path))}</BoardSlot>)}
          </div>
          {!expanded && <button className="loops-stack-preview" aria-label={`Expand ${stack.name}`} onClick={() => toggle(stack.id)}>
            <span className="loops-stack-preview-label">Board previews</span>
            {members.map(path => { const items = path.items.filter(previewMatches); return <span className="loops-stack-preview-board" key={path.id}>
              <span className="loops-stack-preview-name"><i style={{ background: pathDisplayColor(path.color) }} />{path.name}<small>{items.length}</small></span>
              {items.slice(0, 2).map(item => <span className="loops-stack-preview-loop" key={item.id}>{item.title}</span>)}
              {!items.length && <span className="loops-stack-preview-loop">No matching loops</span>}
              {items.length > 2 && <span className="loops-stack-preview-more">+{items.length - 2} more</span>}
            </span>; })}
            <span className="loops-stack-preview-footer">Expand {members.length} boards →</span>
          </button>}
          <div className="loops-stack-order"><button disabled={unitIndex === 0} onClick={() => moveStack(stack.id, -1)} aria-label={`Move ${stack.name} stack earlier`}>←</button><button disabled={unitIndex === units.length - 1} onClick={() => moveStack(stack.id, 1)} aria-label={`Move ${stack.name} stack later`}>→</button></div>
        </section>;
      })}
    </div>
    <Dialog open={!!destination} onOpenChange={open => { if (!open) setDestination(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Organize “{destination?.name}”</DialogTitle><DialogDescription>Keep related boards together in an expandable stack.</DialogDescription></DialogHeader>
      <div className="loops-stack-destinations">{stacks.map(stack => <Button key={stack.id} variant="outline" disabled={stack.id === destination?.stack?.id} onClick={() => { if (onChange(paths.map(p => p.id === destination?.id ? { ...p, stack } : p))) setDestination(null); }}><Layers size={14} />{stack.name}{stack.id === destination?.stack?.id ? " · current" : ""}</Button>)}
      <Button variant="outline" onClick={() => { setEditor({ id: crypto.randomUUID(), name: "", selected: destination ? [destination.id] : [] }); setDestination(null); }}><Plus size={14} />Create a new stack</Button>
      {destination?.stack && <Button variant="ghost" onClick={() => { if (onChange(paths.map(p => p.id === destination.id ? { ...p, stack: undefined } : p))) setDestination(null); }}>Remove from stack</Button>}</div>
    </DialogContent></Dialog>
    <Dialog open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{stacks.some(s => s.id === editor?.id) ? "Manage stack" : "New stack"}</DialogTitle><DialogDescription>Choose the boards to keep together. Boards from other stacks will move here.</DialogDescription></DialogHeader>
      <label className="loops-stack-name-field">Stack name<input autoFocus maxLength={100} placeholder="e.g. Builder" value={editor?.name ?? ""} onChange={event => setEditor(current => current && ({ ...current, name: event.target.value }))} /></label>
      <div className="loops-stack-picker">{paths.map(path => <label key={path.id}><input type="checkbox" checked={editor?.selected.includes(path.id) ?? false} onChange={event => { const checked = event.target.checked; setEditor(current => current && ({ ...current, selected: checked ? [...current.selected, path.id] : current.selected.filter(id => id !== path.id) })); }} /><span>{path.name}{path.stack && path.stack.id !== editor?.id && <small>In {path.stack.name}</small>}</span></label>)}</div>
      <DialogFooter>{stacks.some(s => s.id === editor?.id) && <Button variant="ghost" onClick={() => { if (onChange(paths.map(p => p.stack?.id === editor?.id ? { ...p, stack: undefined } : p))) setEditor(null); }}>Ungroup boards</Button>}<Button variant="outline" onClick={() => setEditor(null)}>Cancel</Button><Button disabled={!editor?.name.trim() || !editor.selected.length} onClick={saveStack}>Save stack</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
