import { cosine } from "../embeddings";
import type { GraphNode } from "../graph/graph-cache";

/**
 * The retrieval seam.
 *
 * Brute-force cosine over the in-memory graph. At 10k entities this is ~15ms,
 * which is faster than a round trip to an ANN index. When the entity count passes
 * ~100k, replace `topK` with a pgvector query (see db/schema.sql) — nothing else
 * in the codebase touches vectors.
 */
export interface ScoredNode {
  node: GraphNode;
  score: number;
  reasons: string[];
}

export interface RetrievalFilters {
  entityTypes?: string[];
  orgMatch?: string | null;
  keywords?: string[];
  sectors?: string[];
  excludeIds?: Set<string>;
}

export function topK(
  nodes: Iterable<GraphNode>,
  queryEmbedding: number[] | null,
  filters: RetrievalFilters,
  k = 25,
): ScoredNode[] {
  const keywords = (filters.keywords ?? []).map((s) => s.toLowerCase()).filter(Boolean);
  const sectors = (filters.sectors ?? []).map((s) => s.toLowerCase());
  const orgMatch = filters.orgMatch?.toLowerCase() ?? null;
  const results: ScoredNode[] = [];

  for (const node of nodes) {
    if (filters.excludeIds?.has(node.id)) continue;
    if (filters.entityTypes?.length && !filters.entityTypes.includes(node.type)) continue;

    const haystack = `${node.name} ${node.dossier ?? ""}`.toLowerCase();
    const reasons: string[] = [];

    // Semantic similarity carries the query; lexical hits are additive evidence.
    const semantic = queryEmbedding ? cosine(queryEmbedding, node.embedding) : 0;
    let score = semantic * 0.6;
    if (semantic > 0.35) reasons.push("semantically close to the query");

    let keywordHits = 0;
    for (const kw of keywords) if (haystack.includes(kw)) keywordHits++;
    if (keywordHits) {
      score += Math.min(0.35, keywordHits * 0.12);
      reasons.push(`mentions ${keywords.filter((k) => haystack.includes(k)).slice(0, 3).join(", ")}`);
    }

    if (orgMatch) {
      const org = String(node.attributes.org ?? "").toLowerCase();
      if (node.name.toLowerCase().includes(orgMatch)) {
        score += 0.45;
        reasons.push("name matches the organisation");
      } else if (org.includes(orgMatch)) {
        score += 0.4;
        reasons.push(`works at ${node.attributes.org}`);
      } else if (haystack.includes(orgMatch)) {
        score += 0.15;
        reasons.push("organisation referenced in their dossier");
      }
    }

    if (sectors.length) {
      const nodeSectors = (Array.isArray(node.attributes.sector) ? node.attributes.sector : []).map((s) =>
        String(s).toLowerCase(),
      );
      if (nodeSectors.some((s) => sectors.some((q) => s.includes(q) || q.includes(s)))) {
        score += 0.2;
        reasons.push("sector match");
      }
    }

    // Corroboration bonus: someone mentioned across several meetings is a more
    // reliable answer than a one-line cameo, all else equal.
    score += Math.min(0.08, node.sourceCount * 0.02);

    if (score <= 0.05) continue;
    results.push({ node, score, reasons });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, k);
}
