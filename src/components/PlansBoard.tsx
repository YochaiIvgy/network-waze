"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, ArrowUpRight, Building2, Check, ChevronDown, ChevronUp, CircleDot, Diamond, Flag, Maximize2, Minus, Pencil, Plus, Redo2, Rows3, Target, Trash2, Undo2, User, X } from "lucide-react";
import { StyledSelect } from "./ui/select";
import {
  LANE_H, MONTH_W, NODE_H, NODE_KINDS, NODE_STATUSES, NODE_W, PRIORITIES, STATUS_COLORS, TAG_GROUPS, THREAD_PALETTE, UNIT_HEAD,
  addMonths, boardBounds, carryNodes, currentMonth, layout, matchesFilter, monthLabel, monthX, newNode, planSchema, starterPlan,
  threadOf, threadRect, todayX, unitOf, unitRect, upgradePlan, xMonth,
  type NodeKind, type NodeStatus, type Plan, type PlanLink, type PlanNode, type Rect, type Tag, type TagGroup, type Thread, type Unit,
} from "@/lib/plans";
import type { ViewEntity } from "@/lib/view-model";

type Selection = { type: "node" | "link" | "thread" | "unit"; id: string } | { type: "nodes"; ids: string[] } | null;
type Camera = { x: number; y: number; k: number };
type Drag =
  | { mode: "pan"; pointer: number; sx: number; sy: number; cam: Camera; moved: boolean }
  | { mode: "marquee"; pointer: number; sx: number; sy: number; base: string[]; moved: boolean }
  | { mode: "node"; pointer: number; sx: number; sy: number; id: string; before: Plan; origins: Map<string, { x: number; y: number }>; moved: boolean }
  | { mode: "connect"; pointer: number; from: string; moved: boolean }
  | { mode: "resize"; pointer: number; sx: number; id: string; edge: "start" | "end"; before: Plan; moved: boolean }
  | { mode: "unit-height"; pointer: number; sy: number; id: string; before: Plan; moved: boolean };

const KIND_ICONS = { step: CircleDot, milestone: Flag, decision: Diamond, goal: Target };
const MIN_K = 0.12;
const MAX_K = 2;
const SNAP = 20;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const kindOptions = Object.entries(NODE_KINDS).map(([value, label]) => ({ value, label }));
const statusOptions = Object.entries(NODE_STATUSES).map(([value, label]) => ({ value, label, color: STATUS_COLORS[value as NodeStatus] }));
const CHROME = ".plans-overlay, .plan-node, .plan-lane-head, .plan-unit-head, .plan-lane-resize, .plan-unit-resize, .plan-link-hit";

/**
 * A flowchart on a timeline. Business units are permanent rows; inside each, an
 * open area holds ongoing work and time-boxed threads sit on the shared month
 * axis. A box belongs to whichever lane it sits in, so dragging it is how you
 * assign and schedule it. Sector and location tags cut across every unit.
 */
export function PlansBoard({ entities, onOpenEntity }: { entities: ViewEntity[]; onOpenEntity: (id: string) => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [camera, setCamera] = useState<Camera>({ x: 80, y: 120, k: 0.8 });
  const [preview, setPreview] = useState<{ from: string; x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [filter, setFilter] = useState<Set<string>>(new Set());
  const [editingTags, setEditingTags] = useState(false);
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
      const upgraded = !!data.plan && !data.plan.units;
      const loaded = data.plan === null ? starterPlan(entitiesRef.current) : planSchema.parse(upgradePlan(data.plan));
      latest.current = loaded; setPlan(loaded); pending.current = false;
      undo.current = []; redo.current = []; syncHistory(); fitted.current = false;
      setStatus(data.plan === null ? "Starter plan · edit anything" : "All changes saved");
      if (upgraded) apply(loaded);
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
  /** Structural edits shift the lanes below, so their boxes are carried along. */
  const editLanes = (fn: (p: Plan) => Plan, key = "") => edit(p => carryNodes(p, fn(p)), key);
  const updateNode = (id: string, patch: Partial<PlanNode>, key = "") => edit(p => ({ ...p, nodes: p.nodes.map(n => n.id === id ? { ...n, ...patch } : n) }), key);
  const updateLink = (id: string, patch: Partial<PlanLink>, key = "") => edit(p => ({ ...p, links: p.links.map(l => l.id === id ? { ...l, ...patch } : l) }), key);
  const updateUnit = (id: string, patch: Partial<Unit>, key = "") => editLanes(p => ({ ...p, units: p.units.map(u => u.id === id ? { ...u, ...patch } : u) }), key);
  function updateThread(id: string, patch: Partial<Thread>, key = "") {
    editLanes(p => {
      const thread = p.threads.find(t => t.id === id)!; const next = { ...thread, ...patch };
      // A thread moved to another unit goes to the bottom of that unit.
      return { ...p, threads: next.unitId !== thread.unitId ? [...p.threads.filter(t => t.id !== id), next] : p.threads.map(t => t.id === id ? next : t) };
    }, key);
  }
  function moveThread(id: string, by: number) {
    editLanes(p => {
      const thread = p.threads.find(t => t.id === id)!; const siblings = p.threads.filter(t => t.unitId === thread.unitId);
      const swap = siblings[siblings.indexOf(thread) + by]; if (!swap) return p;
      const threads = [...p.threads]; const a = threads.indexOf(thread); const b = threads.indexOf(swap);
      [threads[a], threads[b]] = [threads[b], threads[a]];
      return { ...p, threads };
    });
  }
  function moveUnit(id: string, by: number) {
    editLanes(p => {
      const units = [...p.units]; const from = units.findIndex(u => u.id === id); const to = from + by;
      if (from < 0 || to < 0 || to >= units.length) return p;
      [units[from], units[to]] = [units[to], units[from]];
      return { ...p, units };
    });
  }
  function selectNodes(ids: string[]) {
    const unique = [...new Set(ids)];
    setSelection(!unique.length ? null : unique.length === 1 ? { type: "node", id: unique[0] } : { type: "nodes", ids: unique });
  }
  function updateNodes(ids: string[], fn: (n: PlanNode) => PlanNode, key = "") {
    const set = new Set(ids);
    return edit(p => ({ ...p, nodes: p.nodes.map(n => set.has(n.id) ? fn(n) : n) }), key);
  }
  function remove(target: Selection) {
    if (!target) return;
    if (target.type === "nodes") { const set = new Set(target.ids); edit(p => ({ ...p, nodes: p.nodes.filter(n => !set.has(n.id)), links: p.links.filter(l => !set.has(l.from) && !set.has(l.to)) })); }
    else if (target.type === "node") edit(p => ({ ...p, nodes: p.nodes.filter(n => n.id !== target.id), links: p.links.filter(l => l.from !== target.id && l.to !== target.id) }));
    else if (target.type === "link") edit(p => ({ ...p, links: p.links.filter(l => l.id !== target.id) }));
    else if (target.type === "thread") editLanes(p => ({ ...p, threads: p.threads.filter(t => t.id !== target.id) }));
    else editLanes(p => ({ ...p, units: p.units.filter(u => u.id !== target.id), threads: p.threads.filter(t => t.unitId !== target.id) }));
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
  /** New threads go into the unit you're working in. */
  function addThread(unitId?: string) {
    const p = latest.current; if (!p || !p.units.length) return;
    const node = p.nodes.find(n => n.id === nodeIds(selection)[0]);
    const target = unitId ?? (selection?.type === "unit" ? selection.id : selection?.type === "thread" ? p.threads.find(t => t.id === selection.id)?.unitId : node && unitOf(p, node)?.id) ?? p.units[0].id;
    const thread: Thread = { id: crypto.randomUUID(), unitId: target, name: "New thread", goal: "", start: currentMonth(), months: 3, color: THREAD_PALETTE[p.threads.length % THREAD_PALETTE.length].color };
    if (editLanes(q => ({ ...q, threads: [...q.threads, thread] }))) { setSelection({ type: "thread", id: thread.id }); reveal(threadRect(latest.current!, thread.id)); }
  }
  function addUnit() {
    const p = latest.current; if (!p) return;
    const unit: Unit = { id: crypto.randomUUID(), name: "New unit", description: "", color: THREAD_PALETTE[(p.units.length * 3) % THREAD_PALETTE.length].color, height: 240 };
    if (commit({ ...p, units: [...p.units, unit] })) { setSelection({ type: "unit", id: unit.id }); reveal(unitRect(latest.current!, unit.id)); }
  }
  function toggleTag(nodeId: string, tagId: string) {
    edit(p => ({ ...p, nodes: p.nodes.map(n => n.id !== nodeId ? n : { ...n, tags: n.tags.includes(tagId) ? n.tags.filter(t => t !== tagId) : [...n.tags, tagId] }) }));
  }
  function addTag(nodeId: string, group: TagGroup, name: string) {
    const p = latest.current; if (!p) return;
    const existing = p.tags.find(t => t.group === group && t.name.toLowerCase() === name.trim().toLowerCase());
    if (existing) { if (!p.nodes.find(n => n.id === nodeId)?.tags.includes(existing.id)) toggleTag(nodeId, existing.id); return; }
    const tag: Tag = { id: crypto.randomUUID(), group, name: name.trim(), color: THREAD_PALETTE[(p.tags.length * 5) % THREAD_PALETTE.length].color };
    commit({ ...p, tags: [...p.tags, tag], nodes: p.nodes.map(n => n.id === nodeId ? { ...n, tags: [...n.tags, tag.id] } : n) });
  }
  function deleteTag(id: string) {
    edit(p => ({ ...p, tags: p.tags.filter(t => t.id !== id), nodes: p.nodes.map(n => ({ ...n, tags: n.tags.filter(t => t !== id) })) }));
    setFilter(f => { const next = new Set(f); next.delete(id); return next; });
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
    const pad = 70; const top = 70; const w = el.clientWidth - pad * 2 - (selection ? 320 : 0); const h = el.clientHeight - pad - top;
    const k = clamp(Math.min(w / rect.w, h / rect.h), MIN_K, 1);
    setCamera({ k, x: pad + (w - rect.w * k) / 2 - rect.x * k, y: top + (h - rect.h * k) / 2 - rect.y * k });
    return true;
  }
  function reveal(rect: Rect) {
    const el = viewport.current; if (!el) return; const c = cameraRef.current;
    const sx = rect.x * c.k + c.x; const sy = rect.y * c.k + c.y;
    if (sx >= -40 && sy >= 60 && sx < el.clientWidth - 200 && sy < el.clientHeight - 100) return;
    setCamera({ ...c, x: Math.min(c.x, 80 - Math.max(rect.x, -c.x / c.k) * c.k), y: 120 - rect.y * c.k });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const k = cameraRef.current.k;
    if (d.mode === "connect") { d.moved = true; setPreview({ from: d.from, ...toWorld(e.clientX, e.clientY) }); return; }
    if (d.mode === "resize") {
      const orig = d.before.threads.find(t => t.id === d.id); if (!orig) return;
      const dm = (e.clientX - d.sx) / k / MONTH_W;
      // Resizing a thread never carries boxes: the lane edge moves, the plan stays where you put it.
      const patch = d.edge === "end"
        ? { months: clamp(Math.round((orig.months + dm) * 2) / 2, 0.5, 120) }
        : (() => { const shift = clamp(Math.round(dm), Math.ceil(orig.months - 120), Math.floor(orig.months - 0.5)); return { start: addMonths(orig.start, shift), months: orig.months - shift }; })();
      d.moved = true;
      const next = { ...d.before, threads: d.before.threads.map(t => t.id === d.id ? { ...t, ...patch } : t) };
      latest.current = next; setPlan(next);
      return;
    }
    if (d.mode === "unit-height") {
      const orig = d.before.units.find(u => u.id === d.id); if (!orig) return;
      const height = clamp(snap(orig.height + (e.clientY - d.sy) / k), 100, 4000);
      d.moved = true;
      const next = carryNodes(d.before, { ...d.before, units: d.before.units.map(u => u.id === d.id ? { ...u, height } : u) });
      latest.current = next; setPlan(next);
      return;
    }
    const dx = e.clientX - d.sx; const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    if (d.mode === "pan") { setCamera({ ...d.cam, x: d.cam.x + dx, y: d.cam.y + dy }); return; }
    if (d.mode === "marquee") {
      const w = toWorld(e.clientX, e.clientY);
      setMarquee({ x: Math.min(d.sx, w.x), y: Math.min(d.sy, w.y), w: Math.abs(w.x - d.sx), h: Math.abs(w.y - d.sy) });
      return;
    }
    // The grabbed box snaps to the grid; the rest of the group keeps its offsets from it.
    const lead = d.origins.get(d.id)!;
    const ddx = snap(lead.x + dx / k) - lead.x; const ddy = snap(lead.y + dy / k) - lead.y;
    const next = { ...d.before, nodes: d.before.nodes.map(n => { const o = d.origins.get(n.id); return o ? { ...n, x: o.x + ddx, y: o.y + ddy } : n; }) };
    latest.current = next; setPlan(next);
  };
  handlers.current.up = (e: PointerEvent) => {
    const d = drag.current; if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    if (d.mode === "pan" && !d.moved) setSelection(null);
    if (d.mode === "marquee") {
      setMarquee(null);
      if (!d.moved || !latest.current) return;
      const w = toWorld(e.clientX, e.clientY);
      const r = { x: Math.min(d.sx, w.x), y: Math.min(d.sy, w.y), x2: Math.max(d.sx, w.x), y2: Math.max(d.sy, w.y) };
      const hits = latest.current.nodes.filter(n => n.x < r.x2 && n.x + NODE_W > r.x && n.y < r.y2 && n.y + NODE_H > r.y).map(n => n.id);
      selectNodes([...d.base, ...hits]);
    }
    // Clicking one box of a group (without dragging) narrows the selection to it.
    if (d.mode === "node" && !d.moved && d.origins.size > 1) selectNodes([d.id]);
    if ((d.mode === "node" || d.mode === "resize" || d.mode === "unit-height") && d.moved && latest.current) commit(latest.current, { before: d.before });
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
    else if (mod && e.key.toLowerCase() === "a" && latest.current) { e.preventDefault(); selectNodes(latest.current.nodes.map(n => n.id)); }
    else if ((e.key === "Delete" || e.key === "Backspace") && selection) { e.preventDefault(); remove(selection); }
    else if (e.key.startsWith("Arrow") && nodeIds(selection).length) {
      e.preventDefault(); const by = e.shiftKey ? SNAP * 5 : SNAP;
      const [dx, dy] = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[e.key] ?? [0, 0];
      updateNodes(nodeIds(selection), n => ({ ...n, x: n.x + dx, y: n.y + dy }), "nudge");
    }
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
    !e.currentTarget.contains(e.target as Node) || !!(e.target as HTMLElement).closest(CHROME);
  function startPan(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || onCanvasChrome(e)) return;
    if (e.shiftKey) {
      const w = toWorld(e.clientX, e.clientY);
      drag.current = { mode: "marquee", pointer: e.pointerId, sx: w.x, sy: w.y, base: nodeIds(selection), moved: false };
      return;
    }
    drag.current = { mode: "pan", pointer: e.pointerId, sx: e.clientX, sy: e.clientY, cam: cameraRef.current, moved: false };
  }
  function startNode(e: ReactPointerEvent, node: PlanNode) {
    if (e.button !== 0 || !latest.current) return;
    e.stopPropagation();
    const current = nodeIds(selection);
    if (e.shiftKey || e.ctrlKey || e.metaKey) { selectNodes(current.includes(node.id) ? current.filter(id => id !== node.id) : [...current, node.id]); return; }
    const group = current.includes(node.id) ? current : [node.id];
    if (!current.includes(node.id)) selectNodes([node.id]);
    const origins = new Map(latest.current.nodes.filter(n => group.includes(n.id)).map(n => [n.id, { x: n.x, y: n.y }]));
    drag.current = { mode: "node", pointer: e.pointerId, sx: e.clientX, sy: e.clientY, id: node.id, before: latest.current, origins, moved: false };
  }
  function startResize(e: ReactPointerEvent, thread: Thread, edge: "start" | "end") {
    if (e.button !== 0 || !latest.current) return;
    e.stopPropagation(); e.preventDefault(); setSelection({ type: "thread", id: thread.id });
    drag.current = { mode: "resize", pointer: e.pointerId, sx: e.clientX, id: thread.id, edge, before: latest.current, moved: false };
  }
  function startUnitHeight(e: ReactPointerEvent, unit: Unit) {
    if (e.button !== 0 || !latest.current) return;
    e.stopPropagation(); e.preventDefault(); setSelection({ type: "unit", id: unit.id });
    drag.current = { mode: "unit-height", pointer: e.pointerId, sy: e.clientY, id: unit.id, before: latest.current, moved: false };
  }
  function startConnect(e: ReactPointerEvent, node: PlanNode) {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    drag.current = { mode: "connect", pointer: e.pointerId, from: node.id, moved: false };
    setPreview({ from: node.id, ...toWorld(e.clientX, e.clientY) });
  }

  const nodes = new Map(plan?.nodes.map(n => [n.id, n]) ?? []);
  const tags = new Map(plan?.tags.map(t => [t.id, t]) ?? []);
  const selId = selection && "id" in selection ? selection.id : null;
  const picked = new Set(nodeIds(selection));
  const selectedNode = selection?.type === "node" ? nodes.get(selection.id) : undefined;
  const selectedMany = selection?.type === "nodes" ? selection.ids.map(id => nodes.get(id)).filter((n): n is PlanNode => !!n) : [];
  const selectedLink = selection?.type === "link" ? plan?.links.find(l => l.id === selection.id) : undefined;
  const selectedThread = selection?.type === "thread" ? plan?.threads.find(t => t.id === selection.id) : undefined;
  const selectedUnit = selection?.type === "unit" ? plan?.units.find(u => u.id === selection.id) : undefined;
  const linked = new Set(selectedNode ? plan!.links.filter(l => l.from === selectedNode.id || l.to === selectedNode.id).flatMap(l => [l.id, l.from, l.to]) : []);
  const dimmed = new Set(plan && filter.size ? plan.nodes.filter(n => !matchesFilter(n, plan, filter)).map(n => n.id) : []);
  const viewLeft = -camera.x / camera.k;
  const l = plan ? layout(plan) : null;

  return <section ref={root} className="plans-workspace">
    <div ref={viewport} className="plans-canvas" onPointerDown={startPan} onDoubleClick={e => {
      if (onCanvasChrome(e)) return;
      const w = toWorld(e.clientX, e.clientY); addNode(w.x, w.y);
    }} style={{ backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${22 * camera.k}px ${22 * camera.k}px` }}>
      {plan && l && <div className="plans-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.k})` }}>
        <Timeline plan={plan} />
        {plan.units.map(unit => {
          const r = l.units.get(unit.id)!; const members = plan.nodes.filter(n => unitOf(plan, n)?.id === unit.id);
          const threads = plan.threads.filter(t => t.unitId === unit.id);
          return <div key={unit.id} className={`plan-unit ${selId === unit.id ? "selected" : ""}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h, "--thread-color": unit.color } as CSSProperties}>
            <button className="plan-unit-head" style={{ left: clamp(viewLeft - r.x + 16, 16, r.w - 480) }} onPointerDown={e => { e.stopPropagation(); setSelection({ type: "unit", id: unit.id }); }}>
              <Building2 size={16} /><strong>{unit.name}</strong>
              <small>{[unit.description, `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`, `${members.length} ${members.length === 1 ? "box" : "boxes"}`].filter(Boolean).join(" · ")}</small>
            </button>
            <span className="plan-unit-resize" style={{ top: UNIT_HEAD + unit.height - 6 }} title="Drag to make room for ongoing work" aria-hidden onPointerDown={e => startUnitHeight(e, unit)} />
          </div>;
        })}
        {plan.threads.map(thread => {
          const r = l.threads.get(thread.id)!; const members = plan.nodes.filter(n => threadOf(plan, n)?.id === thread.id);
          const done = members.filter(n => n.status === "done").length;
          return <div key={thread.id} className={`plan-lane ${selId === thread.id ? "selected" : ""}`} style={{ left: r.x, top: r.y, width: r.w, height: r.h, "--thread-color": thread.color } as CSSProperties}>
            <button className="plan-lane-head" style={{ left: clamp(viewLeft - r.x + 14, 14, Math.max(14, r.w - 260)) }} onPointerDown={e => { e.stopPropagation(); setSelection({ type: "thread", id: thread.id }); }}>
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
            const geo = curve(box(a), box(b)); const active = selId === link.id || linked.has(link.id) || (picked.size > 1 && picked.has(a.id) && picked.has(b.id));
            return <g key={link.id} className={`plan-link ${b.priority === "secondary" ? "secondary" : ""} ${active ? "active" : ""} ${dimmed.has(a.id) || dimmed.has(b.id) ? "dimmed" : ""}`}>
              <path className="plan-link-hit" d={geo.d} onPointerDown={e => { e.stopPropagation(); setSelection({ type: "link", id: link.id }); }} />
              <path className="plan-link-line" d={geo.d} markerEnd={`url(#${active ? "plan-arrow-active" : "plan-arrow"})`} />
              {link.label && <text x={geo.mid.x} y={geo.mid.y - 6} textAnchor="middle">{link.label}</text>}
            </g>;
          })}
          {preview && nodes.get(preview.from) && <path className="plan-link-preview" d={curve(box(nodes.get(preview.from)!), { x: preview.x, y: preview.y, w: 0, h: 0 }).d} markerEnd="url(#plan-arrow-active)" />}
        </svg>
        {plan.nodes.map(node => {
          const Icon = KIND_ICONS[node.kind]; const lane = threadOf(plan, node) ?? unitOf(plan, node);
          const nodeTags = node.tags.map(id => tags.get(id)).filter((t): t is Tag => !!t);
          return <div key={node.id} data-node-id={node.id} role="button" tabIndex={0} aria-label={`${NODE_KINDS[node.kind]}: ${node.title}`}
            className={`plan-node kind-${node.kind} status-${node.status} ${node.priority} ${picked.has(node.id) ? "selected" : ""} ${linked.has(node.id) && !picked.has(node.id) ? "related" : ""} ${preview && preview.from !== node.id ? "connect-target" : ""} ${dimmed.has(node.id) ? "dimmed" : ""}`}
            style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H, "--thread-color": lane?.color ?? "var(--edge)", "--status-color": STATUS_COLORS[node.status] } as CSSProperties}
            onPointerDown={e => startNode(e, node)} onKeyDown={e => { if (e.key === "Enter") setSelection({ type: "node", id: node.id }); }}>
            <div className="plan-node-meta"><Icon size={12} /><span>{NODE_KINDS[node.kind]}</span><i />{node.status === "done" ? <Check size={12} /> : <span>{NODE_STATUSES[node.status]}</span>}</div>
            <strong>{node.title}</strong>
            {(node.entity || nodeTags.length > 0) && <div className="plan-node-foot">
              {node.entity && <small><User size={11} />{node.entity.name}</small>}
              {nodeTags.map(t => <span key={t.id} className="plan-tag" style={{ "--tag-color": t.color } as CSSProperties}>{t.name}</span>)}
            </div>}
            <span className="plan-handle" title="Drag to connect" aria-hidden onPointerDown={e => startConnect(e, node)} />
          </div>;
        })}
        {marquee && <div className="plans-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / camera.k }} />}
      </div>}

      <div className="plans-overlay plans-topbar">
        <div className="plans-toolbar">
          <strong>Plans</strong>
          <button disabled={!plan} onClick={() => { const el = viewport.current!; const r = el.getBoundingClientRect(); const w = toWorld(r.left + el.clientWidth / 2, r.top + el.clientHeight / 2); addNode(w.x, w.y); }}><Plus size={14} />Box</button>
          <button disabled={!plan?.units.length} title={plan?.units.length ? "Add a time-boxed thread to the selected unit" : "Add a unit first"} onClick={() => addThread()}><Rows3 size={14} />Thread</button>
          <button disabled={!plan} onClick={addUnit}><Building2 size={14} />Unit</button>
          <span className="plans-divider" />
          <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!history.undo} onClick={() => step(undo, redo)}><Undo2 size={14} /></button>
          <button aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!history.redo} onClick={() => step(redo, undo)}><Redo2 size={14} /></button>
          <span role="status" className="plans-status">{status}</span>
        </div>
        {plan && plan.tags.length > 0 && <div className="plans-filter" role="group" aria-label="Filter by tag">
          {(Object.entries(TAG_GROUPS) as Array<[TagGroup, string]>).map(([group, label]) => {
            const groupTags = plan.tags.filter(t => t.group === group); if (!groupTags.length) return null;
            return <div key={group}><small>{label}</small>{groupTags.map(t => <span key={t.id} className="plans-filter-chip">
              <button aria-pressed={filter.has(t.id)} style={{ "--tag-color": t.color } as CSSProperties} onClick={() => setFilter(f => { const next = new Set(f); if (next.has(t.id)) next.delete(t.id); else next.add(t.id); return next; })}><i />{t.name}</button>
              {editingTags && <button className="plans-filter-delete" aria-label={`Delete tag ${t.name}`} title="Delete tag from every box" onClick={() => deleteTag(t.id)}><X size={11} /></button>}
            </span>)}</div>;
          })}
          {filter.size > 0 && <button className="plans-filter-clear" onClick={() => setFilter(new Set())}>Clear · {plan.nodes.length - dimmed.size} shown</button>}
          <button className="plans-filter-edit" aria-pressed={editingTags} aria-label="Edit tags" title={editingTags ? "Done editing tags" : "Delete tags"} onClick={() => setEditingTags(v => !v)}>{editingTags ? <Check size={13} /> : <Pencil size={12} />}</button>
        </div>}
        {error && <div className="plans-error" role="alert">{error}<button onClick={() => void (conflict || !plan ? load() : flush())}>{conflict || !plan ? "Reload" : "Retry"}</button></div>}
      </div>
      <div className="plans-overlay plans-zoom">
        <button aria-label="Zoom out" onClick={() => zoom(0.8)}><Minus size={14} /></button>
        <span>{Math.round(camera.k * 100)}%</span>
        <button aria-label="Zoom in" onClick={() => zoom(1.25)}><Plus size={14} /></button>
        <button aria-label="Fit everything" title="Fit everything" disabled={!plan} onClick={() => plan && fit(withAxis(boardBounds(plan)))}><Maximize2 size={14} /></button>
      </div>
      <p className="plans-overlay plans-hint">Double-click to add a box · drag a box’s dot to connect · Shift+drag or Ctrl+click to select several</p>

      {plan && selection && <aside className="plans-overlay plans-inspector" key={selId ?? "many"}>
        {selectedMany.length > 1 && <GroupInspector plan={plan} nodes={selectedMany} onChange={(fn, key) => updateNodes(selectedMany.map(n => n.id), fn, key)} onClear={() => setSelection(null)} onDelete={() => remove(selection)} />}
        <button className="plans-close" aria-label="Close" onClick={() => setSelection(null)}><X size={15} /></button>
        {selectedNode && <NodeInspector plan={plan} node={selectedNode} entities={entities} onChange={(patch, key) => updateNode(selectedNode.id, patch, key)} onToggleTag={id => toggleTag(selectedNode.id, id)} onAddTag={(group, name) => addTag(selectedNode.id, group, name)} onSelect={setSelection} onRemoveLink={id => remove({ type: "link", id })} onDelete={() => remove(selection)} onOpenEntity={onOpenEntity} />}
        {selectedLink && <LinkInspector link={selectedLink} nodes={nodes} onChange={(patch, key) => updateLink(selectedLink.id, patch, key)} onSelect={setSelection} onDelete={() => remove(selection)} />}
        {selectedThread && <ThreadInspector plan={plan} thread={selectedThread} onChange={(patch, key) => updateThread(selectedThread.id, patch, key)} onMove={by => moveThread(selectedThread.id, by)} onDelete={() => remove(selection)} />}
        {selectedUnit && <UnitInspector plan={plan} unit={selectedUnit} onChange={(patch, key) => updateUnit(selectedUnit.id, patch, key)} onMove={by => moveUnit(selectedUnit.id, by)} onAddThread={() => addThread(selectedUnit.id)} onDelete={() => remove(selection)} />}
      </aside>}
    </div>
  </section>;
}

function Timeline({ plan }: { plan: Plan }) {
  const { span, height } = layout(plan);
  const first = xMonth(plan, span.x0); const months = Math.round((span.x1 - span.x0) / MONTH_W);
  const h = Math.max(LANE_H, height);
  return <>
    {Array.from({ length: months }, (_, i) => {
      const m = addMonths(first, i);
      return <div key={m} className={`plan-month ${m.endsWith("-01") ? "year" : ""}`} style={{ left: monthX(plan, m), width: MONTH_W, height: h + 40 }}>
        <span>{monthLabel(m, m.endsWith("-01") || i === 0)}</span>
      </div>;
    })}
    <div className="plan-today" style={{ left: todayX(plan), height: h + 52 }}><span>Today</span></div>
  </>;
}

function NodeInspector({ plan, node, entities, onChange, onToggleTag, onAddTag, onSelect, onRemoveLink, onDelete, onOpenEntity }: {
  plan: Plan; node: PlanNode; entities: ViewEntity[]; onChange: (patch: Partial<PlanNode>, key?: string) => void;
  onToggleTag: (id: string) => void; onAddTag: (group: TagGroup, name: string) => void;
  onSelect: (s: Selection) => void; onRemoveLink: (id: string) => void; onDelete: () => void; onOpenEntity: (id: string) => void;
}) {
  const thread = threadOf(plan, node); const unit = unitOf(plan, node);
  const people = [...entities].sort((a, b) => a.name.localeCompare(b.name));
  const options = [{ value: "", label: "No one" }, ...people.map(e => ({ value: e.id, label: `${e.name}${e.type === "organization" ? " · org" : ""}` }))];
  if (node.entity && !people.some(e => e.id === node.entity!.id)) options.push({ value: node.entity.id, label: node.entity.name });
  const title = (id: string) => plan.nodes.find(n => n.id === id)?.title ?? "";
  const outgoing = plan.links.filter(l => l.from === node.id); const incoming = plan.links.filter(l => l.to === node.id);
  return <>
    <small className="plans-eyebrow">{NODE_KINDS[node.kind].toUpperCase()}</small>
    <Field id="plan-node-title" label="Title" value={node.title} required maxLength={200} onSave={title => onChange({ title }, `title:${node.id}`)} />
    <p className="plans-note">{thread
      ? <><span className="plans-dot" style={{ background: thread.color }} />{unit && <>{unit.name} › </>}<strong>{thread.name}</strong> · around {monthLabel(xMonth(plan, node.x + NODE_W / 2))}</>
      : unit ? <><span className="plans-dot" style={{ background: unit.color }} /><strong>{unit.name}</strong> · ongoing work</>
      : "Not in a unit yet. Drag it into a unit, or into one of its threads to schedule it."}</p>
    <div className="plans-row">
      <label>Type<StyledSelect label="Box type" compact value={node.kind} options={kindOptions} onChange={kind => onChange({ kind: kind as NodeKind })} /></label>
      <label>Status<StyledSelect label="Status" compact value={node.status} options={statusOptions} onChange={status => onChange({ status: status as NodeStatus })} /></label>
    </div>
    <label>Priority
      <div className="plans-segment" role="group" aria-label="Priority">{(Object.entries(PRIORITIES) as Array<[PlanNode["priority"], string]>).map(([value, label]) => <button key={value} aria-pressed={node.priority === value} onClick={() => onChange({ priority: value })}>{label}</button>)}</div>
    </label>
    {(Object.entries(TAG_GROUPS) as Array<[TagGroup, string]>).map(([group, label]) => <div key={group} className="plans-tags">
      <small>{label}</small>
      <div>
        {plan.tags.filter(t => t.group === group).map(t => <button key={t.id} aria-pressed={node.tags.includes(t.id)} style={{ "--tag-color": t.color } as CSSProperties} onClick={() => onToggleTag(t.id)}><i />{t.name}</button>)}
        <AddTag placeholder={group === "sector" ? "+ Sector" : "+ Location"} onAdd={name => onAddTag(group, name)} />
      </div>
    </div>)}
    <label>Person or organization
      <div className="plans-entity"><StyledSelect label="Linked person or organization" value={node.entity?.id ?? ""} options={options} onChange={id => { const e = entities.find(x => x.id === id); onChange({ entity: e ? { id: e.id, name: e.name } : null }); }} />
        {node.entity && entities.some(e => e.id === node.entity!.id) && <button aria-label={`Open ${node.entity.name} in the network`} title="Open in network" onClick={() => onOpenEntity(node.entity!.id)}><ArrowUpRight size={14} /></button>}</div>
    </label>
    <Field label="Notes" value={node.notes} multiline maxLength={4000} placeholder="Why, how, who to ask…" onSave={notes => onChange({ notes }, `notes:${node.id}`)} />
    {(outgoing.length > 0 || incoming.length > 0) && <div className="plans-connections">
      <small className="plans-eyebrow">CONNECTIONS</small>
      {[...incoming.map(l => ({ l, dir: "from", other: l.from })), ...outgoing.map(l => ({ l, dir: "to", other: l.to }))].map(({ l, dir, other }) =>
        <div key={l.id}><button onClick={() => onSelect({ type: "node", id: other })}>{dir === "from" ? "← " : "→ "}{title(other)}{l.label && <em> · {l.label}</em>}</button><button aria-label="Remove connection" onClick={() => onRemoveLink(l.id)}><X size={12} /></button></div>)}
    </div>}
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete box</button>
  </>;
}

function GroupInspector({ plan, nodes, onChange, onClear, onDelete }: { plan: Plan; nodes: PlanNode[]; onChange: (fn: (n: PlanNode) => PlanNode, key?: string) => void; onClear: () => void; onDelete: () => void }) {
  const same = <T,>(get: (n: PlanNode) => T) => nodes.every(n => get(n) === get(nodes[0])) ? get(nodes[0]) : null;
  const status = same(n => n.status); const priority = same(n => n.priority);
  const done = nodes.filter(n => n.status === "done").length;
  return <>
    <small className="plans-eyebrow">{nodes.length} BOXES SELECTED</small>
    <p className="plans-note">Drag any of them to move the group, or nudge with the arrow keys (Shift for bigger steps). {done}/{nodes.length} done.</p>
    <label>Status<StyledSelect label="Status for selected boxes" compact value={status ?? ""} options={[...(status ? [] : [{ value: "", label: "Mixed" }]), ...statusOptions]} onChange={s => { if (s) onChange(n => ({ ...n, status: s as NodeStatus })); }} /></label>
    <label>Priority
      <div className="plans-segment" role="group" aria-label="Priority for selected boxes">{(Object.entries(PRIORITIES) as Array<[PlanNode["priority"], string]>).map(([value, label]) => <button key={value} aria-pressed={priority === value} onClick={() => onChange(n => ({ ...n, priority: value }))}>{label}</button>)}</div>
    </label>
    {(Object.entries(TAG_GROUPS) as Array<[TagGroup, string]>).map(([group, label]) => {
      const groupTags = plan.tags.filter(t => t.group === group); if (!groupTags.length) return null;
      return <div key={group} className="plans-tags">
        <small>{label}</small>
        <div>{groupTags.map(t => {
          const count = nodes.filter(n => n.tags.includes(t.id)).length; const all = count === nodes.length;
          return <button key={t.id} aria-pressed={all} className={count && !all ? "partial" : ""} title={all ? "Remove from all selected" : "Add to all selected"} style={{ "--tag-color": t.color } as CSSProperties}
            onClick={() => onChange(n => ({ ...n, tags: all ? n.tags.filter(x => x !== t.id) : n.tags.includes(t.id) ? n.tags : [...n.tags, t.id] }))}><i />{t.name}{count > 0 && !all && <em>{count}</em>}</button>;
        })}</div>
      </div>;
    })}
    <div className="plans-row"><button className="plans-secondary-btn" onClick={onClear}>Clear selection</button></div>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete {nodes.length} boxes</button>
  </>;
}

function AddTag({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => void }) {
  const [text, setText] = useState("");
  return <input className="plans-add-tag" aria-label={placeholder.replace("+ ", "Add ")} placeholder={placeholder} maxLength={60} value={text} onChange={e => setText(e.target.value)}
    onKeyDown={e => { if (e.key === "Enter" && text.trim()) { e.preventDefault(); onAdd(text); setText(""); } else if (e.key === "Escape") setText(""); }} />;
}

function LinkInspector({ link, nodes, onChange, onSelect, onDelete }: { link: PlanLink; nodes: Map<string, PlanNode>; onChange: (patch: Partial<PlanLink>, key?: string) => void; onSelect: (s: Selection) => void; onDelete: () => void }) {
  const from = nodes.get(link.from); const to = nodes.get(link.to);
  return <>
    <small className="plans-eyebrow">CONNECTION</small>
    <div className="plans-link-ends"><button onClick={() => onSelect({ type: "node", id: link.from })}>{from?.title}</button><ArrowRight size={14} /><button onClick={() => onSelect({ type: "node", id: link.to })}>{to?.title}</button></div>
    <Field label="Label" value={link.label} maxLength={100} placeholder="e.g. priority, intro, funds…" onSave={label => onChange({ label }, `label:${link.id}`)} />
    <p className="plans-note">Arrows into a secondary box are drawn dashed.</p>
    <div className="plans-row"><button className="plans-secondary-btn" onClick={() => onChange({ from: link.to, to: link.from })}>Reverse direction</button></div>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete connection</button>
  </>;
}

function ThreadInspector({ plan, thread, onChange, onMove, onDelete }: { plan: Plan; thread: Thread; onChange: (patch: Partial<Thread>, key?: string) => void; onMove: (by: number) => void; onDelete: () => void }) {
  const siblings = plan.threads.filter(t => t.unitId === thread.unitId); const index = siblings.indexOf(thread);
  const members = plan.nodes.filter(n => threadOf(plan, n)?.id === thread.id);
  return <>
    <small className="plans-eyebrow">THREAD</small>
    <Field label="Name" value={thread.name} required maxLength={100} onSave={name => onChange({ name }, `name:${thread.id}`)} />
    <Field label="Goal" value={thread.goal} maxLength={100} placeholder="e.g. $300M raised" onSave={goal => onChange({ goal }, `goal:${thread.id}`)} />
    <label>Unit<StyledSelect label="Unit" value={thread.unitId} options={plan.units.map(u => ({ value: u.id, label: u.name, color: u.color }))} onChange={unitId => onChange({ unitId })} /></label>
    <div className="plans-row">
      <label>Starts<input type="month" value={thread.start} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange({ start: e.target.value }, `start:${thread.id}`); }} /></label>
      <label>Months<input type="number" min={0.5} max={120} step={0.5} value={thread.months} onChange={e => { const v = Number(e.target.value); if (v >= 0.5 && v <= 120) onChange({ months: v }, `months:${thread.id}`); }} /></label>
    </div>
    <p className="plans-note">{formatMonths(thread.months)} · ends {monthLabel(addMonths(thread.start, Math.ceil(thread.months) - 1))} · {members.filter(n => n.status === "done").length}/{members.length} boxes done. Drag either end of the lane to resize it.</p>
    <label>Color<Swatches value={thread.color} onChange={color => onChange({ color })} /></label>
    <div className="plans-row">
      <button className="plans-secondary-btn" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp size={14} />Move up</button>
      <button className="plans-secondary-btn" disabled={index === siblings.length - 1} onClick={() => onMove(1)}><ChevronDown size={14} />Move down</button>
    </div>
    <p className="plans-note">Boxes move with their lane. Deleting the thread keeps its boxes on the board.</p>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete thread</button>
  </>;
}

function UnitInspector({ plan, unit, onChange, onMove, onAddThread, onDelete }: { plan: Plan; unit: Unit; onChange: (patch: Partial<Unit>, key?: string) => void; onMove: (by: number) => void; onAddThread: () => void; onDelete: () => void }) {
  const index = plan.units.indexOf(unit);
  const threads = plan.threads.filter(t => t.unitId === unit.id);
  const members = plan.nodes.filter(n => unitOf(plan, n)?.id === unit.id);
  return <>
    <small className="plans-eyebrow">BUSINESS UNIT</small>
    <Field label="Name" value={unit.name} required maxLength={100} onSave={name => onChange({ name }, `name:${unit.id}`)} />
    <Field label="What it does" value={unit.description} maxLength={200} placeholder="e.g. Builds companies · New York" onSave={description => onChange({ description }, `desc:${unit.id}`)} />
    <p className="plans-note">{members.length} {members.length === 1 ? "box" : "boxes"} · {members.filter(n => n.status === "done").length} done. The open area at the top is for ongoing work; drag the line under it to make room.</p>
    <div className="plans-connections">
      <small className="plans-eyebrow">THREADS</small>
      {threads.map(t => <div key={t.id}><span className="plans-thread-row"><span className="plans-dot" style={{ background: t.color }} />{t.name}{t.goal && <em> · {t.goal}</em>}<em> · {formatMonths(t.months)}</em></span></div>)}
      <button className="plans-secondary-btn" onClick={onAddThread}><Plus size={14} />Add a thread</button>
    </div>
    <label>Color<Swatches value={unit.color} onChange={color => onChange({ color })} /></label>
    <div className="plans-row">
      <button className="plans-secondary-btn" disabled={index === 0} onClick={() => onMove(-1)}><ChevronUp size={14} />Move up</button>
      <button className="plans-secondary-btn" disabled={index === plan.units.length - 1} onClick={() => onMove(1)}><ChevronDown size={14} />Move down</button>
    </div>
    <p className="plans-note">Deleting a unit removes its threads. Boxes stay on the board.</p>
    <button className="plans-delete" onClick={onDelete}><Trash2 size={14} />Delete unit</button>
  </>;
}

function Swatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  return <div className="plans-swatches">{THREAD_PALETTE.map(({ color, name }) => <button key={color} aria-label={name} title={name} aria-pressed={value === color} style={{ background: color }} onClick={() => onChange(color)}>{value === color && <Check size={12} />}</button>)}</div>;
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

const nodeIds = (s: Selection) => !s ? [] : s.type === "node" ? [s.id] : s.type === "nodes" ? s.ids : [];
const exists = (p: Plan, s: NonNullable<Selection>) => s.type === "nodes" ? s.ids.every(id => p.nodes.some(n => n.id === id))
  : (s.type === "node" ? p.nodes : s.type === "link" ? p.links : s.type === "thread" ? p.threads : p.units).some(x => x.id === s.id);
const formatMonths = (m: number) => m >= 12 && m % 12 === 0 ? `${m / 12} ${m === 12 ? "year" : "years"}` : `${m} ${m === 1 ? "month" : "months"}`;
