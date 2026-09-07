import { getWorkspace, query } from "./db";
import { traversalProbability } from "./graph/scoring";
import { RELATIONSHIP_META, type EntityAttributes, type OutreachHook, type RelationshipType } from "./types";

/**
 * The read seam between the projected graph (L3/L4) and the single-page UI.
 *
 * The UI thinks in `person | organization` and one flat edge list, because that
 * is what a canvas can draw. The ledger thinks in typed relationships, claims
 * and score terms. This file is the only place that translation happens — so the
 * UI never learns the schema, and the schema never bends to fit the canvas.
 *
 * Everything derived is carried through rather than flattened away: strength,
 * warmth, traversal probability and the per-term breakdown all reach the client,
 * because the whole point of the scoring model is that a user can see *why* an
 * edge ranked where it did.
 */

export type ViewEntityType = "person" | "organization";

export interface ViewEvidence {
  meetingId: string;
  meetingTitle: string;
  quote: string | null;
  observedAt: string | null;
}

export interface ViewEntity {
  id: string;
  name: string;
  type: ViewEntityType;
  /** Display line under the name: title, employer, or org descriptor. */
  role: string;
  tags: string[];
  /** The generated dossier — prose, with the facts it was built from. */
  context: string;
  identifiers: string[];
  resolution: "canonical" | "pending";
  isSelf: boolean;
  mentionCount: number;
  sourceCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** L4 metrics. `brokerage` is the one worth acting on. */
  degree: number;
  weightedDegree: number;
  reachability: number;
  brokerage: number;
  hooks: OutreachHook[];
}

export interface ViewEdge {
  id: string;
  source: string;
  target: string;
  kind: RelationshipType;
  kindLabel: string;
  context: string;
  confidence: number;
  /** Derived, not stored: a `can_intro_to` edge for the same pair means "yes". */
  willingness: "yes" | "no" | "unknown";
  evidence: ViewEvidence[];
  strength: number;
  warmth: number;
  /** p(this hop produces a real introduction) — the number paths are built on. */
  probability: number;
  evidenceCount: number;
  sourceDiversity: number;
  firstSeen: string | null;
  lastSeen: string | null;
  ended: boolean;
  scoreTerms: { base: number; volume: number; diversity: number; recency: number } | null;
}

export interface ViewMeeting {
  id: string;
  title: string;
  date: string | null;
  source: string;
  externalId: string | null;
  transcript: string;
  status: "extracted" | "pending";
  entityCount: number;
  claimCount: number;
}

export interface ViewReview {
  id: string;
  name: string;
  candidateId: string;
  candidateName: string;
  context: string;
  score: number;
  features: Record<string, number>;
}

export interface ViewGraph {
  entities: ViewEntity[];
  edges: ViewEdge[];
  meetings: ViewMeeting[];
  reviews: ViewReview[];
  selfEntityId: string | null;
  stats: {
    people: number;
    organizations: number;
    edges: number;
    claims: number;
    meetings: number;
    reviews: number;
    /** Mentions that never resolved to an entity — the deliberate dangling set. */
    deferred: number;
  };
}

/** Topics and events are extracted and searchable, but they are not network nodes. */
const NODE_TYPES = ["person", "organization", "fund"];

export async function getViewGraph(): Promise<ViewGraph> {
  const ws = await getWorkspace();

  const [entityRows, edgeRows, evidenceRows, meetingRows, reviewRows, statRows] = await Promise.all([
    query<{
      id: string;
      entity_type: string;
      canonical_name: string;
      attributes: EntityAttributes;
      dossier: string | null;
      mention_count: number;
      source_count: number;
      first_seen: string | null;
      last_seen: string | null;
      status: string;
      degree: number | null;
      weighted_degree: number | null;
      reachability: number | null;
      brokerage: number | null;
      aliases: string[] | null;
    }>(
      `SELECT e.id, e.entity_type, e.canonical_name, e.attributes, e.dossier,
              e.mention_count, e.source_count, e.first_seen, e.last_seen, e.status,
              m.degree, m.weighted_degree, m.reachability, m.brokerage,
              (SELECT array_agg(a.alias) FROM entity_aliases a
                WHERE a.entity_id = e.id AND a.kind IN ('email','handle')) AS aliases
         FROM entities e
         LEFT JOIN entity_metrics m ON m.entity_id = e.id
        WHERE e.workspace_id = $1 AND e.status <> 'merged' AND e.entity_type = ANY($2)
        ORDER BY e.mention_count DESC, e.canonical_name ASC`,
      [ws.id, NODE_TYPES],
    ),

    query<{
      id: string;
      src_entity_id: string;
      dst_entity_id: string;
      relationship_type: RelationshipType;
      strength: number;
      warmth: number;
      confidence: number;
      evidence_count: number;
      source_diversity: number;
      first_seen: string | null;
      last_seen: string | null;
      context_card: string | null;
      attributes: Record<string, unknown>;
    }>(
      `SELECT e.id, e.src_entity_id, e.dst_entity_id, e.relationship_type, e.strength, e.warmth,
              e.confidence, e.evidence_count, e.source_diversity, e.first_seen, e.last_seen,
              e.context_card, e.attributes
         FROM edges e
         JOIN entities a ON a.id = e.src_entity_id AND a.status <> 'merged'
         JOIN entities b ON b.id = e.dst_entity_id AND b.status <> 'merged'
        WHERE e.workspace_id = $1
        ORDER BY e.strength DESC`,
      [ws.id],
    ),

    // Quotes are the product, not a debugging aid: every edge in the UI can be
    // opened down to the sentence that produced it.
    query<{
      edge_id: string;
      source_id: string;
      title: string;
      quote: string | null;
      observed_at: string | null;
    }>(
      `SELECT ev.edge_id, ev.source_id, s.title, ev.quote, ev.observed_at
         FROM edge_evidence ev
         JOIN sources s ON s.id = ev.source_id
         JOIN edges e   ON e.id = ev.edge_id
        WHERE e.workspace_id = $1 AND ev.quote IS NOT NULL
        ORDER BY ev.weight DESC`,
      [ws.id],
    ),

    query<{
      id: string;
      title: string;
      occurred_at: string | null;
      kind: string;
      external_id: string | null;
      body: string;
      entity_count: number;
      claim_count: number;
    }>(
      `SELECT s.id, s.title, s.occurred_at, s.kind, s.external_id, s.body,
              (SELECT count(DISTINCT ml.entity_id)::int FROM mentions m
                 JOIN mention_links ml ON ml.mention_id = m.id
                WHERE m.source_id = s.id) AS entity_count,
              (SELECT count(*)::int FROM claims c WHERE c.source_id = s.id) AS claim_count
         FROM sources s
        WHERE s.workspace_id = $1
        ORDER BY COALESCE(s.occurred_at, s.ingested_at) DESC`,
      [ws.id],
    ),

    query<{
      id: string;
      surface_form: string;
      candidate_id: string;
      candidate_name: string;
      disambiguation_context: string | null;
      score: number;
      features: Record<string, number>;
    }>(
      `SELECT r.id, m.surface_form, r.candidate_id, c.canonical_name AS candidate_name,
              m.disambiguation_context, r.score, r.features
         FROM resolution_reviews r
         JOIN mentions m  ON m.id = r.mention_id
         JOIN entities c  ON c.id = r.candidate_id
        WHERE r.workspace_id = $1 AND r.verdict IS NULL
        ORDER BY r.score DESC`,
      [ws.id],
    ),

    query<{ claims: number; deferred: number }>(
      `SELECT
         (SELECT count(*)::int FROM claims c
            JOIN sources s ON s.id = c.source_id WHERE s.workspace_id = $1) AS claims,
         (SELECT count(*)::int FROM mentions m
            JOIN sources s ON s.id = m.source_id
            LEFT JOIN mention_links ml ON ml.mention_id = m.id
           WHERE s.workspace_id = $1 AND ml.mention_id IS NULL) AS deferred`,
      [ws.id],
    ),
  ]);

  const entities: ViewEntity[] = entityRows.map((row) => {
    const attributes = row.attributes ?? {};
    return {
      id: row.id,
      name: row.canonical_name,
      type: row.entity_type === "person" ? "person" : "organization",
      role: describeRole(row.entity_type, attributes),
      tags: collectTags(attributes),
      context: row.dossier ?? "",
      identifiers: (row.aliases ?? []).filter(Boolean),
      resolution: row.status === "needs_review" ? "pending" : "canonical",
      isSelf: row.id === ws.self_entity_id,
      mentionCount: row.mention_count,
      sourceCount: row.source_count,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      degree: row.degree ?? 0,
      weightedDegree: row.weighted_degree ?? 0,
      reachability: row.reachability ?? 0,
      brokerage: row.brokerage ?? 0,
      hooks: Array.isArray(attributes.hooks) ? attributes.hooks : [],
    };
  });

  const known = new Set(entities.map((e) => e.id));

  // "Can this person open that door?" is a separate claim type from "do they
  // know each other", so willingness is looked up per pair rather than read off
  // the edge being rendered.
  const introPairs = new Set(
    edgeRows
      .filter((e) => e.relationship_type === "can_intro_to")
      .map((e) => `${e.src_entity_id}|${e.dst_entity_id}`),
  );

  const evidenceByEdge = new Map<string, ViewEvidence[]>();
  for (const row of evidenceRows) {
    const list = evidenceByEdge.get(row.edge_id) ?? [];
    // Three quotes is what the panel can show without becoming a transcript.
    if (list.length < 3) {
      list.push({
        meetingId: row.source_id,
        meetingTitle: row.title,
        quote: row.quote,
        observedAt: row.observed_at,
      });
    }
    evidenceByEdge.set(row.edge_id, list);
  }

  const edges: ViewEdge[] = edgeRows
    .filter((row) => known.has(row.src_entity_id) && known.has(row.dst_entity_id))
    .map((row) => {
      const attributes = row.attributes ?? {};
      const ended = attributes.ended === true;
      return {
        id: row.id,
        source: row.src_entity_id,
        target: row.dst_entity_id,
        kind: row.relationship_type,
        kindLabel: RELATIONSHIP_META[row.relationship_type]?.label ?? row.relationship_type,
        context: row.context_card ?? "",
        confidence: row.confidence,
        willingness:
          row.relationship_type === "can_intro_to" ||
          introPairs.has(`${row.src_entity_id}|${row.dst_entity_id}`) ||
          introPairs.has(`${row.dst_entity_id}|${row.src_entity_id}`)
            ? "yes"
            : "unknown",
        evidence: evidenceByEdge.get(row.id) ?? [],
        strength: row.strength,
        warmth: row.warmth,
        probability: traversalProbability({
          relationship_type: row.relationship_type,
          strength: row.strength,
          warmth: row.warmth,
          attributes,
        }),
        evidenceCount: row.evidence_count,
        sourceDiversity: row.source_diversity,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen,
        ended,
        scoreTerms: isScoreTerms(attributes.score_terms) ? attributes.score_terms : null,
      };
    });

  const meetings: ViewMeeting[] = meetingRows.map((row) => ({
    id: row.id,
    title: row.title,
    date: row.occurred_at,
    source: row.kind === "granola_meeting" ? "Granola" : "Transcript import",
    externalId: row.external_id,
    transcript: row.body,
    status: row.claim_count > 0 ? "extracted" : "pending",
    entityCount: row.entity_count,
    claimCount: row.claim_count,
  }));

  const reviews: ViewReview[] = reviewRows.map((row) => ({
    id: row.id,
    name: row.surface_form,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    context: row.disambiguation_context ?? "No distinguishing context was recorded for this mention.",
    score: row.score,
    features: row.features ?? {},
  }));

  return {
    entities,
    edges,
    meetings,
    reviews,
    selfEntityId: ws.self_entity_id,
    stats: {
      people: entities.filter((e) => e.type === "person").length,
      organizations: entities.filter((e) => e.type === "organization").length,
      edges: edges.length,
      claims: statRows[0]?.claims ?? 0,
      meetings: meetings.length,
      reviews: reviews.length,
      deferred: statRows[0]?.deferred ?? 0,
    },
  };
}

/** One line the user can read at a glance. Falls back rather than showing blank. */
function describeRole(entityType: string, a: EntityAttributes): string {
  if (entityType === "person") {
    if (a.title && a.org) return `${a.title} at ${a.org}`;
    if (a.title) return a.title;
    if (a.org) return `At ${a.org}`;
    if (a.seniority && a.seniority !== "unknown") return a.seniority.replace(/_/g, " ");
    return "Role not yet known";
  }
  const kind = a.org_type && a.org_type !== "unknown" ? a.org_type.replace(/_/g, " ") : null;
  const sector = a.sector?.length ? a.sector.slice(0, 2).join(", ") : null;
  if (kind && sector) return `${kind} · ${sector}`;
  return kind ?? sector ?? a.description ?? "Organization";
}

function collectTags(a: EntityAttributes): string[] {
  const tags = [
    ...(a.tags ?? []),
    ...(a.sector ?? []),
    ...(a.expertise ?? []),
    ...(a.interests ?? []),
  ]
    .map((t) => String(t).trim())
    .filter(Boolean);
  return [...new Set(tags)].slice(0, 8);
}

function isScoreTerms(v: unknown): v is ViewEdge["scoreTerms"] & object {
  return typeof v === "object" && v !== null && "base" in v && "recency" in v;
}
