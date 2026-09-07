# Network Waze

Turns Granola meeting transcripts into a relationship graph you can route through.

Not a CRM and not a summariser. It reads what was actually said, extracts the
people and organisations *and the intelligence on the edges between them*, merges
each name into one canonical entity as it recurs, and then answers questions like
**"I need Lockheed Martin access"** with a ranked introduction path and the quotes
that justify it.

---

## Quick start

```bash
npm install
npm run db:push      # create the schema
npm run db:seed      # load a demo network (no API key needed)
npm run dev          # http://localhost:3000
```

That works with **zero configuration**. With no `DATABASE_URL`, the app runs on an
embedded Postgres (PGlite — real Postgres compiled to WASM) persisted to
`./.waze-data`. To use a real server instead — Supabase, Neon, local — set
`DATABASE_URL` in `.env` and re-run `npm run db:push`; nothing else changes.

To ingest your own transcripts you need `ANTHROPIC_API_KEY`:

```bash
cp .env.example .env      # add your key
npm run ingest -- ./granola-export   # a file or a whole directory
```

Or paste one into the **Add transcript** page. Re-ingesting the same note is a
no-op — sources are keyed by content hash.

---

## What it does

**Extraction.** One structured call per meeting (`claude-opus-5`, Zod-validated
output) pulls out people, organisations, typed relationships, introduction
opportunities, asks, commitments and outreach hooks. Every one carries a verbatim
quote — no quote, no claim. The prompt is tuned for the signal that actually
matters: relationships *between third parties* ("I worked with Dana at Palantir",
"she was my commanding officer"), not just who was on the call.

**Deduplication.** The same person mentioned across fifteen meetings is one node.
Resolution blocks on name/email/employer keys, scores candidates on six
interpretable features, and splits three ways: auto-merge, auto-reject, or a
review queue. A first name with nothing to pin it to never becomes a node — that
is how naive systems merge four different Michaels.

**Edge intelligence.** An edge is not a boolean. It stores relationship type,
strength, warmth, evidence count, source diversity, first/last seen, a narrative
context card, and the score terms that produced its strength — so a wrong ranking
is diagnosable. Former ties are kept and discounted, never deleted: an ex-employee
is often the best route in. Awareness ("A talked about B") is a separate edge type
with a low traversal prior, because collapsing it into "knows" is how you generate
confident, wrong introductions.

**Routing.** Path finding is Dijkstra over `cost = -ln(p_traverse)`, so the
shortest path *is* the maximum-likelihood introduction chain. A three-hop chain of
strong ties beats a two-hop chain of weak ones for a principled reason, not a
heuristic one.

**Natural language.** "I want to find LPs" → a typed retrieval plan → hybrid
search over entity dossiers → routes from you → a written answer with citations.
The plan is returned alongside the answer, so a bad result is traceable to a bad
plan or a thin graph rather than to an opaque box.

Full design rationale: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | the app |
| `npm run db:push` | apply the schema (`--reset` to drop first) |
| `npm run db:seed` | load the demo network through the real pipeline |
| `npm run ingest -- <path>` | ingest a Granola file or directory |
| `npm run reproject` | **rebuild the entire graph from the claim ledger** |
| `npm run verify` | end-to-end smoke test, in-memory, no key needed |
| `npm run typecheck` | `tsc --noEmit` |

`reproject` is the one worth understanding. Observations are append-only and
everything below them is derived, so you can change resolution weights, edge
scoring or the dossier format and rebuild the whole graph from the transcripts you
already paid to extract. Improving the extractor later means re-running it and
re-projecting — never a migration.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | *(unset)* | Unset → embedded PGlite at `./.waze-data`. Any Postgres 14+ works. |
| `ANTHROPIC_API_KEY` | *(unset)* | Needed for ingestion and written answers. Browsing a seeded graph does not need it. |
| `WAZE_MODEL` | `claude-opus-5` | Extraction and answer model. |
| `WAZE_EMBEDDING_PROVIDER` | `hash` | `hash` is deterministic, offline and lexical — fine for the demo. Set `voyage` (+ `VOYAGE_API_KEY`) for real semantic retrieval; it noticeably improves candidate ranking. |
| `WAZE_DATA_DIR` | `./.waze-data` | Embedded database location. |

---

## Layout

```
db/schema.sql          the five layers, commented
db/seed-data.ts        demo meetings + hand-authored extractions
src/lib/extraction/    prompt + Zod contract + structural repair
src/lib/ingest/        Granola normalisation, the L0->L3 pipeline
src/lib/resolution/    blocking, feature scoring, merge/review decisions
src/lib/graph/         strength scoring, projection, Dijkstra, metrics
src/lib/search/        query planner, hybrid retrieval, answer composition
src/app/               overview, graph, people, profiles, meetings, ask, ingest, review
scripts/verify.ts      end-to-end assertions over the real pipeline
```

---

## Design

White with red accents, from the 46c mark; light and dark themes with an explicit
toggle (right-click it to fall back to the OS setting). The red is reserved for
the mark, the primary action, the "you" node and the current selection —
everything else is greyscale so the data stays the loudest thing on screen.

Entity-type colours were validated with a palette checker: all-pairs
colour-vision separation, chroma floor, lightness band and surface contrast all
pass in **both** themes, and every colour ships beside a text label so identity is
never carried by colour alone. The graph is a purpose-built canvas force layout —
strong ties pull tighter, former ties are dashed, awareness edges are dotted.

---

## Verified

`npm run verify` runs the real pipeline against an in-memory Postgres and asserts
the behaviour that is easy to silently break:

```
[PASS] Sarah Chen is a single node across all 5 meetings
[PASS] Marcus Webb merged across mention-then-attendance
[PASS] "Jen" (first name, no org) did NOT become a global node
[PASS] no duplicate organisations
[PASS] negated relationships survive as former ties
[PASS] awareness kept separate from relationships
[PASS] a route to Janet Reyes exists, and runs through Marcus Webb
[PASS] LP search surfaces the allocators
```
