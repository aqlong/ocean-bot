import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAuthBypassedForDev } from "@/lib/approval-ops";
import { resolveInFlight } from "@/lib/in-flight";

// Cancel button. SIGTERM the child claude process recorded in
// current_run.childPid. Only works when the dashboard is co-located with
// the bot (single-host Mac launchd deploy); on a Railway-only deploy
// kill(2) on a remote PID is a no-op AND the PID may collide with an
// unrelated process on the Railway host. We guard with the env-flag
// OCEAN_BOT_CANCEL_ENABLED so the button can be hidden / disabled on
// hosted deploys until we wire a real RPC channel.

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
  if (process.env["OCEAN_BOT_CANCEL_ENABLED"] !== "1") {
    return NextResponse.json(
      {
        ok: false,
        error:
          "cancel not enabled (set OCEAN_BOT_CANCEL_ENABLED=1 when dashboard runs on the same host as the bot)",
      },
      { status: 409 },
    );
  }

  const flight = await resolveInFlight();
  if (flight.state !== "running") {
    return NextResponse.json(
      { ok: false, error: "no running run" },
      { status: 409 },
    );
  }
  const pid = flight.run.childPid;
  if (pid === null) {
    return NextResponse.json(
      { ok: false, error: "no child pid recorded yet" },
      { status: 409 },
    );
  }
  try {
    process.kill(pid, "SIGTERM");
    return NextResponse.json({ ok: true, pid });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
