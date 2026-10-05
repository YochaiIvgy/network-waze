import { z } from "zod";
import { PATH_PALETTE } from "./loops";

export const THREAD_PALETTE = PATH_PALETTE;
export const NODE_KINDS = { step: "Step", milestone: "Milestone", decision: "Decision", goal: "Goal" } as const;
export const NODE_STATUSES = { idea: "Idea", planned: "Planned", active: "In progress", done: "Done", blocked: "Blocked" } as const;
export const STATUS_COLORS: Record<NodeStatus, string> = { idea: "#868991", planned: "#3986bd", active: "#c39330", done: "#36866b", blocked: "#d9232b" };
export const PRIORITIES = { primary: "Primary", secondary: "Secondary" } as const;
export const TAG_GROUPS = { sector: "Sectors", location: "Locations" } as const;

/**
 * Board geometry, in world units. Business units are permanent rows spanning the
 * whole timeline; each has an open area for ongoing work, then its time-boxed
 * threads stacked beneath it on the shared month axis.
 */
export const MONTH_W = 240;
export const LANE_H = 240;
export const NODE_W = 200;
export const NODE_H = 96;
export const UNIT_HEAD = 64;
const UNIT_PAD = 20;
const THREAD_GAP = 16;
const UNIT_GAP = 28;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const coord = z.number().finite().min(-1e6).max(1e6);
const color = z.string().regex(/^#[0-9a-f]{6}$/i);

export const unitSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(200),
  color,
  height: z.number().min(100).max(4000),
});
export const threadSchema = z.object({
  id: z.string().uuid(),
  unitId: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  goal: z.string().max(100),
  start: month,
  months: z.number().min(0.5).max(120),
  color,
});
export const tagSchema = z.object({
  id: z.string().uuid(),
  group: z.enum(["sector", "location"]),
  name: z.string().trim().min(1).max(60),
  color,
});
export const planNodeSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  notes: z.string().max(4000),
  kind: z.enum(Object.keys(NODE_KINDS) as [NodeKind, ...NodeKind[]]),
  status: z.enum(Object.keys(NODE_STATUSES) as [NodeStatus, ...NodeStatus[]]),
  priority: z.enum(["primary", "secondary"]),
  x: coord, y: coord,
  entity: z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) }).nullable(),
  tags: z.array(z.string().uuid()).max(50),
});
export const planLinkSchema = z.object({
  id: z.string().uuid(),
  from: z.string().uuid(),
  to: z.string().uuid(),
  label: z.string().max(100),
});
export const planSchema = z.object({
  origin: month,
  units: z.array(unitSchema).max(30),
  threads: z.array(threadSchema).max(100),
  tags: z.array(tagSchema).max(100),
  nodes: z.array(planNodeSchema).max(2000),
  links: z.array(planLinkSchema).max(5000),
}).superRefine((plan, ctx) => {
  const ids = [...plan.units, ...plan.threads, ...plan.tags, ...plan.nodes, ...plan.links].map(x => x.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate IDs in plan." });
  const units = new Set(plan.units.map(u => u.id));
  if (plan.threads.some(t => !units.has(t.unitId))) ctx.addIssue({ code: "custom", message: "A thread belongs to a missing unit." });
  const nodes = new Set(plan.nodes.map(n => n.id));
  if (plan.links.some(l => !nodes.has(l.from) || !nodes.has(l.to) || l.from === l.to)) ctx.addIssue({ code: "custom", message: "A connection points at a missing box." });
  const tags = new Set(plan.tags.map(t => t.id));
  if (plan.nodes.some(n => n.tags.some(t => !tags.has(t)))) ctx.addIssue({ code: "custom", message: "A box uses a missing tag." });
});

export type NodeKind = keyof typeof NODE_KINDS;
export type NodeStatus = keyof typeof NODE_STATUSES;
export type TagGroup = keyof typeof TAG_GROUPS;
export type Unit = z.infer<typeof unitSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type PlanNode = z.infer<typeof planNodeSchema>;
export type PlanLink = z.infer<typeof planLinkSchema>;
export type Plan = z.infer<typeof planSchema>;
export type Rect = { x: number; y: number; w: number; h: number };

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const fromIndex = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
export const currentMonth = () => { const d = new Date(); return fromIndex(d.getFullYear() * 12 + d.getMonth()); };
export const addMonths = (m: string, n: number) => fromIndex(monthIndex(m) + n);
export const monthLabel = (m: string, year = true) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)
  .toLocaleDateString(undefined, year ? { month: "short", year: "numeric" } : { month: "short" });
export const monthX = (plan: Pick<Plan, "origin">, m: string) => (monthIndex(m) - monthIndex(plan.origin)) * MONTH_W;
export const xMonth = (plan: Pick<Plan, "origin">, x: number) => fromIndex(monthIndex(plan.origin) + Math.floor(x / MONTH_W));
export function todayX(plan: Pick<Plan, "origin">) {
  const d = new Date(); const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return monthX(plan, currentMonth()) + ((d.getDate() - 1) / days) * MONTH_W;
}
export const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

export type UnitLayout = Rect & { open: Rect };
export type Layout = { span: { x0: number; x1: number }; height: number; units: Map<string, UnitLayout>; threads: Map<string, Rect> };
const layouts = new WeakMap<Plan, Layout>();

/** Plans are immutable, so the layout is computed once per version. */
export function layout(plan: Plan): Layout {
  const cached = layouts.get(plan); if (cached) return cached;
  const xs = [0, todayX(plan), ...plan.threads.flatMap(t => [monthX(plan, t.start), monthX(plan, t.start) + t.months * MONTH_W]), ...plan.nodes.flatMap(n => [n.x, n.x + NODE_W])];
  const x0 = Math.floor(Math.min(...xs) / MONTH_W) * MONTH_W - MONTH_W;
  const x1 = Math.max(x0 + 24 * MONTH_W, Math.ceil(Math.max(...xs) / MONTH_W) * MONTH_W + 2 * MONTH_W);
  const units = new Map<string, UnitLayout>(); const threads = new Map<string, Rect>();
  let y = 0;
  for (const unit of plan.units) {
    const open = { x: x0, y: y + UNIT_HEAD, w: x1 - x0, h: unit.height };
    let ty = open.y + open.h;
    for (const t of plan.threads.filter(t => t.unitId === unit.id)) {
      threads.set(t.id, { x: monthX(plan, t.start), y: ty, w: t.months * MONTH_W, h: LANE_H });
      ty += LANE_H + THREAD_GAP;
    }
    const h = ty - y + UNIT_PAD - (ty > open.y + open.h ? THREAD_GAP : 0);
    units.set(unit.id, { x: x0, y, w: x1 - x0, h, open });
    y += h + UNIT_GAP;
  }
  const result = { span: { x0, x1 }, height: Math.max(0, y - UNIT_GAP), units, threads };
  layouts.set(plan, result);
  return result;
}
export const threadRect = (plan: Plan, id: string) => layout(plan).threads.get(id)!;
export const unitRect = (plan: Plan, id: string) => layout(plan).units.get(id)!;

const center = (n: PlanNode) => ({ x: n.x + NODE_W / 2, y: n.y + NODE_H / 2 });
/** Membership is positional and never stored: a box belongs to the lane its centre sits in. */
export function threadOf(plan: Plan, node: PlanNode): Thread | undefined {
  const c = center(node); const rects = layout(plan).threads;
  return plan.threads.find(t => inside(rects.get(t.id)!, c.x, c.y));
}
export function unitOf(plan: Plan, node: PlanNode): Unit | undefined {
  const c = center(node); const rects = layout(plan).units;
  return plan.units.find(u => { const r = rects.get(u.id)!; return c.y >= r.y && c.y <= r.y + r.h; });
}

/** After lanes move (reorder, resize, delete, new start date), carry their boxes along. */
export function carryNodes(prev: Plan, next: Plan): Plan {
  const before = layout(prev); const after = layout(next);
  return { ...next, nodes: next.nodes.map(node => {
    const thread = threadOf(prev, node);
    const from = thread && before.threads.get(thread.id); const to = thread && after.threads.get(thread.id);
    if (from && to) return { ...node, x: node.x + to.x - from.x, y: node.y + to.y - from.y };
    const unit = unitOf(prev, node);
    const ufrom = unit && before.units.get(unit.id); const uto = unit && after.units.get(unit.id);
    return ufrom && uto ? { ...node, y: node.y + uto.y - ufrom.y } : node;
  }) };
}

export function newNode(x: number, y: number, patch: Partial<PlanNode> = {}): PlanNode {
  return { id: crypto.randomUUID(), title: "New step", notes: "", kind: "step", status: "planned", priority: "primary", x, y, entity: null, tags: [], ...patch };
}

export function boardBounds(plan: Plan): Rect {
  const l = layout(plan);
  const rects: Rect[] = [...l.units.values(), ...plan.nodes.map(n => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H }))];
  if (!rects.length) return { x: 0, y: -200, w: MONTH_W * 6, h: 600 };
  const x = Math.min(...rects.map(r => r.x)); const y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
}

/** The node matches when it carries any selected tag in every group that has a selection. */
export function matchesFilter(node: PlanNode, plan: Plan, filter: Set<string>) {
  if (!filter.size) return true;
  return (Object.keys(TAG_GROUPS) as TagGroup[]).every(group => {
    const wanted = plan.tags.filter(t => t.group === group && filter.has(t.id));
    return !wanted.length || wanted.some(t => node.tags.includes(t.id));
  });
}

const pal = (i: number) => THREAD_PALETTE[i % THREAD_PALETTE.length].color;
function groupStructure() {
  const unit = (name: string, description: string, c: number): Unit => ({ id: crypto.randomUUID(), name, description, color: pal(c), height: 240 });
  const tag = (group: TagGroup, name: string, c: number): Tag => ({ id: crypto.randomUUID(), group, name, color: pal(c) });
  return {
    units: [
      unit("HoldCo", "Holds Capital, Studio and Builder · business development", 10),
      unit("Capital", "Funds the companies and products", 0),
      unit("Studio", "Builds companies · New York, more countries next", 2),
      unit("Builder", "Builds products · Israel", 1),
    ],
    tags: [
      tag("sector", "Financial", 6), tag("sector", "Infrastructure", 5), tag("sector", "Supply chain", 7), tag("sector", "Healthcare", 4),
      tag("location", "New York", 1), tag("location", "Israel", 3),
    ],
  };
}

/** Boards saved before business units existed: threads move into Capital, free boxes into HoldCo. */
export function upgradePlan(raw: unknown): unknown {
  const old = raw as { origin: string; threads: Array<Omit<Thread, "unitId">>; nodes: Array<Omit<PlanNode, "tags">>; links: PlanLink[]; units?: unknown };
  if (!old || typeof old !== "object" || old.units) return raw;
  const { units, tags } = groupStructure();
  const [holdco, capital] = units;
  const OLD_H = 84; const OLD_LANE = LANE_H + 40;
  const oldRect = (i: number) => ({ x: monthX(old, old.threads[i].start), y: i * OLD_LANE, w: old.threads[i].months * MONTH_W, h: LANE_H });
  const owner = (n: { x: number; y: number }) => old.threads.findIndex((_, i) => inside(oldRect(i), n.x + NODE_W / 2, n.y + OLD_H / 2));
  const free = old.nodes.filter(n => owner(n) < 0);
  const fx = Math.min(...free.map(n => n.x)); const fy = Math.min(...free.map(n => n.y));
  if (free.length) holdco.height = Math.max(holdco.height, Math.max(...free.map(n => n.y + NODE_H)) - fy + 60);
  const infra = tags.find(t => t.name === "Infrastructure")!;
  const draft: Plan = {
    origin: old.origin, units, tags, links: old.links,
    threads: old.threads.map(t => ({ ...t, unitId: capital.id })),
    nodes: old.nodes.map(n => ({ ...n, tags: /infra/i.test(n.title) ? [infra.id] : [] })),
  };
  const l = layout(draft);
  draft.nodes = draft.nodes.map((n, i) => {
    const o = owner(old.nodes[i]);
    if (o >= 0) { const from = oldRect(o); const to = l.threads.get(draft.threads[o].id)!; return { ...n, x: n.x + to.x - from.x, y: n.y + to.y - from.y }; }
    const open = l.units.get(holdco.id)!.open;
    return { ...n, x: n.x - fx + 40, y: n.y - fy + open.y + 30 };
  });
  return draft;
}

/** A starter plan built from the group structure and the examples that motivated the page. */
export function starterPlan(entities: Array<{ id: string; name: string; type: string }>): Plan {
  const origin = currentMonth();
  const { units, tags } = groupStructure();
  const [holdco, capital, studio] = units;
  holdco.height = 320;
  const tagId = (name: string) => tags.find(t => t.name === name)!.id;
  const stefano = entities.find(e => e.type === "person" && /ste(f|ph)an/i.test(e.name));
  const un = entities.find(e => e.type === "organization" && /united nations|^un$/i.test(e.name));
  const prime: Thread = { id: crypto.randomUUID(), unitId: capital.id, name: "Prime Fund", goal: "$20M", start: origin, months: 2, color: pal(3) };
  const alpha: Thread = { id: crypto.randomUUID(), unitId: capital.id, name: "Alpha Fund", goal: "$300M", start: origin, months: 18, color: pal(0) };
  const plan: Plan = { origin, units, tags, threads: [prime, alpha], nodes: [], links: [] };
  const l = layout(plan);
  const at = (r: Rect, dx: number, dy: number) => ({ x: r.x + dx, y: r.y + dy });
  const h = l.units.get(holdco.id)!.open; const s = l.units.get(studio.id)!.open;
  const p = l.threads.get(prime.id)!; const a = l.threads.get(alpha.id)!;
  const node = (pos: { x: number; y: number }, patch: Partial<PlanNode>) => newNode(pos.x, pos.y, patch);
  const n = {
    stefano: node(at(h, MONTH_W + 20, 110), { title: "Talking to Stefano", status: "active", entity: stefano ? { id: stefano.id, name: stefano.name } : null }),
    un: node(at(h, MONTH_W + 300, 110), { title: "United Nations", kind: "milestone", entity: un ? { id: un.id, name: un.name } : null }),
    infra: node(at(h, MONTH_W + 580, 30), { title: "Infra companies", tags: [tagId("Infrastructure")] }),
    core: node(at(h, MONTH_W + 580, 190), { title: "Other core sectors", priority: "secondary", tags: [tagId("Financial"), tagId("Supply chain"), tagId("Healthcare")] }),
    nextCountry: node(at(s, MONTH_W + 20, 70), { title: "Open Studio in the next country", status: "idea" }),
    anchors: node(at(p, 20, 70), { title: "Anchor LPs for Prime", status: "active" }),
    primeClose: node(at(p, 260, 130), { title: "Close Prime · $20M", kind: "milestone" }),
    track: node(at(a, 500, 70), { title: "Use Prime as the base for Alpha" }),
    alphaClose: node(at(a, 18 * MONTH_W - NODE_W - 30, 120), { title: "Close Alpha · $300M", kind: "goal" }),
  };
  const link = (from: PlanNode, to: PlanNode, label = "") => ({ id: crypto.randomUUID(), from: from.id, to: to.id, label });
  return {
    ...plan, nodes: Object.values(n),
    links: [link(n.stefano, n.un), link(n.un, n.infra, "priority"), link(n.un, n.core, "secondary"), link(n.anchors, n.primeClose), link(n.primeClose, n.track, "base for"), link(n.track, n.alphaClose)],
  };
}
