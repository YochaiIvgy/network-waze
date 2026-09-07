/**
 * Granola's MCP tool output is not a stable contract.
 *
 * The same account can return structured JSON, a list of text blocks, a fenced
 * code block with prose around it, or an XML-ish `<meeting>` tag soup — and the
 * shape changes with the plan and the tool. These readers accept all of it and
 * report whether the payload was *recognised*, so an unreadable response fails
 * loudly instead of silently importing nothing.
 *
 * Only meeting listing and transcript fetching live here. Relationship
 * extraction deliberately does not: it runs through our own structured-output
 * model call, where a malformed result is a type error rather than a parse
 * gamble. See `lib/extraction/`.
 */

export interface MeetingSummary {
  id: string;
  title: string;
  date?: string;
}

type RecordValue = Record<string, unknown>;

const record = (v: unknown): v is RecordValue =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

const nonempty = (v: unknown): v is string => typeof v === "string" && Boolean(v.trim());

/** Keys Granola has been observed to nest its payload under. */
const WRAPPERS = [
  "structuredContent", "content", "data", "result", "results", "meetings",
  "meeting", "notes", "documents", "items", "text", "answer", "response",
];

const COLLECTION_KEYS = ["meetings", "notes", "documents", "items", "results", "data"];

export function parseJson(text: string): unknown {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    // An answer may wrap a fenced JSON payload in prose.
  }
  const fenced = /```json\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(clean.slice(start, end + 1));
    } catch {
      // Not JSON.
    }
  }
  return null;
}

export function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? whole;
    const n =
      entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
    const valid = n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff);
    return valid ? String.fromCodePoint(n) : whole;
  });
}

/**
 * `recognized` distinguishes "your account genuinely has no meetings" from "we
 * could not read what Granola sent". Collapsing those two produces an empty
 * screen with no explanation, which is the worst possible failure here.
 */
export function parseMeetingResult(value: unknown): {
  meetings: MeetingSummary[];
  recognized: boolean;
} {
  const meetings = new Map<string, MeetingSummary>();
  let recognized = false;

  function add(id: unknown, title: unknown, date?: unknown) {
    if (!nonempty(id) || !nonempty(title) || id.length > 200 || /[\u0000-\u001f]/.test(id)) return;
    if (!meetings.has(id)) {
      meetings.set(id, { id, title: title.trim(), ...(nonempty(date) ? { date } : {}) });
    }
    recognized = true;
  }

  function visit(v: unknown, depth = 0, collection = false) {
    if (depth > 12) return;

    if (Array.isArray(v)) {
      if (collection && !v.length) recognized = true;
      for (const item of v) visit(item, depth + 1, collection);
      return;
    }

    if (record(v)) {
      add(
        v.id ?? v.meeting_id ?? v.document_id ?? v.note_id,
        v.title ?? v.meeting_title ?? v.meetingTitle ?? (collection ? v.name : undefined),
        v.date ?? v.created_at ?? v.createdAt,
      );
      for (const key of WRAPPERS) {
        if (key in v) visit(v[key], depth + 1, COLLECTION_KEYS.includes(key));
      }
      return;
    }

    if (typeof v !== "string") return;

    const parsed = /<meeting\b/i.test(v) ? null : parseJson(v);
    if (parsed !== null) {
      visit(parsed, depth + 1, true);
      return;
    }

    // Tokenise `<meeting>` tags only. This never parses or executes HTML/DTD and
    // never expands external entities — the payload is untrusted input.
    const opening = /<meeting\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
    let match: RegExpExecArray | null;
    while ((match = opening.exec(v))) {
      const attributes: Record<string, string> = {};
      for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attributes[attr[1].toLowerCase()] = decodeXml(attr[2] ?? attr[3]);
      }
      const next = v.indexOf("</meeting>", opening.lastIndex);
      const inside = next >= 0 && !match[0].endsWith("/>") ? v.slice(opening.lastIndex, next) : "";
      const child = (tag: string) => {
        const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(inside);
        return m ? decodeXml(m[1].trim()) : undefined;
      };
      add(
        attributes.id ?? attributes.meeting_id ?? child("id"),
        attributes.title ?? child("title"),
        attributes.date ?? child("date"),
      );
    }

    const emptyListing =
      /^\s*<meetings\b[^>]*\/\s*>\s*$/i.test(v) ||
      /^\s*<meetings\b[^>]*>\s*<\/meetings>\s*$/i.test(v) ||
      /^\s*(?:no meetings(?: found| available)?(?:[.!]| for[^\n]*)?|0 meetings)\s*$/i.test(v);
    if (emptyListing) recognized = true;
  }

  visit(value, 0, true);
  return { meetings: [...meetings.values()], recognized };
}

export function parseTranscriptResult(value: unknown): string {
  function visit(v: unknown, depth: number): string {
    if (depth > 12) return "";

    if (typeof v === "string") {
      const parsed = parseJson(v);
      if (parsed !== null) return visit(parsed, depth + 1);
      const transcript = /<transcript\b[^>]*>([\s\S]*?)<\/transcript>/i.exec(v);
      return transcript ? decodeXml(transcript[1]) : v;
    }

    if (Array.isArray(v)) {
      return v.map((item) => visit(item, depth + 1)).filter(Boolean).join("\n");
    }

    if (record(v)) {
      // Utterance text only — never let an id or title become "transcript
      // evidence", because every downstream quote is validated against this.
      for (const key of ["transcript", "utterances", "segments", "structuredContent", "content", "text", "data", "result"]) {
        if (key in v) {
          const text = visit(v[key], depth + 1);
          if (text) return text;
        }
      }
    }
    return "";
  }
  return visit(value, 0);
}

/** Structural diagnostics only: no titles, transcript text, tokens or values. */
export function responseShape(value: unknown): unknown {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 4) return typeof v;
    if (typeof v === "string") {
      return {
        type: "string",
        length: v.length,
        format: /<meetings?\b/i.test(v) ? "meeting-xml" : parseJson(v) !== null ? "json" : "text",
      };
    }
    if (Array.isArray(v)) {
      return { type: "array", length: v.length, items: v.slice(0, 2).map((x) => walk(x, depth + 1)) };
    }
    if (record(v)) {
      return Object.fromEntries(WRAPPERS.filter((k) => k in v).map((k) => [k, walk(v[k], depth + 1)]));
    }
    return typeof v;
  };
  return walk(value, 0);
}
