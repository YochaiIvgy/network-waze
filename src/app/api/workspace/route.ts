import { NextResponse } from "next/server";
import { getWorkspace, one, query } from "@/lib/db";
import { invalidateGraphCache } from "@/lib/graph/graph-cache";

export const dynamic = "force-dynamic";

/**
 * Set the workspace's "you" node.
 *
 * The graph is egocentric: every introduction path is computed *from* this
 * entity, and natural-language search silently drops routing without it. It used
 * to be a side effect of seeding demo data, which meant a real workspace never
 * got one. Now it is an explicit choice, made once, from a person the graph
 * already knows about.
 */
export async function POST(request: Request) {
  try {
    const { selfEntityId } = (await request.json()) as { selfEntityId?: string | null };
    const ws = await getWorkspace();

    if (selfEntityId === null) {
      await query(`UPDATE workspaces SET self_entity_id = NULL WHERE id = $1`, [ws.id]);
      invalidateGraphCache(ws.id);
      return NextResponse.json({ ok: true, selfEntityId: null });
    }

    if (typeof selfEntityId !== "string" || !selfEntityId) {
      return NextResponse.json({ error: "Choose an entity to mark as you." }, { status: 400 });
    }

    // Must be a live person in this workspace — never an arbitrary id from the
    // client, and never an organisation, which would make "paths from you"
    // meaningless.
    const entity = await one<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM entities
        WHERE id = $1 AND workspace_id = $2 AND status <> 'merged'`,
      [selfEntityId, ws.id],
    );
    if (!entity) {
      return NextResponse.json({ error: "That entity is not in this workspace." }, { status: 400 });
    }
    if (entity.entity_type !== "person") {
      return NextResponse.json({ error: "The you node has to be a person." }, { status: 400 });
    }

    await query(`UPDATE workspaces SET self_entity_id = $2 WHERE id = $1`, [ws.id, entity.id]);
    invalidateGraphCache(ws.id);
    return NextResponse.json({ ok: true, selfEntityId: entity.id });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
