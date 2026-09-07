import { transaction, type ClientLike } from "../db";
import { embed } from "../embeddings";
import { RELATIONSHIP_META, type Explicitness, type OutreachHook, type RelationshipType } from "../types";
import { computeStrength } from "./scoring";
import { invalidateGraphCache } from "./graph-cache";

/**
 * L1 + L2  ->  L3 + L4.
 *
 * A full rebuild rather than an incremental update. At this scale it costs
 * milliseconds, and it means the graph can never drift from the ledger — which is
 * the guarantee the whole architecture is built on. Incremental projection is an
 * optimisation to reach for only when the rebuild stops being instant.
 */
export async function projectGraph(workspaceId: string): Promise<{ entities: number; edges: number }> {
  const result = await transaction(async (c) => {
    await rebuildEntityAggregates(c, workspaceId);
    const edges = await rebuildEdges(c, workspaceId);
    await rebuildMetrics(c, workspaceId);
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM entities WHERE workspace_id = $1 AND status <> 'merged'`,
      [workspaceId],
    );
    return { entities: Number(rows[0].n), edges };
  });
  invalidateGraphCache(workspaceId);
  return result;
}

// ---------------------------------------------------------------------------
// Entity aggregates + dossiers
// ---------------------------------------------------------------------------

interface ClaimRow {
  id: string;
  source_id: string;
  claim_type: string;
  subject_entity: string | null;
  object_entity: string | null;
  predicate: string;
  value: Record<string, unknown>;
  quote: string | null;
  explicitness: Explicitness;
  polarity: number;
  warmth: number | null;
  confidence: number;
  observed_at: string | null;
  source_title: string;
}

async function loadClaims(c: ClientLike, workspaceId: string): Promise<ClaimRow[]> {
  const { rows } = await c.query<ClaimRow>(
    `SELECT cl.id, cl.source_id, cl.claim_type,
            sl.entity_id AS subject_entity, ol.entity_id AS object_entity,
            cl.predicate, cl.value, cl.quote, cl.explicitness, cl.polarity, cl.warmth,
            cl.confidence, COALESCE(cl.observed_at, s.occurred_at, s.ingested_at) AS observed_at,
            s.title AS source_title
     FROM claims cl
     JOIN sources s ON s.id = cl.source_id
     LEFT JOIN mention_links sl ON sl.mention_id = cl.subject_mention_id
     LEFT JOIN mention_links ol ON ol.mention_id = cl.object_mention_id
     WHERE s.workspace_id = $1
     ORDER BY COALESCE(cl.observed_at, s.occurred_at, s.ingested_at) ASC`,
    [workspaceId],
  );
  return rows;
}

async function rebuildEntityAggregates(c: ClientLike, workspaceId: string) {
  // Counts and temporal envelope come straight from the ledger.
  await c.query(
    `UPDATE entities e SET
       mention_count = COALESCE(agg.mentions, 0),
       source_count  = COALESCE(agg.sources, 0),
       first_seen    = agg.first_seen,
       last_seen     = agg.last_seen,
       updated_at    = now()
     FROM (
       SELECT ml.entity_id,
              count(*)                       AS mentions,
              count(DISTINCT m.source_id)    AS sources,
              min(COALESCE(s.occurred_at, s.ingested_at)) AS first_seen,
              max(COALESCE(s.occurred_at, s.ingested_at)) AS last_seen
       FROM mention_links ml
       JOIN mentions m ON m.id = ml.mention_id
       JOIN sources s  ON s.id = m.source_id
       WHERE s.workspace_id = $1
       GROUP BY ml.entity_id
     ) agg
     WHERE e.id = agg.entity_id`,
    [workspaceId],
  );

  const claims = await loadClaims(c, workspaceId);
  const byEntity = new Map<string, ClaimRow[]>();
  for (const cl of claims) {
    if (!cl.subject_entity) continue;
    const list = byEntity.get(cl.subject_entity) ?? [];
    list.push(cl);
    byEntity.set(cl.subject_entity, list);
  }

  const { rows: entities } = await c.query<{
    id: string;
    entity_type: string;
    canonical_name: string;
    attributes: Record<string, unknown>;
  }>(
    `SELECT id, entity_type, canonical_name, attributes FROM entities
     WHERE workspace_id = $1 AND status <> 'merged'`,
    [workspaceId],
  );

  const dossiers: Array<{ id: string; text: string; attributes: Record<string, unknown> }> = [];
  for (const e of entities) {
    const own = byEntity.get(e.id) ?? [];
    const attributes = foldAttributes(e.attributes, own);
    dossiers.push({ id: e.id, text: buildDossier(e.canonical_name, e.entity_type, attributes, own), attributes });
  }

  const vectors = await embed(dossiers.map((d) => d.text));
  for (let i = 0; i < dossiers.length; i++) {
    await c.query(`UPDATE entities SET attributes = $2, dossier = $3, embedding = $4 WHERE id = $1`, [
      dossiers[i].id,
      JSON.stringify(dossiers[i].attributes),
      dossiers[i].text,
      vectors[i],
    ]);
  }
}

/** Latest-wins for scalars, union for lists, and hooks accumulate with citations. */
function foldAttributes(base: Record<string, unknown>, claims: ClaimRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const lists: Record<string, Set<string>> = {
    expertise: new Set(toArray(base.expertise)),
    interests: new Set(toArray(base.interests)),
    sector: new Set(toArray(base.sector)),
    notable_facts: new Set(toArray(base.notable_facts)),
  };
  const hooks: OutreachHook[] = [];

  for (const cl of claims) {
    if (cl.polarity === -1) continue;
    const v = cl.value ?? {};
    switch (cl.predicate) {
      case "title":
        out.title = v.title ?? out.title;
        break;
      case "email":
        out.email = v.email ?? out.email;
        break;
      case "location":
        out.location = v.location ?? out.location;
        break;
      case "seniority":
        out.seniority = v.seniority ?? out.seniority;
        break;
      case "stage":
        out.stage = v.stage ?? out.stage;
        break;
      case "expertise":
        if (v.value) lists.expertise.add(String(v.value));
        break;
      case "interest":
        if (v.value) lists.interests.add(String(v.value));
        break;
      case "sector":
        if (v.value) lists.sector.add(String(v.value));
        break;
      case "notable_fact":
        if (v.value) lists.notable_facts.add(String(v.value));
        break;
      case "outreach_hook":
        hooks.push({
          hook: String(v.hook ?? ""),
          kind: (v.kind as OutreachHook["kind"]) ?? "professional",
          quote: cl.quote ?? undefined,
          source_id: cl.source_id,
          observed_at: cl.observed_at,
        });
        break;
      case "ask":
      case "offer":
        hooks.push({
          hook: String(v.what ?? ""),
          kind: cl.predicate as OutreachHook["kind"],
          quote: cl.quote ?? undefined,
          source_id: cl.source_id,
          observed_at: cl.observed_at,
        });
        break;
    }
  }

  for (const [k, set] of Object.entries(lists)) if (set.size) out[k] = [...set];
  // Freshest hooks first: a hook from last month is worth more than one from 2023.
  out.hooks = hooks
    .filter((h) => h.hook)
    .sort((a, b) => String(b.observed_at ?? "").localeCompare(String(a.observed_at ?? "")))
    .slice(0, 12);
  return out;
}

/** The text that gets embedded, compared during resolution, and shown as a profile. */
function buildDossier(
  name: string,
  type: string,
  attrs: Record<string, unknown>,
  claims: ClaimRow[],
): string {
  const parts: string[] = [name];
  if (attrs.title) parts.push(String(attrs.title));
  if (attrs.org) parts.push(`at ${attrs.org}`);
  if (attrs.org_type) parts.push(String(attrs.org_type).replace(/_/g, " "));
  if (attrs.location) parts.push(String(attrs.location));
  if (attrs.description) parts.push(String(attrs.description));

  const head = parts.join(" — ");
  const lists = [
    listLine("Expertise", attrs.expertise),
    listLine("Sectors", attrs.sector),
    listLine("Interests", attrs.interests),
    listLine("Notable", attrs.notable_facts),
  ].filter(Boolean);

  const hookLines = (attrs.hooks as OutreachHook[] | undefined)
    ?.slice(0, 6)
    .map((h) => `- [${h.kind}] ${h.hook}`) ?? [];

  const contexts = claims
    .filter((cl) => cl.claim_type === "relationship" && typeof cl.value?.context === "string")
    .slice(-6)
    .map((cl) => `- ${cl.value.context as string}`);

  return [
    head,
    lists.join("\n"),
    hookLines.length ? `Hooks:\n${hookLines.join("\n")}` : "",
    contexts.length ? `Connections:\n${contexts.join("\n")}` : "",
    type === "person" ? "" : `Type: ${type}`,
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
}

function listLine(label: string, v: unknown): string {
  const arr = toArray(v);
  return arr.length ? `${label}: ${arr.join(", ")}` : "";
}

function toArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

interface EdgeAccumulator {
  src: string;
  dst: string;
  type: RelationshipType;
  directed: boolean;
  claims: ClaimRow[];
  sources: Set<string>;
  negatedLast: boolean;
  lastSeen: Date | null;
  firstSeen: Date | null;
}

async function rebuildEdges(c: ClientLike, workspaceId: string): Promise<number> {
  const claims = await loadClaims(c, workspaceId);
  const acc = new Map<string, EdgeAccumulator>();

  for (const cl of claims) {
    if (cl.claim_type !== "relationship" && cl.claim_type !== "capability") continue;
    if (!cl.subject_entity || !cl.object_entity) continue;
    if (cl.subject_entity === cl.object_entity) continue;

    const type = cl.predicate as RelationshipType;
    const meta = RELATIONSHIP_META[type];
    if (!meta) continue;

    // Symmetric relationships are stored once, keyed on the sorted pair, so
    // "A colleague B" and "B colleague A" cannot become two edges.
    const [src, dst] = meta.symmetric
      ? [cl.subject_entity, cl.object_entity].sort()
      : [cl.subject_entity, cl.object_entity];

    const key = `${src}|${dst}|${type}`;
    const observed = cl.observed_at ? new Date(cl.observed_at) : null;
    const entry = acc.get(key) ?? {
      src,
      dst,
      type,
      directed: !meta.symmetric,
      claims: [],
      sources: new Set<string>(),
      negatedLast: false,
      lastSeen: null,
      firstSeen: null,
    };

    entry.claims.push(cl);
    entry.sources.add(cl.source_id);
    // Claims arrive ordered by time, so the last one wins the negation question:
    // "left the company" after "works at" ends the tie without erasing it.
    entry.negatedLast = cl.polarity === -1;
    if (observed) {
      if (!entry.firstSeen || observed < entry.firstSeen) entry.firstSeen = observed;
      if (!entry.lastSeen || observed > entry.lastSeen) entry.lastSeen = observed;
    }
    acc.set(key, entry);
  }

  // Full rebuild: see the note at the top of this file.
  await c.query(`DELETE FROM edges WHERE workspace_id = $1`, [workspaceId]);

  let count = 0;
  for (const e of acc.values()) {
    const supporting = e.claims.filter((cl) => cl.polarity === 1);
    if (supporting.length === 0 && !e.negatedLast) continue;

    const bestExplicitness = strongestExplicitness(supporting.length ? supporting : e.claims);
    const strengthSignal = Math.max(
      ...(supporting.length ? supporting : e.claims).map((cl) => num(cl.value?.strength_signal, 0.7)),
    );
    const confidence =
      (supporting.length ? supporting : e.claims).reduce((s, cl) => s + cl.confidence, 0) /
      Math.max(1, supporting.length || e.claims.length);
    const warmthValues = e.claims.map((cl) => cl.warmth).filter((w): w is number => typeof w === "number");
    const warmth = warmthValues.length
      ? warmthValues.reduce((s, w) => s + w, 0) / warmthValues.length
      : 0.5;

    const breakdown = computeStrength({
      explicitness: bestExplicitness,
      strengthSignal,
      confidence,
      evidenceCount: e.claims.length,
      sourceDiversity: e.sources.size,
      lastSeen: e.lastSeen,
    });

    // A former tie is still a route — often a better one than a current
    // acquaintance — so it is preserved and discounted, never deleted.
    const strength = e.negatedLast ? breakdown.strength * 0.5 : breakdown.strength;

    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO edges (workspace_id, src_entity_id, dst_entity_id, relationship_type, directed,
                          strength, warmth, confidence, evidence_count, source_diversity,
                          first_seen, last_seen, context_card, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (src_entity_id, dst_entity_id, relationship_type) DO UPDATE
         SET strength = EXCLUDED.strength, updated_at = now()
       RETURNING id`,
      [
        workspaceId,
        e.src,
        e.dst,
        e.type,
        e.directed,
        strength,
        warmth,
        confidence,
        e.claims.length,
        e.sources.size,
        e.firstSeen,
        e.lastSeen,
        buildContextCard(e),
        JSON.stringify({
          ended: e.negatedLast,
          score_terms: breakdown,
          since: firstDefined(e.claims, "since"),
          until: firstDefined(e.claims, "until"),
        }),
      ],
    );
    const edgeId = rows[0].id;

    for (const cl of e.claims) {
      await c.query(
        `INSERT INTO edge_evidence (edge_id, claim_id, source_id, quote, weight, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (edge_id, claim_id) DO NOTHING`,
        [edgeId, cl.id, cl.source_id, cl.quote, cl.confidence, cl.observed_at],
      );
    }
    count++;
  }
  return count;
}

/** Deterministic narrative. An LLM pass can enrich this later without schema change. */
function buildContextCard(e: EdgeAccumulator): string {
  const contexts = e.claims
    .map((cl) => (typeof cl.value?.context === "string" ? (cl.value.context as string) : null))
    .filter((x): x is string => Boolean(x));
  const basis = e.claims
    .map((cl) => (typeof cl.value?.basis === "string" ? (cl.value.basis as string) : null))
    .filter((x): x is string => Boolean(x));

  const unique = [...new Set([...contexts, ...basis])];
  if (unique.length) return unique.slice(0, 2).join(" ");

  const label = RELATIONSHIP_META[e.type]?.label ?? e.type;
  const where = [...new Set(e.claims.map((cl) => cl.source_title))].slice(0, 2).join(", ");
  return `${label}${where ? ` — established in ${where}` : ""}.`;
}

function strongestExplicitness(claims: ClaimRow[]): Explicitness {
  if (claims.some((c) => c.explicitness === "stated")) return "stated";
  if (claims.some((c) => c.explicitness === "reported")) return "reported";
  return "inferred";
}

function firstDefined(claims: ClaimRow[], key: string): unknown {
  for (const cl of claims) if (cl.value?.[key]) return cl.value[key];
  return null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

async function rebuildMetrics(c: ClientLike, workspaceId: string) {
  const { rows: edges } = await c.query<{ src_entity_id: string; dst_entity_id: string; strength: number }>(
    `SELECT src_entity_id, dst_entity_id, strength FROM edges WHERE workspace_id = $1`,
    [workspaceId],
  );
  const adjacency = new Map<string, Array<{ to: string; w: number }>>();
  const push = (a: string, b: string, w: number) => {
    const list = adjacency.get(a) ?? [];
    list.push({ to: b, w });
    adjacency.set(a, list);
  };
  for (const e of edges) {
    push(e.src_entity_id, e.dst_entity_id, e.strength);
    push(e.dst_entity_id, e.src_entity_id, e.strength);
  }

  await c.query(
    `DELETE FROM entity_metrics WHERE entity_id IN (SELECT id FROM entities WHERE workspace_id = $1)`,
    [workspaceId],
  );

  for (const [id, neighbors] of adjacency) {
    const degree = neighbors.length;
    const weighted = neighbors.reduce((s, n) => s + n.w, 0);
    const reach = reachableWithin(adjacency, id, 3);
    // Brokerage: how much of that 3-hop neighbourhood disappears if this node
    // does. High values are the people whose absence disconnects you.
    const withoutMe = neighbors
      .map((n) => reachableWithin(adjacency, n.to, 2, id))
      .reduce((s, n) => Math.max(s, n), 0);
    const brokerage = reach > 0 ? Math.max(0, (reach - withoutMe) / reach) : 0;

    await c.query(
      `INSERT INTO entity_metrics (entity_id, degree, weighted_degree, reachability, brokerage, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (entity_id) DO UPDATE SET degree = EXCLUDED.degree,
         weighted_degree = EXCLUDED.weighted_degree, reachability = EXCLUDED.reachability,
         brokerage = EXCLUDED.brokerage, updated_at = now()`,
      [id, degree, weighted, reach, brokerage],
    );
  }
}

function reachableWithin(
  adjacency: Map<string, Array<{ to: string; w: number }>>,
  start: string,
  hops: number,
  exclude?: string,
): number {
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const n of adjacency.get(node) ?? []) {
        if (n.to === exclude || seen.has(n.to)) continue;
        seen.add(n.to);
        next.push(n.to);
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return seen.size - 1;
}
