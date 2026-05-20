import { NextResponse } from "next/server";
import { resolveInFlight } from "@/lib/in-flight";

// Lightweight read-only endpoint that powers the dashboard hero card.
// Auth happens via the root middleware (matcher includes /api/bot/*).
// We keep this in /api so the page can re-fetch via fetch() without a
// server-component roundtrip, useful if we later add finer-grained
// polling than the 5s page-refresh cadence.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const payload = await resolveInFlight();
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json(
      { state: "idle", error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
