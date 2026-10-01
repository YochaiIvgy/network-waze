"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, ArrowUpRight, Check, ChevronDown, ChevronUp, CircleDot, Diamond, Flag, Maximize2, Minus, Plus, Redo2, Rows3, Target, Trash2, Undo2, User, X } from "lucide-react";
import { StyledSelect } from "./ui/select";
import {
  LANE_H, MONTH_W, NODE_H, NODE_KINDS, NODE_STATUSES, NODE_W, PRIORITIES, STATUS_COLORS, THREAD_PALETTE,
  addMonths, boardBounds, carryNodes, currentMonth, monthLabel, monthX, newNode, planSchema, starterPlan, threadOf, threadRect, todayX, xMonth,
  type NodeKind, type NodeStatus, type Plan, type PlanLink, type PlanNode, type Rect, type Thread,
} from "@/lib/plans";
import type { ViewEntity } from "@/lib/view-model";

type Selection = { type: "node" | "link" | "thread"; id: string } | null;
type Camera = { x: number; y: number; k: number };
type Drag =
  | { mode: "pan"; pointer: number; sx: number; sy: number; cam: Camera; moved: boolean }
  | { mode: "node"; pointer: number; sx: number; sy: number; id: string; before: Plan; ox: number; oy: number; moved: boolean }
  | { mode: "connect"; pointer: number; from: string; moved: boolean }
  | { mode: "resize"; pointer: number; sx: number; id: string; edge: "start" | "end"; before: Plan; moved: boolean };

const KIND_ICONS = { step: CircleDot, milestone: Flag, decision: Diamond, goal: Target };
const MIN_K = 0.12;
const MAX_K = 2;
const SNAP = 20;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const kindOptions = Object.entries(NODE_KINDS).map(([value, label]) => ({ value, label }));
const statusOptions = Object.entries(NODE_STATUSES).map(([value, label]) => ({ value, label, color: STATUS_COLORS[value as NodeStatus] }));

/**
 * A flowchart on a timeline. Threads are lanes whose width is their duration on
 * a shared month axis; a box belongs to whichever lane it sits in, so dragging
 * it is how you schedule it. Boxes outside every lane are free-floating plans.
 */
export function PlansBoard({ entities, onOpenEntity }: { entities: ViewEntity[]; onOpenEntity: (id: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [camera, setCamera] = useState<Camera>({ x: 80, y: 120, k: 0.8 });
  const [preview, setPreview] = useState<{ from: string; x: number; y: number } | null>(null);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  const root = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const latest = useRef<Plan | null>(null);
  const cameraRef = useRef(camera);
  const revision = useRef(0);
  const pending = useRef(false);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const undo = useRef<Plan[]>([]);
  const redo = useRef<Plan[]>([]);
  const lastEdit = useRef({ key: "", at: 0 });
  const drag = useRef<Drag | null>(null);
  const fitted = useRef(false);
  const entitiesRef = useRef(entities);
  entitiesRef.current = entities;
  cameraRef.current = camera;

  async function load() {
    setError(""); setConflict(false);
    try {
      const response = await fetch("/api/plans"); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load your plan.");
      revision.current = data.revision;
      const loaded = data.plan === null ? starterPlan(entitiesRef.current) : planSchema.parse(data.plan);
      latest.current = loaded; setPlan(loaded); pending.current = false;
      undo.current = []; redo.current = []; syncHistory(); fitted.current = false;
      setStatus(data.plan === null ? "Starter plan · edit anything" : "All changes saved");
    } catch (e) { setError((e as Error).message); setStatus("Unable to load"); }
  }
  useEffect(() => {
    void load();
    const guard = (event: BeforeUnloadEvent) => { if (pending.current || saving.current) event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function flush() {
    if (saving.current || !latest.current) return;
    saving.current = true; setStatus("Saving…");
    try {
      while (pending.current) {
        pending.current = false;
        const response = await fetch("/api/plans", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: revision.current, plan: latest.current }) });
        const data = await response.json();
        if (!response.ok) { setConflict(response.status === 409); throw new Error(data.error || "Could not save the plan."); }
        revision.current = data.revision;
      }
      setStatus("All changes saved"); setError("");
    } catch (e) { pending.current = true; setStatus("Not saved"); setError((e as Error).message); }
    finally { saving.current = false; }
  }
  function syncHistory() { setHistory({ undo: undo.current.length, redo: redo.current.length }); }
  function apply(next: Plan) {
    latest.current = next; setPlan(next); pending.current = true; setStatus("Saving…");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 400);
  }
  /** Consecutive edits with the same key (typing in one field) collapse into one undo step. */
  function commit(next: Plan, { before = latest.current, key = "" }: { before?: Plan | null; key?: string } = {}) {
    const parsed = planSchema.safeParse(next);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "That change can't be saved."); return false; }
    const now = Date.now();
    const coalesce = !!key && lastEdit.current.key === key && now - lastEdit.current.at < 1500;
    lastEdit.current = { key, at: now };
    if (before && !coalesce) { undo.current = [...undo.current.slice(-79), before]; redo.current = []; }
    apply(next); syncHistory();
    return true;
  }
  function step(from: typeof undo, to: typeof redo) {
    const target = from.current.pop(); if (!target || !latest.current) return;
    to.current.push(latest.current); lastEdit.current = { key: "", at: 0 };
    apply(target); syncHistory();
    setSelection(s => s && exists(target, s) ? s : null);
  }

  const edit = (fn: (p: Plan) => Plan, key = "") => latest.current ? commit(fn(latest.current), { key }) : false;
  const updateNode = (id: string, patch: Partial<PlanNode>, key = "") => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === id ? { ...n, ...patch } : n) }), key);
  const updateLink = (id: string, patch: Partial<PlanLink>, key = "") => edit(p => ({ ...p, links: p.links.map(l => l.id === id ? { ...l, ...patch } : l) }), key);
  const updateThread = (id: string, patch: Partial<Thread>, key = "") => edit(p => carryNodes(p, { ...p, threads: p.threads.map(t => t.id === id ? { ...t, ...patch } : t) }), key);
  function moveThread(id: string, by: number) {
    edit(p => {
      const threads = [...p.threads]; const from = threads.findIndex(t => t.id === id); const to = from + by;
      if (from < 0 || to < 0 || to >= threads.length) return p;
      [threads[from], threads[to]] = [threads[to], threads[from]];
      return carryNodes(p, { ...p, threads });
    });
  }
  function remove(target: Selection) {
    if (!target) return;
    edit(p => target.type === "node" ? { ...p, nodes: p.nodes.filter(n => n.id !== target.id), links: p.links.filter(l => l.from !== target.id && l.to !== target.id) }
      : target.type === "link" ? { ...p, links: p.links.filter(l => l.id !== target.id) }
      : carryNodes(p, { ...p, threads: p.threads.filter(t => t.id !== target.id) }));
    setSelection(null);
  }
  function connect(from: string, to: string) {
    const p = latest.current; if (!p || from === to) return;
    const existing = p.links.find(l => l.from === from && l.to === to);
    if (existing) { setSelection({ type: "link", id: existing.id }); return; }
    const link = { id: crypto.randomUUID(), from, to, label: "" };
    if (commit({ ...p, links: [...p.links, link] })) setSelection({ type: "link", id: link.id });
  }
  function addNode(x: number, y: number, linkFrom?: string) {
    const p = latest.current; if (!p) return;
    const node = newNode(snap(x - NODE_W / 2), snap(y - NODE_H / 2));
    const links = linkFrom ? [...p.links, { id: crypto.randomUUID(), from: linkFrom, to: node.id, label: "" }] : p.links;
    if (commit({ ...p, nodes: [...p.nodes, node], links })) {
      setSelection({ type: "node", id: node.id });
      requestAnimationFrame(() => document.getElementById("plan-node-title")?.focus());
    }
  }
  function addThread() {
    const p = latest.current; if (!p) return;
    const thread: Thread = { id: crypto.randomUUID(), name: "New thread", goal: "", start: currentMonth(), months: 3, color: THREAD_PALETTE[p.threads.length % THREAD_PALETTE.length].color };
    const next = { ...p, threads: [...p.threads, thread] };
    if (commit(next)) { setSelection({ type: "thread", id: thread.id }); reveal(threadRect(next, next.threads.length - 1)); }
  }

  function toWorld(clientX: number, clientY: number) {
    const r = viewport.current!.getBoundingClientRect(); const c = cameraRef.current;
    return { x: (clientX - r.left - c.x) / c.k, y: (clientY - r.top - c.y) / c.k };
  }
  function zoom(factor: number, at?: { x: number; y: number }) {
    const el = viewport.current; if (!el) return;
    const px = at?.x ?? el.clientWidth / 2; const py = at?.y ?? el.clientHeight / 2;
    setCamera(c => { const k = clamp(c.k * factor, MIN_K, MAX_K); return { k, x: px - ((px - c.x) / c.k) * k, y: py - ((py - c.y) / c.k) * k }; });
  }
  function fit(rect: Rect) {
    const el = viewport.current; if (!el || !el.clientWidth || !el.clientHeight) return false;
    const pad = 70; const w = el.clientWidth - pad * 2 - (selection ? 320 : 0); const h = el.clientHeight - pad * 2;
    const k = clamp(Math.min(w / rect.w, h / rect.h), MIN_K, 1);
    setCamera({ k, x: pad + (w - rect.w * k) / 2 - rect.x * k, y: pad + (h - rect.h * k) / 2 - rect.y * k });
    return true;
  }
  function reveal(rect: Rect) {
    const el = viewport.current; if (!el) return; const c = cameraRef.current;
    const sx = rect.x * c.k + c.x; const sy = rect.y * c.k + c.y;
    if (sx >= 0 && sy >= 0 && sx < el.clientWidth - 200 && sy < el.clientHeight - 100) return;
    setCamera({ ...c, x: 80 - rect.x * c.k, y: 100 - rect.y * c.k });
  }
  const withAxis = (r: Rect): Rect => ({ x: r.x, y: Math.min(r.y, -60), w: r.w, h: r.h + Math.max(0, r.y + 60) });

  // Open on the near term rather than squeezing an 18-month lane into view.
  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const observer = new ResizeObserver(() => {
      if (fitted.current || !latest.current) return;
      const b = withAxis(boardBounds(latest.current));
      if (fit({ ...b, w: Math.min(b.w, MONTH_W * 7) })) fitted.current = true;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [plan === null]);

  useEffect(() => {
    const el = viewport.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest(".plans-overlay")) return;
      e.preventDefault(); const r = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Window-level listeners read the latest closures through this ref.
  const handlers = useRef({ move: (_: PointerEvent) => {}, up: (_: PointerEvent) => {}, key: (_: KeyboardEvent) => {} });
  handlers.current.move = (e: PointerEvent) => {
    const d = drag.current; if (!d || e.pointerId !== d.pointer) return;
    if (d.mode === "connect") { d.moved = true; setPreview({ from: d.from, ...toWorld(e.clientX, e.clientY) }); return; }
    if (d.mode === "resize") {
      const orig = d.before.threads.find(t => t.id === d.id); if (!orig) return;
      const dm = (e.clientX - d.sx) / cameraRef.current.k / MONTH_W;
      // Resizing never carries boxes: the lane edge moves, the plan stays where you put it.
      const patch = d.edge === "end"
        ? { months: clamp(Math.round((orig.months + dm) * 2) / 2, 0.5, 120) }
        : (() => { const shift = clamp(Math.round(dm), Math.ceil(orig.months - 120), Math.floor(orig.months - 0.5)); return { start: addMonths(orig.start, shift), months: orig.months - shift }; })();
      d.moved = true;
      const next = { ...d.before, threads: d.before.threads.map(t => t.id === d.id ? { ...t, ...patch } : t) };
      latest.current = next; setPlan(next);
      return;
    }
    const dx = e.clientX - d.sx; const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    if (d.mode === "pan") { setCamera({ ...d.cam, x: d.cam.x + dx, y: d.cam.y + dy }); return; }
    const k = cameraRef.current.k;
    const next = { ...d.before, nodes: d.before.nodes.map(n => n.id === d.id ? { ...n, x: snap(d.ox + dx / k), y: snap(d.oy + dy / k) } : n) };
    latest.current = next; setPlan(next);
  };
  handlers.current.up = (e: PointerEvent) => {
    const d = drag.current; if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (d.mode === "pan" && !d.moved) setSelection(null);
    if ((d.mode === "node" || d.mode === "resize") && d.moved && latest.current) commit(latest.current, { before: d.before });
    if (d.mode === "connect") {
      setPreview(null);
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      const target = hit?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      if (target) connect(d.from, target);
      else if (d.moved && hit && viewport.current?.contains(hit) && !hit.closest(".plans-overlay")) { const w = toWorld(e.clientX, e.clientY); addNode(w.x + NODE_W / 2, w.y, d.from); }
    }
  };
  handlers.current.key = (e: KeyboardEvent) => {
    if (!root.current?.offsetParent) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("input, textarea, select, [contenteditable], [role=dialog], [role=listbox]")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) step(redo, undo); else step(undo, redo); }
    else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); step(redo, undo); }
    else if ((e.key === "Delete" || e.key === "Backspace") && selection) { e.preventDefault(); remove(selection); }
    else if (e.key === "Escape") setSelection(null);
  };
  useEffect(() => {
    const move = (e: PointerEvent) => handlers.current.move(e);
    const up = (e: PointerEvent) => handlers.current.up(e);
    const key = (e: KeyboardEvent) => handlers.current.key(e);
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up); window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); window.removeEventListener("keydown", key); };
  }, []);

  /** Select menus portal outside the canvas, but React still bubbles their events through it. */
  const onCanvasChrome = (e: { target: EventTarget; currentTarget: HTMLElement }) =>
    !e.currentTarget.contains(e.target as Node) || !!(e.target as HTMLElement).closest(".plans-overlay, .plan-node, .plan-lane-head, .plan-lane-resize, .plan-link-hit");
  function startPan(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || onCanvasChrome(e)) return;
    drag.current = { mode: "pan", pointer: e.pointerId, sx: e.clientX, sy: e.clientY, cam: cameraRef.current, moved: false };
  }
  function startNode(e: ReactPointerEvent, node: PlanNode) {
    if (e.button !== 0 || !latest.current) return;
    e.stopPropagation(); setSelection({ type: "node", id: node.id });
    drag.current = { mode: "node", pointer: e.pointerId, sx: e.clientX, sy: e.clientY, id: node.id, before: latest.current, ox: node.x, oy: node.y, moved: false };
  }
  function startResize(e: ReactPointerEvent, thread: Thread, edge: "start" | "end") {
    if (e.button !== 0 || !latest.current) return;
    e.stopPropagation(); e.preventDefault(); setSelection({ type: "thread", id: thread.id });
    drag.current = { mode: "resize", pointer: e.pointerId, sx: e.clientX, id: thread.id, edge, before: latest.current, moved: false };
  }
  function startConnect(e: ReactPointerEvent, node: PlanNode) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    drag.current = { mode: "connect", pointer: e.pointerId, from: node.id, moved: false };
    setPreview({ from: node.id, ...toWorld(e.clientX, e.clientY) });
  }

  const nodes = new Map(plan?.nodes.map(n => [n.id, n]) ?? []);
  const selectedNode = selection?.type === "node" ? nodes.get(selection.id) : undefined;
  const selectedLink = selection?.type === "link" ? plan?.links.find(l => l.id === selection.id) : undefined;
  const selectedThread = selection?.type === "thread" ? plan?.threads.find(t => t.id === selection.id) : undefined;
  const linked = new Set(selectedNode ? plan!.links.filter(l => l.from === selectedNode.id || l.to === selectedNode.id).flatMap(l => [l.id, l.from, l.to]) : []);

  return <section ref={root} className="plans-workspace">
    <div ref={viewport} className="plans-canvas" onPointerDown={startPan} onDoubleClick={e => {
      if (onCanvasChrome(e)) return;
      const w = toWorld(e.clientX, e.clientY); addNode(w.x, w.y);
    }} style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${22 * camera.k}px ${22 * camera.k}px` }}>
      {plan && <div className="plans-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
        <Timeline plan={plan} />
        {plan.threads.map((thread, i) => {
          const r = threadRect(plan, i); const members = plan.nodes.filter(n => threadOf(plan, n)?.id === thread.id);
          const done = members.filter(n => n.status === "done").length;
          return <div key={thread.id} className={`plan-lane ${selection?.id === thread.id ? "selected" : ""}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h, "--thread-color": thread.color } as CSSProperties}>
            <button className="plan-lane-head" onPointerDown={e => { e.stopPropagation(); setSelection({ type: "thread", id: thread.id }); }}>
              <Rows3 size={14} /><strong>{thread.name}</strong>{thread.goal && <span className="plan-lane-goal">{thread.goal}</span>}
              <small>{formatMonths(thread.months)} · {monthLabel(thread.start)} → {monthLabel(addMonths(thread.start, Math.ceil(thread.months) - 1))}{members.length > 0 && ` · ${done}/${members.length} done`}</small>
            </button>
            {members.length > 0 && <div className="plan-lane-progress"><span style={{ width: `${(done / members.length) * 100}%` }} /></div>}
            {(["start", "end"] as const).map(edge => <span key={edge} className={`plan-lane-resize ${edge}`} title={edge === "end" ? "Drag to change the length" : "Drag to change the start month"} aria-hidden onPointerDown={e => startResize(e, thread, edge)} />)}
          </div>;
        })}
        <svg className="plans-links" width="1" height="1">
          <defs>
            <marker id="plan-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" className="plan-arrow" /></marker>
            <marker id="plan-arrow-active" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" className="plan-arrow active" /></marker>
          </defs>
          {plan.links.map(link => {
            const a = nodes.get(link.from); const b = nodes.get(link.to); if (!a || !b) return null;
            const geo = curve(box(a), box(b)); const active = selection?.id === link.id || linked.has(link.id);
            return <g key={link.id} className={`plan-link ${b.priority === "secondary" ? "secondary" : ""} ${active ? "active" : ""}`}>
              <path className="plan-link-hit" d={geo.d} onPointerDown={e => { e.stopPropagation(); setSelection({ type: "link", id: link.id }); }} />
              <path className="plan-link-line" d={geo.d} markerEnd={`url(#${active ? "plan-arrow-active" : "plan-arrow"})`} />
              {link.label && <text x={geo.mid.x} y={geo.mid.y - 6} textAnchor="middle">{link.label}</text>}
            </g>;
          })}
          {preview && nodes.get(preview.from) && <path className="plan-link-preview" d={curve(box(nodes.get(preview.from)!), { x: preview.x, y: preview.y, w: 0, h: 0 }).d} markerEnd="url(#plan-arrow-active)" />}
        </svg>
        {plan.nodes.map(node => {
          const Icon = KIND_ICONS[node.kind]; const thread = threadOf(plan, node);
          return <div key={node.id} data-node-id={node.id} role="button" tabIndex={0} aria-label={`${NODE_KINDS[node.kind]}: ${node.title}`}
            className={`plan-node kind-${node.kind} status-${node.status} ${node.priority} ${selection?.id === node.id ? "selected" : ""} ${linked.has(node.id) && selection?.id !== node.id ? "related" : ""} ${preview && preview.from !== node.id ? "connect-target" : ""}`}
            style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H, "--thread-color": thread?.color ?? "var(--edge)", "--status-color": STATUS_COLORS[node.status] } as CSSProperties}
            onPointerDown={e => startNode(e, node)} onKeyDown={e => { if (e.key === "Enter") setSelection({ type: "node", id: node.id }); }}>
            <div className="plan-node-meta"><Icon size={12} /><span>{NODE_KINDS[node.kind]}</span><i />{node.status === "done" ? <Check size={12} /> : <span>{NODE_STATUSES[node.status]}</span>}</div>
            <strong>{node.title}</strong>
            {node.entity && <small><User size={11} />{node.entity.name}</small>}
            <span className="plan-handle" title="Drag to connect" aria-hidden onPointerDown={e => startConnect(e, node)} />
          </div>;
        })}
      </div>}

      <div className="plans-overlay plans-toolbar">
        <strong>Plans</strong>
        <button disabled={!plan} onClick={() => { const el = viewport.current!; const r = el.getBoundingClientRect(); const w = toWorld(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2); addNode(w.x, w.y); }}><Plus size={14} />Box</button>
        <button disabled={!plan} onClick={addThread}><Rows3 size={14} />Thread</button>
        <span className="plans-divider" />
        <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.undo} onClick={() => step(undo, redo)}><Undo2 size={14} /></button>
        <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!history.redo} onClick={() => step(redo, undo)}><Redo2 size={14} /></button>
        <span role="status" className="plans-status">{status}</span>
      </div>
      {error && <div className="plans-overlay plans-error" role="alert">{error}<button onClick={() => void (conflict || !plan ? load() : flush())}>{conflict || !plan ? "Reload" : "Retry"}</button></div>}
      <div className="plans-overlay plans-zoom">
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}><Minus size={14} /></button>
        <span>{Math.round(camera.k * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={14} /></button>
        <button aria-label="Fit everything" title="Fit everything" disabled={!plan} onClick={() => plan && fit(withAxis(boardBounds(plan)))}><Maximize2 size={14} /></button>
      </div>
      <p className="plans-overlay plans-hint">Double-click to add a box · drag a box’s dot to connect · drop a box in a lane to schedule it</p>

      {plan && selection && <aside className="plans-overlay plans-inspector" key={selection.id}>
        <button className="plans-close" aria-label="Close" onClick={() => setSelection(null)}><X size={15} /></button>
        {selectedNode && <NodeInspector plan={plan} node={selectedNode} entities={entities} onChange={(patch, key) => updateNode(selectedNode.id, patch, key)} onSelect={setSelection} onRemoveLink={id => remove({ type: "link", id })} onDelete={() => remove(selection)} onOpenEntity={onOpenEntity} />}
        {selectedLink && <LinkInspector link={selectedLink} nodes={nodes} onChange={(patch, key) => updateLink(selectedLink.id, patch, key)} onSelect={setSelection} onDelete={() => remove(selection)} />}
        {selectedThread && <ThreadInspector plan={plan} thread={selectedThread} onChange={(patch, key) => updateThread(selectedThread.id, patch, key)} onMove={by => moveThread(selectedThread.id, by)} onDelete={() => remove(selection)} />}
      </aside>}
    </div>
  </section>;
}

function Timeline({ plan }: { plan: Plan }) {
  const b = boardBounds(plan);
  const first = xMonth(plan, Math.min(0, b.x)); const months = Math.max(12, Math.ceil((b.x + b.w - monthX(plan, first)) / MONTH_W) + 1);
  const height = Math.max(LANE_H, plan.threads.length ? threadRect(plan, plan.threads.length - 1).y + LANE_H : LANE_H);
  const today = todayX(plan);
  return <>
    {Array.from({ length: months }, (_, i) => {
      const m = addMonths(first, i);
      return <div key={m} className={`plan-month ${m.endsWith("-01") ? "year" : ""}`} style={{ left: monthX(plan, m), width: MONTH_W, height: height + 40 }}>
        <span>{monthLabel(m, m.endsWith("-01") || i === 0)}</span>
      </div>;
    })}
    <div className="plan-today" style={{ left: today, height: height + 52 }}><span>Today</span></div>
  </>;
}

function NodeInspector({ plan, node, entities, onChange, onSelect, onRemoveLink, onDelete, onOpenEntity }: {
  plan: Plan; node: PlanNode; entities: ViewEntity[]; onChange: (patch: Partial<PlanNode>, key?: string) => void;
  onSelect: (s: Selection) => void; onRemoveLink: (id: string) => void; onDelete: () => void; onOpenEntity: (id: string) => void;
}) {
  const thread = threadOf(plan, node);
  const people = [...entities].sort((a, b) => a.name.localeCompare(b.name));
  const options = [{ value: "", label: "No one" }, ...people.map(e => ({ value: e.id, label: `${e.name}${e.type === "organization" ? " · org" : ""}` }))];
  if (node.entity && !people.some(e => e.id === node.entity!.id)) options.push({ value: node.entity.id, label: node.entity.name });
  const title = (id: string) => plan.nodes.find(n => n.id === id)?.title ?? "";
  const outgoing = plan.links.filter(l => l.from === node.id); const incoming = plan.links.filter(l => l.to === node.id);
  return <>
    <small className="plans-eyebrow">{NODE_KINDS[node.kind].toUpperCase()}</small>
    <Field id="plan-node-title" label="Title" value={node.title} required maxLength={200} onSave={title => onChange({ title }, `title:${node.id}`)} />
    <div className="plans-row">
      <label>Type<StyledSelect label="Box type" compact value={node.kind} options={kindOptions} onChange={kind => onChange({ kind: kind as NodeKind })} /></label>
      <label>Status<StyledSelect label="Status" compact value={node.status} options={statusOptions} onChange={status => onChange({ status: status as NodeStatus })} /></label>
    </div>
    <label>Priority
      <div className="plans-segment" role="group" aria-label="Priority">{(Object.entries(PRIORITIES) as Array<[PlanNode["priority"], string]>).map(([value, label]) => <button key={value} aria-pressed={node.priority === value} onClick={() => onChange({ priority: value })}>{label}</button>)}</div>
    </label>
    <label>Person or organization
      <div className="plans-entity"><StyledSelect label="Linked person or organization" value={node.entity?.id ?? ""} options={options} onChange={id => { const e = entities.find(x => x.id === id); onChange({ entity: e ? { id: e.id, name: e.name } : null }); }} />
        {node.entity && entities.some(e => e.id === node.entity!.id) && <button aria-label={`Open ${node.entity.name} in the network`} title="Open in network" onClick={() => onOpenEntity(node.entity!.id)}><ArrowUpRight size={14} /></button>}</div>
    </label>
    <Field label="Notes" value={node.notes} multiline maxLength={4000} placeholder="Why, how, who to ask…" onSave={notes => onChange({ notes }, `notes:${node.id}`)} />
    <p className="plans-note">{thread
      ? <><span className="plans-dot" style={{ background: thread.color }} />In <strong>{thread.name}</strong> · around {monthLabel(xMonth(plan, node.x + NODE_W / 2))}</>
      : "Free-floating. Drag it into a thread lane to put it on the timeline."}</p>
    {(outgoing.length > 0 || incoming.length > 0) && <div className="plans-connections">
      <small className="plans-eyebrow">CONNECTIONS</small>
      {[...incoming.map(l => ({ l, dir: "from", other: l.from })), ...outgoing.map(l => ({ l, dir: "to", other: l.to }))].map(({ l, dir, other }) =>
        <div key={l.id}><button onClick={() => onSelect({ type: "node", id: other })}>{dir === "from" ? "← " : "→ "}{title(other)}{l.label && <em> · {l.label}</em>}</button><button aria-label="Remove connection" onClick={() => onRemoveLink(l.id)}><X size={12} /></button></div>)}
    </div>}
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete box</button>
  </>;
}

function LinkInspector({ link, nodes, onChange, onSelect, onDelete }: { link: PlanLink; nodes: Map<string, PlanNode>; onChange: (patch: Partial<PlanLink>, key?: string) => void; onSelect: (s: Selection) => void; onDelete: () => void }) {
  const from = nodes.get(link.from); const to = nodes.get(link.to);
  return <>
    <small className="plans-eyebrow">CONNECTION</small>
    <div className="plans-link-ends"><button onClick={() => onSelect({ type: "node", id: link.from })}>{from?.title}</button><ArrowRight size={14} /><button onClick={() => onSelect({ type: "node", id: link.to })}>{to?.title}</button></div>
    <Field label="Label" value={link.label} maxLength={100} placeholder="e.g. priority, intro, base for…" onSave={label => onChange({ label }, `label:${link.id}`)} />
    <p className="plans-note">Arrows into a secondary box are drawn dashed.</p>
    <div className="plans-row"><button className="plans-secondary-btn" onClick={() => onChange({ from: link.to, to: link.from })}>Reverse direction</button></div>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete connection</button>
  </>;
}

function ThreadInspector({ plan, thread, onChange, onMove, onDelete }: { plan: Plan; thread: Thread; onChange: (patch: Partial<Thread>, key?: string) => void; onMove: (by: number) => void; onDelete: () => void }) {
  const index = plan.threads.findIndex(t => t.id === thread.id);
  const members = plan.nodes.filter(n => threadOf(plan, n)?.id === thread.id);
  return <>
    <small className="plans-eyebrow">THREAD</small>
    <Field label="Name" value={thread.name} required maxLength={100} onSave={name => onChange({ name }, `name:${thread.id}`)} />
    <Field label="Goal" value={thread.goal} maxLength={100} placeholder="e.g. $300M raised" onSave={goal => onChange({ goal }, `goal:${thread.id}`)} />
    <div className="plans-row">
      <label>Starts<input type="month" value={thread.start} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange({ start: e.target.value }, `start:${thread.id}`); }} /></label>
      <label>Months<input type="number" min={0.5} max={120} step={0.5} value={thread.months} onChange={e => { const v = Number(e.target.value); if (v >= 0.5 && v <= 120) onChange({ months: v }, `months:${thread.id}`); }} /></label>
    </div>
    <p className="plans-note">{formatMonths(thread.months)} · ends {monthLabel(addMonths(thread.start, Math.ceil(thread.months) - 1))} · {members.filter(n => n.status === "done").length}/{members.length} boxes done</p>
    <label>Color<div className="plans-swatches">{THREAD_PALETTE.map(({ color, name }) => <button key={color} aria-label={name} title={name} aria-pressed={thread.color === color} style={{ background: color }} onClick={() => onChange({ color })}>{thread.color === color && <Check size={12} />}</button>)}</div></label>
    <div className="plans-row">
      <button className="plans-secondary-btn" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp size={14} />Move up</button>
      <button className="plans-secondary-btn" disabled={index === plan.threads.length - 1} onClick={() => onMove(1)}><ChevronDown size={14} />Move down</button>
    </div>
    <p className="plans-note">Boxes move with their lane. Deleting the thread keeps its boxes on the board.</p>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete thread</button>
  </>;
}

function Field({ id, label, value, onSave, placeholder, maxLength, required = false, multiline = false }: { id?: string; label: string; value: string; onSave: (value: string) => void; placeholder?: string; maxLength: number; required?: boolean; multiline?: boolean }) {
  const [draft, setDraft] = useState(value); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(value); }, [value]);
  const props = {
    id, value: draft, placeholder, maxLength, "aria-label": label,
    onFocus: () => { focused.current = true; },
    onChange: (e: { target: { value: string } }) => { setDraft(e.target.value); if (!required || e.target.value.trim()) onSave(required ? e.target.value.trim() : e.target.value); },
    onBlur: () => { focused.current = false; if (required && !draft.trim()) setDraft(value); },
  };
  return <label>{label}{multiline ? <textarea rows={4} {...props} /> : <input {...props} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />}</label>;
}

type Box = { x: number; y: number; w: number; h: number };
const box = (n: PlanNode): Box => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H });

/** A bezier leaving the side of `a` that faces `b`, so arrows read left-to-right or top-to-bottom. */
function curve(a: Box, b: Box) {
  const ax = a.x + a.w / 2; const ay = a.y + a.h / 2; const bx = b.x + b.w / 2; const by = b.y + b.h / 2;
  const dx = bx - ax; const dy = by - ay;
  const horizontal = Math.abs(dx) * (a.h + b.h + 1) >= Math.abs(dy) * (a.w + b.w + 1);
  const dir = Math.sign(horizontal ? dx : dy) || 1;
  const s = horizontal ? { x: ax + dir * a.w / 2, y: ay } : { x: ax, y: ay + dir * a.h / 2 };
  const t = horizontal ? { x: bx - dir * b.w / 2, y: by } : { x: bx, y: by - dir * b.h / 2 };
  const off = Math.max(30, Math.abs(horizontal ? t.x - s.x : t.y - s.y) / 2);
  const c1 = horizontal ? { x: s.x + dir * off, y: s.y } : { x: s.x, y: s.y + dir * off };
  const c2 = horizontal ? { x: t.x - dir * off, y: t.y } : { x: t.x, y: t.y - dir * off };
  return { d: `M${s.x},${s.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${t.x},${t.y}`, mid: { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 } };
}

const exists = (p: Plan, s: NonNullable<Selection>) => (s.type === "node" ? p.nodes : s.type === "link" ? p.links : p.threads).some(x => x.id === s.id);
const formatMonths = (m: number) => m >= 12 && m % 12 === 0 ? `${m / 12} ${m === 12 ? "year" : "years"}` : `${m} ${m === 1 ? "month" : "months"}`;
