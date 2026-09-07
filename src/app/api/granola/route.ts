import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { hasAnthropicKey } from "@/lib/anthropic";
import { disconnect, mcp, readSession, toolArgs, type McpClient } from "@/lib/granola/client";
import { parseMeetingResult, parseTranscriptResult, responseShape } from "@/lib/granola/response";
import { displayTranscript, normalizeGranola } from "@/lib/ingest/granola";
import {
  extractStoredSource,
  ingestSource,
  sourcesByExternalIds,
  storeSource,
} from "@/lib/ingest/pipeline";

export const dynamic = "force-dynamic";
// Listing hydrates missing transcripts; extraction is the slowest call in the app.
export const maxDuration = 300;

/**
 * Granola is transport. `list` enumerates meetings and fetches any transcript
 * we have not stored yet. `extract` runs our own model against that stored
 * copy — Granola's conversational query tool is never asked to do the analysis.
 *
 * That is the substantive difference from chunk-and-ask extraction: one model
 * call sees the entire transcript, so a relationship mentioned in minute 3 and
 * confirmed in minute 40 becomes one claim with two quotes instead of two
 * fragments that later have to be reconciled.
 */
export async function POST(request: Request) {
  try {
    const { action, meetingId, title, date } = (await request.json()) as {
      action?: string;
      meetingId?: string;
      title?: string;
      date?: string;
    };

    if (action === "disconnect") {
      await disconnect(request);
      return NextResponse.json({ ok: true });
    }

    if (action === "list") {
      const client = await mcp(request);
      const tool = requireTool(client, "list_meetings");
      const result = await client.call(tool.name, toolArgs(tool, {}));
      const { meetings, recognized } = parseMeetingResult(result);
      if (!recognized) {
        // Log the shape, never the content — this payload is a user's meetings.
        console.error("granola_meeting_format", JSON.stringify(responseShape(result)));
        throw new Error("Granola returned an unreadable meeting list. Please retry.");
      }

      const listed = meetings.slice(0, 50);
      const ws = await getWorkspace();
      const stored = await sourcesByExternalIds(
        ws.id,
        listed.map((m) => m.id),
      );
      const errors: Record<string, string> = {};
      const fetched: Array<{ id: string; title: string; date?: string; transcript: string }> = [];

      await poolMap(
        listed.filter((m) => !stored.has(m.id)),
        3,
        async (meeting) => {
          try {
            fetched.push({
              ...meeting,
              transcript: await readTranscript(client, meeting.id),
            });
          } catch (err) {
            errors[meeting.id] = (err as Error).message;
          }
        },
      );

      for (const meeting of fetched) {
        try {
          const doc = normalizeGranola({
            id: meeting.id,
            title: meeting.title,
            created_at: meeting.date,
            transcript: meeting.transcript,
          });
          await storeSource(ws.id, doc);
          stored.set(meeting.id, {
            id: "",
            externalId: meeting.id,
            body: doc.body,
            raw: doc.raw,
          });
        } catch (err) {
          errors[meeting.id] = (err as Error).message;
        }
      }

      return NextResponse.json({
        meetings: listed.map((m) => {
          const local = stored.get(m.id);
          return {
            ...m,
            transcript: local ? displayTranscript(local.raw, local.body) : null,
            error: errors[m.id],
          };
        }),
      });
    }

    if (action === "extract") {
      if (!hasAnthropicKey()) {
        throw new Error(
          "ANTHROPIC_API_KEY is not set. Extraction needs it; browsing the graph does not.",
        );
      }
      if (typeof meetingId !== "string" || !meetingId || meetingId.length > 200) {
        throw new Error("Choose a valid meeting.");
      }

      const ws = await getWorkspace();
      const existing = (await sourcesByExternalIds(ws.id, [meetingId])).get(meetingId);
      if (existing) {
        const result = await extractStoredSource(ws.id, existing.id);
        return NextResponse.json({ ...result, title: title || "Granola meeting" });
      }

      const client = await mcp(request);
      const transcript = await readTranscript(client, meetingId);
      const doc = normalizeGranola({
        id: meetingId,
        title: title || "Granola meeting",
        created_at: typeof date === "string" && date.length <= 100 ? date : undefined,
        transcript,
      });

      const result = await ingestSource(ws.id, doc);
      return NextResponse.json({ ...result, title: doc.title, tokenEstimate: doc.tokenEstimate });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const session = await readSession(request);
  return NextResponse.json({ connected: Boolean(session?.accessToken) });
}

function requireTool(client: McpClient, name: string) {
  const tool = client.tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Granola does not provide ${name} on this account.`);
  return tool;
}

async function readTranscript(client: McpClient, meetingId: string): Promise<string> {
  const tool = requireTool(client, "get_meeting_transcript");
  const transcript = parseTranscriptResult(await client.call(tool.name, toolArgs(tool, { meetingId })));
  if (!transcript || transcript.trim().length < 40) {
    throw new Error(
      "Granola returned no transcript for this meeting. Full transcripts depend on your Granola plan.",
    );
  }
  return transcript;
}

async function poolMap<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  const n = Math.min(Math.max(limit, 1), items.length);
  if (n === 0) return;
  await Promise.all(Array.from({ length: n }, () => worker()));
}
