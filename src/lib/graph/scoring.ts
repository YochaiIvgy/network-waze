import { EXPLICITNESS_WEIGHT, RELATIONSHIP_META, type Explicitness, type RelationshipType } from "../types";

export const HALF_LIFE_MONTHS = 18;

export interface StrengthInputs {
  explicitness: Explicitness;
  strengthSignal: number;   // 0..1, from the transcript's own hedging
  confidence: number;       // extractor confidence
  evidenceCount: number;
  sourceDiversity: number;
  lastSeen: Date | null;
  now?: Date;
}

export interface StrengthBreakdown {
  strength: number;
  base: number;
  volume: number;
  diversity: number;
  recency: number;
}

/**
 * Every term is separately reported so the UI can show *why* an edge scored what
 * it scored. An unexplainable ranking cannot be tuned.
 */
export function computeStrength(i: StrengthInputs): StrengthBreakdown {
  const base = EXPLICITNESS_WEIGHT[i.explicitness] * i.strengthSignal * (0.5 + 0.5 * i.confidence);
  const volume = 1 - Math.exp(-i.evidenceCount / 3);
  const diversity = 1 - Math.exp(-i.sourceDiversity / 2);
  const recency = recencyFactor(i.lastSeen, i.now);

  const strength = clamp01(
    base * (0.55 + 0.25 * volume + 0.2 * diversity) * (0.35 + 0.65 * recency),
  );
  return { strength, base, volume, diversity, recency };
}

export function recencyFactor(lastSeen: Date | null, now = new Date()): number {
  if (!lastSeen) return 0.5;
  const months = (now.getTime() - lastSeen.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  if (months <= 0) return 1;
  return Math.pow(0.5, months / HALF_LIFE_MONTHS);
}

/**
 * Probability that traversing this edge produces a real introduction.
 *
 * Path cost is -ln(p), so the shortest path is the maximum-likelihood
 * introduction chain. This is the single most important function in the app:
 * it is why a three-hop warm chain can beat a two-hop cold one.
 */
export function traversalProbability(edge: {
  relationship_type: RelationshipType;
  strength: number;
  warmth: number;
  attributes?: Record<string, unknown> | null;
}): number {
  const meta = RELATIONSHIP_META[edge.relationship_type];
  const typePrior = meta?.typePrior ?? 0.3;
  // Warmth modulates but never dominates: a cold strong tie still transmits.
  const warmthFactor = 0.6 + 0.4 * clamp01(edge.warmth);
  const ended = edge.attributes?.ended === true ? 0.6 : 1;
  const p = typePrior * (0.15 + 0.85 * clamp01(edge.strength)) * warmthFactor * ended;
  // Floor keeps the graph connected; ceiling keeps any single hop from reading
  // as a certainty.
  return Math.min(0.97, Math.max(0.02, p));
}

export function edgeCost(edge: Parameters<typeof traversalProbability>[0]): number {
  return -Math.log(traversalProbability(edge));
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Human-readable label for a probability, used in the UI rather than raw decimals. */
export function strengthLabel(p: number): "very strong" | "strong" | "moderate" | "weak" | "faint" {
  if (p >= 0.75) return "very strong";
  if (p >= 0.55) return "strong";
  if (p >= 0.35) return "moderate";
  if (p >= 0.18) return "weak";
  return "faint";
}
