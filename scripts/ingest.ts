import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { getWorkspace, closePool } from "../src/lib/db";
import { normalizeGranola } from "../src/lib/ingest/granola";
import { ingestSource } from "../src/lib/ingest/pipeline";

/**
 * Point this at a Granola export: a file or a directory of .json/.md/.txt notes.
 *
 *   npm run ingest -- ./exports
 *
 * Safe to re-run: sources are keyed by content hash, so already-ingested notes
 * are skipped rather than re-extracted.
 */
async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: npm run ingest -- <file-or-directory>");
    process.exit(1);
  }

  const ws = await getWorkspace();
  const files = collectFiles(target);
  if (files.length === 0) {
    console.error(`No .json, .md or .txt files found at ${target}`);
    process.exit(1);
  }

  console.log(`Ingesting ${files.length} file(s) into workspace "${ws.slug}"…\n`);
  let skipped = 0;

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const doc = normalizeGranola(raw, path.basename(file, path.extname(file)));
    process.stdout.write(`- ${doc.title} … `);
    try {
      const result = await ingestSource(ws.id, doc);
      if (result.alreadyIngested) {
        skipped++;
        console.log("already ingested, skipped");
        continue;
      }
      console.log(
        `${result.counts.people} people, ${result.counts.organizations} orgs, ` +
          `${result.counts.relationships} relationships → ` +
          `${result.entitiesCreated} new / ${result.entitiesMatched} matched` +
          (result.reviewsQueued ? `, ${result.reviewsQueued} to review` : ""),
      );
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
    }
  }

  if (skipped) console.log(`\n${skipped} file(s) already in the graph.`);
  await closePool();
}

function collectFiles(target: string): string[] {
  const stats = statSync(target);
  if (stats.isFile()) return [target];
  return readdirSync(target)
    .filter((f) => /\.(json|md|txt)$/i.test(f))
    .map((f) => path.join(target, f))
    .sort();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
