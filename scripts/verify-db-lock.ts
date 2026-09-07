import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddedPool } from "../src/lib/db";
async function main() {
 const root = await mkdtemp(join(tmpdir(), "waze-db-lock-"));
 let pool: Awaited<ReturnType<typeof createEmbeddedPool>> | undefined;
 try {
  process.env.NEXT_PHASE = "phase-production-build";
  await assert.rejects(() => createEmbeddedPool(root), /production build/);
  delete process.env.NEXT_PHASE;
  pool = await createEmbeddedPool(root);
  await pool.query("CREATE TABLE preserved (value text); INSERT INTO preserved VALUES ('kept')");
  await assert.rejects(() => createEmbeddedPool(root), /already open/);
  await pool.end(); pool = undefined;
  pool = await createEmbeddedPool(root);
  assert.equal((await pool.query("SELECT value FROM preserved")).rows[0].value, "kept");
  console.log("Build guard, exclusive database access, and persistence checks passed.");
 } finally { delete process.env.NEXT_PHASE; await pool?.end(); await rm(root, {recursive:true,force:true}); }
}
main().catch(e=>{console.error(e);process.exitCode=1});
