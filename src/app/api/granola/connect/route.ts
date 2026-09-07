import { NextResponse } from "next/server";
import { beginConnect } from "@/lib/granola/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await beginConnect(request);
  } catch (err) {
    // Also log it: the redirect carries a one-line message, but the stack and
    // the underlying cause are what actually diagnose a transport failure.
    console.error("granola_connect_failed", err);
    const url = new URL("/", request.url);
    url.searchParams.set("error", (err as Error).message);
    return NextResponse.redirect(url, 302);
  }
}
