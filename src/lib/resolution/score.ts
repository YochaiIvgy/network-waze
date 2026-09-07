import { cosine } from "../embeddings";
import {
  jaccard,
  jaroWinkler,
  nameParts,
  nameSimilarity,
  normalizeName,
  normalizeOrg,
  tokenSet,
} from "./normalize";

/**
 * Interpretable scoring. Every feature is named, weighted, and stored on the
 * mention_link, so a wrong merge can be explained rather than shrugged at.
 *
 * Thresholds are deliberately far apart: the gap between them is the review
 * queue, and a wide gap is what keeps precision high early on, when there is not
 * yet enough graph context to disambiguate confidently.
 */
export const AUTO_MERGE = 0.82;
export const AUTO_REJECT = 0.45;

export interface ResolutionCandidateInput {
  name: string;
  isFirstNameOnly: boolean;
  /** Organisations resolve on name far more decisively than people do. */
  isPerson?: boolean;
  email?: string | null;
  org?: string | null;
  title?: string | null;
  seniority?: string | null;
  context?: string | null;
  embedding?: number[] | null;
  /** Entity ids already linked from the same source — the co-mention signal. */
  neighborEntityIds?: string[];
}

export interface EntityCandidate {
  id: string;
  canonical_name: string;
  aliases: string[];
  email?: string | null;
  org?: string | null;
  title?: string | null;
  seniority?: string | null;
  dossier?: string | null;
  embedding?: number[] | null;
  neighborEntityIds?: string[];
  /** True when this entity already has a mention in the same source. */
  presentInSameSource?: boolean;
}

export interface ScoreBreakdown {
  total: number;
  features: Record<string, number>;
  blocked: boolean;
  reason?: string;
}

const W = {
  name: 0.3,
  email: 0.45,
  org: 0.2,
  context: 0.2,
  neighbors: 0.15,
  title: 0.05,
  firstNameOnlyPenalty: -0.35,
} as const;

export function scoreCandidate(
  mention: ResolutionCandidateInput,
  candidate: EntityCandidate,
): ScoreBreakdown {
  const features: Record<string, number> = {};

  // Hard block: two mentions in one meeting are different people unless the
  // transcript equated them (which the extractor expresses as a single ref).
  if (candidate.presentInSameSource) {
    return {
      total: 0,
      features: { same_source_block: -1 },
      blocked: true,
      reason: "candidate already has a distinct mention in this source",
    };
  }

  const isPerson = mention.isPerson !== false;
  const names = [candidate.canonical_name, ...candidate.aliases.filter(Boolean)];
  const compare = isPerson
    ? (a: string, b: string) => nameSimilarity(a, b)
    : (a: string, b: string) => jaroWinkler(normalizeOrg(a), normalizeOrg(b));

  const bestName = Math.max(...names.map((n) => compare(mention.name, n)));
  features.name = bestName;

  const norm = isPerson ? normalizeName : normalizeOrg;
  const exactName = names.some((n) => norm(n) === norm(mention.name)) && norm(mention.name).length > 0;

  // A surname mismatch is disqualifying regardless of everything else: shared
  // employer plus shared interests must never merge two different people.
  const mp = nameParts(mention.name);
  const cp = nameParts(candidate.canonical_name);
  if (isPerson && mp.last && cp.last && bestName < 0.6) {
    return { total: 0, features, blocked: true, reason: "surname mismatch" };
  }
  if (!isPerson && bestName < 0.72) {
    return { total: 0, features, blocked: true, reason: "different organisation" };
  }

  const emailMatch =
    mention.email && candidate.email
      ? mention.email.toLowerCase() === candidate.email.toLowerCase()
        ? 1
        : -1
      : 0;
  features.email = emailMatch;

  const orgMatch =
    mention.org && candidate.org
      ? normalizeOrg(mention.org) === normalizeOrg(candidate.org)
        ? 1
        : jaccard(tokenSet(mention.org), tokenSet(candidate.org)) > 0.5
          ? 0.6
          : -0.3
      : 0;
  features.org = orgMatch;

  const contextSim = mention.embedding && candidate.embedding
    ? cosine(mention.embedding, candidate.embedding)
    : mention.context && candidate.dossier
      ? jaccard(tokenSet(mention.context), tokenSet(candidate.dossier))
      : 0;
  features.context = contextSim;

  const neighborOverlap = overlapScore(mention.neighborEntityIds, candidate.neighborEntityIds);
  features.neighbors = neighborOverlap;

  const titleMatch =
    mention.title && candidate.title
      ? jaccard(tokenSet(mention.title), tokenSet(candidate.title))
      : 0;
  features.title = titleMatch;

  let total =
    W.name * bestName +
    W.email * emailMatch +
    W.org * orgMatch +
    W.context * contextSim +
    W.neighbors * neighborOverlap +
    W.title * titleMatch;

  // Normalise into 0..1 against the achievable maximum, so thresholds mean the
  // same thing whether or not an email happened to be present.
  const maxAchievable = W.name + W.email + W.org + W.context + W.neighbors + W.title;
  total = Math.max(0, Math.min(1, total / maxAchievable + 0.35 * bestName));

  if (mention.isFirstNameOnly) {
    features.first_name_only = W.firstNameOnlyPenalty;
    total += W.firstNameOnlyPenalty;
  }

  // An exact email match is near-decisive on its own — it is the one identifier
  // people do not share.
  if (emailMatch === 1) total = Math.max(total, 0.95);

  // Exact-name short circuit. Without it the 0..1 normalisation above dilutes a
  // perfect match below the merge threshold, and every re-mention of the same
  // organisation spawns a fresh node.
  //
  // The guards are what make it safe: never for a bare first name, never when
  // the employer or email actively contradicts, and — for people — never
  // without a surname. Two mentions inside one source are blocked earlier.
  if (exactName && emailMatch >= 0 && orgMatch >= 0 && !mention.isFirstNameOnly) {
    if (!isPerson) {
      features.exact_org_name = 1;
      total = Math.max(total, 0.93);
    } else if (mp.last && cp.last) {
      features.exact_full_name = 1;
      total = Math.max(total, 0.88);
    }
  }

  return { total: Math.max(0, Math.min(1, total)), features, blocked: false };
}

function overlapScore(a?: string[], b?: string[]): number {
  if (!a?.length || !b?.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const id of a) if (setB.has(id)) shared++;
  if (shared === 0) return 0;
  // Saturating: two shared contacts is already strong evidence; ten is not five
  // times stronger.
  return 1 - Math.exp(-shared / 1.5);
}

export type Verdict = "merge" | "review" | "reject";

export function verdictFor(score: number, blocked: boolean): Verdict {
  if (blocked) return "reject";
  if (score >= AUTO_MERGE) return "merge";
  if (score <= AUTO_REJECT) return "reject";
  return "review";
}
