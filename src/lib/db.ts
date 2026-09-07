import type { QueryResultRow } from "pg";
import { env } from "./env";

/**
 * Data access.
 *
 * Two backends behind one interface:
 *  - `DATABASE_URL` set  -> node-postgres against a real server (Supabase, Neon, local).
 *  - `DATABASE_URL` unset -> PGlite, real Postgres compiled to WASM, persisted to
 *    ./.waze-data. Same SQL, same semantics, no server to install. Good for a
 *    first run and for tests; use a real server for anything shared.
 */

export interface QueryResultLike<T> {
  rows: T[];
  rowCount: number;
}

export interface ClientLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResultLike<T>>;
  release(): void;
}

export interface PoolLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResultLike<T>>;
  connect(): Promise<ClientLike>;
  end(): Promise<void>;
}

declare global {
  // Next dev reloads modules; keep one pool per process.
  // eslint-disable-next-line no-var
  var __wazePool: PoolLike | undefined;
  // eslint-disable-next-line no-var
  var __wazePoolPromise: Promise<PoolLike> | undefined;
}

/** Test seam: lets a harness inject an in-memory pool. */
export function setPool(p: PoolLike) {
  globalThis.__wazePool = p;
  globalThis.__wazePoolPromise = Promise.resolve(p);
}

export function isEmbedded(): boolean {
  return !env.databaseUrl;
}

/** Opaque to bundlers: resolved by Node at runtime, never traced by webpack. */
async function loadPg(): Promise<typeof import("pg")> {
  const specifier = "pg";
  return import(/* webpackIgnore: true */ /* turbopackIgnore: true */ specifier);
}

async function createPool(): Promise<PoolLike> {
  if (env.databaseUrl) {
    // Loaded through an opaque specifier so the bundler never walks into `pg`.
    // It pulls in `fs` and `pg-native`, which break the edge/instrumentation
    // compile even though this branch only ever runs under Node.
    const { Pool } = await loadPg();
    const pool = new Pool({
      connectionString: env.databaseUrl,
      max: 8,
      // Hosted Postgres needs TLS; a local server does not.
      ssl: /supabase|amazonaws|neon|render|azure/.test(env.databaseUrl)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    return pool as unknown as PoolLike;
  }
  return createEmbeddedPool();
}

/**
 * PGlite: genuine Postgres, in-process. Persisted to disk by default; pass
 * "memory://" for a throwaway instance (that is what the verify harness uses).
 */
export async function createEmbeddedPool(dataDir = env.embeddedDataDir): Promise<PoolLike> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create({ dataDir });

  const run = async <T extends QueryResultRow>(text: string, params?: unknown[]) => {
    // Multi-statement strings (the schema file) must go through `exec`.
    if (!params || params.length === 0) {
      const results = await db.exec(text);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? 0 };
    }
    const res = await db.query<T>(text, params as never[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  };

  const client: ClientLike = { query: run, release: () => undefined };
  return {
    query: run,
    connect: async () => client,
    end: async () => db.close(),
  };
}

export async function getPool(): Promise<PoolLike> {
  if (globalThis.__wazePool) return globalThis.__wazePool;
  if (!globalThis.__wazePoolPromise) {
    globalThis.__wazePoolPromise = createPool().then((p) => {
      globalThis.__wazePool = p;
      return p;
    });
  }
  return globalThis.__wazePoolPromise;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const pool = await getPool();
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Ingestion and re-projection are all-or-nothing: a half-written claim ledger is
 * worse than no ledger, because every derived layer is rebuilt from it.
 */
export async function transaction<T>(fn: (c: ClientLike) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  const pool = globalThis.__wazePool;
  globalThis.__wazePool = undefined;
  globalThis.__wazePoolPromise = undefined;
  if (pool) await pool.end();
}

export async function getWorkspace(slug = env.workspaceSlug) {
  const row = await one<{ id: string; slug: string; name: string; self_entity_id: string | null }>(
    `SELECT id, slug, name, self_entity_id FROM workspaces WHERE slug = $1`,
    [slug],
  );
  if (!row) {
    throw new Error(
      `Workspace "${slug}" not found. Run \`npm run db:push\` (then \`npm run db:seed\` for the demo network).`,
    );
  }
  return row;
}
