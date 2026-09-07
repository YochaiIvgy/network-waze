import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { normalizeGranola } from "@/lib/ingest/granola";
import { ingestSource } from "@/lib/ingest/pipeline";
import { hasAnthropicKey } from "@/lib/anthropic";

export const dynamic = "force-dynamic";
// Extraction on a long transcript is the slowest thing the app does.
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    if (!hasAnthropicKey()) {
      return NextResponse.json(
        { error: "ANTHROPIC_API_KEY is not set. Extraction needs it; browsing the graph does not." },
        { status: 400 },
      );
    }
    const { text, title } = (await request.json()) as { text?: string; title?: string };
    if (!text || text.trim().length < 40) {
      return NextResponse.json({ error: "Paste a transcript first." }, { status: 400 });
    }

    const ws = await getWorkspace();
    const doc = normalizeGranola(text, title || "Pasted meeting");
    const result = await ingestSource(ws.id, doc);

    return NextResponse.json({
      ...result,
      title: doc.title,
      tokenEstimate: doc.tokenEstimate,
      attendees: doc.attendeeHints.length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
