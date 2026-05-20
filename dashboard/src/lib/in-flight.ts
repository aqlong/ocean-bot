// Pure shape resolver for the dashboard's "what's the bot doing now"
// hero card. The bot writes three state keys we read here:
//   - current_run         shape: { runId, taskSummary, model, startedAt, project, queue, runnerPid, childPid }
//   - tick_meta           shape: { lastEndedAt: ISO, intervalSec: number }
//   - tick_requested      boolean
//
// The bot also writes status='running' onto a row in ocean_bot_run.
// current_run is the primary source: it carries the friendly fields the
// card needs without a join, AND it disambiguates "running row in DB but
// process already exited" (race during shutdown).
//
// Plus the awaiting-approval count from ocean_bot_run, used only when
// there's no running run.

import { getDb, schema } from "./db";
import { and, eq, sql } from "drizzle-orm";

export type InFlightState =
  | { state: "running"; run: RunningRun }
  | { state: "awaiting"; awaitingCount: number }
  | { state: "idle"; lastTickEndedAt: string | null; nextTickAt: string | null; intervalSec: number | null };

export interface RunningRun {
  runId: string;
  project: string | null;
  queue: string | null;
  taskSummary: string | null;
  model: string | null;
  startedAt: string;
  elapsedMs: number;
  /** Heuristic per-model wall-clock budget; lets the UI show a progress
   *  bar without polling tool-call internals. */
  expectedTotalMs: number;
  childPid: number | null;
}

const EXPECTED_MS: Record<string, number> = {
  haiku: 3 * 60 * 1000,
  sonnet: 5 * 60 * 1000,
  opus: 12 * 60 * 1000,
};

function expectedMsFor(model: string | null | undefined): number {
  if (!model) return EXPECTED_MS["sonnet"]!;
  return EXPECTED_MS[model] ?? EXPECTED_MS["sonnet"]!;
}

interface StateBlob {
  current_run?: unknown;
  tick_meta?: unknown;
}

async function readStateKeys(): Promise<StateBlob> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(sql`${schema.oceanBotState.key} IN ('current_run', 'tick_meta')`);
  const out: StateBlob = {};
  for (const r of rows) {
    if (r.key === "current_run") out.current_run = r.value;
    else if (r.key === "tick_meta") out.tick_meta = r.value;
  }
  return out;
}

async function awaitingCount(): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.oceanBotRun)
    .where(eq(schema.oceanBotRun.status, "awaiting-approval"));
  return rows[0]?.count ?? 0;
}

/** A run row is "live" when status='running' AND it hasn't already been
 *  flipped to a terminal state. Used as a corroborating signal: if
 *  current_run state was written but the bot then crashed, we want to
 *  fall back to idle, not show a phantom running card. */
async function liveRunRowExists(runId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ status: schema.oceanBotRun.status })
    .from(schema.oceanBotRun)
    .where(
      and(eq(schema.oceanBotRun.id, runId), eq(schema.oceanBotRun.status, "running")),
    )
    .limit(1);
  return rows.length > 0;
}

export async function resolveInFlight(now: number = Date.now()): Promise<InFlightState> {
  const state = await readStateKeys();
  const cur = state.current_run as Record<string, unknown> | null | undefined;

  if (cur && typeof cur === "object" && typeof cur["runId"] === "string") {
    const runId = cur["runId"];
    if (await liveRunRowExists(runId)) {
      const startedAtIso = typeof cur["startedAt"] === "string" ? cur["startedAt"] : null;
      const startedMs = startedAtIso ? Date.parse(startedAtIso) : Number.NaN;
      const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now - startedMs) : 0;
      const model = typeof cur["model"] === "string" ? cur["model"] : null;
      const childPidRaw = cur["childPid"];
      const childPid = typeof childPidRaw === "number" ? childPidRaw : null;
      return {
        state: "running",
        run: {
          runId,
          project: stringOrNull(cur["project"]),
          queue: stringOrNull(cur["queue"]),
          taskSummary: stringOrNull(cur["taskSummary"]),
          model,
          startedAt: startedAtIso ?? new Date(now).toISOString(),
          elapsedMs,
          expectedTotalMs: expectedMsFor(model),
          childPid,
        },
      };
    }
  }

  const awaiting = await awaitingCount();
  if (awaiting > 0) {
    return { state: "awaiting", awaitingCount: awaiting };
  }

  const meta = state.tick_meta as Record<string, unknown> | null | undefined;
  const lastEndedAt = meta && typeof meta["lastEndedAt"] === "string"
    ? (meta["lastEndedAt"] as string)
    : null;
  const intervalSec = meta && typeof meta["intervalSec"] === "number"
    ? (meta["intervalSec"] as number)
    : null;
  let nextTickAt: string | null = null;
  if (lastEndedAt && intervalSec !== null) {
    const t = Date.parse(lastEndedAt);
    if (Number.isFinite(t)) nextTickAt = new Date(t + intervalSec * 1000).toISOString();
  }
  return { state: "idle", lastTickEndedAt: lastEndedAt, nextTickAt, intervalSec };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
