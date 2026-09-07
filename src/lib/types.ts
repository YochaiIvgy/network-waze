/**
 * The domain vocabulary. Kept in one file because the relationship taxonomy is
 * the part of this system that is expensive to change later: it is baked into
 * extraction prompts, edge dedup keys, and path-traversal priors.
 */

export const ENTITY_TYPES = ["person", "organization", "fund", "topic", "event"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONSHIP_TYPES = [
  "colleague",
  "former_colleague",
  "reports_to",
  "founded",
  "works_at",
  "investor_in",
  "advisor_to",
  "board_member",
  "client_of",
  "friend",
  "family",
  "introduced_by",
  "can_intro_to",
  "met_with",
  "mentioned",
  "affiliated_with",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * `typePrior` is the probability that an edge of this type actually carries an
 * introduction, given that it exists at full strength. This is the number that
 * stops "A mentioned B once" from ranking as a warm path.
 *
 * `symmetric` edges are stored once and traversed both ways.
 */
export const RELATIONSHIP_META: Record<
  RelationshipType,
  { label: string; typePrior: number; symmetric: boolean; connects: "people" | "mixed" }
> = {
  colleague: { label: "Colleague", typePrior: 0.8, symmetric: true, connects: "people" },
  former_colleague: { label: "Former colleague", typePrior: 0.7, symmetric: true, connects: "people" },
  reports_to: { label: "Reports to", typePrior: 0.85, symmetric: false, connects: "people" },
  founded: { label: "Founded", typePrior: 0.9, symmetric: false, connects: "mixed" },
  works_at: { label: "Works at", typePrior: 0.75, symmetric: false, connects: "mixed" },
  investor_in: { label: "Investor in", typePrior: 0.8, symmetric: false, connects: "mixed" },
  advisor_to: { label: "Advisor to", typePrior: 0.75, symmetric: false, connects: "mixed" },
  board_member: { label: "Board member", typePrior: 0.85, symmetric: false, connects: "mixed" },
  client_of: { label: "Client of", typePrior: 0.6, symmetric: false, connects: "mixed" },
  friend: { label: "Friend", typePrior: 0.9, symmetric: true, connects: "people" },
  family: { label: "Family", typePrior: 0.95, symmetric: true, connects: "people" },
  introduced_by: { label: "Introduced by", typePrior: 0.85, symmetric: false, connects: "people" },
  can_intro_to: { label: "Can introduce to", typePrior: 0.9, symmetric: false, connects: "people" },
  met_with: { label: "Met with", typePrior: 0.45, symmetric: true, connects: "people" },
  // Awareness, not relationship. Deliberately near the floor.
  mentioned: { label: "Mentioned", typePrior: 0.12, symmetric: false, connects: "mixed" },
  affiliated_with: { label: "Affiliated with", typePrior: 0.5, symmetric: false, connects: "mixed" },
};

/** How much a claim is trusted by how it was said. Used in strength scoring. */
export const EXPLICITNESS_WEIGHT = {
  stated: 1.0,
  reported: 0.75,
  inferred: 0.5,
} as const;
export type Explicitness = keyof typeof EXPLICITNESS_WEIGHT;

// --- Row shapes ------------------------------------------------------------

export interface EntityRow {
  id: string;
  entity_type: EntityType;
  canonical_name: string;
  normalized: string;
  attributes: EntityAttributes;
  dossier: string | null;
  mention_count: number;
  source_count: number;
  first_seen: string | null;
  last_seen: string | null;
  status: string;
}

export interface EntityAttributes {
  title?: string;
  org?: string;
  org_entity_id?: string;
  email?: string;
  location?: string;
  seniority?: string;
  sector?: string[];
  tags?: string[];
  org_type?: string;
  stage?: string;
  description?: string;
  expertise?: string[];
  interests?: string[];
  hooks?: OutreachHook[];
  [key: string]: unknown;
}

export interface OutreachHook {
  hook: string;
  kind: "personal" | "professional" | "timing" | "ask" | "offer";
  quote?: string;
  source_id?: string;
  observed_at?: string | null;
}

export interface EdgeRow {
  id: string;
  src_entity_id: string;
  dst_entity_id: string;
  relationship_type: RelationshipType;
  directed: boolean;
  strength: number;
  warmth: number;
  confidence: number;
  evidence_count: number;
  source_diversity: number;
  first_seen: string | null;
  last_seen: string | null;
  context_card: string | null;
  attributes: Record<string, unknown>;
}

export interface PathHop {
  from: string;
  to: string;
  edge: EdgeRow;
  probability: number;
}

export interface IntroPath {
  target: string;
  hops: PathHop[];
  score: number;
  nodes: string[];
}
