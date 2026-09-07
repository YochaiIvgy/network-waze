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
npm run dev          # http://localhost:3000
```

The workspace starts **empty**. There is no demo data and no way to load any —
every person in your graph got there from a transcript you supplied, which is the
only way the citations under each edge mean anything.

That works with **zero configuration**. With no `DATABASE_URL`, the app runs on an
embedded Postgres (PGlite — real Postgres compiled to WASM) persisted to
`./.waze-data`. To use a real server instead — Supabase, Neon, local — set
`DATABASE_URL` in `.env` and re-run `npm run db:push`; nothing else changes.

> **PGlite is single-writer.** Only one process may hold `./.waze-data` at a
> time. Stop `npm run dev` before running `db:push`, `ingest`, `reproject` or
> `verify`, or the WASM instance aborts and the directory is left corrupt
> (recover with `npm run db:reset`, then re-ingest). Setting
> `DATABASE_URL` removes the restriction entirely, which is the better setup once
> you are ingesting real meetings.

To ingest your own transcripts you need `ANTHROPIC_API_KEY`:

```bash
cp .env.example .env      # add your key
npm run ingest -- ./granola-export   # a file or a whole directory
```

Three other ways in, all landing in the same pipeline:

- **Connect Granola** in the app (Settings → Connect Granola). OAuth with PKCE and
  dynamic client registration; tokens are encrypted with a key derived from a
  secret that lives only in your cookie, so the `granola_sessions` row is useless
  on its own. You then browse your real meetings and extract one with a click.
- **Paste a transcript** into the import dialog.
- `npm run ingest` for a file or a whole export directory.

Re-ingesting the same note is a no-op — sources are keyed by content hash.

### Granola is a source, not the extractor

The Granola connection calls exactly two tools: `list_meetings` and
`get_meeting_transcript`. Its conversational `query_granola_meetings` tool is
deliberately never used for analysis. A chat endpoint cannot promise a schema, so
building a claim ledger on it means chunking the transcript, re-asking on failure,
and validating prose after the fact. Instead the raw transcript goes to one
structured model call that sees the whole meeting at once — which is also why a
relationship raised in minute 3 and confirmed in minute 40 becomes a single claim
with two quotes rather than two fragments to reconcile later.

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

**Who you are.** The graph is egocentric — every introduction path is computed
*from* one node. Open your own entity once it appears and choose **This is me**;
until you do, the app says so, paths have no origin, and search returns matches
without routes.

Full design rationale: **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | the app |
| `npm run db:push` | apply the schema (`--reset` to drop first) |
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
| `ANTHROPIC_API_KEY` | *(unset)* | Needed for ingestion and written answers. Browsing a graph you already built does not need it. |
| `WAZE_MODEL` | `claude-opus-5` | Extraction and answer model. |
| `WAZE_EMBEDDING_PROVIDER` | `hash` | `hash` is deterministic, offline and lexical — enough to get started. Set `voyage` (+ `VOYAGE_API_KEY`) for real semantic retrieval; it noticeably improves candidate ranking. |
| `WAZE_DATA_DIR` | `./.waze-data` | Embedded database location. |
| `WAZE_APP_ORIGIN` | *(unset)* | Only needed to connect Granola from a non-localhost deployment. The OAuth redirect URI is derived from the request origin, so this pins which origin may start a sign-in. |
| `WAZE_EXTRA_CA_CERTS` | *(unset)* | Optional extra PEM. On Windows the launcher already loads the OS trust store (same roots Avast / corporate proxies install). Set this only if that is not enough — see below. |

### HTTPS inspection

`network-analysis` talks to Granola from Cloudflare's workerd runtime, which
reads the Windows certificate store. This app is Next.js on Node, which does
not — so Avast (or a corporate proxy) re-signing HTTPS looks like a bad
certificate and Connect Granola fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

`npm run dev` already closes that gap: on Node 22.15+ it passes
`--use-system-ca`; on older Node on Windows it dumps Trusted Root CAs into
`NODE_EXTRA_CA_CERTS` before Next starts. Restart the server after a first
clone. You should not need a manual CA file.

If it still fails, export the interceptor's **root** CA as PEM and set
`WAZE_EXTRA_CA_CERTS` in `.env`, or turn off HTTPS scanning in the antivirus
(Avast: Protection → Core Shields → Web Shield → Enable HTTPS scanning).

---

## Layout

```
db/schema.sql          the five layers, commented, + granola_sessions
src/lib/extraction/    prompt + Zod contract + structural repair
src/lib/ingest/        Granola normalisation, the L0->L3 pipeline
src/lib/resolution/    blocking, feature scoring, merge/review decisions
src/lib/graph/         strength scoring, projection, Dijkstra, metrics
src/lib/search/        query planner, hybrid retrieval, answer composition
src/lib/granola/       OAuth + MCP transport, tolerant response readers
src/lib/view-model.ts  the one place the ledger is flattened for the UI
src/lib/network-layout.ts  deterministic clustered spring layout
src/app/page.tsx       the whole client: graph, directory, paths, ask, meetings, review
src/app/api/           graph, paths, ingest, search, review, granola
scripts/verify.ts      end-to-end assertions over the real pipeline
scripts/fixtures/      test fixtures for verify — never loaded into a workspace
```

The UI is a single client page against a small JSON surface, not a set of server
routes. `src/lib/view-model.ts` is the only file that knows both shapes: the UI
thinks in `person | organization` and one flat edge list because that is what a
canvas can draw, while the ledger keeps typed claims and score terms. Nothing
derived is flattened away in the translation — strength, warmth, traversal
probability and the per-term breakdown all reach the client, because the point of
an explicit scoring model is that you can see why an edge ranked where it did.

Views are deep-linkable: `/?view=Introduction%20paths`.

---

## Design

White with red accents, from the 46c mark; light and dark themes with an explicit
toggle. The red is reserved for the mark, the primary action, the "you" node and
the current selection — everything else is greyscale so the data stays the
loudest thing on screen.

The graph is a hand-written SVG canvas over a deterministic clustered spring
layout: connected components are seeded apart, then edges attract and nodes repel
for a fixed number of ticks. Determinism is the point — the same graph lays out
the same way on every reload, so the spatial memory you build of your own network
survives a refresh. Drag a node to rearrange it, drag the background to pan,
scroll to zoom; nodes are keyboard-reachable and arrow keys nudge them.

Edges are drawn at a weight and opacity taken from `strength`, and former ties are
dashed. That matters more than it sounds: awareness edges ("A mentioned B") are
the majority of any real graph, and drawing them at full strength makes the
picture look far denser and warmer than the evidence supports.

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
