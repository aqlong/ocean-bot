import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassedForDev, setStateValue } from "@/lib/approval-ops";

// "Tick now" button. Sets the tick_requested flag the bot's sleep loop
// polls every 2s; on the next poll the bot breaks the sleep early and
// runs an immediate tick. Idempotent: multiple presses while the bot
// is sleeping just collapse to one wake-up. While the bot is mid-tick,
// the flag sits set and gets consumed on the next sleep window.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function requireOcean(): Promise<boolean> {
  if (isAuthBypassedForDev()) return true;
  const session = await auth();
  const ghId = (session?.user as { githubId?: string } | undefined)?.githubId;
  return Boolean(ghId && ghId === process.env["OCEAN_USER_ID"]);
}

export async function POST(): Promise<Response> {
  if (!(await requireOcean())) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  await setStateValue("tick_requested", true);
  return NextResponse.json({ ok: true });
}
