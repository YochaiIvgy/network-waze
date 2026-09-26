import { z } from "zod";
import { transaction } from "./db";
import { normalizeName, normalizeOrg } from "./resolution/normalize";
import { projectGraphInTransaction } from "./graph/project";
import { invalidateGraphCache } from "./graph/graph-cache";

const profile = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(["person", "organization", "fund"]),
  title: z.string().trim().max(300).default(""),
  org: z.string().trim().max(300).default(""),
  description: z.string().trim().max(5000).default(""),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
});
export const entityMutation = z.discriminatedUnion("action", [
  profile.extend({ action: z.literal("create") }),
  profile.extend({ action: z.literal("update"), id: z.string().uuid() }),
  z.object({ action: z.literal("delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("merge"), id: z.string().uuid(), targetId: z.string().uuid() }),
]);

const uniqueTags = (tags: string[]) => tags.filter((tag, index) => tags.findIndex(other => other.toLocaleLowerCase() === tag.toLocaleLowerCase()) === index);

/** User decisions and the resulting graph commit together. Source evidence stays intact. */
export async function manageEntity(workspaceId: string, input: z.infer<typeof entityMutation>) {
  const result = await transaction(async c => {
    // Serialize edits to the same workspace, including opposing merge requests.
    await c.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId]);
    async function entity(id: string) {
      const { rows } = await c.query<{ id: string; canonical_name: string; entity_type: string; attributes: Record<string, unknown> }>(
        `SELECT id, canonical_name, entity_type, attributes FROM entities WHERE id = $1 AND workspace_id = $2 AND status NOT IN ('merged', 'deleted') FOR UPDATE`, [id, workspaceId]);
      if (!rows[0]) throw new Error("Entity is no longer available in this workspace. Refresh and try again.");
      return rows[0];
    }
    let id: string;
    if (input.action === "create" || input.action === "update") {
      const previous = input.action === "update" ? await entity(input.id) : null;
      if (previous && previous.entity_type === "person" && input.type !== "person") {
        await c.query(`UPDATE workspaces SET self_entity_id = NULL WHERE id = $1 AND self_entity_id = $2`, [workspaceId, previous.id]);
      }
      const manual = { title: input.title, org: input.org, description: input.description, tags: uniqueTags(input.tags) };
      const attrs = { ...previous?.attributes, ...manual, manual_profile: manual };
      const normalized = input.type === "person" ? normalizeName(input.name) : normalizeOrg(input.name);
      if (previous) {
        id = previous.id;
        await c.query(`UPDATE entities SET canonical_name = $2, normalized = $3, entity_type = $4, attributes = $5, updated_at = now() WHERE id = $1`, [id, input.name, normalized, input.type, JSON.stringify(attrs)]);
      } else {
        const { rows } = await c.query<{ id: string }>(`INSERT INTO entities (workspace_id, canonical_name, normalized, entity_type, attributes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [workspaceId, input.name, normalized, input.type, JSON.stringify(attrs)]);
        id = rows[0].id;
      }
      await c.query(`INSERT INTO entity_aliases (entity_id, alias, normalized, kind) VALUES ($1,$2,$3,'name') ON CONFLICT DO NOTHING`, [id, input.name, normalized]);
    } else if (input.action === "delete") {
      const removed = await entity(input.id);
      id = removed.id;
      await c.query(`UPDATE entities SET status = 'deleted', updated_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE workspaces SET self_entity_id = NULL WHERE id = $1 AND self_entity_id = $2`, [workspaceId, id]);
      await c.query(`UPDATE resolution_reviews SET verdict = 'different', decided_by = 'human', decided_at = now() WHERE workspace_id = $1 AND verdict IS NULL AND (candidate_id = $2 OR mention_id IN (SELECT mention_id FROM mention_links WHERE entity_id = $2))`, [workspaceId, id]);
    } else {
      if (input.id === input.targetId) throw new Error("Choose a different entity to merge into.");
      const loser = await entity(input.id);
      const winner = await entity(input.targetId);
      if ((loser.entity_type === "person") !== (winner.entity_type === "person")) throw new Error("People can only merge with people; organizations with organizations.");
      id = winner.id;
      const attrs = { ...loser.attributes, ...winner.attributes };
      for (const key of new Set([...Object.keys(loser.attributes), ...Object.keys(winner.attributes)])) {
        if (Array.isArray(loser.attributes[key]) || Array.isArray(winner.attributes[key])) {
          attrs[key] = [...new Set([...(Array.isArray(loser.attributes[key]) ? loser.attributes[key] as unknown[] : []), ...(Array.isArray(winner.attributes[key]) ? winner.attributes[key] as unknown[] : [])])];
        }
      }
      const manual = { ...(loser.attributes.manual_profile as object ?? {}), ...(winner.attributes.manual_profile as object ?? {}), tags: uniqueTags((attrs.tags ?? []) as string[]) };
      for (const key of Object.keys(manual)) {
        if (key !== "tags" && key in attrs) (manual as Record<string, unknown>)[key] = attrs[key];
      }
      attrs.manual_profile = manual;
      await c.query(`INSERT INTO entity_merges (winner_id, loser_id, score, method, evidence) VALUES ($1,$2,1,'manual',$3)`, [id, loser.id, JSON.stringify({ winner, loser })]);
      await c.query(`UPDATE entities SET attributes = $2, updated_at = now() WHERE id = $1`, [id, JSON.stringify(attrs)]);
      await c.query(`INSERT INTO entity_aliases (entity_id, alias, normalized, kind, confidence) SELECT $1, alias, normalized, kind, confidence FROM entity_aliases WHERE entity_id = $2 ON CONFLICT DO NOTHING`, [id, loser.id]);
      await c.query(`UPDATE mention_links SET entity_id = $1, method = 'manual' WHERE entity_id = $2`, [id, loser.id]);
      await c.query(`UPDATE entities SET status = 'merged', merged_into = $1, updated_at = now() WHERE id = $2`, [id, loser.id]);
      await c.query(`UPDATE entities SET merged_into = $1 WHERE merged_into = $2`, [id, loser.id]);
      await c.query(`UPDATE workspaces SET self_entity_id = $2 WHERE id = $1 AND self_entity_id = $3`, [workspaceId, id, loser.id]);
      await c.query(`UPDATE resolution_reviews SET verdict = 'same', decided_by = 'human', decided_at = now() WHERE workspace_id = $1 AND verdict IS NULL AND candidate_id IN ($2,$3) AND mention_id IN (SELECT mention_id FROM mention_links WHERE entity_id = $2)`, [workspaceId, id, loser.id]);
      await c.query(`UPDATE resolution_reviews SET candidate_id = $1 WHERE candidate_id = $2 AND verdict IS NULL`, [id, loser.id]);
    }
    await projectGraphInTransaction(c, workspaceId);
    return { id };
  });
  invalidateGraphCache(workspaceId);
  return result;
}
