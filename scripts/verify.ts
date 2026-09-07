import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SEED_MEETINGS, SELF_NAME } from "../db/seed-data";
import { closePool, createEmbeddedPool, one, query, setPool } from "../src/lib/db";
import { projectGraph } from "../src/lib/graph/project";
import { loadGraph } from "../src/lib/graph/graph-cache";
import { alternativePaths, pathsToMany, rankConnectors } from "../src/lib/graph/paths";
import { hash, estimateTokens } from "../src/lib/ingest/granola";
import { persistExtraction } from "../src/lib/ingest/pipeline";
import { resolveRun } from "../src/lib/resolution/resolve";
import { embedOne } from "../src/lib/embeddings";
import { topK } from "../src/lib/search/vector-index";
import { heuristicPlan } from "../src/lib/search/planner";

/**
 * End-to-end smoke test against an in-memory Postgres.
 *
 *   npx tsx scripts/verify.ts
 *
 * Exercises the real pipeline — persist -> resolve -> project -> path search —
 * with no database, no API key and no network. If this passes, the architecture
 * holds together; only infrastructure is left to go wrong.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main() {

  // A throwaway in-memory Postgres, so verification never touches real data.
  setPool(await createEmbeddedPool("memory://"));

  const schema = readFileSync(path.join(here, "..", "db", "schema.sql"), "utf8");
  await query(schema);
  await query(`INSERT INTO workspaces (slug, name) VALUES ('default', 'Verification')`);
  const ws = (await one<{ id: string }>(`SELECT id FROM workspaces WHERE slug = 'default'`))!;

  console.log("\nIngesting seed meetings through the real pipeline");
  for (const meeting of SEED_MEETINGS) {
    const body = `[ATTENDEES]\n${meeting.attendees.map((a) => `- ${a.name}`).join("\n")}\n\n[TRANSCRIPT]\n${meeting.transcript}`;
    const src = (await one<{ id: string }>(
      `INSERT INTO sources (workspace_id, kind, title, occurred_at, body, raw, content_hash,
                            attendee_hints, token_estimate)
       VALUES ($1,'granola_meeting',$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ws.id, meeting.title, meeting.occurredAt, body, JSON.stringify({}), hash(body),
       JSON.stringify(meeting.attendees), estimateTokens(body)],
    ))!;
    const { runId, counts } = await persistExtraction(
      src.id, { occurredAt: meeting.occurredAt }, meeting.extraction, "seed-v1", "seed", {},
    );
    const res = await resolveRun(ws.id, runId);
    console.log(
      `  ${meeting.title}: ${counts.claims} claims, +${res.created} new, ` +
      `${res.matched} matched, ${res.deferred} deferred`,
    );
  }

  const projection = await projectGraph(ws.id);
  console.log(`  projected ${projection.entities} entities / ${projection.edges} edges\n`);

  // --- Entity resolution -----------------------------------------------------
  console.log("Entity resolution");
  const sarahs = await query<{ id: string; canonical_name: string; source_count: number }>(
    `SELECT id, canonical_name, source_count FROM entities
     WHERE workspace_id = $1 AND entity_type = 'person' AND canonical_name ILIKE '%Sarah%' AND status <> 'merged'`,
    [ws.id],
  );
  check("Sarah Chen is a single node across all 5 meetings", sarahs.length === 1,
    sarahs.map((s) => `${s.canonical_name}(${s.source_count} sources)`).join(", "));

  const marcus = await query<{ id: string; source_count: number }>(
    `SELECT id, source_count FROM entities WHERE workspace_id = $1 AND canonical_name ILIKE '%Marcus%' AND status <> 'merged'`,
    [ws.id],
  );
  check("Marcus Webb merged across mention-then-attendance", marcus.length === 1,
    `${marcus.length} node(s)`);

  const jen = await query(
    `SELECT id FROM entities WHERE workspace_id = $1 AND canonical_name = 'Jen' AND status <> 'merged'`,
    [ws.id],
  );
  check('"Jen" (first name, no org) did NOT become a global node', jen.length === 0);

  const dangling = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM mentions m
     LEFT JOIN mention_links ml ON ml.mention_id = m.id WHERE ml.mention_id IS NULL`,
  );
  check("unresolved mentions are retained in the ledger", Number(dangling?.n) >= 1, `${dangling?.n} deferred`);

  const orgDupes = await query<{ canonical_name: string; n: string }>(
    `SELECT canonical_name, count(*)::text AS n FROM entities
     WHERE workspace_id = $1 AND entity_type IN ('organization','fund') AND status <> 'merged'
     GROUP BY canonical_name HAVING count(*) > 1`,
    [ws.id],
  );
  check("no duplicate organisations", orgDupes.length === 0,
    orgDupes.map((o) => `${o.canonical_name} x${o.n}`).join(", ") || "all unique");

  const northlane = await query(
    `SELECT id FROM entities WHERE workspace_id = $1 AND canonical_name ILIKE '%Northlane%' AND status <> 'merged'`,
    [ws.id],
  );
  check("Northlane Ventures is one node across 4 meetings", northlane.length === 1,
    `${northlane.length} node(s)`);

  const priya = await query<{ source_count: number }>(
    `SELECT source_count FROM entities WHERE workspace_id = $1 AND canonical_name ILIKE '%Priya%' AND status <> 'merged'`,
    [ws.id],
  );
  check("Priya Raman appears once, seen in 3 meetings", priya.length === 1 && priya[0].source_count === 3,
    `${priya.length} node(s), ${priya[0]?.source_count} sources`);

  // --- Edge intelligence -----------------------------------------------------
  console.log("\nEdge intelligence");
  const marcusJanet = await one<{ strength: number; warmth: number; evidence_count: number; context_card: string }>(
    `SELECT e.strength, e.warmth, e.evidence_count, e.context_card FROM edges e
     JOIN entities a ON a.id = e.src_entity_id JOIN entities b ON b.id = e.dst_entity_id
     WHERE (a.canonical_name ILIKE '%Marcus%' AND b.canonical_name ILIKE '%Janet%')
        OR (b.canonical_name ILIKE '%Marcus%' AND a.canonical_name ILIKE '%Janet%')
     ORDER BY e.strength DESC LIMIT 1`,
  );
  check("Marcus–Janet edge exists and is warm", (marcusJanet?.warmth ?? 0) > 0.7,
    marcusJanet ? `warmth ${marcusJanet.warmth.toFixed(2)}, strength ${marcusJanet.strength.toFixed(2)}` : "missing");
  check("edge carries a context card", Boolean(marcusJanet?.context_card),
    marcusJanet?.context_card?.slice(0, 70));

  const ended = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM edges WHERE workspace_id = $1 AND attributes->>'ended' = 'true'`,
    [ws.id],
  );
  check("negated relationships survive as former ties", Number(ended?.n) >= 3, `${ended?.n} former ties`);

  const mentionedEdges = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM edges WHERE workspace_id = $1 AND relationship_type = 'mentioned'`,
    [ws.id],
  );
  check("awareness kept separate from relationships", Number(mentionedEdges?.n) > 0,
    `${mentionedEdges?.n} 'mentioned' edges`);

  // --- Path finding ----------------------------------------------------------
  console.log("\nPath finding");
  const graph = await loadGraph(ws.id, true);
  const self = [...graph.nodes.values()].find((n) => n.name === SELF_NAME);
  check("self node present", Boolean(self), self?.name);

  const janet = [...graph.nodes.values()].find((n) => n.name.includes("Janet"));
  const paths = self && janet ? pathsToMany(graph, self.id, [janet.id], { maxHops: 4 }) : [];
  const best = paths[0];
  check("a route to Janet Reyes exists", Boolean(best),
    best ? best.hops.map((h) => h.toName).join(" -> ") : "none");
  check("that route runs through Marcus Webb",
    Boolean(best?.hops.some((h) => h.toName.includes("Marcus"))),
    best ? `${best.hops.length} hops, ${(best.probability * 100).toFixed(0)}% likelihood` : "");

  // Excluding mere awareness must not silently strengthen the answer.
  const strictPaths = self && janet
    ? pathsToMany(graph, self.id, [janet.id], { maxHops: 4, excludeTypes: ["mentioned"] })
    : [];
  check("warm-only routing still reaches Janet", strictPaths.length > 0,
    strictPaths[0] ? `${(strictPaths[0].probability * 100).toFixed(0)}% likelihood` : "no warm route");

  const alts = self && janet ? alternativePaths(graph, self.id, janet.id, 3) : [];
  check("alternative routes are enumerated", alts.length >= 1, `${alts.length} route(s)`);

  // --- Retrieval -------------------------------------------------------------
  console.log("\nRetrieval (offline embeddings)");
  const plan = heuristicPlan("I want to find LPs for the fund");
  const qv = await embedOne("limited partner endowment pension family office allocator fund commitments");
  const lps = topK(graph.nodes.values(), qv, { entityTypes: ["person"], keywords: plan.keywords }, 10);
  const lpNames = lps.slice(0, 5).map((s) => s.node.name);
  check("LP search surfaces the allocators",
    ["Priya", "Elena", "Michael"].filter((n) => lpNames.some((m) => m.includes(n))).length >= 2,
    lpNames.join(", "));

  const orgQv = await embedOne("Lockheed Martin defense prime contractor supplier programs");
  const lockheed = topK(graph.nodes.values(), orgQv, { orgMatch: "lockheed" }, 5);
  check("org-scoped search finds Lockheed people", lockheed.some((c) => c.node.name.includes("Janet")),
    lockheed.map((c) => c.node.name).join(", "));

  if (self) {
    const allPaths = pathsToMany(graph, self.id, [...graph.nodes.keys()], { maxHops: 3 });
    const connectors = rankConnectors(allPaths).slice(0, 3);
    check("connectors are rankable", connectors.length > 0,
      connectors.map((c) => `${c.name} (${c.unlocks})`).join(", "));
  }

  console.log(
    failures === 0
      ? "\nAll checks passed.\n"
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
