import { NextResponse } from "next/server";
import { listProviderModels, modelsQuery } from "@/lib/ai-models";
import { resolveApiKey } from "@/lib/ai-settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: "Models must be listed from this app." }, { status: 403 });
  }
  try {
    const parsed = modelsQuery.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Choose a provider to list models." }, { status: 400 });
    const apiKey = resolveApiKey(parsed.data.provider, parsed.data.apiKey);
    if (!apiKey) return NextResponse.json({ error: "Add an API key to load models for this provider." }, { status: 400 });
    return NextResponse.json({ models: await listProviderModels(parsed.data.provider, apiKey) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list models.";
    const status = message.includes("rejected") ? 401 : message.includes("rate-limited") ? 429 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
