import { one, query, transaction, type ClientLike } from "../db";
import { extractFromSource } from "../extraction/extract";
import type { Extraction } from "../extraction/schema";
import { normalizeName, normalizeOrg } from "../resolution/normalize";
import { resolveRun } from "../resolution/resolve";
import { projectGraph } from "../graph/project";
import type { NormalizedSource } from "./granola";

export interface IngestResult {
  sourceId: string;
  runId: string | null;
  alreadyIngested: boolean;
  counts: { people: number; organizations: number; relationships: number; claims: number };
  entitiesCreated: number;
  entitiesMatched: number;
  reviewsQueued: number;
  usage?: Record<string, number>;
}

/**
 * The full L0 -> L3 path for one meeting.
 *
 * Each stage commits independently on purpose: a successful extraction is worth
 * keeping even if projection later fails, because projection is re-runnable and
 * extraction costs money.
 */
export async function ingestSource(
  workspaceId: string,
  doc: NormalizedSource,
): Promise<IngestResult> {
  const existing = await one<{ id: string }>(
    `SELECT id FROM sources WHERE workspace_id = $1 AND content_hash = $2`,
    [workspaceId, doc.contentHash],
  );
  if (existing) {
    return {
      sourceId: existing.id,
      runId: null,
      alreadyIngested: true,
      counts: { people: 0, organizations: 0, relationships: 0, claims: 0 },
      entitiesCreated: 0,
      entitiesMatched: 0,
      reviewsQueued: 0,
    };
  }

  const source = await one<{ id: string }>(
    `INSERT INTO sources (workspace_id, kind, external_id, title, occurred_at, body, raw,
                          content_hash, attendee_hints, token_estimate)
     VALUES ($1, 'granola_meeting', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      workspaceId,
      doc.externalId,
      doc.title,
      doc.occurredAt,
      doc.body,
      JSON.stringify(doc.raw),
      doc.contentHash,
      JSON.stringify(doc.attendeeHints),
      doc.tokenEstimate,
    ],
  );
  if (!source) throw new Error("Failed to insert source");

  const result = await extractFromSource({
    title: doc.title,
    occurredAt: doc.occurredAt,
    body: doc.body,
  });

  const { runId, counts } = await persistExtraction(
    source.id,
    doc,
    result.extraction,
    result.extractorVersion,
    result.promptHash,
    result.usage,
  );

  const resolution = await resolveRun(workspaceId, runId);
  await projectGraph(workspaceId);

  return {
    sourceId: source.id,
    runId,
    alreadyIngested: false,
    counts,
    entitiesCreated: resolution.created,
    entitiesMatched: resolution.matched,
    reviewsQueued: resolution.queued,
    usage: result.usage as unknown as Record<string, number>,
  };
}

const WARMTH: Record<string, number> = { warm: 0.85, neutral: 0.5, cool: 0.2, unknown: 0.5 };
const STRENGTH_SIGNAL: Record<string, number> = { strong: 1, moderate: 0.75, weak: 0.5, unknown: 0.7 };

/** Writes L1 in a single transaction. Mentions and claims are append-only. */
export async function persistExtraction(
  sourceId: string,
  doc: Pick<NormalizedSource, "occurredAt">,
  extraction: Extraction,
  extractorVersion: string,
  promptHash: string,
  usage: Record<string, number>,
): Promise<{ runId: string; counts: IngestResult["counts"] }> {
  return transaction(async (c) => {
    const run = await c.query<{ id: string }>(
      `INSERT INTO extraction_runs (source_id, extractor_version, model, prompt_hash, status,
                                    usage, raw_output, finished_at)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, now())
       RETURNING id`,
      [
        sourceId,
        extractorVersion,
        process.env.WAZE_MODEL ?? "claude-opus-5",
        promptHash,
        JSON.stringify(usage),
        JSON.stringify(extraction),
      ],
    );
    const runId = run.rows[0].id;
    const observedAt = extraction.meeting.occurred_at_hint ?? doc.occurredAt ?? null;
    const mentionIds = new Map<string, string>();

    const insertMention = async (m: {
      ref: string;
      entityType: string;
      surface: string;
      normalized: string;
      firstNameOnly?: boolean;
      role?: string | null;
      disambiguation?: string | null;
      attributes: Record<string, unknown>;
      quote?: string | null;
      confidence: number;
    }) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO mentions (run_id, source_id, local_ref, entity_type, surface_form, normalized,
                               is_first_name_only, role_in_source, disambiguation_context,
                               attributes, quote, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          runId,
          sourceId,
          m.ref,
          m.entityType,
          m.surface,
          m.normalized,
          m.firstNameOnly ?? false,
          m.role ?? null,
          m.disambiguation ?? null,
          JSON.stringify(m.attributes),
          m.quote ?? null,
          m.confidence,
        ],
      );
      mentionIds.set(m.ref, res.rows[0].id);
    };

    for (const org of extraction.organizations) {
      await insertMention({
        ref: org.ref,
        entityType: isFundLike(org.org_type) ? "fund" : "organization",
        surface: org.name,
        normalized: normalizeOrg(org.name),
        disambiguation: org.description,
        attributes: {
          aliases: org.aliases,
          org_type: org.org_type,
          sector: org.sector,
          stage: org.stage,
          location: org.location,
          description: org.description,
          notable_facts: org.notable_facts,
        },
        confidence: org.confidence,
      });
    }

    for (const p of extraction.people) {
      const orgName =
        p.organization_name ??
        extraction.organizations.find((o) => o.ref === p.organization_ref)?.name ??
        null;
      await insertMention({
        ref: p.ref,
        entityType: "person",
        surface: p.name,
        normalized: normalizeName(p.name),
        firstNameOnly: p.is_first_name_only,
        role: p.role_in_meeting,
        disambiguation: p.disambiguation_context,
        attributes: {
          aliases: p.aliases,
          title: p.title,
          org: orgName,
          seniority: p.seniority,
          email: p.email,
          location: p.location,
          expertise: p.expertise,
          interests: p.interests,
        },
        quote: p.quote,
        confidence: p.confidence,
      });
    }

    for (const t of extraction.topics) {
      await insertMention({
        ref: t.ref,
        entityType: "topic",
        surface: t.name,
        normalized: normalizeName(t.name),
        disambiguation: t.summary,
        attributes: { kind: t.kind, summary: t.summary },
        confidence: 0.7,
      });
    }

    let claimCount = 0;
    const addClaim = async (claim: {
      type: string;
      subject?: string | null;
      object?: string | null;
      predicate: string;
      value?: Record<string, unknown>;
      quote?: string | null;
      explicitness?: string;
      polarity?: number;
      warmth?: number | null;
      confidence?: number;
    }) => {
      const subjectId = claim.subject ? mentionIds.get(claim.subject) : null;
      const objectId = claim.object ? mentionIds.get(claim.object) : null;
      if (claim.subject && !subjectId) return;
      if (claim.object && !objectId) return;
      await c.query(
        `INSERT INTO claims (run_id, source_id, claim_type, subject_mention_id, object_mention_id,
                             predicate, value, quote, explicitness, polarity, warmth, confidence,
                             observed_at, extractor_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          runId,
          sourceId,
          claim.type,
          subjectId,
          objectId,
          claim.predicate,
          JSON.stringify(claim.value ?? {}),
          claim.quote ?? null,
          claim.explicitness ?? "stated",
          claim.polarity ?? 1,
          claim.warmth ?? null,
          claim.confidence ?? 0.6,
          observedAt,
          extractorVersion,
        ],
      );
      claimCount++;
    };

    // --- attribute claims ---
    for (const p of extraction.people) {
      if (p.title) await addClaim({ type: "attribute", subject: p.ref, predicate: "title", value: { title: p.title }, quote: p.quote, confidence: p.confidence });
      if (p.email) await addClaim({ type: "attribute", subject: p.ref, predicate: "email", value: { email: p.email }, confidence: 0.9 });
      if (p.location) await addClaim({ type: "attribute", subject: p.ref, predicate: "location", value: { location: p.location }, confidence: p.confidence });
      if (p.seniority !== "unknown") await addClaim({ type: "attribute", subject: p.ref, predicate: "seniority", value: { seniority: p.seniority }, confidence: 0.6 });
      for (const e of p.expertise) await addClaim({ type: "attribute", subject: p.ref, predicate: "expertise", value: { value: e }, confidence: 0.6 });
      for (const i of p.interests) await addClaim({ type: "attribute", subject: p.ref, predicate: "interest", value: { value: i }, confidence: 0.5 });
      // Employment is a graph edge, not a string field: it is how org access works.
      if (p.organization_ref) {
        await addClaim({
          type: "relationship",
          subject: p.ref,
          object: p.organization_ref,
          predicate: "works_at",
          value: { title: p.title, strength_signal: 1 },
          quote: p.quote,
          explicitness: "stated",
          warmth: 0.6,
          confidence: p.confidence,
        });
      }
    }

    for (const o of extraction.organizations) {
      if (o.stage) await addClaim({ type: "attribute", subject: o.ref, predicate: "stage", value: { stage: o.stage }, confidence: o.confidence });
      if (o.location) await addClaim({ type: "attribute", subject: o.ref, predicate: "location", value: { location: o.location }, confidence: o.confidence });
      for (const s of o.sector) await addClaim({ type: "attribute", subject: o.ref, predicate: "sector", value: { value: s }, confidence: 0.7 });
      for (const f of o.notable_facts) await addClaim({ type: "attribute", subject: o.ref, predicate: "notable_fact", value: { value: f }, confidence: 0.6 });
    }

    // --- relationship claims ---
    for (const r of extraction.relationships) {
      await addClaim({
        type: "relationship",
        subject: r.src_ref,
        object: r.dst_ref,
        predicate: r.type,
        value: {
          context: r.context,
          since: r.since,
          until: r.until,
          strength_signal: STRENGTH_SIGNAL[r.strength_signal] ?? 0.7,
        },
        quote: r.quote,
        explicitness: r.explicitness,
        polarity: r.polarity === "negated" ? -1 : 1,
        warmth: WARMTH[r.warmth_signal] ?? 0.5,
        confidence: r.confidence,
      });
    }

    // --- capability claims: the intro layer ---
    for (const i of extraction.intro_opportunities) {
      await addClaim({
        type: "capability",
        subject: i.connector_ref,
        object: i.target_ref,
        predicate: "can_intro_to",
        value: { basis: i.basis, offered: i.offered, strength_signal: i.offered ? 1 : 0.8 },
        quote: i.quote,
        explicitness: i.offered ? "stated" : "inferred",
        warmth: i.offered ? 0.9 : 0.65,
        confidence: i.confidence,
      });
    }

    // --- outreach layer ---
    for (const h of extraction.outreach_hooks) {
      await addClaim({ type: "hook", subject: h.person_ref, predicate: "outreach_hook", value: { hook: h.hook, kind: h.kind }, quote: h.quote, confidence: 0.7 });
    }
    for (const a of extraction.asks_and_offers) {
      await addClaim({ type: "hook", subject: a.actor_ref, predicate: a.kind, value: { what: a.what, urgency: a.urgency }, quote: a.quote, confidence: 0.7 });
    }
    for (const cm of extraction.commitments) {
      await addClaim({ type: "commitment", subject: cm.actor_ref, predicate: "commitment", value: { action: cm.action, due_hint: cm.due_hint }, quote: cm.quote, confidence: 0.7 });
    }

    // --- implicit structure ---
    // Co-attendance: real but weak, and deliberately its own type.
    const attendees = extraction.meeting.attendee_refs;
    for (let i = 0; i < attendees.length; i++) {
      for (let j = i + 1; j < attendees.length; j++) {
        await addClaim({
          type: "relationship",
          subject: attendees[i],
          object: attendees[j],
          predicate: "met_with",
          value: { via: "co-attendance", strength_signal: 0.6 },
          explicitness: "inferred",
          warmth: 0.55,
          confidence: 0.9,
        });
      }
    }
    // Awareness: an attendee raised this name. Not a relationship — see types.ts.
    const discussed = extraction.people.filter(
      (p) => !attendees.includes(p.ref) && p.role_in_meeting !== "attendee" && p.role_in_meeting !== "speaker",
    );
    for (const a of attendees) {
      for (const d of discussed) {
        await addClaim({
          type: "relationship",
          subject: a,
          object: d.ref,
          predicate: "mentioned",
          value: { strength_signal: 0.4 },
          explicitness: "inferred",
          warmth: 0.5,
          confidence: 0.5,
        });
      }
    }

    await touchSourceDate(c, sourceId, observedAt);

    return {
      runId,
      counts: {
        people: extraction.people.length,
        organizations: extraction.organizations.length,
        relationships: extraction.relationships.length,
        claims: claimCount,
      },
    };
  });
}

async function touchSourceDate(c: ClientLike, sourceId: string, observedAt: string | null) {
  if (!observedAt) return;
  await c.query(`UPDATE sources SET occurred_at = COALESCE(occurred_at, $2) WHERE id = $1`, [
    sourceId,
    observedAt,
  ]);
}

function isFundLike(orgType: string): boolean {
  return ["vc_fund", "pe_fund", "family_office", "lp"].includes(orgType);
}

export async function listRunsForSource(sourceId: string) {
  return query(
    `SELECT id, extractor_version, model, status, started_at, finished_at
     FROM extraction_runs WHERE source_id = $1 ORDER BY started_at DESC`,
    [sourceId],
  );
}
