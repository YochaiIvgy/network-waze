import { z } from "zod/v4";
import { callStructured } from "../anthropic";
import { hasAnthropicKey } from "../anthropic";
import { ENTITY_TYPES } from "../types";

/**
 * Natural language in, a retrieval plan out.
 *
 * Keeping the plan as data (rather than letting a model call search directly)
 * is what makes the query layer debuggable: every answer can show the plan it
 * ran, and a bad answer is traceable to a bad plan or a bad graph, never to both
 * at once.
 */
export const QueryPlanSchema = z.object({
  intent: z.enum([
    "find_path",      // "I need Lockheed Martin access"
    "find_people",    // "who do I know in defense"
    "explain_link",   // "how do I know Sarah Chen"
    "list_targets",   // "which LPs have I met"
  ]),
  interpretation: z.string().describe("One sentence restating what the user is really asking for"),
  semantic_query: z
    .string()
    .describe("A dense description of the ideal match, written as if describing that person's profile"),
  entity_types: z.array(z.enum(ENTITY_TYPES)),
  org_match: z.string().nullable().describe("A specific organisation name if one was named"),
  person_name: z.string().nullable().describe("A specific person if one was named"),
  keywords: z.array(z.string()).describe("Literal terms worth matching, lowercase"),
  sectors: z.array(z.string()),
  constraints: z.object({
    max_hops: z.number().min(1).max(5),
    min_strength: z.number().min(0).max(1),
    exclude_weak_awareness: z
      .boolean()
      .describe("true when the user needs a real relationship rather than mere awareness"),
  }),
});

export type QueryPlan = z.infer<typeof QueryPlanSchema>;

const PLANNER_SYSTEM = `You turn a natural-language request about someone's professional network into a retrieval plan.

The network is a graph of people and organisations built from that person's meeting transcripts. You are not answering the question — you are describing what to look for.

Guidance:
- "I need access to X" / "I want to reach X" -> intent find_path, org_match or person_name set.
- "Who do I know that..." -> intent find_people.
- "How do I know X" / "what's my connection to X" -> intent explain_link with person_name set.
- "Which/list ..." -> intent list_targets.
- semantic_query is the highest-leverage field. Write it as the *profile of an ideal match*, not as a restatement of the question. For "I want to find LPs", write something like: "Limited partner, institutional allocator or family office principal who commits capital to venture and private equity funds; endowment, pension or fund-of-funds background; makes fund investment decisions." Rich, concrete, and full of the vocabulary such a profile would contain.
- keywords are literal strings likely to appear verbatim: job titles, company names, acronyms.
- Set exclude_weak_awareness true when the user needs a warm route (an introduction, access, a favour). Set it false for pure discovery questions where any lead is useful.
- min_strength: 0.25 for warm-route requests, 0 for discovery. max_hops: 3 normally, 4 when the ask is hard or niche.

Be generous with entity_types: a request for company access usually wants people, but the organisation node is worth returning too.`;

/** Heuristic fallback so search still works without an API key. */
export function heuristicPlan(queryText: string): QueryPlan {
  const q = queryText.toLowerCase();
  const wantsPath = /\b(access|reach|intro|introduc|connect|get to|warm|path)\b/.test(q);
  const explain = /\bhow do i know\b|\bconnection to\b|\brelationship with\b/.test(q);
  const keywords = q
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .slice(0, 8);

  return {
    intent: explain ? "explain_link" : wantsPath ? "find_path" : "find_people",
    interpretation: `Keyword search for: ${keywords.join(", ")}`,
    semantic_query: queryText,
    entity_types: ["person", "organization", "fund"],
    org_match: null,
    person_name: null,
    keywords,
    sectors: [],
    constraints: {
      max_hops: wantsPath ? 3 : 4,
      min_strength: wantsPath ? 0.25 : 0,
      exclude_weak_awareness: wantsPath,
    },
  };
}

export async function planQuery(queryText: string): Promise<{ plan: QueryPlan; planner: "llm" | "heuristic" }> {
  if (!hasAnthropicKey()) return { plan: heuristicPlan(queryText), planner: "heuristic" };
  try {
    const { data } = await callStructured({
      system: PLANNER_SYSTEM,
      user: queryText,
      schema: QueryPlanSchema,
      // Planning is a small, well-specified transformation; high effort here
      // buys nothing and adds latency to every search.
      effort: "low",
      maxTokens: 2000,
    });
    return { plan: data, planner: "llm" };
  } catch {
    return { plan: heuristicPlan(queryText), planner: "heuristic" };
  }
}

const STOPWORDS = new Set([
  "want", "need", "find", "know", "some", "someone", "with", "that", "from", "into", "have",
  "help", "make", "give", "there", "their", "about", "would", "could", "should", "please",
  "anyone", "people", "person", "looking", "access", "intro", "introduction",
]);
