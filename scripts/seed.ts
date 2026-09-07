import "dotenv/config";
import { SEED_MEETINGS, SELF_NAME } from "../db/seed-data";
import { getWorkspace, one, closePool, query } from "../src/lib/db";
import { projectGraph } from "../src/lib/graph/project";
import { hash, estimateTokens } from "../src/lib/ingest/granola";
import { persistExtraction } from "../src/lib/ingest/pipeline";
import { resolveRun } from "../src/lib/resolution/resolve";

/**
 * Seeds the demo network by running hand-authored extractions through the real
 * pipeline. No API key required, and no shortcut around resolution or
 * projection — the seeded graph is built the same way a real one is.
 */
async function main() {
  const ws = await getWorkspace();

  const existing = await one<{ n: string }>(`SELECT count(*)::text AS n FROM sources WHERE workspace_id = $1`, [
    ws.id,
  ]);
  if (Number(existing?.n ?? 0) > 0 && !process.argv.includes("--force")) {
    console.log("Workspace already has sources. Re-run with --force to seed anyway.");
    await closePool();
    return;
  }

  console.log(`Seeding ${SEED_MEETINGS.length} meetings…\n`);

  for (const meeting of SEED_MEETINGS) {
    const body = [
      "[ATTENDEES]",
      ...meeting.attendees.map(
        (a) => `- ${a.name}${a.email ? ` <${a.email}>` : ""}${a.company ? ` — ${a.company}` : ""}`,
      ),
      "",
      "[SUMMARY]",
      meeting.extraction.meeting.summary,
      "",
      "[TRANSCRIPT]",
      meeting.transcript,
    ].join("\n");

    const source = await one<{ id: string }>(
      `INSERT INTO sources (workspace_id, kind, title, occurred_at, body, raw, content_hash,
                            attendee_hints, token_estimate)
       VALUES ($1,'granola_meeting',$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id, content_hash) DO NOTHING
       RETURNING id`,
      [
        ws.id,
        meeting.title,
        meeting.occurredAt,
        body,
        JSON.stringify({ seeded: true }),
        hash(`${meeting.title}\n${body}`),
        JSON.stringify(meeting.attendees),
        estimateTokens(body),
      ],
    );
    if (!source) {
      console.log(`- ${meeting.title}: already present, skipped`);
      continue;
    }

    const { runId, counts } = await persistExtraction(
      source.id,
      { occurredAt: meeting.occurredAt },
      meeting.extraction,
      "seed-v1",
      "seed",
      {},
    );
    const resolution = await resolveRun(ws.id, runId);
    console.log(
      `- ${meeting.title}\n    ${counts.people} people, ${counts.organizations} orgs, ` +
        `${counts.claims} claims → ${resolution.created} new entities, ` +
        `${resolution.matched} matched to existing` +
        (resolution.deferred ? `, ${resolution.deferred} deferred` : "") +
        (resolution.queued ? `, ${resolution.queued} queued for review` : ""),
    );
  }

  const projection = await projectGraph(ws.id);
  console.log(`\nProjected ${projection.entities} entities and ${projection.edges} edges.`);

  // Every path is computed from this node. Without it the app has no "you".
  const self = await one<{ id: string }>(
    `SELECT id FROM entities WHERE workspace_id = $1 AND entity_type = 'person'
       AND lower(canonical_name) = lower($2) LIMIT 1`,
    [ws.id, SELF_NAME],
  );
  if (self) {
    await query(`UPDATE workspaces SET self_entity_id = $2 WHERE id = $1`, [ws.id, self.id]);
    console.log(`Set "${SELF_NAME}" as the workspace's self node.`);
  } else {
    console.warn(`Could not find "${SELF_NAME}" to set as the self node.`);
  }

  const deferred = await one<{ n: string }>(
    `SELECT count(*)::text AS n FROM mentions m
     LEFT JOIN mention_links ml ON ml.mention_id = m.id
     JOIN sources s ON s.id = m.source_id
     WHERE s.workspace_id = $1 AND ml.mention_id IS NULL`,
    [ws.id],
  );
  if (Number(deferred?.n ?? 0) > 0) {
    console.log(
      `${deferred?.n} mention(s) left unresolved on purpose — first names with nothing to pin them to.`,
    );
  }

  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
