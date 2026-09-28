import { z } from "zod";

export const PATH_COLORS = ["#7c83db", "#5a9b85", "#d6a04e", "#ce788d", "#589ebc", "#a185bf"];
export const LOOP_STATES = { action: "Action", waiting: "Waiting", decision: "Decision", note: "Mental tab" } as const;
const stateSchema = z.enum(["action", "waiting", "decision", "note"]);
const personSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(200) });
const moveSchema = z.object({
  id: z.string().uuid(), at: z.string().datetime(),
  event: z.enum(["created", "move", "updated", "resolved", "reopened"]),
  text: z.string().max(4000), state: stateSchema,
  owner: z.string().max(200), next: z.string().max(2000),
});
export const loopItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  context: z.string().max(4000), state: stateSchema,
  resolved: z.boolean(),
  people: z.array(personSchema).max(50),
  ownerId: z.union([z.literal("me"), z.literal(""), z.string().uuid()]),
  next: z.string().max(2000),
  review: z.union([z.literal(""), z.string().date()]),
  history: z.array(moveSchema).max(5000),
  steps: z.array(z.object({
    id: z.string().uuid(), text: z.string().trim().min(1).max(2000),
    done: z.boolean(), completedAt: z.string().datetime().nullable(),
  })).max(2000).default([]),
}).refine(item => !item.ownerId || item.ownerId === "me" || item.people.some(p => p.id === item.ownerId), { message: "The next owner must be attached to this loop." });
export const loopPathSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(100),
  color: z.enum(PATH_COLORS as [string, ...string[]]),
  items: z.array(loopItemSchema).max(2000),
});
export const loopsSchema = z.array(loopPathSchema).min(1).max(100).superRefine((paths, ctx) => {
  const ids = paths.flatMap(p => [p.id, ...p.items.map(i => i.id)]);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Duplicate IDs in board." });
});
export type LoopItem = z.infer<typeof loopItemSchema>;
export type LoopPath = z.infer<typeof loopPathSchema>;
export type LoopPerson = z.infer<typeof personSchema>;
export type LoopState = keyof typeof LOOP_STATES;

export function newLoop(): LoopItem {
  return { id: crypto.randomUUID(), title: "", context: "", state: "action", resolved: false,
    people: [], ownerId: "me", next: "", review: "", history: [], steps: [] };
}

export function ownerName(item: LoopItem, people: LoopPerson[] = item.people): string {
  return item.ownerId === "me" ? "Me" : people.find(p => p.id === item.ownerId)?.name ?? item.people.find(p => p.id === item.ownerId)?.name ?? "Unassigned";
}

/** Keep completed moves immutable while the current state and next move evolve. */
export function recordLoop(item: LoopItem, prior: LoopItem | undefined, move: string, people: LoopPerson[]): LoopItem {
  const history = [...(prior?.history ?? [])];
  const append = (event: LoopItem["history"][number]["event"], text: string) => history.push({
    id: crypto.randomUUID(), at: new Date().toISOString(), event, text,
    state: item.state, owner: ownerName(item, people), next: item.next,
  });
  if (!prior) append("created", "Opened loop");
  if (move.trim()) append("move", move.trim());
  if (prior && prior.resolved !== item.resolved) append(item.resolved ? "resolved" : "reopened", item.resolved ? "Resolved loop" : "Reopened loop");
  else if (prior && !move.trim() && (prior.state !== item.state || prior.ownerId !== item.ownerId)) {
    append("updated", `${LOOP_STATES[item.state]} · ${ownerName(item, people)} has the next move`);
  }
  return { ...item, title: item.title.trim(), history };
}

export function completeNext(item: LoopItem, people: LoopPerson[]): LoopItem {
  if (item.resolved) return item;
  if (!item.next.trim()) {
    const next = (item.steps ?? []).find(step => !step.done);
    return next ? toggleStep(item, next.id, true) : item;
  }
  return recordLoop({ ...item, next: "", ownerId: "me", state: "action" }, item, item.next, people);
}

export function planSteps(item: LoopItem, text: string): LoopItem {
  const steps = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(text => ({
    id: crypto.randomUUID(), text, done: false, completedAt: null,
  }));
  return { ...item, steps: [...(item.steps ?? []), ...steps] };
}

export function toggleStep(item: LoopItem, id: string, done: boolean): LoopItem {
  return { ...item, steps: (item.steps ?? []).map(step => step.id === id ? {
    ...step, done, completedAt: done ? (step.completedAt ?? new Date().toISOString()) : null,
  } : step) };
}

export function captureLoops(text: string): LoopItem[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const item = { ...newLoop(), title: line.slice(0, 200), context: line.slice(200) };
    return recordLoop(item, undefined, "", []);
  });
}

export function needsMyMove(item: LoopItem, today: string): boolean {
  return !item.resolved && (item.ownerId === "me" || (!!item.review && item.review <= today));
}

export function moveItem(paths: LoopPath[], itemId: string, destination: string, before?: string): LoopPath[] {
  const item = paths.flatMap(p => p.items).find(i => i.id === itemId);
  if (!item || itemId === before || !paths.some(p => p.id === destination)) return paths;
  return paths.map(p => {
    const items = p.items.filter(i => i.id !== itemId);
    if (p.id === destination) {
      const index = before ? items.findIndex(i => i.id === before) : -1;
      items.splice(index < 0 ? items.length : index, 0, item);
    }
    return { ...p, items };
  });
}
