"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { ChevronDown, Layers, Plus, Ellipsis, GripVertical, LayoutGrid, Rows3, Check, X } from "lucide-react";
import { type LoopPath, pathDisplayColor, PATH_COLORS } from "@/lib/loops";
import { LoopDependencyToolbar } from "./LoopDependencies";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type Layout = { arrangement: "grid" | "vertical"; height: number; expanded: Record<string, boolean>; emptyStacks?: { id: string; name: string }[] };

function BoardSlot({ path, children }: { path: LoopPath; children: ReactNode }) {
  return <div data-layout-unit={path.id} className="loops-board-slot">{children}</div>;
}

export function LoopsLayout({ paths, storageKey, onChange, previewMatches, children, dragPathId, onDragFinish, toolbar }: {
  toolbar: ReactNode;
  dragPathId: string | null; onDragFinish: () => void;
  paths: LoopPath[]; storageKey: string; onChange: (paths: LoopPath[]) => boolean;
  previewMatches: (item: LoopPath["items"][number]) => boolean;
  children: (path: LoopPath, index: number, organize: () => void) => ReactNode;
}) {
  const [layout, setLayout] = useState<Layout>({ arrangement: "grid", height: 360, expanded: {} });
  const [dragStack, setDragStack] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [editor, setEditor] = useState<{ id: string; name: string; selected: string[] } | null>(null);
  const [destination, setDestination] = useState<LoopPath | null>(null);
  const [dropTarget, setDropTarget] = useState("");
  const [newPath, setNewPath] = useState<{ stack?: { id: string; name: string }; name: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { if (!dragPathId) setDropTarget(""); }, [dragPathId]);
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
        setLayout({ arrangement: saved.arrangement === "vertical" ? "vertical" : "grid", emptyStacks: Array.isArray(saved.emptyStacks) ? saved.emptyStacks.filter((s: { id?: unknown; name?: unknown }) => typeof s?.id === "string" && typeof s?.name === "string") : [], height: Math.max(260, Math.min(640, saved.height)), expanded: Object.fromEntries(Object.entries(saved.expanded).filter(([, value]) => typeof value === "boolean")) as Record<string, boolean> });
      }
    } catch { /* Use the default layout if browser storage is unavailable. */ }
    setReady(true);
  }, [storageKey]);
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify(layout)); } catch { /* Layout is still usable for this session. */ }
  }, [layout, ready, storageKey]);

  const stacks = [...new Map([...(layout.emptyStacks ?? []).map(s => [s.id, s] as const), ...paths.filter(p => p.stack).map(p => [p.stack!.id, p.stack!] as const)]).values()];
  const units = paths.filter((path, index) => !path.stack || paths.findIndex(p => p.stack?.id === path.stack!.id) === index);
  function toggle(id: string) {
    previousRects.current = new Map(Array.from(board.current?.children ?? []).map(element => [(element as HTMLElement).dataset.layoutUnit ?? "", element.getBoundingClientRect()]));
    opening.current = layout.expanded[id] ? null : id;
    setLayout(current => ({ ...current, expanded: { ...current.expanded, [id]: !current.expanded[id] } }));
  }
  function saveStack() {
    if (!editor || !editor.name.trim() || !editor.selected.length) return;
    const stack = { id: editor.id, name: editor.name.trim() };
    if (onChange(paths.map(p => editor.selected.includes(p.id) ? { ...p, stack } : p.stack?.id === editor.id ? { ...p, stack: undefined } : p))) { setLayout(current => ({ ...current, emptyStacks: [...(current.emptyStacks ?? []).filter(s => s.id !== stack.id), stack] })); setEditor(null); }
  }
  function moveStack(id: string, direction: number) {
    const index = units.findIndex(p => p.stack?.id === id);
    if (index < 0) return;
    const target = units[index + direction];
    if (!target) return;
    const ordered = [...units]; const [unit] = ordered.splice(index, 1); ordered.splice(index + direction, 0, unit);
    onChange(ordered.flatMap(p => p.stack ? paths.filter(child => child.stack?.id === p.stack!.id) : [p]));
  }

  function createStack(path?: LoopPath) {
    const stack = { id: crypto.randomUUID(), name: "Untitled stack" };
    if (path && !onChange(paths.map(p => p.id === path.id ? { ...p, stack } : p))) return;
    setLayout(current => ({ ...current, emptyStacks: [...(current.emptyStacks ?? []), stack], expanded: { ...current.expanded, [stack.id]: true } }));
    setRenaming(stack.id);
  }
  function renameStack(stack: { id: string; name: string }, name: string) {
    name = name.trim() || stack.name;
    if (!onChange(paths.map(p => p.stack?.id === stack.id ? { ...p, stack: { ...stack, name } } : p))) return;
    setLayout(current => ({ ...current, emptyStacks: (current.emptyStacks ?? []).map(s => s.id === stack.id ? { ...s, name } : s) }));
    setRenaming(null);
  }
  function receive(event: DragEvent, stack?: { id: string; name: string }, before?: string, after = false) {
    if (dragStack) {
      event.preventDefault(); event.stopPropagation();
      const targetIndex = units.findIndex(p => p.id === before || p.stack?.id === stack?.id);
      const from = units.findIndex(p => p.stack?.id === dragStack);
      if (from >= 0 && targetIndex >= 0 && from !== targetIndex) {
        const ordered = units.filter(p => p.stack?.id !== dragStack);
        const target = units[targetIndex];
        const index = ordered.indexOf(target);
        ordered.splice(index + (after ? 1 : 0), 0, units[from]);
        onChange(ordered.flatMap(p => p.stack ? paths.filter(child => child.stack?.id === p.stack!.id) : [p]));
      }
      setDragStack(null); setDropTarget(""); return;
    }
    if (!dragPathId) return;
    event.preventDefault(); event.stopPropagation();
    const moving = paths.find(p => p.id === dragPathId);
    if (moving) {
      const rest = paths.filter(p => p.id !== moving.id);
      const index = before ? rest.findIndex(p => p.id === before) : -1;
      rest.splice(index < 0 ? rest.length : index + (after ? 1 : 0), 0, { ...moving, stack });
      if (onChange(rest)) setLayout(current => ({ ...current, emptyStacks: [...new Map([...(current.emptyStacks ?? []), ...(moving.stack ? [moving.stack] : [])].map(s => [s.id, s])).values()], expanded: stack ? { ...current.expanded, [stack.id]: true } : current.expanded }));
    }
    setDropTarget(""); onDragFinish();
  }
  function dropZone(id: string, stack?: { id: string; name: string }, before?: string) {
    const side = (e: DragEvent) => {
      if (!before) return "left";
      const rect = e.currentTarget.getBoundingClientRect();
      const after = layout.arrangement === "vertical" ? e.clientY > rect.top + rect.height / 2 : e.clientX > rect.left + rect.width / 2;
      return after ? "right" : "left";
    };
    return { onDragOver: (e: DragEvent) => { if ((dragPathId || dragStack) && dragPathId !== before) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = "move"; setDropTarget(before ? `${id}:${side(e)}` : id); } }, onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(""); }, onDrop: (e: DragEvent) => { if (dragPathId === before) { e.stopPropagation(); return; } receive(e, stack, before, side(e) === "right"); } };

  }
  function pathComposer(stack?: { id: string; name: string }) {
    return newPath && newPath.stack?.id === stack?.id ? <form className="loops-add-path-card" onSubmit={e => {
      e.preventDefault(); if (!newPath.name.trim()) return;
      if (onChange([...paths, { id: crypto.randomUUID(), name: newPath.name.trim(), color: PATH_COLORS[paths.length % PATH_COLORS.length], items: [], stack }])) setNewPath(null);
    }}><input autoFocus aria-label="New board name" placeholder="Board name" maxLength={100} value={newPath.name} onChange={e => setNewPath({ stack, name: e.target.value })} onKeyDown={e => { if (e.key === "Escape") setNewPath(null); }} /><div><Button type="submit" disabled={!newPath.name.trim()}>Add board</Button><Button type="button" variant="ghost" aria-label="Cancel new path" onClick={() => setNewPath(null)}><X size={14} /></Button></div></form>
      : <button className="loops-add-path-card" onClick={() => setNewPath({ stack, name: "" })}><Plus size={16} /> Add board</button>;
  }
  return <>
    <header className="loops-command-bar">{toolbar}<div className="loops-command-actions"><LoopDependencyToolbar />
      <details className="loops-control-menu"><summary>View <ChevronDown size={13} /></summary><div><span>Layout</span>{(["grid", "vertical"] as const).map(arrangement => <button className="loops-view-option" key={arrangement} aria-pressed={layout.arrangement === arrangement} onClick={e => { setLayout(current => ({ ...current, arrangement })); e.currentTarget.closest("details")?.removeAttribute("open"); }}>{arrangement === "grid" ? <LayoutGrid size={14} /> : <Rows3 size={14} />}<span>{arrangement === "grid" ? "Grid" : "Vertical"}</span>{layout.arrangement === arrangement && <Check size={13} />}</button>)}<span>Spacing</span>{[[280, "Compact"], [360, "Comfortable"]].map(([height, label]) => <button key={height} aria-pressed={layout.height === height} onClick={e => { setLayout(current => ({ ...current, height: Number(height) })); e.currentTarget.closest("details")?.removeAttribute("open"); }}>{label}</button>)}</div></details>
      <details className="loops-control-menu"><summary><Plus size={14} /> Add</summary><div><button onClick={e => { setNewPath({ name: "" }); e.currentTarget.closest("details")?.removeAttribute("open"); requestAnimationFrame(() => board.current?.querySelector<HTMLInputElement>(".loops-add-path-card input")?.scrollIntoView({ block: "center", behavior: "smooth" })); }}>Board</button><button onClick={e => { createStack(); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Stack</button></div></details>
    </div></header>
    <div ref={board} className={`loops-board loops-spatial-board ${layout.arrangement === "vertical" ? "is-vertical" : ""} ${layout.height < 340 ? "is-compact" : ""}`} style={{ "--board-height": `${layout.height}px` } as CSSProperties}>
      {[...units, ...stacks.filter(stack => !paths.some(p => p.stack?.id === stack.id)).map(stack => ({ id: stack.id, stack } as LoopPath))].map((unit, unitIndex) => {
        if (!unit.stack) return <div key={unit.id} data-layout-unit={unit.id} className={`loops-path-drop ${dropTarget.startsWith(`${unit.id}:`) ? `insert-${dropTarget.split(":")[1]}` : ""}`} {...dropZone(unit.id, undefined, unit.id)}><BoardSlot path={unit}>{children(unit, paths.indexOf(unit), () => setDestination(unit))}</BoardSlot></div>;
        const stack = unit.stack; const members = paths.filter(p => p.stack?.id === stack.id); const expanded = !!layout.expanded[stack.id];
        return <section key={stack.id} data-layout-unit={stack.id} ref={element => { if (element) anchors.current.set(stack.id, element); else anchors.current.delete(stack.id); }} {...dropZone(stack.id, stack)} className={`loops-stack ${dropTarget === stack.id ? "is-drop-target" : ""} ${expanded ? "is-expanded" : "is-collapsed"}`} style={{ "--stack-width": `${Math.max(300, members.length * 300 + Math.max(0, members.length - 1) * 16 + 26)}px` } as CSSProperties}>
          <header className="loops-stack-header" onClick={e => { if (e.target instanceof Element && !e.target.closest("button, input, details")) toggle(stack.id); }}>
            {renaming === stack.id && <input className="loops-stack-inline-name" autoFocus aria-label="Stack name" defaultValue={stack.name} maxLength={100} onFocus={e => e.target.select()} onBlur={e => renameStack(stack, e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }} />}
            <button className="loop-grip loops-stack-handle" draggable title="Drag stack" aria-label={`Drag ${stack.name} stack`} onDragStart={e => { setDragStack(stack.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", stack.id); const el = e.currentTarget.closest<HTMLElement>(".loops-stack"); if (el) e.dataTransfer.setDragImage(el, 24, 24); }} onDragEnd={() => { setDragStack(null); setDropTarget(""); }}><Layers className="stack-handle-icon" size={15} /><GripVertical className="stack-handle-grip" size={15} /></button>
            <button className="loops-stack-banner" aria-label={`${expanded ? "Collapse" : "Expand"} ${stack.name}`} aria-expanded={expanded} aria-controls={`stack-${stack.id}`} onClick={() => toggle(stack.id)}>
              {renaming !== stack.id && <span className="loops-stack-name">{stack.name}</span>}
              <span className="loops-stack-count">{members.length} {members.length === 1 ? "board" : "boards"}</span>
              <ChevronDown size={15} />
            </button>
            <details className="loops-control-menu"><summary aria-label={`Options for ${stack.name}`}><Ellipsis size={16} /></summary><div><button onClick={e => { setRenaming(stack.id); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Rename stack</button><button onClick={e => { setEditor({ ...stack, selected: members.map(p => p.id) }); e.currentTarget.closest("details")?.removeAttribute("open"); }}>Manage boards</button><button disabled={!members.length || unitIndex === 0} onClick={() => moveStack(stack.id, -1)}>Move earlier</button><button disabled={!members.length || unitIndex === units.length - 1} onClick={() => moveStack(stack.id, 1)}>Move later</button></div></details>

          </header>
          <div id={`stack-${stack.id}`} className="loops-stack-children" hidden={!expanded}>
            {members.map(path => <div key={path.id} className={`loops-path-drop ${dropTarget.startsWith(`${path.id}:`) ? `insert-${dropTarget.split(":")[1]}` : ""}`} {...dropZone(path.id, stack, path.id)}><BoardSlot path={path}>{children(path, paths.indexOf(path), () => setDestination(path))}</BoardSlot></div>)}
            {!members.length && <div className="loops-empty-stack">Drag a board here to add it to this stack.</div>}
          </div>
          {!expanded && <button className="loops-stack-preview loops-stack-summary" aria-label={`Expand ${stack.name}`} aria-expanded={false} aria-controls={`stack-${stack.id}`} onClick={() => toggle(stack.id)}>
            {members.slice(0, 4).map(path => <span className="loops-stack-summary-row" key={path.id}>
              <i style={{ background: pathDisplayColor(path.color) }} />
              <span>{path.name}</span>
              <small title="Loops matching the current filter">{path.items.filter(previewMatches).length}</small>
            </span>)}
            {members.length > 4 && <span className="loops-stack-summary-more">+{members.length - 4} more boards</span>}
            {!members.length && <span className="loops-stack-summary-more">No boards yet</span>}
          </button>}


        </section>;
      })}
      <div className={`loops-board-create ${dropTarget === "outside" ? "is-drop-target" : ""}`} {...dropZone("outside")} >{dragPathId ? <span className="loops-detach-hint">Drop here to move out of a stack</span> : pathComposer()}</div>
    </div>
    <Dialog open={!!destination} onOpenChange={open => { if (!open) setDestination(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Organize “{destination?.name}”</DialogTitle><DialogDescription>Keep related boards together in an expandable stack.</DialogDescription></DialogHeader>
      <div className="loops-stack-destinations">{stacks.map(stack => <Button key={stack.id} variant="outline" disabled={stack.id === destination?.stack?.id} onClick={() => { if (onChange(paths.map(p => p.id === destination?.id ? { ...p, stack } : p))) setDestination(null); }}><Layers size={14} />{stack.name}{stack.id === destination?.stack?.id ? " · current" : ""}</Button>)}
      <Button variant="outline" onClick={() => { createStack(destination ?? undefined); setDestination(null); }}><Plus size={14} />Create a new stack</Button>
      {destination?.stack && <Button variant="ghost" onClick={() => { if (onChange(paths.map(p => p.id === destination.id ? { ...p, stack: undefined } : p))) setDestination(null); }}>Remove from stack</Button>}</div>
    </DialogContent></Dialog>
    <Dialog open={!!editor} onOpenChange={open => { if (!open) setEditor(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{stacks.some(s => s.id === editor?.id) ? "Manage stack" : "New stack"}</DialogTitle><DialogDescription>Choose the boards to keep together. Boards from other stacks will move here.</DialogDescription></DialogHeader>
      <label className="loops-stack-name-field">Stack name<input autoFocus maxLength={100} placeholder="e.g. Builder" value={editor?.name ?? ""} onChange={event => setEditor(current => current && ({ ...current, name: event.target.value }))} /></label>
      <div className="loops-stack-picker">{paths.map(path => <label key={path.id}><input type="checkbox" checked={editor?.selected.includes(path.id) ?? false} onChange={event => { const checked = event.target.checked; setEditor(current => current && ({ ...current, selected: checked ? [...current.selected, path.id] : current.selected.filter(id => id !== path.id) })); }} /><span>{path.name}{path.stack && path.stack.id !== editor?.id && <small>In {path.stack.name}</small>}</span></label>)}</div>
      <DialogFooter>{stacks.some(s => s.id === editor?.id) && <Button variant="ghost" onClick={() => { if (onChange(paths.map(p => p.stack?.id === editor?.id ? { ...p, stack: undefined } : p))) { setLayout(current => ({ ...current, emptyStacks: current.emptyStacks?.filter(s => s.id !== editor?.id) })); setEditor(null); } }}>Ungroup boards</Button>}<Button variant="outline" onClick={() => setEditor(null)}>Cancel</Button><Button disabled={!editor?.name.trim() || !editor.selected.length} onClick={saveStack}>Save stack</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
