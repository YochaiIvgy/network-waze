import { createHash } from "node:crypto";

/**
 * Granola normalisation.
 *
 * Granola exports vary (JSON note, Markdown export, clipboard paste), but all of
 * them contain up to three regions with very different reliability. We tag the
 * regions rather than flattening them, because the extractor is told to trust the
 * attendee block for spelling and the transcript for relationship nuance.
 */

export interface NormalizedSource {
  title: string;
  externalId: string | null;
  occurredAt: string | null;
  body: string;
  attendeeHints: AttendeeHint[];
  contentHash: string;
  tokenEstimate: number;
  raw: Record<string, unknown>;
}

export interface AttendeeHint {
  name: string;
  email: string | null;
  company: string | null;
}

interface GranolaJsonNote {
  id?: string;
  title?: string;
  created_at?: string;
  createdAt?: string;
  date?: string;
  summary?: string;
  notes?: string;
  notes_markdown?: string;
  ai_summary?: string;
  transcript?: string | Array<{ speaker?: string; text?: string; start?: number }>;
  attendees?: Array<string | { name?: string; email?: string; company?: string }>;
  participants?: Array<string | { name?: string; email?: string; company?: string }>;
  [key: string]: unknown;
}

const REGION = {
  attendees: "[ATTENDEES]",
  summary: "[SUMMARY]",
  transcript: "[TRANSCRIPT]",
  notes: "[NOTES]",
} as const;

export function normalizeGranolaJson(note: GranolaJsonNote): NormalizedSource {
  const title = (note.title ?? "Untitled meeting").trim();
  const occurredAt = firstDate([note.created_at, note.createdAt, note.date]);
  const attendees = parseAttendees(note.attendees ?? note.participants ?? []);
  const transcript = flattenTranscript(note.transcript);
  const summary = (note.ai_summary ?? note.summary ?? "").trim();
  const notes = (note.notes_markdown ?? note.notes ?? "").trim();

  const body = assembleBody({ attendees, summary, notes, transcript });

  return {
    title,
    externalId: note.id ?? null,
    occurredAt,
    body,
    attendeeHints: attendees,
    contentHash: hash(`${title}\n${body}`),
    tokenEstimate: estimateTokens(body),
    raw: note as Record<string, unknown>,
  };
}

/**
 * Markdown / pasted export. Granola's markdown uses `## ` headings whose text we
 * match loosely, because the exact wording has changed across versions.
 */
export function normalizeGranolaMarkdown(text: string, fallbackTitle = "Pasted meeting"): NormalizedSource {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const titleLine = lines.find((l) => /^#\s+/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : fallbackTitle;

  const sections = splitSections(lines);
  const attendees = parseAttendees(
    (sections.attendees ?? "")
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean),
  );

  const body = assembleBody({
    attendees,
    summary: sections.summary ?? "",
    notes: sections.notes ?? "",
    transcript: sections.transcript ?? (sections.summary || sections.notes ? "" : stripTitle(text, titleLine)),
  });

  return {
    title,
    externalId: null,
    occurredAt: firstDate([findDateLine(lines)]),
    body,
    attendeeHints: attendees,
    contentHash: hash(`${title}\n${body}`),
    tokenEstimate: estimateTokens(body),
    raw: { format: "markdown", text },
  };
}

/** Entry point used by both the CLI and the paste box in the UI. */
export function normalizeGranola(input: string | GranolaJsonNote, fallbackTitle?: string): NormalizedSource {
  if (typeof input !== "string") return normalizeGranolaJson(input);
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    try {
      return normalizeGranolaJson(JSON.parse(trimmed) as GranolaJsonNote);
    } catch {
      /* fall through to markdown */
    }
  }
  return normalizeGranolaMarkdown(trimmed, fallbackTitle);
}

// --- internals -------------------------------------------------------------

function assembleBody(parts: {
  attendees: AttendeeHint[];
  summary: string;
  notes: string;
  transcript: string;
}): string {
  const chunks: string[] = [];
  if (parts.attendees.length) {
    chunks.push(
      `${REGION.attendees}\n` +
        parts.attendees
          .map((a) => `- ${a.name}${a.email ? ` <${a.email}>` : ""}${a.company ? ` — ${a.company}` : ""}`)
          .join("\n"),
    );
  }
  if (parts.summary) chunks.push(`${REGION.summary}\n${parts.summary}`);
  if (parts.notes) chunks.push(`${REGION.notes}\n${parts.notes}`);
  if (parts.transcript) chunks.push(`${REGION.transcript}\n${parts.transcript}`);
  return chunks.join("\n\n");
}

function splitSections(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current && buffer.length) out[current] = buffer.join("\n").trim();
    buffer = [];
  };

  for (const line of lines) {
    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const label = heading[1].toLowerCase();
      current = /attend|participant|people|invit/.test(label)
        ? "attendees"
        : /summary|overview|recap|takeaway/.test(label)
          ? "summary"
          : /transcript|conversation|dialogue/.test(label)
            ? "transcript"
            : /note|detail|discussion/.test(label)
              ? "notes"
              : null;
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return out;
}

function stripTitle(text: string, titleLine?: string): string {
  return titleLine ? text.replace(titleLine, "").trim() : text.trim();
}

function flattenTranscript(t: GranolaJsonNote["transcript"]): string {
  if (!t) return "";
  if (typeof t === "string") return t.trim();
  return t
    .map((seg) => `${seg.speaker ? `${seg.speaker}: ` : ""}${seg.text ?? ""}`.trim())
    .filter(Boolean)
    .join("\n");
}

function parseAttendees(list: Array<string | { name?: string; email?: string; company?: string }>): AttendeeHint[] {
  const out: AttendeeHint[] = [];
  for (const item of list) {
    if (typeof item === "string") {
      // "Sarah Chen <sarah@northlane.vc> — Northlane"
      const email = /<([^>]+)>/.exec(item)?.[1] ?? /([\w.+-]+@[\w.-]+\.\w+)/.exec(item)?.[1] ?? null;
      const withoutEmail = item.replace(/<[^>]+>/, "").replace(/[\w.+-]+@[\w.-]+\.\w+/, "");
      const [namePart, companyPart] = withoutEmail.split(/\s+[—–-]\s+/);
      const name = (namePart ?? "").trim().replace(/[,;]$/, "");
      if (!name && !email) continue;
      out.push({ name: name || (email ?? ""), email, company: companyPart?.trim() || null });
    } else {
      if (!item.name && !item.email) continue;
      out.push({ name: item.name ?? item.email ?? "", email: item.email ?? null, company: item.company ?? null });
    }
  }
  return out;
}

function firstDate(candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function findDateLine(lines: string[]): string | null {
  for (const line of lines.slice(0, 12)) {
    const m = /(\d{4}-\d{2}-\d{2})|((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})/i.exec(line);
    if (m) return m[0];
  }
  return null;
}

export function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Rough, and only used for display and cost estimates. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.8);
}
