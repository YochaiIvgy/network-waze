import { NextResponse } from "next/server";
import { publicSettings, saveSettings, settingsUpdate } from "@/lib/ai-settings";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try { return NextResponse.json(publicSettings(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Could not load AI settings." }, { status: 500 }); }
}
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return NextResponse.json({ error: "Settings must be saved from this app." }, { status: 403 });
  try {
    const parsed = settingsUpdate.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Choose a provider and enter a valid model ID." }, { status: 400 });
    return NextResponse.json(saveSettings(parsed.data), { headers: { "Cache-Control": "no-store" } });
  } catch { return NextResponse.json({ error: "Could not save AI settings." }, { status: 500 }); }
}
