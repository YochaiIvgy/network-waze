-- Network Waze schema.
--
-- Layering (see ARCHITECTURE.md):
--   L0 sources                          immutable raw input
--   L1 extraction_runs/mentions/claims  append-only observation ledger
--   L2 entities/aliases/mention_links   resolution
--   L3 edges/edge_evidence/metrics      graph projection (rebuildable)
--   L5 search_queries                   query log
--
-- Everything from L2 down is derived. `npm run reproject` truncates it and
-- rebuilds from L1. Never hand-edit those tables.

-- gen_random_uuid() is in core Postgres since 13; no extension required.

-- ---------------------------------------------------------------------------
-- Workspace + identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE,
  name          text NOT NULL,
  -- The graph is egocentric: every path is computed *from* this entity.
  self_entity_id uuid,
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- L0 — Sources
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'granola_meeting',   -- granola_meeting | note | manual | email
  external_id   text,                                      -- Granola note id, if any
  title         text NOT NULL,
  occurred_at   timestamptz,
  -- Normalised document: attendee block + summary block + transcript block,
  -- each region tagged so the extractor can weigh them differently.
  body          text NOT NULL,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,        -- untouched original payload
  content_hash  text NOT NULL,                             -- idempotent re-ingest
  attendee_hints jsonb NOT NULL DEFAULT '[]'::jsonb,       -- names/emails from the calendar invite
  token_estimate int,
  ingested_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, content_hash)
);

CREATE INDEX IF NOT EXISTS sources_ws_occurred_idx ON sources (workspace_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- L1 — Observations (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS extraction_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  extractor_version text NOT NULL,
  model             text NOT NULL,
  prompt_hash       text NOT NULL,
  status            text NOT NULL DEFAULT 'pending',  -- pending | succeeded | failed
  error             text,
  usage             jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_output        jsonb,                             -- the full validated extraction
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

CREATE INDEX IF NOT EXISTS extraction_runs_source_idx ON extraction_runs (source_id, started_at DESC);

-- One row per reference to an entity inside one source.
CREATE TABLE IF NOT EXISTS mentions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  source_id     uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  local_ref     text NOT NULL,            -- "p1"/"o2": stable within one extraction
  entity_type   text NOT NULL,            -- person | organization | fund | topic | event
  surface_form  text NOT NULL,            -- exactly as said
  normalized    text NOT NULL,            -- casefolded, de-accented, honorifics stripped
  is_first_name_only boolean NOT NULL DEFAULT false,
  role_in_source text,                    -- attendee | speaker | mentioned | third_party
  -- Written by the extractor *for the resolver*: the distinguishing details.
  disambiguation_context text,
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- title, org, email, location, seniority...
  quote         text,
  confidence    real NOT NULL DEFAULT 0.5,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, local_ref)
);

CREATE INDEX IF NOT EXISTS mentions_source_idx     ON mentions (source_id);
CREATE INDEX IF NOT EXISTS mentions_normalized_idx ON mentions (normalized);

-- Atomic, quoted facts. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            uuid NOT NULL REFERENCES extraction_runs(id) ON DELETE CASCADE,
  source_id         uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  claim_type        text NOT NULL,        -- attribute | relationship | capability | hook | commitment
  subject_mention_id uuid REFERENCES mentions(id) ON DELETE CASCADE,
  object_mention_id  uuid REFERENCES mentions(id) ON DELETE CASCADE,
  predicate         text NOT NULL,        -- title | works_at | former_colleague | can_intro_to | outreach_hook ...
  value             jsonb NOT NULL DEFAULT '{}'::jsonb,
  quote             text,                 -- verbatim support; the citation shown in the UI
  -- stated: said outright. reported: second-hand. inferred: model deduced it.
  explicitness      text NOT NULL DEFAULT 'stated',
  polarity          smallint NOT NULL DEFAULT 1,   -- 1 asserted, -1 negated ("no longer works there")
  warmth            real,                 -- 0..1, tone of the described relationship
  confidence        real NOT NULL DEFAULT 0.5,
  observed_at       timestamptz,          -- when the fact was true, if datable
  extractor_version text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_subject_idx ON claims (subject_mention_id);
CREATE INDEX IF NOT EXISTS claims_object_idx  ON claims (object_mention_id);
CREATE INDEX IF NOT EXISTS claims_source_idx  ON claims (source_id);
CREATE INDEX IF NOT EXISTS claims_pred_idx    ON claims (predicate);

-- ---------------------------------------------------------------------------
-- L2 — Resolution (derived)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS entities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type   text NOT NULL,            -- person | organization | fund | topic | event
  canonical_name text NOT NULL,
  normalized    text NOT NULL,
  -- Merged aliases live in entity_aliases; this is just the best display form.
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- title, org, email, location, tags, sector...
  dossier       text,                     -- regenerated prose summary, with citations
  embedding     real[],                   -- dossier embedding; see vector-index.ts
  mention_count int NOT NULL DEFAULT 0,
  source_count  int NOT NULL DEFAULT 0,
  first_seen    timestamptz,
  last_seen     timestamptz,
  status        text NOT NULL DEFAULT 'active',   -- active | merged | needs_review
  merged_into   uuid REFERENCES entities(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entities_ws_type_idx    ON entities (workspace_id, entity_type) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS entities_normalized_idx ON entities (workspace_id, normalized);

-- Blocking keys: cheap candidate generation for resolution. One entity has many.
CREATE TABLE IF NOT EXISTS entity_aliases (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias       text NOT NULL,
  normalized  text NOT NULL,
  kind        text NOT NULL DEFAULT 'name',   -- name | email | handle | domain | block_key
  confidence  real NOT NULL DEFAULT 1.0,
  UNIQUE (entity_id, normalized, kind)
);

CREATE INDEX IF NOT EXISTS entity_aliases_lookup_idx ON entity_aliases (normalized, kind);

CREATE TABLE IF NOT EXISTS mention_links (
  mention_id  uuid PRIMARY KEY REFERENCES mentions(id) ON DELETE CASCADE,
  entity_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  method      text NOT NULL,          -- exact | blocked_score | llm_adjudicated | manual | new_entity
  score       real NOT NULL DEFAULT 1.0,
  features    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- the per-feature breakdown, for debugging
  decided_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mention_links_entity_idx ON mention_links (entity_id);

-- Reversible merge log.
CREATE TABLE IF NOT EXISTS entity_merges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  winner_id   uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  loser_id    uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  score       real NOT NULL,
  method      text NOT NULL,
  evidence    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  undone_at   timestamptz
);

-- Ambiguous pairs parked for adjudication instead of being guessed.
CREATE TABLE IF NOT EXISTS resolution_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mention_id   uuid REFERENCES mentions(id) ON DELETE CASCADE,
  candidate_id uuid REFERENCES entities(id) ON DELETE CASCADE,
  score        real NOT NULL,
  features     jsonb NOT NULL DEFAULT '{}'::jsonb,
  verdict      text,                 -- same | different | unsure
  decided_by   text,                 -- llm | human
  rationale    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);

CREATE INDEX IF NOT EXISTS resolution_reviews_open_idx
  ON resolution_reviews (workspace_id) WHERE verdict IS NULL;

-- ---------------------------------------------------------------------------
-- L3 — Graph projection (derived)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edges (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  src_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  directed      boolean NOT NULL DEFAULT false,
  -- The intelligence on the edge:
  strength      real NOT NULL DEFAULT 0,    -- 0..1, recomputed on projection
  warmth        real NOT NULL DEFAULT 0.5,  -- 0..1
  confidence    real NOT NULL DEFAULT 0.5,
  evidence_count   int NOT NULL DEFAULT 0,
  source_diversity int NOT NULL DEFAULT 0,
  first_seen    timestamptz,
  last_seen     timestamptz,
  context_card  text,                       -- "how they know each other", with citations
  attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,  -- tenure, deal, shared history, score terms
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_entity_id, dst_entity_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS edges_src_idx ON edges (src_entity_id);
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges (dst_entity_id);
CREATE INDEX IF NOT EXISTS edges_ws_idx  ON edges (workspace_id);

CREATE TABLE IF NOT EXISTS edge_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id     uuid NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  claim_id    uuid REFERENCES claims(id) ON DELETE CASCADE,
  source_id   uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote       text,
  weight      real NOT NULL DEFAULT 1.0,
  observed_at timestamptz,
  UNIQUE (edge_id, claim_id)
);

CREATE INDEX IF NOT EXISTS edge_evidence_edge_idx ON edge_evidence (edge_id);

CREATE TABLE IF NOT EXISTS entity_metrics (
  entity_id       uuid PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  degree          int  NOT NULL DEFAULT 0,
  weighted_degree real NOT NULL DEFAULT 0,
  reachability    int  NOT NULL DEFAULT 0,  -- nodes within 3 hops
  brokerage       real NOT NULL DEFAULT 0,  -- share of graph reachable only through them
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- L5 — Query log (feeds ranking improvements)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS search_queries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_text   text NOT NULL,
  plan         jsonb,
  candidates   jsonb,
  paths        jsonb,
  answer       text,
  latency_ms   int,
  outcome      text,          -- later: intro_made | ignored | dead_end
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_queries_ws_idx ON search_queries (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Scaling note: pgvector migration
-- ---------------------------------------------------------------------------
-- Embeddings live in `entities.embedding real[]` and cosine runs in the app
-- (lib/search/vector-index.ts). That is faster than an ANN round trip below
-- ~100k entities and keeps the app on stock Postgres. To switch:
--
--   CREATE EXTENSION vector;
--   ALTER TABLE entities ADD COLUMN embedding_v vector(1024);
--   UPDATE entities SET embedding_v = embedding::vector WHERE embedding IS NOT NULL;
--   CREATE INDEX ON entities USING ivfflat (embedding_v vector_cosine_ops) WITH (lists = 200);
--
-- then reimplement `topK` in vector-index.ts as an ORDER BY embedding_v <=> $1.
-- No other file changes.

-- ---------------------------------------------------------------------------
-- Granola connection (transport only)
-- ---------------------------------------------------------------------------
-- Granola supplies transcripts; it does not extract anything. See
-- lib/granola/client.ts and ARCHITECTURE.md ("L0 — Sources").
--
-- `id` is SHA-256 of a random secret held only in the user's cookie, and `data`
-- is AES-GCM ciphertext keyed from that same secret. A dump of this table
-- therefore contains no usable Granola credentials.

CREATE TABLE IF NOT EXISTS granola_sessions (
  id          text PRIMARY KEY,
  data        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS granola_sessions_expiry_idx ON granola_sessions (expires_at);
