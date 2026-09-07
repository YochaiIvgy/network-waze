import type { LoadedGraph, GraphEdge } from "./graph-cache";
import { edgeCost, traversalProbability } from "./scoring";

export interface Hop {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  edge: GraphEdge;
  probability: number;
}

export interface RankedPath {
  targetId: string;
  targetName: string;
  hops: Hop[];
  /** Product of per-hop probabilities: the likelihood the whole chain works. */
  probability: number;
  cost: number;
  /** The person you actually contact first. */
  firstConnector: { id: string; name: string } | null;
}

export interface PathOptions {
  maxHops?: number;
  minEdgeStrength?: number;
  excludeTypes?: string[];
  /** Nodes that may not be routed *through* (targets themselves are fine). */
  avoid?: Set<string>;
}

/**
 * Dijkstra over cost = -ln(p). Because the costs are additive logs, the minimum
 * cost path is exactly the maximum-probability path. This is why the ranking
 * survives contact with a real network: a long warm chain can, and should, beat a
 * short cold one.
 */
export function shortestPaths(
  graph: LoadedGraph,
  sourceId: string,
  options: PathOptions = {},
): Map<string, { cost: number; prev: string | null; edge: GraphEdge | null; hops: number }> {
  const maxHops = options.maxHops ?? 4;
  const minStrength = options.minEdgeStrength ?? 0;
  const exclude = new Set(options.excludeTypes ?? []);

  const dist = new Map<string, { cost: number; prev: string | null; edge: GraphEdge | null; hops: number }>();
  dist.set(sourceId, { cost: 0, prev: null, edge: null, hops: 0 });

  // A binary heap is unnecessary here: personal networks are small, and the
  // linear scan keeps the code readable. Swap it if node count passes ~50k.
  const visited = new Set<string>();
  const frontier = new Set<string>([sourceId]);

  while (frontier.size) {
    let current: string | null = null;
    let bestCost = Infinity;
    for (const id of frontier) {
      const d = dist.get(id);
      if (d && d.cost < bestCost) {
        bestCost = d.cost;
        current = id;
      }
    }
    if (!current) break;
    frontier.delete(current);
    visited.add(current);

    const entry = dist.get(current)!;
    if (entry.hops >= maxHops) continue;

    for (const { to, edge } of graph.adjacency.get(current) ?? []) {
      if (visited.has(to)) continue;
      if (edge.strength < minStrength) continue;
      if (exclude.has(edge.relationship_type)) continue;
      // Intermediate hops must be routable; the destination itself may be avoided.
      if (options.avoid?.has(to) && to !== current) continue;

      const cost = entry.cost + edgeCost(edge);
      const known = dist.get(to);
      if (!known || cost < known.cost) {
        dist.set(to, { cost, prev: current, edge, hops: entry.hops + 1 });
        frontier.add(to);
      }
    }
  }

  return dist;
}

export function reconstruct(
  graph: LoadedGraph,
  dist: ReturnType<typeof shortestPaths>,
  sourceId: string,
  targetId: string,
): RankedPath | null {
  const end = dist.get(targetId);
  if (!end || targetId === sourceId) return null;

  const hops: Hop[] = [];
  let cursor = targetId;
  while (cursor !== sourceId) {
    const step = dist.get(cursor);
    if (!step || !step.prev || !step.edge) return null;
    hops.unshift({
      from: step.prev,
      fromName: graph.nodes.get(step.prev)?.name ?? "Unknown",
      to: cursor,
      toName: graph.nodes.get(cursor)?.name ?? "Unknown",
      edge: step.edge,
      probability: traversalProbability(step.edge),
    });
    cursor = step.prev;
  }

  const probability = hops.reduce((p, h) => p * h.probability, 1);
  const first = hops[0];
  return {
    targetId,
    targetName: graph.nodes.get(targetId)?.name ?? "Unknown",
    hops,
    probability,
    cost: end.cost,
    firstConnector: first ? { id: first.to, name: first.toName } : null,
  };
}

/**
 * k alternative routes to one target.
 *
 * A simplified Yen: re-run the search with one intermediary removed at a time.
 * That yields genuinely different routes (different people to ask) rather than
 * near-identical variants, which is what the user is choosing between.
 */
export function alternativePaths(
  graph: LoadedGraph,
  sourceId: string,
  targetId: string,
  k = 3,
  options: PathOptions = {},
): RankedPath[] {
  const results: RankedPath[] = [];
  const seen = new Set<string>();

  const base = reconstruct(graph, shortestPaths(graph, sourceId, options), sourceId, targetId);
  if (!base) return [];
  results.push(base);
  seen.add(pathKey(base));

  const intermediaries = base.hops.slice(0, -1).map((h) => h.to);
  for (const banned of intermediaries) {
    if (results.length >= k) break;
    const avoid = new Set(options.avoid ?? []);
    avoid.add(banned);
    const alt = reconstruct(
      graph,
      shortestPaths(graph, sourceId, { ...options, avoid }),
      sourceId,
      targetId,
    );
    if (alt && !seen.has(pathKey(alt))) {
      results.push(alt);
      seen.add(pathKey(alt));
    }
  }

  return results.sort((a, b) => b.probability - a.probability).slice(0, k);
}

/** Best route to each of many candidate targets, in one search. */
export function pathsToMany(
  graph: LoadedGraph,
  sourceId: string,
  targetIds: string[],
  options: PathOptions = {},
): RankedPath[] {
  const dist = shortestPaths(graph, sourceId, options);
  return targetIds
    .map((id) => reconstruct(graph, dist, sourceId, id))
    .filter((p): p is RankedPath => p !== null)
    .sort((a, b) => b.probability - a.probability);
}

function pathKey(p: RankedPath): string {
  return p.hops.map((h) => h.to).join(">");
}

/**
 * "Who should I call?" — the connectors who unlock the most of a target set,
 * weighted by how likely each unlock is. Answers the question one level above
 * "how do I reach this person".
 */
export function rankConnectors(
  paths: RankedPath[],
): Array<{ id: string; name: string; unlocks: number; score: number; targets: string[] }> {
  const map = new Map<string, { id: string; name: string; unlocks: number; score: number; targets: string[] }>();
  for (const path of paths) {
    const connector = path.firstConnector;
    // A one-hop path is a direct contact, not an introduction: they open nobody
    // but themselves, so counting them here would crowd out the real brokers.
    if (!connector || path.hops.length < 2) continue;
    const entry = map.get(connector.id) ?? {
      id: connector.id,
      name: connector.name,
      unlocks: 0,
      score: 0,
      targets: [],
    };
    entry.unlocks += 1;
    entry.score += path.probability;
    entry.targets.push(path.targetName);
    map.set(connector.id, entry);
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}
