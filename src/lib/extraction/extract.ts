import { callStructured } from "../anthropic";
import { hash } from "../ingest/granola";
import { EXTRACTION_SYSTEM, buildExtractionUserTurn, type SourceDocument } from "./prompt";
import { ExtractionSchema, EXTRACTOR_VERSION, type Extraction } from "./schema";

export interface ExtractionResult {
  extraction: Extraction;
  extractorVersion: string;
  promptHash: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

export const PROMPT_HASH = hash(EXTRACTION_SYSTEM + EXTRACTOR_VERSION);

export async function extractFromSource(doc: SourceDocument): Promise<ExtractionResult> {
  const { data, usage } = await callStructured({
    system: EXTRACTION_SYSTEM,
    user: buildExtractionUserTurn(doc),
    schema: ExtractionSchema,
    // Relationship mining rewards thoroughness; this is the one call worth
    // spending on, since everything downstream is a projection of its output.
    effort: "high",
    maxTokens: 16000,
  });

  return {
    extraction: sanitize(data),
    extractorVersion: EXTRACTOR_VERSION,
    promptHash: PROMPT_HASH,
    usage,
  };
}

/**
 * Structural repair, not content editing. The model occasionally references a ref
 * it never defined; a dangling ref would create a claim pointing at nothing, so we
 * drop those rows rather than let them into the ledger.
 */
function sanitize(e: Extraction): Extraction {
  const refs = new Set<string>([
    ...e.people.map((p) => p.ref),
    ...e.organizations.map((o) => o.ref),
    ...e.topics.map((t) => t.ref),
  ]);
  const known = (r: string | null | undefined) => Boolean(r && refs.has(r));

  return {
    ...e,
    meeting: {
      ...e.meeting,
      attendee_refs: e.meeting.attendee_refs.filter(known),
    },
    people: e.people.map((p) => ({
      ...p,
      organization_ref: known(p.organization_ref) ? p.organization_ref : null,
      // A first-name-only flag the model forgot to set is a resolution hazard,
      // so derive it defensively rather than trusting the flag alone.
      is_first_name_only: p.is_first_name_only || p.name.trim().split(/\s+/).length === 1,
    })),
    relationships: e.relationships.filter(
      (r) => known(r.src_ref) && known(r.dst_ref) && r.src_ref !== r.dst_ref,
    ),
    intro_opportunities: e.intro_opportunities.filter(
      (i) => known(i.connector_ref) && known(i.target_ref) && i.connector_ref !== i.target_ref,
    ),
    asks_and_offers: e.asks_and_offers.filter((a) => known(a.actor_ref)),
    commitments: e.commitments.filter((c) => known(c.actor_ref)),
    outreach_hooks: e.outreach_hooks.filter((h) => known(h.person_ref)),
    topics: e.topics.map((t) => ({ ...t, discussed_by_refs: t.discussed_by_refs.filter(known) })),
  };
}
