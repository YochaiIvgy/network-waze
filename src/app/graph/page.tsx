import { getWorkspace } from "@/lib/db";
import { loadGraph } from "@/lib/graph/graph-cache";
import { RELATIONSHIP_META } from "@/lib/types";
import { GraphCanvas, type GraphEdgeDTO, type GraphNodeDTO } from "@/components/GraphCanvas";
import { EmptyState } from "@/components/ui";
import { Setup } from "@/components/Setup";

export default async function GraphPage() {
  let ws;
  let graph;
  try {
    ws = await getWorkspace();
    graph = await loadGraph(ws.id);
  } catch (err) {
    return <Setup error={(err as Error).message} />;
  }

  if (graph.nodes.size === 0) {
    return (
      <div className="page">
        <EmptyState title="Nothing to draw yet">
          Ingest a transcript or run <code className="mono">npm run db:seed</code> first.
        </EmptyState>
      </div>
    );
  }

  const nodes: GraphNodeDTO[] = [...graph.nodes.values()].map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    title: (n.attributes.title as string) ?? null,
    org: (n.attributes.org as string) ?? null,
    degree: n.degree,
    brokerage: n.brokerage,
    isSelf: n.id === ws.self_entity_id,
    needsReview: n.status === "needs_review",
  }));

  const edges: GraphEdgeDTO[] = graph.edges.map((e) => ({
    id: e.id,
    src: e.src_entity_id,
    dst: e.dst_entity_id,
    type: e.relationship_type,
    typeLabel: RELATIONSHIP_META[e.relationship_type]?.label ?? e.relationship_type,
    strength: e.strength,
    warmth: e.warmth,
    evidenceCount: e.evidence_count,
    context: e.context_card,
    ended: e.attributes?.ended === true,
  }));

  return <GraphCanvas nodes={nodes} edges={edges} selfId={ws.self_entity_id} />;
}
