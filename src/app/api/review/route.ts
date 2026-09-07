import { NextResponse } from "next/server";
import { getWorkspace } from "@/lib/db";
import { applyReviewVerdict } from "@/lib/resolution/resolve";
import { projectGraph } from "@/lib/graph/project";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const { reviewId, verdict } = (await request.json()) as {
      reviewId?: string;
      verdict?: "same" | "different";
    };
    if (!reviewId || (verdict !== "same" && verdict !== "different")) {
      return NextResponse.json({ error: "reviewId and verdict are required." }, { status: 400 });
    }

    await applyReviewVerdict(reviewId, verdict, "human");
    // A merge changes which entities exist, so the projection has to follow.
    const ws = await getWorkspace();
    await projectGraph(ws.id);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
