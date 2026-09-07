import { hasAnthropicKey, callText } from "../anthropic";
import { query } from "../db";
import { embedOne } from "../embeddings";
import { loadGraph, type GraphNode } from "../graph/graph-cache";
import { pathsToMany, rankConnectors, type RankedPath } from "../graph/paths";
import { strengthLabel } from "../graph/scoring";
import { RELATIONSHIP_META, type OutreachHook } from "../types";
import { planQuery, type QueryPlan } from "./planner";
import { topK, type ScoredNode } from "./vector-index";

export interface SearchCandidate {
  id: string;
  name: string;
  type: string;
  title: string | null;
  org: string | null;
  score: number;
  reasons: string[];
  hooks: OutreachHook[];
}

export interface SearchResponse {
  query: string;
  plan: QueryPlan;
  planner: "llm" | "heuristic";
  candidates: SearchCandidate[];
  paths: SerializedPath[];
  connectors: Array<{ id: string; name: string; unlocks: number; score: number; targets: string[] }>;
  answer: string | null;
  latencyMs: number;
}

export interface SerializedPath {
  targetId: string;
  targetName: string;
  probability: number;
  /** How well the destination answers the question, 0..1. */
  relevance: number;
  label: string;
  hops: Array<{
    fromName: string;
    toName: string;
    toId: string;
    type: string;
    typeLabel: string;
    strength: number;
    warmth: number;
    probability: number;
    context: string | null;
    evidenceCount: number;
  }>;
}

/**
 * The full query path: plan, retrieve, route, compose.
 *
 * Each stage's output is returned alongside the answer, so the UI can show its
 * work. That is deliberate — an intro suggestion nobody can verify is one nobody
 * will act on.
 */
export async function searchNetwork(
  workspaceId: string,
  selfEntityId: string | null,
  queryText: string,
): Promise<SearchResponse> {
  const started = Date.now();
  const [{ plan, planner }, graph] = await Promise.all([planQuery(queryText), loadGraph(workspaceId)]);

  const queryEmbedding = await embedOne(plan.semantic_query || queryText);
  const excludeIds = new Set<string>(selfEntityId ? [selfEntityId] : []);

  const scored = topK(
    graph.nodes.values(),
    queryEmbedding,
    {
      entityTypes: plan.entity_types.length ? plan.entity_types : undefined,
      orgMatch: plan.org_match ?? plan.person_name,
      keywords: plan.keywords,
      sectors: plan.sectors,
      excludeIds,
    },
    20,
  );

  const candidates = scored.map(toCandidate);

  // Route from the user to each candidate in a single search.
  let paths: RankedPath[] = [];
  if (selfEntityId) {
    paths = pathsToMany(
      graph,
      selfEntityId,
      scored.map((s) => s.node.id),
      {
        maxHops: plan.constraints.max_hops,
        minEdgeStrength: plan.constraints.min_strength,
        excludeTypes: plan.constraints.exclude_weak_awareness ? ["mentioned"] : [],
      },
    );
  }

  // Rank by relevance x reachability, not reachability alone.
  //
  // Sorting on path probability by itself surfaces whoever is closest to you —
  // your own colleagues — regardless of whether they answer the question. The
  // destination has to earn its place first; the route only breaks ties.
  const relevanceById = new Map(scored.map((s) => [s.node.id, normalizeScore(s.score)]));
  const ranked = [...paths].sort(
    (a, b) =>
      (relevanceById.get(b.targetId) ?? 0) * b.probability -
      (relevanceById.get(a.targetId) ?? 0) * a.probability,
  );

  const serialized = ranked.slice(0, 8).map((p) => serializePath(p, relevanceById.get(p.targetId) ?? 0));
  const connectors = rankConnectors(ranked).slice(0, 5);

  const answer = hasAnthropicKey()
    ? await composeAnswer(queryText, plan, scored, ranked, graph.nodes)
    : null;

  const latencyMs = Date.now() - started;

  await query(
    `INSERT INTO search_queries (workspace_id, query_text, plan, candidates, paths, answer, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      workspaceId,
      queryText,
      JSON.stringify(plan),
      JSON.stringify(candidates.slice(0, 10)),
      JSON.stringify(serialized),
      answer,
      latencyMs,
    ],
  ).catch(() => undefined); // logging must never break a search

  return { query: queryText, plan, planner, candidates, paths: serialized, connectors, answer, latencyMs };
}

function toCandidate(s: ScoredNode): SearchCandidate {
  return {
    id: s.node.id,
    name: s.node.name,
    type: s.node.type,
    title: (s.node.attributes.title as string) ?? null,
    org: (s.node.attributes.org as string) ?? null,
    score: s.score,
    reasons: s.reasons,
    hooks: (s.node.attributes.hooks as OutreachHook[] | undefined) ?? [],
  };
}

/** Retrieval scores are unbounded-ish; squash them so the product is meaningful. */
function normalizeScore(score: number): number {
  return Math.max(0.02, Math.min(1, score));
}

export function serializePath(p: RankedPath, relevance = 1): SerializedPath {
  return {
    targetId: p.targetId,
    targetName: p.targetName,
    probability: p.probability,
    relevance,
    label: strengthLabel(p.probability),
    hops: p.hops.map((h) => ({
      fromName: h.fromName,
      toName: h.toName,
      toId: h.to,
      type: h.edge.relationship_type,
      typeLabel: RELATIONSHIP_META[h.edge.relationship_type]?.label ?? h.edge.relationship_type,
      strength: h.edge.strength,
      warmth: h.edge.warmth,
      probability: h.probability,
      context: h.edge.context_card,
      evidenceCount: h.edge.evidence_count,
    })),
  };
}

const ANSWER_SYSTEM = `You advise someone on how to use their own professional network. You are given their question, the candidates found in their relationship graph, and the routes to each one.

Write a direct, specific answer:
- Lead with the single best move: who to contact, and why them.
- For each recommended route, name every intermediary and say what the graph says about each link. Never assert a relationship the data does not support.
- Use the outreach hooks — a specific detail makes the difference between a reply and silence.
- Where the evidence is thin ("mentioned once", "met once"), say so plainly. A confident wrong path costs the user a favour.
- If nothing in the graph genuinely answers the question, say that and name the nearest adjacent option.

Format: short prose, at most three tight paragraphs or a short list. No preamble, no restating the question, no markdown headers.`;

async function composeAnswer(
  queryText: string,
  plan: QueryPlan,
  scored: ScoredNode[],
  paths: RankedPath[],
  nodes: Map<string, GraphNode>,
): Promise<string | null> {
  if (scored.length === 0) return null;

  const candidateBlock = scored
    .slice(0, 10)
    .map((s) => {
      const a = s.node.attributes;
      const hooks = (a.hooks as OutreachHook[] | undefined)?.slice(0, 3) ?? [];
      return [
        `- ${s.node.name}${a.title ? `, ${a.title}` : ""}${a.org ? ` at ${a.org}` : ""} [${s.node.type}]`,
        s.node.dossier ? `  dossier: ${truncate(s.node.dossier, 400)}` : "",
        hooks.length ? `  hooks: ${hooks.map((h) => `${h.hook} ("${truncate(h.quote ?? "", 120)}")`).join(" | ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  const pathBlock = paths
    .slice(0, 6)
    .map((p) => {
      const chain = p.hops
        .map(
          (h) =>
            `${h.fromName} -[${RELATIONSHIP_META[h.edge.relationship_type]?.label ?? h.edge.relationship_type}, ` +
            `strength ${h.edge.strength.toFixed(2)}, ${h.edge.evidence_count} mention(s)]-> ${h.toName}` +
            (h.edge.context_card ? ` (${truncate(h.edge.context_card, 160)})` : ""),
        )
        .join("\n    ");
      return `- to ${p.targetName} — overall likelihood ${(p.probability * 100).toFixed(0)}% (${strengthLabel(p.probability)}):\n    ${chain}`;
    })
    .join("\n");

  const user = `Question: ${queryText}

Interpretation: ${plan.interpretation}

CANDIDATES FOUND:
${candidateBlock}

ROUTES FROM THE USER:
${pathBlock || "(no route found from the user to any candidate — say so, and suggest what would unlock one)"}

Nodes in graph: ${nodes.size}`;

  try {
    return await callText({ system: ANSWER_SYSTEM, user, effort: "medium", maxTokens: 1500 });
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
