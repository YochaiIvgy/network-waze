import { query } from "../db";
import type { EdgeRow, EntityRow, RelationshipType } from "../types";

export interface GraphNode {
  id: string;
  name: string;
  type: EntityRow["entity_type"];
  attributes: EntityRow["attributes"];
  dossier: string | null;
  embedding: number[] | null;
  mentionCount: number;
  sourceCount: number;
  lastSeen: string | null;
  degree: number;
  brokerage: number;
  status: string;
}

export interface GraphEdge extends EdgeRow {
  relationship_type: RelationshipType;
}

export interface LoadedGraph {
  workspaceId: string;
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  /** Undirected adjacency. Direction is kept on the edge for display only —
   *  an introduction travels both ways along a relationship. */
  adjacency: Map<string, Array<{ to: string; edge: GraphEdge }>>;
  loadedAt: number;
}

const cache = new Map<string, LoadedGraph>();
const TTL_MS = 30_000;

export function invalidateGraphCache(workspaceId?: string) {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

/**
 * The whole graph in memory. Deliberate: path search over a personal network is
 * a millisecond-scale in-process problem, and keeping it in one place makes the
 * ranking logic testable without a database.
 */
export async function loadGraph(workspaceId: string, force = false): Promise<LoadedGraph> {
  const hit = cache.get(workspaceId);
  if (!force && hit && Date.now() - hit.loadedAt < TTL_MS) return hit;

  const [entityRows, edgeRows] = await Promise.all([
    query<{
      id: string;
      canonical_name: string;
      entity_type: GraphNode["type"];
      attributes: EntityRow["attributes"];
      dossier: string | null;
      embedding: number[] | null;
      mention_count: number;
      source_count: number;
      last_seen: string | null;
      status: string;
      degree: number | null;
      brokerage: number | null;
    }>(
      `SELECT e.id, e.canonical_name, e.entity_type, e.attributes, e.dossier, e.embedding,
              e.mention_count, e.source_count, e.last_seen, e.status,
              m.degree, m.brokerage
       FROM entities e
       LEFT JOIN entity_metrics m ON m.entity_id = e.id
       WHERE e.workspace_id = $1 AND e.status <> 'merged'`,
      [workspaceId],
    ),
    query<GraphEdge>(
      `SELECT id, src_entity_id, dst_entity_id, relationship_type, directed, strength, warmth,
              confidence, evidence_count, source_diversity, first_seen, last_seen,
              context_card, attributes
       FROM edges WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);

  const nodes = new Map<string, GraphNode>();
  for (const r of entityRows) {
    nodes.set(r.id, {
      id: r.id,
      name: r.canonical_name,
      type: r.entity_type,
      attributes: r.attributes ?? {},
      dossier: r.dossier,
      embedding: r.embedding,
      mentionCount: r.mention_count,
      sourceCount: r.source_count,
      lastSeen: r.last_seen,
      degree: r.degree ?? 0,
      brokerage: r.brokerage ?? 0,
      status: r.status,
    });
  }

  const adjacency = new Map<string, Array<{ to: string; edge: GraphEdge }>>();
  const link = (from: string, to: string, edge: GraphEdge) => {
    const list = adjacency.get(from) ?? [];
    list.push({ to, edge });
    adjacency.set(from, list);
  };
  for (const e of edgeRows) {
    if (!nodes.has(e.src_entity_id) || !nodes.has(e.dst_entity_id)) continue;
    link(e.src_entity_id, e.dst_entity_id, e);
    link(e.dst_entity_id, e.src_entity_id, e);
  }

  const graph: LoadedGraph = { workspaceId, nodes, edges: edgeRows, adjacency, loadedAt: Date.now() };
  cache.set(workspaceId, graph);
  return graph;
}
