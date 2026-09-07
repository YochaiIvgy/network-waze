import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { closePool, query } from "../src/lib/db";
import { env } from "../src/lib/env";

const here = path.dirname(fileURLToPath(import.meta.url));

const DERIVED_TABLES = [
  "search_queries",
  "edge_evidence",
  "entity_metrics",
  "edges",
  "resolution_reviews",
  "entity_merges",
  "mention_links",
  "entity_aliases",
  "entities",
];

const ALL_TABLES = [...DERIVED_TABLES, "claims", "mentions", "extraction_runs", "sources", "granola_sessions", "workspaces"];

async function main() {
  const reset = process.argv.includes("--reset");
  console.log(
    env.databaseUrl
      ? `Using DATABASE_URL.`
      : `No DATABASE_URL set — using the embedded PGlite database at ${env.embeddedDataDir}.`,
  );

  if (reset) {
    console.log("Dropping existing tables…");
    await query(`DROP TABLE IF EXISTS ${ALL_TABLES.join(", ")} CASCADE`);
  }

  const schema = readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");
  await query(schema);
  console.log("Schema applied.");

  await query(
    `INSERT INTO workspaces (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING`,
    [env.workspaceSlug, "My Network"],
  );
  console.log(`Workspace "${env.workspaceSlug}" ready.`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
