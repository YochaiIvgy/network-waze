import { NextResponse } from "next/server";
import { completeConnect } from "@/lib/granola/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await completeConnect(request);
  } catch (err) {
    console.error("granola_callback_failed", err);
    const url = new URL("/", request.url);
    url.searchParams.set("error", (err as Error).message);
    return NextResponse.redirect(url, 302);
  }
}
