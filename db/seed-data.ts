import type {
  Extraction,
  ExtractedOrg,
  ExtractedPerson,
  ExtractedRelationship,
} from "../src/lib/extraction/schema";

/**
 * Demo network.
 *
 * These are hand-authored extractions rather than model output, so `npm run
 * db:seed` works with no API key — but they are fed through the *real* pipeline
 * (persistExtraction -> resolveRun -> projectGraph), so the seeded graph is
 * produced by exactly the code that production ingestion runs.
 *
 * The data is designed to exercise the hard cases:
 *  - Sarah Chen appears in three meetings, once as just "Sarah"  (dedup)
 *  - Marcus Webb is mentioned before he is ever met               (mention -> attendee)
 *  - "Jen" appears with no surname and no org                     (deferred resolution)
 *  - Janet Reyes is reachable only through Marcus                 (brokerage)
 *  - a negated relationship: Marcus left Palantir                 (polarity)
 */

// --- factories: seed data only, to keep the fixtures readable ---------------

function person(p: Partial<ExtractedPerson> & { ref: string; name: string }): ExtractedPerson {
  return {
    is_first_name_only: p.name.trim().split(/\s+/).length === 1,
    aliases: [],
    role_in_meeting: "mentioned",
    title: null,
    organization_ref: null,
    organization_name: null,
    seniority: "unknown",
    email: null,
    location: null,
    expertise: [],
    interests: [],
    disambiguation_context: "",
    quote: null,
    confidence: 0.85,
    ...p,
  } as ExtractedPerson;
}

function org(o: Partial<ExtractedOrg> & { ref: string; name: string }): ExtractedOrg {
  return {
    aliases: [],
    org_type: "unknown",
    sector: [],
    stage: null,
    location: null,
    description: null,
    notable_facts: [],
    confidence: 0.9,
    ...o,
  } as ExtractedOrg;
}

function rel(r: Partial<ExtractedRelationship> & {
  src_ref: string;
  dst_ref: string;
  type: ExtractedRelationship["type"];
  quote: string;
  context: string;
}): ExtractedRelationship {
  return {
    explicitness: "stated",
    polarity: "asserted",
    strength_signal: "moderate",
    warmth_signal: "neutral",
    since: null,
    until: null,
    confidence: 0.85,
    ...r,
  } as ExtractedRelationship;
}

export interface SeedMeeting {
  title: string;
  occurredAt: string;
  attendees: Array<{ name: string; email: string | null; company: string | null }>;
  transcript: string;
  extraction: Extraction;
}

// ---------------------------------------------------------------------------

const M1: SeedMeeting = {
  title: "Coffee with Sarah Chen — Northlane",
  occurredAt: "2026-02-11T16:00:00Z",
  attendees: [
    { name: "Alex Moreau", email: "alex@harborline.vc", company: "Harborline Capital" },
    { name: "Sarah Chen", email: "sarah@northlane.vc", company: "Northlane Ventures" },
  ],
  transcript: `Alex: Congrats on the close. Fund three, right?
Sarah: Fund three, yeah. Four hundred. Priya at Redwood came in early again which basically made the rest of it easy — she's been in every fund since I was a principal.
Alex: Redwood University Endowment?
Sarah: Yeah, Priya Raman. She runs the private markets book there. Straightforward, decides fast, hates a long deck.
Alex: Noted. I'm starting to think about Harborline II next year.
Sarah: Talk to her. Honestly, use my name.
Alex: On the defense side — we're looking at a robotics company that needs a prime relationship.
Sarah: Then you want Marcus. Marcus Webb. He and I were at Palantir together for four years, he ran a lot of the government stuff. He's head of BD at Anduril now.
Alex: Do you know him well?
Sarah: Very. We were in the same pod, we still get dinner every couple of months. He'd take the call if I asked.
Alex: That'd be great.
Sarah: I'll ping him this week. He's good — he actually knows the procurement side, not just the pitch.`,
  extraction: {
    meeting: {
      summary:
        "Catch-up with Sarah Chen after Northlane's third fund closed at $400M. Surfaced Priya Raman at Redwood University Endowment as a fast-moving LP anchor, and Marcus Webb at Anduril as a warm route into defense BD. Sarah offered to introduce both.",
      meeting_type: "social",
      occurred_at_hint: "2026-02-11",
      attendee_refs: ["p_alex", "p_sarah"],
    },
    people: [
      person({
        ref: "p_alex",
        name: "Alex Moreau",
        role_in_meeting: "attendee",
        title: "Managing Partner",
        organization_ref: "o_harborline",
        seniority: "partner",
        email: "alex@harborline.vc",
        expertise: ["venture capital", "defense technology"],
        disambiguation_context: "Managing partner at Harborline Capital, planning to raise Harborline II next year.",
        confidence: 0.95,
      }),
      person({
        ref: "p_sarah",
        name: "Sarah Chen",
        role_in_meeting: "attendee",
        title: "General Partner",
        organization_ref: "o_northlane",
        seniority: "partner",
        email: "sarah@northlane.vc",
        expertise: ["venture capital", "government software", "fund formation"],
        disambiguation_context:
          "GP at Northlane Ventures who just closed a $400M third fund. Spent four years at Palantir before venture. Close with Marcus Webb and with LP Priya Raman.",
        quote: "Fund three, yeah. Four hundred.",
        confidence: 0.95,
      }),
      person({
        ref: "p_priya",
        name: "Priya Raman",
        title: "Head of Private Markets",
        organization_ref: "o_redwood",
        seniority: "director",
        expertise: ["LP allocation", "private markets", "fund investing"],
        disambiguation_context:
          "Runs the private markets book at Redwood University Endowment. Has invested in every Northlane fund since Sarah Chen was a principal. Decides quickly, dislikes long decks.",
        quote: "Priya at Redwood came in early again which basically made the rest of it easy",
        confidence: 0.9,
      }),
      person({
        ref: "p_marcus",
        name: "Marcus Webb",
        title: "Head of Business Development",
        organization_ref: "o_anduril",
        seniority: "director",
        expertise: ["defense business development", "government procurement"],
        disambiguation_context:
          "Head of BD at Anduril. Was at Palantir with Sarah Chen for four years running government work. Knows the procurement side, not just sales.",
        quote: "He's head of BD at Anduril now.",
        confidence: 0.9,
      }),
    ],
    organizations: [
      org({ ref: "o_harborline", name: "Harborline Capital", org_type: "vc_fund", sector: ["venture capital"], description: "Alex Moreau's fund; planning Fund II." }),
      org({
        ref: "o_northlane",
        name: "Northlane Ventures",
        org_type: "vc_fund",
        sector: ["venture capital", "govtech"],
        stage: "Fund III",
        notable_facts: ["Closed a $400M third fund in early 2026"],
      }),
      org({ ref: "o_redwood", name: "Redwood University Endowment", org_type: "lp", sector: ["endowment", "private markets"], description: "University endowment investing in venture and PE funds." }),
      org({ ref: "o_anduril", name: "Anduril Industries", org_type: "defense", sector: ["defense", "autonomy"], description: "Defense technology company." }),
      org({ ref: "o_palantir", name: "Palantir", org_type: "public_company", sector: ["software", "government"] }),
    ],
    relationships: [
      rel({
        src_ref: "p_sarah",
        dst_ref: "p_marcus",
        type: "former_colleague",
        strength_signal: "strong",
        warmth_signal: "warm",
        since: "Palantir",
        context: "Sarah and Marcus were at Palantir together for four years in the same pod, and still have dinner every couple of months.",
        quote: "We were in the same pod, we still get dinner every couple of months. He'd take the call if I asked.",
        confidence: 0.95,
      }),
      rel({
        src_ref: "p_sarah",
        dst_ref: "p_priya",
        type: "investor_in",
        strength_signal: "strong",
        warmth_signal: "warm",
        context: "Priya's endowment has anchored every Northlane fund since Sarah was a principal.",
        quote: "she's been in every fund since I was a principal",
        confidence: 0.9,
      }),
      rel({ src_ref: "p_priya", dst_ref: "o_redwood", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Priya runs private markets at Redwood.", quote: "She runs the private markets book there." }),
      rel({ src_ref: "p_marcus", dst_ref: "o_anduril", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Marcus is head of BD at Anduril.", quote: "He's head of BD at Anduril now." }),
      rel({ src_ref: "p_sarah", dst_ref: "o_palantir", type: "works_at", polarity: "negated", strength_signal: "moderate", warmth_signal: "neutral", until: "pre-2020", context: "Sarah worked at Palantir before moving into venture.", quote: "He and I were at Palantir together for four years" }),
      rel({ src_ref: "p_marcus", dst_ref: "o_palantir", type: "works_at", polarity: "negated", strength_signal: "moderate", warmth_signal: "neutral", context: "Marcus was at Palantir running government work before Anduril.", quote: "he ran a lot of the government stuff" }),
      rel({ src_ref: "p_alex", dst_ref: "o_harborline", type: "works_at", strength_signal: "strong", warmth_signal: "warm", context: "Alex is managing partner at Harborline Capital.", quote: "I'm starting to think about Harborline II next year." }),
      rel({ src_ref: "p_sarah", dst_ref: "o_northlane", type: "works_at", strength_signal: "strong", warmth_signal: "warm", context: "Sarah is a GP at Northlane Ventures.", quote: "Fund three, yeah." }),
    ],
    intro_opportunities: [
      { connector_ref: "p_sarah", target_ref: "p_marcus", basis: "Four years together at Palantir; still close.", offered: true, quote: "I'll ping him this week.", confidence: 0.95 },
      { connector_ref: "p_sarah", target_ref: "p_priya", basis: "Priya has anchored every Northlane fund.", offered: true, quote: "Talk to her. Honestly, use my name.", confidence: 0.9 },
    ],
    asks_and_offers: [
      { actor_ref: "p_alex", kind: "ask", what: "A prime contractor relationship for a robotics portfolio company", urgency: "this_quarter", quote: "we're looking at a robotics company that needs a prime relationship" },
      { actor_ref: "p_sarah", kind: "offer", what: "Introduction to Marcus Webb at Anduril", urgency: "now", quote: "I'll ping him this week." },
    ],
    commitments: [{ actor_ref: "p_sarah", action: "Introduce Alex to Marcus Webb", due_hint: "this week", quote: "I'll ping him this week." }],
    outreach_hooks: [
      { person_ref: "p_sarah", hook: "Closed Northlane Fund III at $400M in early 2026", kind: "timing", quote: "Fund three, yeah. Four hundred." },
      { person_ref: "p_priya", hook: "Decides fast and dislikes long decks — lead with one page", kind: "professional", quote: "Straightforward, decides fast, hates a long deck." },
      { person_ref: "p_alex", hook: "Raising Harborline II next year", kind: "timing", quote: "I'm starting to think about Harborline II next year." },
    ],
    topics: [
      { ref: "t_defense", name: "Defense procurement", kind: "sector", discussed_by_refs: ["p_alex", "p_sarah"], summary: "Getting a robotics portfolio company access to a prime contractor." },
    ],
  },
};

const M2: SeedMeeting = {
  title: "Northlane co-invest sync",
  occurredAt: "2026-03-18T15:30:00Z",
  attendees: [
    { name: "Alex Moreau", email: "alex@harborline.vc", company: "Harborline Capital" },
    { name: "Sarah Chen", email: "sarah@northlane.vc", company: "Northlane Ventures" },
    { name: "David Okonkwo", email: "david@northlane.vc", company: "Northlane Ventures" },
  ],
  transcript: `Alex: David, good to finally meet.
David: Likewise. Sarah's been talking about the robotics deal for a month.
Sarah: Because it's good. Alex, David runs all our hardware diligence — he was at Sierra before us.
David: Seven years. I still know most of the programs people there. Tom Bradley runs programs now, we overlapped the whole time.
Alex: Would Sierra be a channel for Lumen?
David: Possibly. Tom's careful, he won't move without a technical champion, but he takes my calls.
Sarah: Worth a conversation.
Alex: Let's do it after the round closes.`,
  extraction: {
    meeting: {
      summary:
        "Co-investment sync with Northlane on the Lumen Robotics deal. David Okonkwo, who spent seven years at Sierra Defense Systems, surfaced Tom Bradley (VP Programs at Sierra) as a possible channel and said Tom takes his calls.",
      meeting_type: "partnership",
      occurred_at_hint: "2026-03-18",
      attendee_refs: ["p_alex", "p_sarah", "p_david"],
    },
    people: [
      person({ ref: "p_alex", name: "Alex Moreau", role_in_meeting: "attendee", title: "Managing Partner", organization_ref: "o_harborline", seniority: "partner", email: "alex@harborline.vc", disambiguation_context: "Managing partner at Harborline Capital, co-investing with Northlane." }),
      // Referred to as just "Sarah" in the room; the full name is on the invite.
      person({
        ref: "p_sarah",
        name: "Sarah Chen",
        aliases: ["Sarah"],
        role_in_meeting: "attendee",
        title: "General Partner",
        organization_ref: "o_northlane",
        seniority: "partner",
        email: "sarah@northlane.vc",
        disambiguation_context: "GP at Northlane Ventures leading the Lumen Robotics co-investment.",
      }),
      person({
        ref: "p_david",
        name: "David Okonkwo",
        role_in_meeting: "attendee",
        title: "Partner, Hardware",
        organization_ref: "o_northlane",
        seniority: "partner",
        email: "david@northlane.vc",
        expertise: ["hardware diligence", "defense programs"],
        disambiguation_context:
          "Partner at Northlane running hardware diligence. Spent seven years at Sierra Defense Systems and still knows the programs organisation there.",
        quote: "Seven years. I still know most of the programs people there.",
      }),
      person({
        ref: "p_tom",
        name: "Tom Bradley",
        title: "VP Programs",
        organization_ref: "o_sierra",
        seniority: "vp",
        expertise: ["defense programs", "supplier qualification"],
        disambiguation_context:
          "VP of Programs at Sierra Defense Systems. Overlapped with David Okonkwo for seven years at Sierra. Careful; needs a technical champion before moving.",
        quote: "Tom Bradley runs programs now, we overlapped the whole time.",
      }),
      person({ ref: "p_ravi", name: "Ravi Menon", title: "Founder & CEO", organization_ref: "o_lumen", seniority: "founder", disambiguation_context: "Founder of Lumen Robotics, the company Harborline and Northlane are co-investing in." }),
    ],
    organizations: [
      org({ ref: "o_harborline", name: "Harborline Capital", org_type: "vc_fund", sector: ["venture capital"] }),
      org({ ref: "o_northlane", name: "Northlane Ventures", org_type: "vc_fund", sector: ["venture capital"] }),
      org({ ref: "o_sierra", name: "Sierra Defense Systems", org_type: "defense", sector: ["defense", "aerospace"], description: "Defense systems integrator." }),
      org({ ref: "o_lumen", name: "Lumen Robotics", org_type: "startup", sector: ["robotics", "defense"], stage: "Series A" }),
    ],
    relationships: [
      rel({ src_ref: "p_david", dst_ref: "o_sierra", type: "works_at", polarity: "negated", strength_signal: "strong", warmth_signal: "neutral", until: "2018", context: "David spent seven years at Sierra Defense Systems before joining Northlane.", quote: "he was at Sierra before us" }),
      rel({
        src_ref: "p_david",
        dst_ref: "p_tom",
        type: "former_colleague",
        strength_signal: "strong",
        warmth_signal: "warm",
        context: "David and Tom overlapped for seven years at Sierra; Tom still takes David's calls.",
        quote: "Tom's careful, he won't move without a technical champion, but he takes my calls.",
        confidence: 0.9,
      }),
      rel({ src_ref: "p_david", dst_ref: "o_northlane", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "David is a partner at Northlane running hardware diligence.", quote: "David runs all our hardware diligence" }),
      rel({ src_ref: "p_tom", dst_ref: "o_sierra", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Tom runs programs at Sierra.", quote: "Tom Bradley runs programs now" }),
      rel({ src_ref: "p_sarah", dst_ref: "p_david", type: "colleague", strength_signal: "strong", warmth_signal: "warm", context: "Sarah and David are partners at Northlane.", quote: "David runs all our hardware diligence" }),
      rel({ src_ref: "p_ravi", dst_ref: "o_lumen", type: "founded", strength_signal: "strong", warmth_signal: "neutral", context: "Ravi founded Lumen Robotics.", quote: "Sarah's been talking about the robotics deal for a month." }),
    ],
    intro_opportunities: [
      { connector_ref: "p_david", target_ref: "p_tom", basis: "Seven years overlapping at Sierra; Tom still takes his calls.", offered: false, quote: "he takes my calls", confidence: 0.85 },
    ],
    asks_and_offers: [],
    commitments: [{ actor_ref: "p_alex", action: "Revisit the Sierra channel conversation after the round closes", due_hint: "after the round closes", quote: "Let's do it after the round closes." }],
    outreach_hooks: [
      { person_ref: "p_tom", hook: "Won't move without a technical champion — bring the engineer, not the deck", kind: "professional", quote: "Tom's careful, he won't move without a technical champion" },
      { person_ref: "p_david", hook: "Seven years at Sierra; hardware diligence is his lane", kind: "professional", quote: "Seven years. I still know most of the programs people there." },
    ],
    topics: [{ ref: "t_channel", name: "Defense channel partnerships", kind: "thesis", discussed_by_refs: ["p_alex", "p_david"], summary: "Using Sierra as a route to market for Lumen Robotics." }],
  },
};

const M3: SeedMeeting = {
  title: "Intro call — Marcus Webb (Anduril)",
  occurredAt: "2026-04-22T18:00:00Z",
  attendees: [
    { name: "Alex Moreau", email: "alex@harborline.vc", company: "Harborline Capital" },
    { name: "Marcus Webb", email: "mwebb@anduril.com", company: "Anduril Industries" },
  ],
  transcript: `Marcus: Sarah said you'd call. Any friend of hers.
Alex: Appreciate it. She said you two go back to Palantir.
Marcus: Four years. She's the reason I got into this at all. What do you need?
Alex: Lumen Robotics — one of ours. They need a path into a prime. Lockheed specifically.
Marcus: Lockheed is a maze. You don't go in the front door. The person you want is Janet Reyes — Colonel Reyes, retired. She was my commanding officer at Fort Bragg, and she's now director of supplier programs at Lockheed. She decides which small companies get qualified.
Alex: You still speak?
Marcus: Every few months. She came to my wedding. I'd walk over hot coals for her, and I think that goes both ways.
Alex: Would you make the introduction?
Marcus: For a company I believe in, yes. Send me the one-pager, I want to read it before I put my name on anything.
Alex: Understood.
Marcus: Fair warning, she's slow in the summer — she's out at her place in Montana most of August.
Alex: Good to know.
Marcus: Also, if you strike out there, Jen might have a route. But let me try Janet first.`,
  extraction: {
    meeting: {
      summary:
        "Introduction call with Marcus Webb, arranged by Sarah Chen. Marcus named Janet Reyes — his former commanding officer, now Director of Supplier Programs at Lockheed Martin — as the decision-maker for qualifying small suppliers, and offered to introduce once he has read Lumen's one-pager.",
      meeting_type: "intro_call",
      occurred_at_hint: "2026-04-22",
      attendee_refs: ["p_alex", "p_marcus"],
    },
    people: [
      person({ ref: "p_alex", name: "Alex Moreau", role_in_meeting: "attendee", title: "Managing Partner", organization_ref: "o_harborline", seniority: "partner", email: "alex@harborline.vc", disambiguation_context: "Managing partner at Harborline Capital seeking prime contractor access for Lumen Robotics." }),
      person({
        ref: "p_marcus",
        name: "Marcus Webb",
        role_in_meeting: "attendee",
        title: "Head of Business Development",
        organization_ref: "o_anduril",
        seniority: "director",
        email: "mwebb@anduril.com",
        expertise: ["defense business development", "government procurement", "supplier qualification"],
        disambiguation_context:
          "Head of BD at Anduril, ex-Palantir with Sarah Chen. Served under Colonel Janet Reyes at Fort Bragg; she attended his wedding.",
        quote: "She was my commanding officer at Fort Bragg",
        confidence: 0.95,
      }),
      person({
        ref: "p_janet",
        name: "Janet Reyes",
        aliases: ["Colonel Reyes", "Col. Janet Reyes"],
        title: "Director of Supplier Programs",
        organization_ref: "o_lockheed",
        seniority: "director",
        expertise: ["supplier qualification", "defense procurement"],
        disambiguation_context:
          "Retired Army colonel, now Director of Supplier Programs at Lockheed Martin, where she decides which small companies get qualified. Was Marcus Webb's commanding officer at Fort Bragg.",
        quote: "The person you want is Janet Reyes — Colonel Reyes, retired.",
        confidence: 0.9,
      }),
      // Deliberately unresolvable: a first name with no organisation and no role.
      // The resolver defers this rather than inventing a node.
      person({
        ref: "p_jen",
        name: "Jen",
        is_first_name_only: true,
        disambiguation_context: "Mentioned only as a possible alternative route into Lockheed if Janet Reyes does not work out. No surname, organisation or role given.",
        quote: "if you strike out there, Jen might have a route",
        confidence: 0.4,
      }),
      person({ ref: "p_sarah", name: "Sarah Chen", title: "General Partner", organization_ref: "o_northlane", seniority: "partner", disambiguation_context: "GP at Northlane Ventures who made this introduction; ex-Palantir with Marcus." }),
    ],
    organizations: [
      org({ ref: "o_harborline", name: "Harborline Capital", org_type: "vc_fund", sector: ["venture capital"] }),
      org({ ref: "o_anduril", name: "Anduril Industries", org_type: "defense", sector: ["defense", "autonomy"] }),
      org({
        ref: "o_lockheed",
        name: "Lockheed Martin",
        aliases: ["Lockheed"],
        org_type: "defense",
        sector: ["defense", "aerospace"],
        description: "Prime defense contractor. Supplier qualification runs through the supplier programs office.",
        notable_facts: ["Small suppliers are qualified through the supplier programs office, not the front door"],
      }),
      org({ ref: "o_northlane", name: "Northlane Ventures", org_type: "vc_fund", sector: ["venture capital"] }),
      org({ ref: "o_lumen", name: "Lumen Robotics", org_type: "startup", sector: ["robotics", "defense"], stage: "Series A" }),
    ],
    relationships: [
      rel({
        src_ref: "p_marcus",
        dst_ref: "p_janet",
        type: "former_colleague",
        strength_signal: "strong",
        warmth_signal: "warm",
        since: "Fort Bragg",
        context: "Janet Reyes was Marcus's commanding officer at Fort Bragg. They speak every few months and she attended his wedding.",
        quote: "Every few months. She came to my wedding. I'd walk over hot coals for her, and I think that goes both ways.",
        confidence: 0.95,
      }),
      rel({ src_ref: "p_janet", dst_ref: "o_lockheed", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Janet is Director of Supplier Programs at Lockheed Martin and decides which small companies get qualified.", quote: "she's now director of supplier programs at Lockheed", confidence: 0.9 }),
      rel({ src_ref: "p_sarah", dst_ref: "p_marcus", type: "former_colleague", strength_signal: "strong", warmth_signal: "warm", context: "Sarah and Marcus were at Palantir together for four years; she is why he entered the industry.", quote: "Four years. She's the reason I got into this at all.", confidence: 0.95 }),
      rel({ src_ref: "p_alex", dst_ref: "p_marcus", type: "introduced_by", strength_signal: "moderate", warmth_signal: "warm", explicitness: "stated", context: "Sarah Chen introduced Alex to Marcus.", quote: "Sarah said you'd call. Any friend of hers." }),
      rel({ src_ref: "p_marcus", dst_ref: "o_anduril", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Marcus leads BD at Anduril.", quote: "Sarah said you'd call." }),
    ],
    intro_opportunities: [
      {
        connector_ref: "p_marcus",
        target_ref: "p_janet",
        basis: "Janet was his commanding officer at Fort Bragg; they remain close and she attended his wedding.",
        offered: true,
        quote: "For a company I believe in, yes. Send me the one-pager, I want to read it before I put my name on anything.",
        confidence: 0.95,
      },
      { connector_ref: "p_marcus", target_ref: "p_jen", basis: "Named as a fallback route into Lockheed.", offered: false, quote: "if you strike out there, Jen might have a route", confidence: 0.4 },
    ],
    asks_and_offers: [
      { actor_ref: "p_alex", kind: "ask", what: "Introduction to Lockheed Martin supplier programs for Lumen Robotics", urgency: "this_quarter", quote: "They need a path into a prime. Lockheed specifically." },
      { actor_ref: "p_marcus", kind: "offer", what: "Introduction to Janet Reyes at Lockheed, conditional on reading the one-pager", urgency: "now", quote: "For a company I believe in, yes." },
    ],
    commitments: [{ actor_ref: "p_alex", action: "Send Marcus the Lumen Robotics one-pager", due_hint: "before the intro", quote: "Send me the one-pager" }],
    outreach_hooks: [
      { person_ref: "p_marcus", hook: "Will not put his name on an intro before reading the material himself", kind: "professional", quote: "I want to read it before I put my name on anything." },
      { person_ref: "p_janet", hook: "Slow in the summer — she is in Montana most of August", kind: "timing", quote: "she's out at her place in Montana most of August" },
      { person_ref: "p_janet", hook: "Controls which small companies get qualified as Lockheed suppliers", kind: "professional", quote: "She decides which small companies get qualified." },
    ],
    topics: [{ ref: "t_supplier", name: "Supplier qualification", kind: "thesis", discussed_by_refs: ["p_marcus", "p_alex"], summary: "Small companies enter Lockheed through the supplier programs office rather than the front door." }],
  },
};

const M4: SeedMeeting = {
  title: "Priya Raman — Redwood Endowment",
  occurredAt: "2026-06-09T14:00:00Z",
  attendees: [
    { name: "Alex Moreau", email: "alex@harborline.vc", company: "Harborline Capital" },
    { name: "Priya Raman", email: "praman@redwood.edu", company: "Redwood University Endowment" },
  ],
  transcript: `Priya: Sarah vouched for you, so let's skip the preamble. What's the fund?
Alex: Harborline II. Two-fifty target, defense and industrial.
Priya: Our committee meets in October. If you want to be in that cycle I need materials by mid-September.
Alex: That works.
Priya: I'll say the useful thing: we're at our venture allocation for this year, so realistically I'm a first-close-of-next-year conversation, not this one. But I'll take the meeting because Sarah asked.
Alex: Honest is better.
Priya: Two others you should know. Michael Torres runs the CIO seat at Brightwater Pension — he and I sat on a manager selection committee together for three years, and he's actively adding defense exposure. I'd introduce you.
Alex: That'd be helpful.
Priya: The other is Elena Vasquez at Castellan. Family office. We worked together at Redwood years ago, she left to run their private book. Smaller cheques, moves in weeks not months.
Alex: How well do you know her?
Priya: Well enough to call. We're not close-close, but it's a real relationship.`,
  extraction: {
    meeting: {
      summary:
        "LP meeting with Priya Raman at Redwood University Endowment about Harborline II. Priya is out of venture allocation this year and framed herself as a next-year conversation, but offered introductions to Michael Torres (CIO, Brightwater Pension), who is actively adding defense exposure, and Elena Vasquez (Castellan Family Office).",
      meeting_type: "fundraising",
      occurred_at_hint: "2026-06-09",
      attendee_refs: ["p_alex", "p_priya"],
    },
    people: [
      person({ ref: "p_alex", name: "Alex Moreau", role_in_meeting: "attendee", title: "Managing Partner", organization_ref: "o_harborline", seniority: "partner", email: "alex@harborline.vc", disambiguation_context: "Managing partner at Harborline Capital raising Harborline II, a $250M defense and industrial fund." }),
      person({
        ref: "p_priya",
        name: "Priya Raman",
        role_in_meeting: "attendee",
        title: "Head of Private Markets",
        organization_ref: "o_redwood",
        seniority: "director",
        email: "praman@redwood.edu",
        expertise: ["LP allocation", "manager selection", "private markets"],
        disambiguation_context:
          "Head of private markets at Redwood University Endowment. Investment committee meets in October. Long-time Northlane LP introduced by Sarah Chen.",
        quote: "Our committee meets in October.",
        confidence: 0.95,
      }),
      person({
        ref: "p_michael",
        name: "Michael Torres",
        title: "Chief Investment Officer",
        organization_ref: "o_brightwater",
        seniority: "c_level",
        expertise: ["pension investing", "manager selection", "defense exposure"],
        disambiguation_context:
          "CIO at Brightwater Pension. Sat on a manager selection committee with Priya Raman for three years. Actively adding defense exposure to the portfolio.",
        quote: "Michael Torres runs the CIO seat at Brightwater Pension",
        confidence: 0.9,
      }),
      person({
        ref: "p_elena",
        name: "Elena Vasquez",
        title: "Head of Private Investments",
        organization_ref: "o_castellan",
        seniority: "director",
        expertise: ["family office investing", "private markets"],
        disambiguation_context:
          "Runs the private book at Castellan Family Office. Formerly worked with Priya Raman at Redwood. Writes smaller cheques and decides in weeks.",
        quote: "Elena Vasquez at Castellan. Family office.",
        confidence: 0.9,
      }),
      person({ ref: "p_sarah", name: "Sarah Chen", title: "General Partner", organization_ref: "o_northlane", seniority: "partner", disambiguation_context: "GP at Northlane Ventures whose vouching secured this LP meeting." }),
    ],
    organizations: [
      org({ ref: "o_harborline", name: "Harborline Capital", org_type: "vc_fund", sector: ["venture capital", "defense", "industrial"], stage: "Fund II", notable_facts: ["Harborline II targeting $250M"] }),
      org({ ref: "o_redwood", name: "Redwood University Endowment", org_type: "lp", sector: ["endowment"], notable_facts: ["Investment committee meets in October", "At its venture allocation for 2026"] }),
      org({ ref: "o_brightwater", name: "Brightwater Pension", org_type: "lp", sector: ["pension", "institutional"], notable_facts: ["Actively adding defense exposure"] }),
      org({ ref: "o_castellan", name: "Castellan Family Office", org_type: "family_office", sector: ["family office"], notable_facts: ["Smaller cheques, decides in weeks"] }),
      org({ ref: "o_northlane", name: "Northlane Ventures", org_type: "vc_fund", sector: ["venture capital"] }),
    ],
    relationships: [
      rel({
        src_ref: "p_priya",
        dst_ref: "p_michael",
        type: "former_colleague",
        strength_signal: "strong",
        warmth_signal: "warm",
        context: "Priya and Michael served together on a manager selection committee for three years.",
        quote: "he and I sat on a manager selection committee together for three years",
        confidence: 0.9,
      }),
      rel({
        src_ref: "p_priya",
        dst_ref: "p_elena",
        type: "former_colleague",
        strength_signal: "moderate",
        warmth_signal: "neutral",
        context: "Priya and Elena worked together at Redwood before Elena left for Castellan. A real but not close relationship.",
        quote: "We're not close-close, but it's a real relationship.",
        confidence: 0.9,
      }),
      rel({ src_ref: "p_michael", dst_ref: "o_brightwater", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Michael is CIO at Brightwater Pension.", quote: "Michael Torres runs the CIO seat at Brightwater Pension" }),
      rel({ src_ref: "p_elena", dst_ref: "o_castellan", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Elena runs the private book at Castellan.", quote: "she left to run their private book" }),
      rel({ src_ref: "p_elena", dst_ref: "o_redwood", type: "works_at", polarity: "negated", strength_signal: "moderate", warmth_signal: "neutral", context: "Elena worked at Redwood before moving to Castellan.", quote: "We worked together at Redwood years ago, she left" }),
      rel({ src_ref: "p_priya", dst_ref: "o_redwood", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Priya heads private markets at Redwood.", quote: "Our committee meets in October." }),
      rel({ src_ref: "p_sarah", dst_ref: "p_priya", type: "investor_in", strength_signal: "strong", warmth_signal: "warm", context: "Sarah's vouching is why this meeting happened.", quote: "Sarah vouched for you, so let's skip the preamble." }),
      rel({ src_ref: "p_alex", dst_ref: "o_harborline", type: "works_at", strength_signal: "strong", warmth_signal: "warm", context: "Alex is raising Harborline II.", quote: "Harborline II. Two-fifty target, defense and industrial." }),
    ],
    intro_opportunities: [
      { connector_ref: "p_priya", target_ref: "p_michael", basis: "Three years together on a manager selection committee; he is actively adding defense exposure.", offered: true, quote: "I'd introduce you.", confidence: 0.9 },
      { connector_ref: "p_priya", target_ref: "p_elena", basis: "Former colleagues at Redwood; close enough to call.", offered: false, quote: "Well enough to call.", confidence: 0.8 },
    ],
    asks_and_offers: [
      { actor_ref: "p_alex", kind: "ask", what: "LP commitment to Harborline II", urgency: "this_quarter", quote: "Harborline II. Two-fifty target, defense and industrial." },
      { actor_ref: "p_priya", kind: "offer", what: "Introductions to Michael Torres and Elena Vasquez", urgency: "now", quote: "I'd introduce you." },
    ],
    commitments: [{ actor_ref: "p_alex", action: "Send Redwood materials by mid-September for the October committee", due_hint: "mid-September 2025", quote: "I need materials by mid-September." }],
    outreach_hooks: [
      { person_ref: "p_priya", hook: "Committee meets in October; materials due mid-September", kind: "timing", quote: "If you want to be in that cycle I need materials by mid-September." },
      { person_ref: "p_priya", hook: "At venture allocation for 2026 — she is a first-close-of-next-year conversation", kind: "timing", quote: "realistically I'm a first-close-of-next-year conversation, not this one" },
      { person_ref: "p_michael", hook: "Actively adding defense exposure right now", kind: "timing", quote: "he's actively adding defense exposure" },
      { person_ref: "p_elena", hook: "Smaller cheques but moves in weeks, not months", kind: "professional", quote: "Smaller cheques, moves in weeks not months." },
    ],
    topics: [{ ref: "t_lp", name: "LP fundraising", kind: "asset_class", discussed_by_refs: ["p_alex", "p_priya"], summary: "Raising Harborline II from endowments, pensions and family offices." }],
  },
};

const M5: SeedMeeting = {
  title: "Elena Vasquez — Castellan Family Office",
  occurredAt: "2026-08-20T17:00:00Z",
  attendees: [
    { name: "Alex Moreau", email: "alex@harborline.vc", company: "Harborline Capital" },
    { name: "Elena Vasquez", email: "elena@castellan.co", company: "Castellan Family Office" },
  ],
  transcript: `Elena: Priya said good things, and Priya doesn't say good things.
Alex: I'll take it.
Elena: We do two or three fund commitments a year, five to ten million. The family made its money in industrials, so defense doesn't scare them the way it scares some of my peers.
Alex: That's rare.
Elena: It is. What's your differentiation?
Alex: Access. We can get a portfolio company qualified at a prime.
Elena: That's the whole game. Sarah Chen said something similar about you, actually — we were on a panel in March.
Alex: Small world.
Elena: Small industry. Send me the deck. If the committee likes it we can move by the end of October.`,
  extraction: {
    meeting: {
      summary:
        "LP meeting with Elena Vasquez at Castellan Family Office, sourced through Priya Raman. Castellan writes $5-10M cheques two or three times a year and is unusually comfortable with defense because of the family's industrial background. Elena also knows Sarah Chen from a March panel.",
      meeting_type: "fundraising",
      occurred_at_hint: "2026-08-20",
      attendee_refs: ["p_alex", "p_elena"],
    },
    people: [
      person({ ref: "p_alex", name: "Alex Moreau", role_in_meeting: "attendee", title: "Managing Partner", organization_ref: "o_harborline", seniority: "partner", email: "alex@harborline.vc", disambiguation_context: "Managing partner at Harborline Capital raising Harborline II." }),
      person({
        ref: "p_elena",
        name: "Elena Vasquez",
        role_in_meeting: "attendee",
        title: "Head of Private Investments",
        organization_ref: "o_castellan",
        seniority: "director",
        email: "elena@castellan.co",
        expertise: ["family office investing", "fund commitments", "industrials"],
        disambiguation_context:
          "Head of private investments at Castellan Family Office; two to three fund commitments a year at $5-10M. Introduced via Priya Raman; knows Sarah Chen from a March panel.",
        quote: "We do two or three fund commitments a year, five to ten million.",
        confidence: 0.95,
      }),
      person({ ref: "p_priya", name: "Priya Raman", title: "Head of Private Markets", organization_ref: "o_redwood", seniority: "director", disambiguation_context: "Head of private markets at Redwood University Endowment; referred Alex to Elena." }),
      person({ ref: "p_sarah", name: "Sarah Chen", title: "General Partner", organization_ref: "o_northlane", seniority: "partner", disambiguation_context: "GP at Northlane Ventures; shared a panel with Elena Vasquez in March." }),
    ],
    organizations: [
      org({ ref: "o_harborline", name: "Harborline Capital", org_type: "vc_fund", sector: ["venture capital", "defense"] }),
      org({ ref: "o_castellan", name: "Castellan Family Office", org_type: "family_office", sector: ["family office", "industrials"], notable_facts: ["Two to three fund commitments a year at $5-10M", "Family wealth from industrials, comfortable with defense"] }),
      org({ ref: "o_redwood", name: "Redwood University Endowment", org_type: "lp", sector: ["endowment"] }),
      org({ ref: "o_northlane", name: "Northlane Ventures", org_type: "vc_fund", sector: ["venture capital"] }),
    ],
    relationships: [
      rel({ src_ref: "p_priya", dst_ref: "p_elena", type: "former_colleague", strength_signal: "moderate", warmth_signal: "warm", context: "Priya referred Alex to Elena; her endorsement carries weight with Elena.", quote: "Priya said good things, and Priya doesn't say good things.", confidence: 0.9 }),
      rel({ src_ref: "p_elena", dst_ref: "p_sarah", type: "affiliated_with", strength_signal: "weak", warmth_signal: "neutral", explicitness: "stated", since: "March 2026", context: "Elena and Sarah Chen shared a panel in March 2026.", quote: "we were on a panel in March", confidence: 0.85 }),
      rel({ src_ref: "p_alex", dst_ref: "p_elena", type: "introduced_by", strength_signal: "moderate", warmth_signal: "warm", context: "Priya Raman referred Alex to Elena.", quote: "Priya said good things" }),
      rel({ src_ref: "p_elena", dst_ref: "o_castellan", type: "works_at", strength_signal: "strong", warmth_signal: "neutral", context: "Elena runs private investments at Castellan.", quote: "We do two or three fund commitments a year" }),
    ],
    intro_opportunities: [],
    asks_and_offers: [
      { actor_ref: "p_alex", kind: "ask", what: "Castellan commitment to Harborline II", urgency: "this_quarter", quote: "Access. We can get a portfolio company qualified at a prime." },
      { actor_ref: "p_elena", kind: "offer", what: "Committee review that could close by end of October", urgency: "this_quarter", quote: "If the committee likes it we can move by the end of October." },
    ],
    commitments: [{ actor_ref: "p_alex", action: "Send Elena the Harborline II deck", due_hint: "immediately", quote: "Send me the deck." }],
    outreach_hooks: [
      { person_ref: "p_elena", hook: "Family wealth is industrial, so defense is comfortable — unusual among family offices", kind: "professional", quote: "the family made its money in industrials, so defense doesn't scare them" },
      { person_ref: "p_elena", hook: "Can move by end of October if the committee likes it", kind: "timing", quote: "we can move by the end of October" },
    ],
    topics: [{ ref: "t_lp", name: "LP fundraising", kind: "asset_class", discussed_by_refs: ["p_alex", "p_elena"], summary: "Family office commitments to a defense-focused venture fund." }],
  },
};

export const SEED_MEETINGS: SeedMeeting[] = [M1, M2, M3, M4, M5];

export const SELF_NAME = "Alex Moreau";
