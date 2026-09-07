# Network Waze — Architecture

The goal is not "a database of people from my meetings." It is a **re-derivable
relationship graph whose edges carry enough context to act on**, and which gets
denser (not messier) every time a name is mentioned again.

Two decisions drive everything else:

1. **Observations are the source of truth; the graph is a projection.**
   Extraction is append-only. Entities and edges are *derived* and can be thrown
   away and rebuilt from the claim ledger at any time. When you improve the
   extractor a year from now, you re-run it over stored transcripts, append new
   claims, and re-project — you never migrate or hand-patch the graph.
2. **An edge is a hypothesis with evidence, not a boolean.**
   Every edge stores what was said, who said it, when, how confidently, and how
   warm it sounded. Path finding then reduces to a well-posed probability
   question rather than a vibe.

---

## The layers

```
L0  SOURCES        raw Granola transcript, immutable, content-hashed
        |            sources
        v
L1  OBSERVATIONS   append-only claim ledger - never updated, never deleted
        |            extraction_runs -> mentions -> claims
        v            (every row cites a source + a verbatim quote)
L2  RESOLUTION     which mentions are the same real person / org
        |            entities . entity_aliases . mention_links . entity_merges
        v
L3  PROJECTION     the graph, fully rebuildable from L1 + L2
        |            edges . edge_evidence . entity_metrics
        v
L4  INTELLIGENCE   dossiers, context cards, embeddings, brokerage scores
        |            entities.dossier . entities.embedding . edges.context_card
        v
L5  QUERY          NL -> plan -> hybrid retrieval -> path search -> ranked intros
                     search_queries (logged, so ranking can be tuned later)
```

`npm run reproject` rebuilds L2 through L4 from L1. That command existing and
working is the single best guarantee that the architecture is right.

---

## L0 — Sources

`sources` holds the raw transcript plus a `content_hash`. Re-ingesting the same
transcript is a no-op (idempotent by hash), so you can point the ingester at your
whole Granola export folder repeatedly without fear.

A Granola note has three usable regions and they are *not* equal in value:
the attendee list (identity, high precision), the AI summary (relationships,
compressed), and the raw transcript (the actual signal — hedges, warmth, "I've
known Sarah for years"). `lib/ingest/granola.ts` normalises all three into one
document, tagging each region, because the extractor should trust the attendee
list for spelling and the transcript for relationship nuance.

## L1 — Observations (the claim ledger)

The unit is not "a person." It is **a mention** and **a claim**.

- `mentions` — one row per time an entity is referred to in a source, with the
  surface form (`Sarah`, `Sarah Chen`, `the Lockheed woman`), the verbatim quote,
  and a `disambiguation_context` blob the extractor writes specifically to help
  the resolver later.
- `claims` — atomic, quoted facts. Three shapes:
  - *attribute*: `subject=m1, predicate="title", value="GP at Northlane"`
  - *relationship*: `subject=m1, object=m2, predicate="former_colleague"`
  - *capability*: `subject=m1, predicate="can_intro_to", object=m7`

Every claim carries `confidence`, `polarity` (so "Dana no longer works there" is
representable), `quote`, and `extractor_version`. Nothing is ever overwritten —
contradiction is normal, and is resolved at projection time by recency and
weight, not by destroying the older claim.

**Why this matters for the future:** "add natural-language search over the
network" is easy on a claim ledger and painful on a mutated graph, because every
answer needs citations back to what was actually said.

## L2 — Entity resolution (the anti-duplicate layer)

The hard requirement: *the same person mentioned in fifteen meetings is one node.*
Naive name matching fails in both directions — two different Johns collapse, while
"Sarah" and "Sarah Chen" stay split.

Pipeline, per mention:

1. **Blocking** — cheap candidate generation, never a full scan: `normalized_name`
   key, last-name key, first-initial + last key, email, org domain, and a
   co-mention key (people seen in the same meeting).
2. **Feature scoring** — a linear model over interpretable features, not one
   opaque similarity:

   | feature | weight | notes |
   |---|---|---|
   | Jaro-Winkler on normalized name | 0.30 | |
   | exact email / handle match | 0.45 | near-decisive on its own |
   | shared organization | 0.20 | |
   | dossier embedding cosine | 0.20 | catches "the Lockheed woman" |
   | shared-neighbour overlap (Adamic-Adar) | 0.15 | strongest real-world signal |
   | title / seniority compatibility | 0.05 | |
   | first-name-only penalty | -0.35 | see below |
   | same-source-different-person | -1.00 | hard block |

3. **Three-way decision** — at or above `0.82` auto-merge, at or below `0.45`
   auto-reject, and the band between goes to `resolution_reviews` for LLM
   adjudication (and, if still uncertain, a human queue in the UI). Never a silent
   coin-flip.

Two rules prevent most real-world corruption:

- **A first-name-only mention never creates a global entity.** It resolves inside
  the meeting's local scope (attendees plus orgs discussed) or stays a dangling
  mention until corroborated. This is the single most common way naive systems
  merge four different Michaels.
- **Two mentions in the same source are presumed distinct** unless the transcript
  explicitly equates them ("Sarah — Sarah Chen, our GP —").

Merges are recorded in `entity_merges` with the winning and losing ids, the score,
and the evidence. `undone_at` makes every merge reversible; `mention_links` are
re-pointed, so unmerging is a projection concern rather than surgery.

## L3 — The graph projection

`edges` are aggregates over `claims`, deduplicated on
`(src_entity, dst_entity, relationship_type)`. Each edge accumulates:

| column | meaning |
|---|---|
| `relationship_type` | typed: `colleague`, `former_colleague`, `investor_in`, `advisor_to`, `friend`, `reports_to`, `board_member`, `client_of`, `introduced_by`, `met_with`, `mentioned` |
| `strength` | 0-1, recomputed from evidence (below) |
| `warmth` | 0-1, tone of how the relationship was described |
| `evidence_count`, `source_diversity` | how many claims, how many distinct meetings |
| `first_seen`, `last_seen` | temporal envelope |
| `context_card` | the narrative: *how* they know each other, with citations |
| `attributes` | tenure, overlap window, deal, shared history |

**Strength** is deliberately explicit rather than learned:

```
base      = max(explicitness weight of each supporting claim)   # stated > inferred
volume    = 1 - exp(-evidence_count / 3)                        # saturating
diversity = 1 - exp(-distinct_sources / 2)
recency   = 0.5 ^ (months_since_last_seen / 18)                 # 18-month half-life
strength  = clamp(base * (0.55 + 0.25*volume + 0.20*diversity)
                       * (0.35 + 0.65*recency))
```

Every term is inspectable in the UI, so when a path looks wrong you can see
*which* term made it wrong. That is what makes the ranking tunable later.

Two implicit edge types are generated, and keeping them **separate** from stated
relationships matters:

- `met_with` — every pair of attendees in a meeting. Real, but weak.
- `mentioned` — A talked about B. This is *awareness*, not a relationship, and it
  gets a low traversal probability. Collapsing these into "knows" is the fastest
  way to produce confident, wrong intro paths.

## L4 — Intelligence

- **Entity dossier** — a regenerated prose summary of everything known about an
  entity, with citations. It is what gets embedded, what the resolver compares,
  and what an outreach draft is grounded in.
- **Outreach hooks** — extracted separately (`claims.predicate = 'outreach_hook'`):
  personal details, timing, live asks. This is the difference between "I see you
  know Sarah" and "Sarah mentioned in March that she's raising for fund II."
- **Metrics** — degree, weighted degree, and a **brokerage** score (how much of the
  graph is reachable *only* through this person). Brokers are who you actually
  want to call.

## L5 — Query

```
"I need Lockheed Martin access"
        |
        |- 1. PLAN      LLM -> { intent: find_path,
        |                        target: { org_match: "Lockheed Martin",
        |                                  predicates: ["works_at", "defense procurement"] },
        |                        constraints: { min_strength: 0.3 } }
        |
        |- 2. RETRIEVE  hybrid: embedding cosine over dossiers
        |               intersected with structured filters (type, org, tags, attributes)
        |               -> candidate target set
        |
        |- 3. PATH      Dijkstra from `self` over cost = -ln(p_traverse)
        |               p_traverse = strength * warmth_factor * type_prior * recency
        |               => additive cost, so total path score = product of hop
        |               probabilities. k-shortest paths, capped at 4 hops.
        |
        `- 4. COMPOSE   LLM writes each path as: who to ask, what to say, why they
                        can help, quoting the meetings. Citations are mandatory.
```

The `-ln(p)` transform is why paths are correct rather than heuristic: the
shortest path under that cost function *is* the maximum-likelihood introduction
chain. A three-hop chain of strong ties can and should beat a two-hop chain of
weak ones, and here it does so for a principled reason.

`search_queries` logs the plan, the candidates, and the chosen paths — and, once
you record whether an intro actually worked, becomes the training set for tuning
the weights above.

---

## Deliberate choices worth knowing

**Postgres only; no graph database.** Path finding here is Dijkstra over a graph
that fits in memory (tens of thousands of nodes covers any realistic personal
network). The projection is loaded and cached in `lib/graph/graph-cache.ts`.
Neo4j earns its keep at millions of edges, or with truly variable-length pattern
queries; adopting it now would buy a second consistency domain for no gain.
`lib/graph/paths.ts` is the only file that would change.

**Embeddings in `real[]`, cosine computed in the app.** Brute-force cosine over
10k x 1024 floats is about 15ms — genuinely faster than a round trip to an ANN
index at this size, and it means the app runs on stock Postgres with no
extensions. `lib/search/vector-index.ts` is the seam: swap it for pgvector and an
`ivfflat` index when entity count passes ~100k. The migration is sketched in
`db/schema.sql`.

**Extraction returns structured output, not JSON-in-prose.** `messages.parse()`
with a Zod schema (`lib/extraction/schema.ts`) means a malformed extraction is a
type error rather than a 3am parse failure. The long transcript sits *after* the
cached system prefix, so re-runs and multi-pass extraction hit the prompt cache.

**`extractor_version` on every row.** Mixed-version claims coexist. Re-projection
can weight v2 claims above v1, or filter v1 out entirely, with no migration.
