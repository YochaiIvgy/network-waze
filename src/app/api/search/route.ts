import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { searchNetwork } from "@/lib/search/answer";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const { query } = (await request.json()) as { query?: string };
    if (!query || !query.trim()) {
      return NextResponse.json({ error: "Empty query." }, { status: 400 });
    }
    const ws = await getWorkspace();
    const result = await searchNetwork(ws.id, ws.self_entity_id, query.trim());
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
