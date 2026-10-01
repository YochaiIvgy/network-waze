import { z } from "zod";
import { PATH_PALETTE } from "./loops";

export const THREAD_PALETTE = PATH_PALETTE;
export const NODE_KINDS = { step: "Step", milestone: "Milestone", decision: "Decision", goal: "Goal" } as const;
export const NODE_STATUSES = { idea: "Idea", planned: "Planned", active: "In progress", done: "Done", blocked: "Blocked" } as const;
export const STATUS_COLORS: Record<NodeStatus, string> = { idea: "#868991", planned: "#3986bd", active: "#c39330", done: "#36866b", blocked: "#d9232b" };
export const PRIORITIES = { primary: "Primary", secondary: "Secondary" } as const;

/** Board geometry, in world units. Threads are lanes on a shared month axis. */
export const MONTH_W = 240;
export const LANE_H = 240;
export const LANE_GAP = 40;
export const NODE_W = 200;
export const NODE_H = 84;

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const coord = z.number().finite().min(-1e6).max(1e6);

export const threadSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  goal: z.string().max(100),
  start: month,
  months: z.number().min(0.5).max(120),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
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
});
export const planLinkSchema = z.object({
  id: z.string().uuid(),
  from: z.string().uuid(),
  to: z.string().uuid(),
  label: z.string().max(100),
});
export const planSchema = z.object({
  origin: month,
  threads: z.array(threadSchema).max(50),
  nodes: z.array(planNodeSchema).max(2000),
  links: z.array(planLinkSchema).max(5000),
}).superRefine((plan, ctx) => {
  const ids = [...plan.threads, ...plan.nodes, ...plan.links].map(x => x.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate IDs in plan." });
  const nodes = new Set(plan.nodes.map(n => n.id));
  if (plan.links.some(l => !nodes.has(l.from) || !nodes.has(l.to) || l.from === l.to)) ctx.addIssue({ code: "custom", message: "A connection points at a missing box." });
});

export type NodeKind = keyof typeof NODE_KINDS;
export type NodeStatus = keyof typeof NODE_STATUSES;
export type Thread = z.infer<typeof threadSchema>;
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
export const monthX = (plan: Plan, m: string) => (monthIndex(m) - monthIndex(plan.origin)) * MONTH_W;
export const xMonth = (plan: Plan, x: number) => fromIndex(monthIndex(plan.origin) + Math.floor(x / MONTH_W));
export function todayX(plan: Plan) {
  const d = new Date(); const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return monthX(plan, currentMonth()) + ((d.getDate() - 1) / days) * MONTH_W;
}

/** Lane rectangles follow thread order (rows) and dates (columns). */
export function threadRect(plan: Plan, index: number): Rect {
  const t = plan.threads[index];
  return { x: monthX(plan, t.start), y: index * (LANE_H + LANE_GAP), w: t.months * MONTH_W, h: LANE_H };
}
export const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/** A box belongs to the lane its centre sits in; membership is never stored. */
export function threadOf(plan: Plan, node: PlanNode): Thread | undefined {
  const cx = node.x + NODE_W / 2; const cy = node.y + NODE_H / 2;
  return plan.threads.find((_, i) => inside(threadRect(plan, i), cx, cy));
}

/** After lanes move (reorder, delete, new start date), carry their boxes along. */
export function carryNodes(prev: Plan, next: Plan): Plan {
  const nextRects = new Map(next.threads.map((t, i) => [t.id, threadRect(next, i)]));
  return { ...next, nodes: next.nodes.map(node => {
    const owner = threadOf(prev, node); if (!owner) return node;
    const from = threadRect(prev, prev.threads.findIndex(t => t.id === owner.id)); const to = nextRects.get(owner.id);
    return to ? { ...node, x: node.x + to.x - from.x, y: node.y + to.y - from.y } : node;
  }) };
}

export function newNode(x: number, y: number, patch: Partial<PlanNode> = {}): PlanNode {
  return { id: crypto.randomUUID(), title: "New step", notes: "", kind: "step", status: "planned", priority: "primary", x, y, entity: null, ...patch };
}

export function boardBounds(plan: Plan): Rect {
  const rects: Rect[] = [...plan.threads.map((_, i) => threadRect(plan, i)), ...plan.nodes.map(n => ({ x: n.x, y: n.y, w: NODE_W, h: NODE_H }))];
  if (!rects.length) return { x: 0, y: -200, w: MONTH_W * 6, h: 600 };
  const x = Math.min(...rects.map(r => r.x)); const y = Math.min(...rects.map(r => r.y));
  return { x, y, w: Math.max(...rects.map(r => r.x + r.w)) - x, h: Math.max(...rects.map(r => r.y + r.h)) - y };
}

/** A starter plan built from the examples that motivated the page, so it opens with something to edit. */
export function starterPlan(entities: Array<{ id: string; name: string; type: string }>): Plan {
  const origin = currentMonth();
  const stefano = entities.find(e => e.type === "person" && /ste(f|ph)an/i.test(e.name));
  const un = entities.find(e => e.type === "organization" && /united nations|^un$/i.test(e.name));
  const prime = { id: crypto.randomUUID(), name: "Prime Fund", goal: "$20M", start: origin, months: 2, color: THREAD_PALETTE[3].color };
  const alpha = { id: crypto.randomUUID(), name: "Alpha Fund", goal: "$300M", start: origin, months: 18, color: THREAD_PALETTE[0].color };
  const alphaY = LANE_H + LANE_GAP;
  const n = {
    stefano: newNode(0, -300, { title: "Talking to Stefano", status: "active", entity: stefano ? { id: stefano.id, name: stefano.name } : null }),
    un: newNode(280, -300, { title: "United Nations", kind: "milestone", entity: un ? { id: un.id, name: un.name } : null }),
    infra: newNode(560, -380, { title: "Infra companies" }),
    core: newNode(560, -220, { title: "Other core sectors", priority: "secondary" }),
    anchors: newNode(20, 60, { title: "Anchor LPs for Prime", status: "active" }),
    primeClose: newNode(260, 140, { title: "Close Prime · $20M", kind: "milestone" }),
    track: newNode(600, alphaY + 60, { title: "Use Prime as the base for Alpha" }),
    alphaClose: newNode(18 * MONTH_W - NODE_W - 30, alphaY + 120, { title: "Close Alpha · $300M", kind: "goal" }),
  };
  const link = (from: PlanNode, to: PlanNode, label = "") => ({ id: crypto.randomUUID(), from: from.id, to: to.id, label });
  return {
    origin, threads: [prime, alpha], nodes: Object.values(n),
    links: [link(n.stefano, n.un), link(n.un, n.infra, "priority"), link(n.un, n.core, "secondary"), link(n.anchors, n.primeClose), link(n.primeClose, n.track, "base for"), link(n.track, n.alphaClose)],
  };
}
