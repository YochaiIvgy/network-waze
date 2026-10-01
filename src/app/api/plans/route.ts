import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspace, one } from "@/lib/db";
import { planSchema } from "@/lib/plans";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ws = await getWorkspace();
    const row = await one<{ board: { revision: number; plan: unknown } | null }>("SELECT settings->'plans' AS board FROM workspaces WHERE id = $1", [ws.id]);
    return NextResponse.json({ ...(row?.board ?? { revision: 0, plan: null }), workspaceId: ws.id });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  let input: unknown;
  try { input = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  try {
    const body = z.object({ revision: z.number().int().nonnegative(), plan: planSchema }).safeParse(input);
    if (!body.success) return NextResponse.json({ error: "Invalid plan." }, { status: 400 });
    const ws = await getWorkspace();
    const { revision, plan } = body.data;
    const row = await one<{ id: string }>(
      `UPDATE workspaces SET settings = jsonb_set(settings, '{plans}', $2::jsonb)
       WHERE id = $1 AND COALESCE((settings->'plans'->>'revision')::int, 0) = $3 RETURNING id`,
      [ws.id, JSON.stringify({ revision: revision + 1, plan }), revision],
    );
    if (!row) return NextResponse.json({ error: "This plan changed in another tab. Reload to get that version." }, { status: 409 });
    return NextResponse.json({ revision: revision + 1 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
