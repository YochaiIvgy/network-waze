import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { loadGraph } from "@/lib/graph/graph-cache";
import { alternativePaths, pathsToMany, rankConnectors } from "@/lib/graph/paths";
import { strengthLabel } from "@/lib/graph/scoring";
import { RELATIONSHIP_META } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Introduction routing.
 *
 * The old client-side search enumerated simple paths and multiplied confidences.
 * This runs the real thing: Dijkstra over cost = -ln(p), so the returned route is
 * the maximum-likelihood introduction chain rather than the shortest one. A long
 * warm chain can outrank a short cold one, which is usually the correct answer
 * and never falls out of a hop-count heuristic.
 *
 * Path search needs the whole graph in memory, so it belongs on the server —
 * that is also what lets the UI stay a thin renderer.
 */
export async function POST(request: Request) {
  try {
    const { source, target, maxHops, minStrength, excludeTypes } = (await request.json()) as {
      source?: string;
      target?: string;
      maxHops?: number;
      minStrength?: number;
      excludeTypes?: string[];
    };
    if (!source) {
      return NextResponse.json({ error: "Choose a starting point." }, { status: 400 });
    }

    const ws = await getWorkspace();
    const graph = await loadGraph(ws.id);
    if (!graph.nodes.has(source)) {
      return NextResponse.json({ error: "That starting point is no longer in the graph." }, { status: 400 });
    }

    const options = {
      maxHops: clampHops(maxHops),
      minEdgeStrength: typeof minStrength === "number" ? minStrength : 0,
      excludeTypes: Array.isArray(excludeTypes) ? excludeTypes : [],
    };

    // With a target, the user is asking "how do I reach this person" and wants
    // genuinely different routes. Without one, they are asking the question one
    // level up — "who should I call?" — which is the connector ranking.
    if (target && target !== source) {
      const routes = alternativePaths(graph, source, target, 3, options);
      return NextResponse.json({ paths: routes.map(serialize), connectors: [] });
    }

    const reachable = [...graph.nodes.keys()].filter((id) => id !== source);
    const all = pathsToMany(graph, source, reachable, options);
    return NextResponse.json({
      paths: all.slice(0, 8).map(serialize),
      connectors: rankConnectors(all).slice(0, 6),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

function clampHops(n: unknown): number {
  // Past four hops the probability product is so small that the ranking stops
  // meaning anything, and the UI cannot show the chain legibly either.
  if (typeof n !== "number" || !Number.isFinite(n)) return 4;
  return Math.max(1, Math.min(4, Math.round(n)));
}

type Ranked = ReturnType<typeof alternativePaths>[number];

function serialize(path: Ranked) {
  return {
    targetId: path.targetId,
    targetName: path.targetName,
    probability: path.probability,
    cost: path.cost,
    label: strengthLabel(path.probability),
    firstConnector: path.firstConnector,
    hops: path.hops.map((hop) => ({
      from: hop.from,
      fromName: hop.fromName,
      to: hop.to,
      toName: hop.toName,
      probability: hop.probability,
      edgeId: hop.edge.id,
      kind: hop.edge.relationship_type,
      kindLabel: RELATIONSHIP_META[hop.edge.relationship_type]?.label ?? hop.edge.relationship_type,
      strength: hop.edge.strength,
      warmth: hop.edge.warmth,
      context: hop.edge.context_card ?? "",
      ended: (hop.edge.attributes as { ended?: boolean })?.ended === true,
    })),
  };
}
