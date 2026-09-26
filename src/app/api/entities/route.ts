import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { entityMutation, manageEntity } from "@/lib/manage-entities";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = entityMutation.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") }, { status: 400 });
  try {
    const ws = await getWorkspace();
    return NextResponse.json(await manageEntity(ws.id, parsed.data));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
