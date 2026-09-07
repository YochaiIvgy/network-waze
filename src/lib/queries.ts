import { getWorkspace, one, query } from "./db";
import { loadGraph } from "./graph/graph-cache";
import { pathsToMany, rankConnectors } from "./graph/paths";
import { serializePath } from "./search/answer";
import type { EntityAttributes, OutreachHook, RelationshipType } from "./types";
import { RELATIONSHIP_META } from "./types";

/** Read-side helpers for the server components. Nothing here mutates. */

export interface Overview {
  ready: boolean;
  workspaceId: string;
  selfEntityId: string | null;
  stats: {
    people: number;
    organizations: number;
    meetings: number;
    edges: number;
    claims: number;
    reviews: number;
    deferred: number;
    reachable: number;
  };
  connectors: Array<{ id: string; name: string; unlocks: number; score: number; targets: string[] }>;
  recentMeetings: Array<{ id: string; title: string; occurred_at: string | null; people: number }>;
  liveHooks: Array<{ entityId: string; entityName: string; hook: OutreachHook }>;
  strongestEdges: Array<{
    id: string;
    a: string;
    b: string;
    aId: string;
    bId: string;
    type: RelationshipType;
    typeLabel: string;
    strength: number;
    context: string | null;
  }>;
}

export async function getOverview(): Promise<Overview> {
  const ws = await getWorkspace();

  const stats = await one<{
    people: string; organizations: string; meetings: string; edges: string;
    claims: string; reviews: string; deferred: string;
  }>(
    `SELECT
      (SELECT count(*) FROM entities WHERE workspace_id = $1 AND entity_type = 'person' AND status <> 'merged')::text AS people,
      (SELECT count(*) FROM entities WHERE workspace_id = $1 AND entity_type IN ('organization','fund') AND status <> 'merged')::text AS organizations,
      (SELECT count(*) FROM sources WHERE workspace_id = $1)::text AS meetings,
      (SELECT count(*) FROM edges WHERE workspace_id = $1)::text AS edges,
      (SELECT count(*) FROM claims c JOIN sources s ON s.id = c.source_id WHERE s.workspace_id = $1)::text AS claims,
      (SELECT count(*) FROM resolution_reviews WHERE workspace_id = $1 AND verdict IS NULL)::text AS reviews,
      (SELECT count(*) FROM mentions m
         JOIN sources s ON s.id = m.source_id
         LEFT JOIN mention_links ml ON ml.mention_id = m.id
        WHERE s.workspace_id = $1 AND ml.mention_id IS NULL)::text AS deferred`,
    [ws.id],
  );

  const recentMeetings = await query<{ id: string; title: string; occurred_at: string | null; people: string }>(
    `SELECT s.id, s.title, s.occurred_at,
            (SELECT count(DISTINCT ml.entity_id) FROM mentions m
               JOIN mention_links ml ON ml.mention_id = m.id
              WHERE m.source_id = s.id)::text AS people
     FROM sources s WHERE s.workspace_id = $1
     ORDER BY COALESCE(s.occurred_at, s.ingested_at) DESC LIMIT 6`,
    [ws.id],
  );

  const strongestEdges = await query<{
    id: string; a: string; b: string; a_id: string; b_id: string;
    relationship_type: RelationshipType; strength: number; context_card: string | null;
  }>(
    `SELECT e.id, ea.canonical_name AS a, eb.canonical_name AS b,
            ea.id AS a_id, eb.id AS b_id, e.relationship_type, e.strength, e.context_card
     FROM edges e
     JOIN entities ea ON ea.id = e.src_entity_id
     JOIN entities eb ON eb.id = e.dst_entity_id
     WHERE e.workspace_id = $1 AND e.relationship_type NOT IN ('mentioned','met_with','works_at')
     ORDER BY e.strength DESC LIMIT 6`,
    [ws.id],
  );

  const hookRows = await query<{ id: string; canonical_name: string; attributes: EntityAttributes }>(
    `SELECT id, canonical_name, attributes FROM entities
     WHERE workspace_id = $1 AND status <> 'merged' AND attributes ? 'hooks'
     ORDER BY last_seen DESC NULLS LAST LIMIT 40`,
    [ws.id],
  );
  const liveHooks: Overview["liveHooks"] = [];
  for (const row of hookRows) {
    for (const hook of (row.attributes?.hooks ?? []).slice(0, 2)) {
      // "timing" and "ask" hooks decay fastest, so they lead.
      if (hook.kind === "timing" || hook.kind === "ask" || hook.kind === "offer") {
        liveHooks.push({ entityId: row.id, entityName: row.canonical_name, hook });
      }
    }
  }
  liveHooks.sort((a, b) => String(b.hook.observed_at ?? "").localeCompare(String(a.hook.observed_at ?? "")));

  let connectors: Overview["connectors"] = [];
  let reachable = 0;
  if (ws.self_entity_id) {
    const graph = await loadGraph(ws.id);
    const targets = [...graph.nodes.keys()].filter((id) => id !== ws.self_entity_id);
    const paths = pathsToMany(graph, ws.self_entity_id, targets, { maxHops: 3 });
    reachable = paths.length;
    connectors = rankConnectors(paths).slice(0, 5);
  }

  return {
    ready: true,
    workspaceId: ws.id,
    selfEntityId: ws.self_entity_id,
    stats: {
      people: Number(stats?.people ?? 0),
      organizations: Number(stats?.organizations ?? 0),
      meetings: Number(stats?.meetings ?? 0),
      edges: Number(stats?.edges ?? 0),
      claims: Number(stats?.claims ?? 0),
      reviews: Number(stats?.reviews ?? 0),
      deferred: Number(stats?.deferred ?? 0),
      reachable,
    },
    connectors,
    recentMeetings: recentMeetings.map((m) => ({ ...m, people: Number(m.people) })),
    liveHooks: liveHooks.slice(0, 6),
    strongestEdges: strongestEdges.map((e) => ({
      id: e.id,
      a: e.a,
      b: e.b,
      aId: e.a_id,
      bId: e.b_id,
      type: e.relationship_type,
      typeLabel: RELATIONSHIP_META[e.relationship_type]?.label ?? e.relationship_type,
      strength: e.strength,
      context: e.context_card,
    })),
  };
}

export interface EntityListRow {
  id: string;
  canonical_name: string;
  entity_type: string;
  attributes: EntityAttributes;
  mention_count: number;
  source_count: number;
  last_seen: string | null;
  status: string;
  degree: number;
  brokerage: number;
}

export async function listEntities(): Promise<EntityListRow[]> {
  const ws = await getWorkspace();
  const rows = await query<EntityListRow & { degree: number | null; brokerage: number | null }>(
    `SELECT e.id, e.canonical_name, e.entity_type, e.attributes, e.mention_count, e.source_count,
            e.last_seen, e.status, m.degree, m.brokerage
     FROM entities e
     LEFT JOIN entity_metrics m ON m.entity_id = e.id
     WHERE e.workspace_id = $1 AND e.status <> 'merged'
     ORDER BY m.weighted_degree DESC NULLS LAST, e.mention_count DESC`,
    [ws.id],
  );
  return rows.map((r) => ({ ...r, degree: r.degree ?? 0, brokerage: r.brokerage ?? 0 }));
}

export interface EntityDetail {
  entity: EntityListRow & { dossier: string | null; first_seen: string | null };
  aliases: string[];
  relationships: Array<{
    edgeId: string;
    otherId: string;
    otherName: string;
    otherType: string;
    otherTitle: string | null;
    type: RelationshipType;
    typeLabel: string;
    strength: number;
    warmth: number;
    evidenceCount: number;
    sourceDiversity: number;
    lastSeen: string | null;
    context: string | null;
    ended: boolean;
    scoreTerms: Record<string, number> | null;
    direction: "out" | "in";
  }>;
  evidence: Array<{
    source_id: string;
    source_title: string;
    occurred_at: string | null;
    quote: string | null;
    predicate: string;
    explicitness: string;
  }>;
  meetings: Array<{ id: string; title: string; occurred_at: string | null }>;
  pathsFromSelf: ReturnType<typeof serializePath>[];
  isSelf: boolean;
}

export async function getEntity(id: string): Promise<EntityDetail | null> {
  const ws = await getWorkspace();
  const entity = await one<EntityListRow & { dossier: string | null; first_seen: string | null; degree: number | null; brokerage: number | null }>(
    `SELECT e.id, e.canonical_name, e.entity_type, e.attributes, e.mention_count, e.source_count,
            e.last_seen, e.first_seen, e.status, e.dossier, m.degree, m.brokerage
     FROM entities e
     LEFT JOIN entity_metrics m ON m.entity_id = e.id
     WHERE e.id = $1 AND e.workspace_id = $2`,
    [id, ws.id],
  );
  if (!entity) return null;

  const aliasRows = await query<{ alias: string }>(
    `SELECT DISTINCT alias FROM entity_aliases WHERE entity_id = $1 AND kind = 'name'`,
    [id],
  );

  const edgeRows = await query<{
    id: string; other_id: string; other_name: string; other_type: string; other_attributes: EntityAttributes;
    relationship_type: RelationshipType; strength: number; warmth: number; evidence_count: number;
    source_diversity: number; last_seen: string | null; context_card: string | null;
    attributes: Record<string, unknown>; direction: string;
  }>(
    `SELECT e.id, eb.id AS other_id, eb.canonical_name AS other_name, eb.entity_type AS other_type,
            eb.attributes AS other_attributes, e.relationship_type, e.strength, e.warmth,
            e.evidence_count, e.source_diversity, e.last_seen, e.context_card, e.attributes,
            'out' AS direction
     FROM edges e JOIN entities eb ON eb.id = e.dst_entity_id
     WHERE e.src_entity_id = $1
     UNION ALL
     SELECT e.id, ea.id, ea.canonical_name, ea.entity_type, ea.attributes, e.relationship_type,
            e.strength, e.warmth, e.evidence_count, e.source_diversity, e.last_seen, e.context_card,
            e.attributes, 'in'
     FROM edges e JOIN entities ea ON ea.id = e.src_entity_id
     WHERE e.dst_entity_id = $1
     ORDER BY strength DESC`,
    [id],
  );

  const evidence = await query<{
    source_id: string; source_title: string; occurred_at: string | null;
    quote: string | null; predicate: string; explicitness: string;
  }>(
    `SELECT DISTINCT s.id AS source_id, s.title AS source_title,
            COALESCE(c.observed_at, s.occurred_at) AS occurred_at,
            c.quote, c.predicate, c.explicitness
     FROM claims c
     JOIN sources s ON s.id = c.source_id
     JOIN mention_links ml ON ml.mention_id = c.subject_mention_id
     WHERE ml.entity_id = $1 AND c.quote IS NOT NULL
     ORDER BY occurred_at DESC LIMIT 25`,
    [id],
  );

  const meetings = await query<{ id: string; title: string; occurred_at: string | null }>(
    `SELECT DISTINCT s.id, s.title, s.occurred_at
     FROM sources s
     JOIN mentions m ON m.source_id = s.id
     JOIN mention_links ml ON ml.mention_id = m.id
     WHERE ml.entity_id = $1
     ORDER BY s.occurred_at DESC NULLS LAST`,
    [id],
  );

  let pathsFromSelf: ReturnType<typeof serializePath>[] = [];
  if (ws.self_entity_id && ws.self_entity_id !== id) {
    const graph = await loadGraph(ws.id);
    const { alternativePaths } = await import("./graph/paths");
    pathsFromSelf = alternativePaths(graph, ws.self_entity_id, id, 3, { maxHops: 4 }).map(serializePath);
  }

  return {
    entity: { ...entity, degree: entity.degree ?? 0, brokerage: entity.brokerage ?? 0 },
    aliases: aliasRows.map((a) => a.alias),
    relationships: edgeRows.map((r) => ({
      edgeId: r.id,
      otherId: r.other_id,
      otherName: r.other_name,
      otherType: r.other_type,
      otherTitle: (r.other_attributes?.title as string) ?? null,
      type: r.relationship_type,
      typeLabel: RELATIONSHIP_META[r.relationship_type]?.label ?? r.relationship_type,
      strength: r.strength,
      warmth: r.warmth,
      evidenceCount: r.evidence_count,
      sourceDiversity: r.source_diversity,
      lastSeen: r.last_seen,
      context: r.context_card,
      ended: r.attributes?.ended === true,
      scoreTerms: (r.attributes?.score_terms as Record<string, number>) ?? null,
      direction: r.direction === "in" ? "in" : "out",
    })),
    evidence,
    meetings,
    pathsFromSelf,
    isSelf: ws.self_entity_id === id,
  };
}

export async function listMeetings() {
  const ws = await getWorkspace();
  return query<{
    id: string; title: string; occurred_at: string | null; token_estimate: number | null;
    people: string; claims: string; relationships: string;
  }>(
    `SELECT s.id, s.title, s.occurred_at, s.token_estimate,
            (SELECT count(DISTINCT ml.entity_id) FROM mentions m
               JOIN mention_links ml ON ml.mention_id = m.id WHERE m.source_id = s.id)::text AS people,
            (SELECT count(*) FROM claims c WHERE c.source_id = s.id)::text AS claims,
            (SELECT count(*) FROM claims c WHERE c.source_id = s.id AND c.claim_type IN ('relationship','capability'))::text AS relationships
     FROM sources s WHERE s.workspace_id = $1
     ORDER BY COALESCE(s.occurred_at, s.ingested_at) DESC`,
    [ws.id],
  );
}

export async function getMeeting(id: string) {
  const ws = await getWorkspace();
  const source = await one<{
    id: string; title: string; occurred_at: string | null; body: string; token_estimate: number | null;
    attendee_hints: Array<{ name: string; email: string | null; company: string | null }>;
  }>(
    `SELECT id, title, occurred_at, body, token_estimate, attendee_hints
     FROM sources WHERE id = $1 AND workspace_id = $2`,
    [id, ws.id],
  );
  if (!source) return null;

  const run = await one<{ id: string; extractor_version: string; model: string; raw_output: Record<string, unknown> | null; usage: Record<string, number> }>(
    `SELECT id, extractor_version, model, raw_output, usage FROM extraction_runs
     WHERE source_id = $1 AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1`,
    [id],
  );

  const participants = await query<{
    entity_id: string; canonical_name: string; entity_type: string; role_in_source: string | null;
    surface_form: string; attributes: EntityAttributes;
  }>(
    `SELECT ml.entity_id, e.canonical_name, e.entity_type, m.role_in_source, m.surface_form, e.attributes
     FROM mentions m
     JOIN mention_links ml ON ml.mention_id = m.id
     JOIN entities e ON e.id = ml.entity_id
     WHERE m.source_id = $1
     ORDER BY CASE m.role_in_source WHEN 'attendee' THEN 0 WHEN 'speaker' THEN 0 ELSE 1 END,
              e.canonical_name`,
    [id],
  );

  const relationships = await query<{
    subject: string; subject_id: string; object: string; object_id: string;
    predicate: string; quote: string | null; explicitness: string; polarity: number; confidence: number;
    value: Record<string, unknown>;
  }>(
    `SELECT es.canonical_name AS subject, es.id AS subject_id,
            eo.canonical_name AS object, eo.id AS object_id,
            c.predicate, c.quote, c.explicitness, c.polarity, c.confidence, c.value
     FROM claims c
     JOIN mention_links mls ON mls.mention_id = c.subject_mention_id
     JOIN entities es ON es.id = mls.entity_id
     JOIN mention_links mlo ON mlo.mention_id = c.object_mention_id
     JOIN entities eo ON eo.id = mlo.entity_id
     WHERE c.source_id = $1 AND c.claim_type IN ('relationship','capability')
       AND c.predicate NOT IN ('mentioned','met_with')
     ORDER BY c.confidence DESC`,
    [id],
  );

  const hooks = await query<{ entity_id: string; canonical_name: string; value: OutreachHook; quote: string | null; predicate: string }>(
    `SELECT ml.entity_id, e.canonical_name, c.value, c.quote, c.predicate
     FROM claims c
     JOIN mention_links ml ON ml.mention_id = c.subject_mention_id
     JOIN entities e ON e.id = ml.entity_id
     WHERE c.source_id = $1 AND c.claim_type IN ('hook','commitment')`,
    [id],
  );

  const unresolved = await query<{ surface_form: string; disambiguation_context: string | null }>(
    `SELECT m.surface_form, m.disambiguation_context FROM mentions m
     LEFT JOIN mention_links ml ON ml.mention_id = m.id
     WHERE m.source_id = $1 AND ml.mention_id IS NULL`,
    [id],
  );

  return { source, run, participants, relationships, hooks, unresolved };
}

export async function listReviews() {
  const ws = await getWorkspace();
  return query<{
    id: string; score: number; features: Record<string, number>; created_at: string;
    mention_surface: string; mention_context: string | null; source_title: string;
    candidate_id: string; candidate_name: string; candidate_title: string | null;
    candidate_dossier: string | null;
  }>(
    `SELECT r.id, r.score, r.features, r.created_at,
            m.surface_form AS mention_surface, m.disambiguation_context AS mention_context,
            s.title AS source_title,
            e.id AS candidate_id, e.canonical_name AS candidate_name,
            e.attributes->>'title' AS candidate_title, e.dossier AS candidate_dossier
     FROM resolution_reviews r
     JOIN mentions m ON m.id = r.mention_id
     JOIN sources s ON s.id = m.source_id
     JOIN entities e ON e.id = r.candidate_id
     WHERE r.workspace_id = $1 AND r.verdict IS NULL
     ORDER BY r.score DESC`,
    [ws.id],
  );
}
