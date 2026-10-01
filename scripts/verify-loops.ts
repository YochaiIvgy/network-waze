import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmbeddedPool, setPool, query, one, closePool } from "../src/lib/db";
import { env } from "../src/lib/env";
import { GET, PUT } from "../src/app/api/loops/route";
import { manageEntity } from "../src/lib/manage-entities";
import { PATH_COLORS, pathDisplayColor, loopsSchema, newLoop, recordLoop, moveItem, captureLoops, completeNext, needsMyMove, planSteps, toggleStep, type LoopPath } from "../src/lib/loops";

async function main() {
  const colorBoard = [{ id: crypto.randomUUID(), name: "Color compatibility", color: "#7c83db", items: [] }];
  for (const color of [...PATH_COLORS, "#7c83db", "#5a9b85", "#d6a04e", "#ce788d", "#589ebc", "#a185bf"]) {
    assert(loopsSchema.safeParse([{ ...colorBoard[0], color }]).success, `Saved color ${color} must load`);
    assert(PATH_COLORS.includes(pathDisplayColor(color)), `Saved color ${color} must have a palette swatch`);
  }
  assert(!loopsSchema.safeParse([{ ...colorBoard[0], color: "not-a-color" }]).success);
  const fixture = process.argv[2] === "--ui-fixture" ? process.argv[3] : undefined;
  if (process.argv[2] === "--ui-fixture" && !fixture) throw new Error("Provide a temporary fixture directory.");
  setPool(await createEmbeddedPool(fixture ?? "memory://"));
  try {
    await query(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const ws = await one<{ id: string }>(`INSERT INTO workspaces (slug, name, settings) VALUES ($1, 'Loops verification', '{"unrelated":true}') RETURNING id`, [env.workspaceSlug]);
    const person = await manageEntity(ws!.id, { action: "create", name: "Roy Test", type: "person", title: "", org: "", description: "", tags: [] });
    const people = [{ id: person.id, name: "Roy Test" }];
    let item = recordLoop({ ...newLoop(), title: "Fund minimum", people }, undefined, "", people);
    item = recordLoop({ ...item, state: "waiting", ownerId: person.id, next: "Confirm implications" }, item, "Asked Roy about the minimum", people);
    const waitingHistory = structuredClone(item.history);
    item = recordLoop({ ...item, state: "decision", ownerId: "me" }, item, "Roy replied", people);
    item = recordLoop({ ...item, state: "action", next: "Confirm first close" }, item, "Reviewed the answer", people);
    item = recordLoop({ ...item, resolved: true, next: "" }, item, "Confirmed first close", people);
    assert.deepEqual(item.history.slice(0, waitingHistory.length), waitingHistory, "earlier handoffs must remain unchanged");
    assert.equal(item.history.filter(h => h.event === "move").length, 4);
    assert.equal(item.history.at(-1)?.event, "resolved");
    item = recordLoop({ ...item, resolved: false }, item, "", people);
    assert.equal(item.history.at(-1)?.event, "reopened");
    const another = recordLoop({ ...newLoop(), title: "Mental tab", state: "note" }, undefined, "Initial research", []);
    assert.equal(another.history.at(-1)?.event, "move", "initial move must be visible as last move");
    const paths: LoopPath[] = [
      { id: crypto.randomUUID(), name: "Inbox", color: "#7c83db", items: [item, another] },
      { id: crypto.randomUUID(), name: "Fund", color: "#5a9b85", items: [] },
    ];
    const moved = moveItem(paths, item.id, paths[1].id);
    assert.equal(moved[0].items.length, 1); assert.deepEqual(moved[1].items[0], item);
    const reordered = moveItem(paths, another.id, paths[0].id, item.id);
    assert.equal(reordered[0].items[0].id, another.id);
    assert.deepEqual(moveItem(paths, item.id, "missing"), paths);
    assert.equal(loopsSchema.safeParse([{ ...paths[0], items: [item, item] }]).success, false);
    assert.equal(loopsSchema.safeParse([{ ...paths[0], items: [{ ...item, ownerId: crypto.randomUUID() }] }]).success, false);
    const put = (revision: number, board: unknown) => PUT(new Request("http://localhost/api/loops", { method: "PUT", body: JSON.stringify({ revision, paths: board }), headers: { "Content-Type": "application/json" } }));
    assert.deepEqual(await (await GET()).json(), { revision: 0, paths: null, workspaceId: ws!.id });
    assert.equal((await put(0, moved)).status, 200);
    assert.deepEqual((await (await GET()).json()).paths, moved);
    assert.equal((await put(0, paths)).status, 409, "stale tab must not overwrite saved board");
    assert.equal((await put(1, [])).status, 400);
    assert.equal((await PUT(new Request("http://localhost/api/loops", { method: "PUT", body: "{" }))).status, 400);
    assert.equal((await put(1, reordered)).status, 200);
    assert.equal((await one<{ preserved: boolean }>(`SELECT (settings->>'unrelated')::boolean AS preserved FROM workspaces WHERE id = $1`, [ws!.id]))?.preserved, true);
    await manageEntity(ws!.id, { action: "update", id: person.id, name: "Roy Updated", type: "person", title: "Partner", org: "", description: "", tags: [] });
    assert.equal((await (await GET()).json()).paths[0].items[1].people[0].id, person.id, "person links survive directory edits");
    const captured = captureLoops("Call Roy\n\nDecide on the venue\r\nRemember the timeline");
    assert.equal(captured.length, 3); assert.equal(new Set(captured.map(i => i.id)).size, 3);
    const step = { ...captured[0], next: "Send the question" };
    const checked = completeNext(step, []);
    assert.equal(checked.id, step.id, "a checked step belongs to the same loop");
    assert.equal(checked.resolved, false, "checking a step must not resolve the loop");
    assert.equal(checked.next, ""); assert.equal(checked.history.at(-1)?.text, "Send the question");
    assert.deepEqual(completeNext(checked, []), checked, "empty steps cannot create duplicate moves");
    const edited = recordLoop({ ...checked, title: "Call Roy tomorrow", context: "A note", next: "Review the answer" }, checked, "", []);
    assert.deepEqual(edited.history, checked.history, "typing must not fill the trail with metadata updates");
    const passed = recordLoop({ ...edited, people, ownerId: person.id, state: "waiting" }, edited, "", people);
    assert.equal(passed.history.at(-1)?.event, "updated");
    assert.equal(needsMyMove(edited, "2026-09-28"), true);
    assert.equal(needsMyMove(passed, "2026-09-28"), false);
    assert.equal(needsMyMove({ ...passed, review: "2026-09-27" }, "2026-09-28"), true);
    assert.equal(needsMyMove({ ...edited, resolved: true }, "2026-09-28"), false);
    assert.deepEqual(captureLoops("   \n"), []);
    const planned = planSteps(captured[1], "Choose a venue\nAsk for a quote\nConfirm the booking");
    const checkedPlan = toggleStep(planned, planned.steps[1].id, true);
    assert.deepEqual(checkedPlan.steps.map(s => s.id), planned.steps.map(s => s.id), "checked steps stay in their original order");
    assert.equal(checkedPlan.steps[1].done, true);
    assert.ok(checkedPlan.steps[1].completedAt);
    assert.equal(toggleStep(checkedPlan, planned.steps[1].id, false).steps[1].done, false);
    const nextPlanned = completeNext(planned, []);
    assert.equal(nextPlanned.id, planned.id); assert.equal(nextPlanned.resolved, false);
    assert.equal(nextPlanned.steps[0].done, true); assert.equal(nextPlanned.steps.length, 3);
    const persistedPlan = [{ ...paths[0], items: [checkedPlan] }, paths[1]];
    assert.equal((await put(2, persistedPlan)).status, 200);
    assert.deepEqual((await (await GET()).json()).paths[0].items[0].steps, checkedPlan.steps);
    console.log("PASS: handoffs, move history, checkable steps staying in one loop, bulk capture, inline edits, focus filters, persistence, validation and conflicting saves.");
  } finally { await closePool(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
