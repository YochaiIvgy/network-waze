import { NextResponse } from "next/server";
import { getViewGraph } from "@/lib/view-model";
import { readSession } from "@/lib/granola/client";
import { hasAnthropicKey } from "@/lib/anthropic";
import { isEmbedded } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Everything the single-page client renders, in one round trip. */
export async function GET(request: Request) {
  try {
    const [graph, session] = await Promise.all([getViewGraph(), readSession(request)]);
    return NextResponse.json(
      {
        graph,
        connected: Boolean(session?.accessToken),
        canExtract: hasAnthropicKey(),
        embedded: isEmbedded(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
