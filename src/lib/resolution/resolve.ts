import { transaction, type ClientLike } from "../db";
import { embed } from "../embeddings";
import { blockingKeys, nameParts, normalizeName, normalizeOrg } from "./normalize";
import {
  scoreCandidate,
  verdictFor,
  type EntityCandidate,
  type ResolutionCandidateInput,
  type ScoreBreakdown,
} from "./score";

export interface ResolutionSummary {
  created: number;
  matched: number;
  queued: number;
  deferred: number;
}

interface MentionRow {
  id: string;
  source_id: string;
  local_ref: string;
  entity_type: string;
  surface_form: string;
  normalized: string;
  is_first_name_only: boolean;
  role_in_source: string | null;
  disambiguation_context: string | null;
  attributes: Record<string, unknown>;
  confidence: number;
}

/**
 * Resolve every mention in one extraction run to a canonical entity.
 *
 * Order matters: organisations resolve first, so that a person's employer is
 * already a known entity id by the time that person is scored. Employer is one of
 * the strongest disambiguating features available.
 */
export async function resolveRun(workspaceId: string, runId: string): Promise<ResolutionSummary> {
  return transaction(async (c) => {
    const { rows: mentions } = await c.query<MentionRow>(
      `SELECT id, source_id, local_ref, entity_type, surface_form, normalized,
              is_first_name_only, role_in_source, disambiguation_context, attributes, confidence
       FROM mentions WHERE run_id = $1`,
      [runId],
    );
    if (mentions.length === 0) return { created: 0, matched: 0, queued: 0, deferred: 0 };

    const contexts = mentions.map((m) => resolutionText(m));
    const embeddings = await embed(contexts);

    const summary: ResolutionSummary = { created: 0, matched: 0, queued: 0, deferred: 0 };
    // Entities resolved so far *within this run* — both the local scope for
    // first-name resolution and the co-mention neighbour signal.
    const localScope = new Map<string, { entityId: string; mention: MentionRow }>();

    const ordered = [...mentions].sort((a, b) => typeRank(a.entity_type) - typeRank(b.entity_type));

    for (const mention of ordered) {
      const idx = mentions.indexOf(mention);
      const embedding = embeddings[idx];
      const outcome = await resolveMention(c, {
        workspaceId,
        mention,
        embedding,
        localScope,
        allMentionsInRun: mentions,
      });

      if (outcome.entityId) localScope.set(mention.local_ref, { entityId: outcome.entityId, mention });
      summary.created += outcome.action === "created" ? 1 : 0;
      summary.matched += outcome.action === "matched" ? 1 : 0;
      summary.queued += outcome.queuedReview ? 1 : 0;
      summary.deferred += outcome.action === "deferred" ? 1 : 0;
    }

    return summary;
  });
}

function typeRank(t: string): number {
  return t === "organization" || t === "fund" ? 0 : t === "person" ? 1 : 2;
}

/** What the resolver compares. Name alone is never enough. */
function resolutionText(m: MentionRow): string {
  const a = m.attributes as Record<string, unknown>;
  return [
    m.surface_form,
    a.title,
    a.org,
    a.location,
    Array.isArray(a.expertise) ? (a.expertise as string[]).join(", ") : null,
    Array.isArray(a.sector) ? (a.sector as string[]).join(", ") : null,
    m.disambiguation_context,
  ]
    .filter(Boolean)
    .join(" | ");
}

interface ResolveArgs {
  workspaceId: string;
  mention: MentionRow;
  embedding: number[];
  localScope: Map<string, { entityId: string; mention: MentionRow }>;
  allMentionsInRun: MentionRow[];
}

interface ResolveOutcome {
  entityId: string | null;
  action: "created" | "matched" | "deferred";
  queuedReview: boolean;
}

async function resolveMention(c: ClientLike, args: ResolveArgs): Promise<ResolveOutcome> {
  const { workspaceId, mention, embedding, localScope } = args;
  const attrs = mention.attributes as Record<string, unknown>;
  const email = (attrs.email as string | null) ?? null;
  const org = (attrs.org as string | null) ?? null;

  // 1. Local scope first. "Sarah" in a meeting where "Sarah Chen" is an attendee
  //    is Sarah Chen — and this is resolvable with certainty that no global
  //    lookup can match.
  if (mention.entity_type === "person" && mention.is_first_name_only) {
    const local = matchWithinSource(mention, args.allMentionsInRun, localScope);
    if (local) {
      await linkMention(c, mention.id, local, "exact", 0.95, { via: "local_scope" });
      await absorbMention(c, local, mention);
      return { entityId: local, action: "matched", queuedReview: false };
    }
  }

  // 2. Blocking: pull only entities sharing a key with this mention.
  const keys = blockingKeys(mention.surface_form, { email, org });
  const candidates = await fetchCandidates(
    c,
    workspaceId,
    mention.entity_type,
    keys,
    mention.source_id,
    mention.id,
  );

  const neighborEntityIds = [...localScope.values()].map((v) => v.entityId);
  const input: ResolutionCandidateInput = {
    name: mention.surface_form,
    isFirstNameOnly: mention.is_first_name_only,
    isPerson: mention.entity_type === "person",
    email,
    org,
    title: (attrs.title as string | null) ?? null,
    seniority: (attrs.seniority as string | null) ?? null,
    context: resolutionText(mention),
    embedding,
    neighborEntityIds,
  };

  let best: { candidate: EntityCandidate; score: ScoreBreakdown } | null = null;
  for (const candidate of candidates) {
    const score = scoreCandidate(input, candidate);
    if (!best || score.total > best.score.total) best = { candidate, score };
  }

  const verdict = best ? verdictFor(best.score.total, best.score.blocked) : "reject";

  if (best && verdict === "merge") {
    await linkMention(c, mention.id, best.candidate.id, "blocked_score", best.score.total, best.score.features);
    await absorbMention(c, best.candidate.id, mention);
    return { entityId: best.candidate.id, action: "matched", queuedReview: false };
  }

  // 3. A first-name-only mention must not become a global node on its own —
  //    that is how four different Michaels become one. It stays in the ledger,
  //    unlinked, until a later meeting corroborates it. The exception is a
  //    mention carrying real distinguishing detail, which becomes a node flagged
  //    for review rather than silently disappearing.
  if (mention.entity_type === "person" && mention.is_first_name_only) {
    const hasDistinguishingDetail = Boolean(org || attrs.title);
    if (!hasDistinguishingDetail) {
      if (best && verdict === "review") {
        await queueReview(c, workspaceId, mention.id, best.candidate.id, best.score);
        return { entityId: null, action: "deferred", queuedReview: true };
      }
      return { entityId: null, action: "deferred", queuedReview: false };
    }
    const entityId = await createEntity(c, workspaceId, mention, embedding, "needs_review");
    await linkMention(c, mention.id, entityId, "new_entity", 0.5, { first_name_only: true });
    if (best && verdict === "review") await queueReview(c, workspaceId, mention.id, best.candidate.id, best.score);
    return { entityId, action: "created", queuedReview: Boolean(best && verdict === "review") };
  }

  // 4. Ambiguous band: create the node so the graph stays complete, and park the
  //    pair for adjudication instead of guessing.
  const entityId = await createEntity(
    c,
    workspaceId,
    mention,
    embedding,
    best && verdict === "review" ? "needs_review" : "active",
  );
  await linkMention(c, mention.id, entityId, "new_entity", best?.score.total ?? 1, best?.score.features ?? {});
  if (best && verdict === "review") {
    await queueReview(c, workspaceId, mention.id, best.candidate.id, best.score);
    return { entityId, action: "created", queuedReview: true };
  }
  return { entityId, action: "created", queuedReview: false };
}

function matchWithinSource(
  mention: MentionRow,
  all: MentionRow[],
  localScope: Map<string, { entityId: string; mention: MentionRow }>,
): string | null {
  const first = nameParts(mention.surface_form).first;
  if (!first) return null;

  const matches = all.filter((m) => {
    if (m.id === mention.id || m.entity_type !== "person" || m.is_first_name_only) return false;
    return nameParts(m.surface_form).first === first;
  });
  // Two people named Sarah in the same meeting: ambiguous, so resolve neither.
  if (matches.length !== 1) return null;
  return localScope.get(matches[0].local_ref)?.entityId ?? null;
}

async function fetchCandidates(
  c: ClientLike,
  workspaceId: string,
  entityType: string,
  keys: string[],
  sourceId: string,
  mentionId: string,
): Promise<EntityCandidate[]> {
  if (keys.length === 0) return [];
  const types = entityType === "fund" || entityType === "organization"
    ? ["organization", "fund"]
    : [entityType];

  const { rows } = await c.query<{
    id: string;
    canonical_name: string;
    attributes: Record<string, unknown>;
    dossier: string | null;
    embedding: number[] | null;
    aliases: string[] | null;
  }>(
    `SELECT e.id, e.canonical_name, e.attributes, e.dossier, e.embedding,
            array_agg(DISTINCT a2.alias) FILTER (WHERE a2.alias IS NOT NULL) AS aliases
     FROM entity_aliases a
     JOIN entities e ON e.id = a.entity_id
     LEFT JOIN entity_aliases a2 ON a2.entity_id = e.id AND a2.kind = 'name'
     WHERE e.workspace_id = $1
       AND e.status <> 'merged'
       AND e.entity_type = ANY($2)
       AND a.kind = 'block_key'
       AND a.normalized = ANY($3)
     GROUP BY e.id
     LIMIT 40`,
    [workspaceId, types, keys],
  );

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const neighbors = await neighborMap(c, ids);
  // Two distinct mentions in one meeting are two distinct people unless the
  // extractor merged them into a single ref. This is a hard block, not a
  // penalty, and it is the reason the same name said twice in one room does not
  // collapse.
  const sameSource = await sameSourceEntities(c, ids, sourceId, mentionId);

  return rows.map((r) => {
    const at = r.attributes ?? {};
    return {
    id: r.id,
    canonical_name: r.canonical_name,
    aliases: (r.aliases ?? []).filter(Boolean),
    email: (at.email as string | null) ?? null,
    org: (at.org as string | null) ?? null,
    title: (at.title as string | null) ?? null,
    seniority: (at.seniority as string | null) ?? null,
    dossier: r.dossier,
    embedding: r.embedding,
    neighborEntityIds: neighbors.get(r.id) ?? [],
    presentInSameSource: sameSource.has(r.id),
    };
  });
}

async function sameSourceEntities(
  c: ClientLike,
  ids: string[],
  sourceId: string,
  mentionId: string,
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { rows } = await c.query<{ entity_id: string }>(
    `SELECT DISTINCT ml.entity_id
     FROM mention_links ml
     JOIN mentions m ON m.id = ml.mention_id
     WHERE ml.entity_id = ANY($1) AND m.source_id = $2 AND m.id <> $3`,
    [ids, sourceId, mentionId],
  );
  return new Set(rows.map((r) => r.entity_id));
}

async function neighborMap(c: ClientLike, ids: string[]): Promise<Map<string, string[]>> {
  const { rows } = await c.query<{ id: string; neighbor: string }>(
    `SELECT src_entity_id AS id, dst_entity_id AS neighbor FROM edges WHERE src_entity_id = ANY($1)
     UNION ALL
     SELECT dst_entity_id AS id, src_entity_id AS neighbor FROM edges WHERE dst_entity_id = ANY($1)`,
    [ids],
  );
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.id) ?? [];
    list.push(r.neighbor);
    map.set(r.id, list);
  }
  return map;
}

async function createEntity(
  c: ClientLike,
  workspaceId: string,
  mention: MentionRow,
  embedding: number[],
  status: string,
): Promise<string> {
  const attrs = mention.attributes as Record<string, unknown>;
  const normalized =
    mention.entity_type === "person" ? normalizeName(mention.surface_form) : normalizeOrg(mention.surface_form);

  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO entities (workspace_id, entity_type, canonical_name, normalized, attributes,
                           dossier, embedding, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      workspaceId,
      mention.entity_type,
      mention.surface_form,
      normalized,
      JSON.stringify(stripNulls(attrs)),
      mention.disambiguation_context,
      embedding,
      status,
    ],
  );
  const entityId = rows[0].id;

  await writeAliases(c, entityId, mention);
  return entityId;
}

/** Aliases double as blocking keys, which is what makes candidate lookup O(1). */
async function writeAliases(c: ClientLike, entityId: string, mention: MentionRow) {
  const attrs = mention.attributes as Record<string, unknown>;
  const email = (attrs.email as string | null) ?? null;
  const org = (attrs.org as string | null) ?? null;
  const aliasList = Array.isArray(attrs.aliases) ? (attrs.aliases as string[]) : [];

  const rows: Array<[string, string, string]> = [];
  for (const name of [mention.surface_form, ...aliasList]) {
    if (!name?.trim()) continue;
    const norm = mention.entity_type === "person" ? normalizeName(name) : normalizeOrg(name);
    if (norm) rows.push([name, norm, "name"]);
  }
  if (email) rows.push([email, email.toLowerCase(), "email"]);
  for (const key of blockingKeys(mention.surface_form, { email, org })) {
    rows.push([key, key, "block_key"]);
  }
  // Aliases are blocking keys too, so a later "Sarah Chen" finds an entity first
  // seen as "S. Chen".
  for (const alias of aliasList) {
    for (const key of blockingKeys(alias, { email, org })) rows.push([key, key, "block_key"]);
  }

  for (const [alias, normalized, kind] of rows) {
    await c.query(
      `INSERT INTO entity_aliases (entity_id, alias, normalized, kind)
       VALUES ($1,$2,$3,$4) ON CONFLICT (entity_id, normalized, kind) DO NOTHING`,
      [entityId, alias, normalized, kind],
    );
  }
}

async function linkMention(
  c: ClientLike,
  mentionId: string,
  entityId: string,
  method: string,
  score: number,
  features: Record<string, unknown>,
) {
  await c.query(
    `INSERT INTO mention_links (mention_id, entity_id, method, score, features)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (mention_id) DO UPDATE SET entity_id = EXCLUDED.entity_id,
       method = EXCLUDED.method, score = EXCLUDED.score, features = EXCLUDED.features`,
    [mentionId, entityId, method, score, JSON.stringify(features)],
  );
}

/**
 * Fold a newly-linked mention's attributes into its entity. Deliberately
 * additive: a later meeting adding a title should not erase a known email.
 * The authoritative attribute rebuild happens in projection.
 */
async function absorbMention(c: ClientLike, entityId: string, mention: MentionRow) {
  const attrs = stripNulls(mention.attributes as Record<string, unknown>);
  await c.query(
    `UPDATE entities
     SET attributes = attributes || $2::jsonb,
         canonical_name = CASE WHEN length($3) > length(canonical_name) THEN $3 ELSE canonical_name END,
         updated_at = now()
     WHERE id = $1`,
    [entityId, JSON.stringify(attrs), mention.surface_form],
  );
  await writeAliases(c, entityId, mention);
}

async function queueReview(
  c: ClientLike,
  workspaceId: string,
  mentionId: string,
  candidateId: string,
  score: ScoreBreakdown,
) {
  await c.query(
    `INSERT INTO resolution_reviews (workspace_id, mention_id, candidate_id, score, features)
     VALUES ($1,$2,$3,$4,$5)`,
    [workspaceId, mentionId, candidateId, score.total, JSON.stringify(score.features)],
  );
}

function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/** Applies a review verdict. Merges are recorded so they can be undone. */
export async function applyReviewVerdict(
  reviewId: string,
  verdict: "same" | "different",
  decidedBy: "llm" | "human",
  rationale?: string,
): Promise<void> {
  await transaction(async (c) => {
    const { rows } = await c.query<{
      mention_id: string;
      candidate_id: string;
      score: number;
      entity_id: string | null;
    }>(
      `SELECT r.mention_id, r.candidate_id, r.score, ml.entity_id
       FROM resolution_reviews r
       LEFT JOIN mention_links ml ON ml.mention_id = r.mention_id
       WHERE r.id = $1`,
      [reviewId],
    );
    if (rows.length === 0) return;
    const review = rows[0];

    await c.query(
      `UPDATE resolution_reviews SET verdict = $2, decided_by = $3, rationale = $4, decided_at = now()
       WHERE id = $1`,
      [reviewId, verdict, decidedBy, rationale ?? null],
    );

    if (verdict !== "same") {
      if (review.entity_id) {
        await c.query(`UPDATE entities SET status = 'active' WHERE id = $1 AND status = 'needs_review'`, [
          review.entity_id,
        ]);
      }
      return;
    }

    await c.query(
      `UPDATE mention_links SET entity_id = $2, method = 'llm_adjudicated' WHERE mention_id = $1`,
      [review.mention_id, review.candidate_id],
    );

    // If the mention had spawned its own node, retire it into the winner.
    if (review.entity_id && review.entity_id !== review.candidate_id) {
      await c.query(
        `INSERT INTO entity_merges (winner_id, loser_id, score, method, evidence)
         VALUES ($1,$2,$3,'llm_adjudicated',$4)`,
        [review.candidate_id, review.entity_id, review.score, JSON.stringify({ reviewId, rationale })],
      );
      await c.query(
        `UPDATE mention_links SET entity_id = $1 WHERE entity_id = $2`,
        [review.candidate_id, review.entity_id],
      );
      await c.query(
        `INSERT INTO entity_aliases (entity_id, alias, normalized, kind)
         SELECT $1, alias, normalized, kind FROM entity_aliases WHERE entity_id = $2
         ON CONFLICT (entity_id, normalized, kind) DO NOTHING`,
        [review.candidate_id, review.entity_id],
      );
      await c.query(
        `UPDATE entities SET status = 'merged', merged_into = $1 WHERE id = $2`,
        [review.candidate_id, review.entity_id],
      );
    }
  });
}
