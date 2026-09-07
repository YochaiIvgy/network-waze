import { z } from "zod/v4";

/**
 * The extraction contract.
 *
 * Design rules, learned the hard way:
 *  - Every claim carries a verbatim `quote`. No quote, no claim. This is what
 *    makes the graph auditable and what NL answers cite.
 *  - Nothing is optional; everything nullable. Structured outputs are strict, and
 *    a model that must emit `null` explicitly is a model that decided.
 *  - `disambiguation_context` exists purely to feed entity resolution later. It is
 *    the highest-leverage field in the whole schema: it is what stops the fourth
 *    "Michael" from colliding with the first three.
 *  - Relationships are between *local refs*, never names. Names get resolved
 *    downstream; the extractor's job is to be internally consistent.
 */

export const EXTRACTOR_VERSION = "v1.2.0";

const Explicitness = z.enum(["stated", "reported", "inferred"]);
const Confidence = z.number().min(0).max(1);

const PersonSchema = z.object({
  ref: z.string().describe("Local id, e.g. 'p1'. Referenced by relationships."),
  name: z.string().describe("Best full name available. If only a first name was used, put just that."),
  is_first_name_only: z.boolean(),
  aliases: z.array(z.string()).describe("Nicknames, spellings, 'Sarah'/'Sarah C.'"),
  role_in_meeting: z.enum(["attendee", "speaker", "mentioned", "third_party"]),
  title: z.string().nullable(),
  organization_ref: z.string().nullable().describe("ref of an organization in this extraction"),
  organization_name: z.string().nullable().describe("Use when the org is named but not worth its own node"),
  seniority: z.enum(["ic", "manager", "director", "vp", "c_level", "founder", "partner", "unknown"]),
  email: z.string().nullable(),
  location: z.string().nullable(),
  expertise: z.array(z.string()).describe("Domains they are credible in"),
  interests: z.array(z.string()),
  /** The resolver's input. Concrete, distinguishing detail only. */
  disambiguation_context: z
    .string()
    .describe(
      "2-3 sentences of the most distinguishing detail about this specific person: org, role, " +
        "who they were discussed alongside, any unique fact. Written to tell them apart from " +
        "someone else with the same name. Never generic.",
    ),
  quote: z.string().nullable().describe("A verbatim line that establishes who they are"),
  confidence: Confidence,
});

const OrganizationSchema = z.object({
  ref: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  org_type: z.enum([
    "startup",
    "public_company",
    "private_company",
    "vc_fund",
    "pe_fund",
    "family_office",
    "lp",
    "government",
    "defense",
    "university",
    "nonprofit",
    "unknown",
  ]),
  sector: z.array(z.string()),
  stage: z.string().nullable().describe("seed / series B / public, if said"),
  location: z.string().nullable(),
  description: z.string().nullable(),
  notable_facts: z.array(z.string()),
  confidence: Confidence,
});

const RelationshipSchema = z.object({
  src_ref: z.string(),
  dst_ref: z.string(),
  type: z.enum([
    "colleague",
    "former_colleague",
    "reports_to",
    "founded",
    "works_at",
    "investor_in",
    "advisor_to",
    "board_member",
    "client_of",
    "friend",
    "family",
    "introduced_by",
    "affiliated_with",
  ]),
  explicitness: Explicitness,
  /** Negation matters: "Dana left Anduril" must not read as "Dana works at Anduril". */
  polarity: z.enum(["asserted", "negated"]),
  strength_signal: z.enum(["strong", "moderate", "weak", "unknown"]),
  warmth_signal: z.enum(["warm", "neutral", "cool", "unknown"]),
  since: z.string().nullable().describe("ISO date or a phrase like '2019'"),
  until: z.string().nullable(),
  /** The whole point of the product: what is actually known about this tie. */
  context: z.string().describe("How these two know each other, in one or two sentences"),
  quote: z.string().describe("Verbatim support from the transcript"),
  confidence: Confidence,
});

const IntroOpportunitySchema = z.object({
  connector_ref: z.string().describe("Who can make the introduction"),
  target_ref: z.string().describe("Who or what they can open"),
  basis: z.string().describe("Why they can — the stated reason"),
  offered: z.boolean().describe("true if they actually offered, false if merely capable"),
  quote: z.string(),
  confidence: Confidence,
});

const AskOfferSchema = z.object({
  actor_ref: z.string(),
  kind: z.enum(["ask", "offer"]),
  what: z.string(),
  urgency: z.enum(["now", "this_quarter", "someday", "unknown"]),
  quote: z.string(),
});

const CommitmentSchema = z.object({
  actor_ref: z.string(),
  action: z.string(),
  due_hint: z.string().nullable(),
  quote: z.string(),
});

/** The outreach layer: why you'd be able to write a non-generic email in 6 months. */
const OutreachHookSchema = z.object({
  person_ref: z.string(),
  hook: z.string().describe("A specific, usable detail — not 'interested in AI'"),
  kind: z.enum(["personal", "professional", "timing", "ask", "offer"]),
  quote: z.string(),
});

const TopicSchema = z.object({
  ref: z.string(),
  name: z.string(),
  kind: z.enum(["sector", "technology", "thesis", "geography", "asset_class", "other"]),
  discussed_by_refs: z.array(z.string()),
  summary: z.string(),
});

export const ExtractionSchema = z.object({
  meeting: z.object({
    summary: z.string().describe("3-4 sentences: what happened and what it means for the network"),
    meeting_type: z.enum([
      "intro_call",
      "pitch",
      "fundraising",
      "customer",
      "partnership",
      "internal",
      "advisory",
      "social",
      "interview",
      "other",
    ]),
    occurred_at_hint: z.string().nullable().describe("ISO date if stated or inferable from context"),
    /** Every attendee pair becomes a weak `met_with` edge, so this must be accurate. */
    attendee_refs: z.array(z.string()),
  }),
  people: z.array(PersonSchema),
  organizations: z.array(OrganizationSchema),
  topics: z.array(TopicSchema),
  relationships: z.array(RelationshipSchema),
  intro_opportunities: z.array(IntroOpportunitySchema),
  asks_and_offers: z.array(AskOfferSchema),
  commitments: z.array(CommitmentSchema),
  outreach_hooks: z.array(OutreachHookSchema),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractedPerson = z.infer<typeof PersonSchema>;
export type ExtractedOrg = z.infer<typeof OrganizationSchema>;
export type ExtractedRelationship = z.infer<typeof RelationshipSchema>;
export type ExtractedHook = z.infer<typeof OutreachHookSchema>;
