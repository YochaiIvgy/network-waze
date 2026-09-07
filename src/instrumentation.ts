/**
 * Runs once at server startup, before any request is rendered.
 *
 * The embedded Postgres is a WASM module, and bringing it up moves a large
 * ArrayBuffer around. Doing that *during* a streamed RSC render detaches the
 * buffers Next is holding for the response, and the request dies with
 * "The ArrayBuffer could not be transferred". Opening the pool here moves all of
 * it before the first render — and removes a multi-second stall from the first
 * page load as a side effect.
 *
 * Harmless with a real DATABASE_URL: it just opens the connection pool early.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getPool } = await import("./lib/db");
    const pool = await getPool();
    // PGlite defers part of its start-up until a statement actually runs.
    await pool.query("SELECT 1");
  } catch {
    // An unconfigured or unreachable database is a normal first-run state — the
    // pages render a setup screen for it rather than the server failing to boot.
  }
}
