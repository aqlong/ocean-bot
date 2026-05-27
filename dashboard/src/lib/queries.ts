// All read queries the dashboard runs. Single-user invariant, no
// tenant scope needed; the auth middleware ensures only Ocean reads.

import { getDb, schema } from "./db";
import { and, desc, eq, getTableColumns, gte, sql } from "drizzle-orm";

export async function summaryToday() {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ status: schema.oceanBotRun.status, count: sql<number>`count(*)::int` })
    .from(schema.oceanBotRun)
    .where(gte(schema.oceanBotRun.startedAt, since))
    .groupBy(schema.oceanBotRun.status);

  return tallyByStatus(rows);
}

export async function summaryWeek() {
  const db = getDb();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({ status: schema.oceanBotRun.status, count: sql<number>`count(*)::int` })
    .from(schema.oceanBotRun)
    .where(gte(schema.oceanBotRun.startedAt, since))
    .groupBy(schema.oceanBotRun.status);

  return tallyByStatus(rows);
}

function tallyByStatus(rows: Array<{ status: string; count: number }>) {
  const out = {
    shipped: 0,
    awaitingApproval: 0,
    running: 0,
    failed: 0,
    rejected: 0,
    total: 0,
  };
  for (const r of rows) {
    out.total += r.count;
    if (r.status === "shipped") out.shipped += r.count;
    else if (r.status === "awaiting-approval") out.awaitingApproval += r.count;
    else if (r.status === "running") out.running += r.count;
    else if (r.status === "failed") out.failed += r.count;
    else if (r.status === "rejected") out.rejected += r.count;
  }
  return out;
}

export async function recentRuns(limit = 25) {
  return getDb()
    .select({
      ...getTableColumns(schema.oceanBotRun),
      // Derived label that splits the `shipped` status into commit-bearing
      // ships vs no-op ships (the bot ran, decided no commit was needed,
      // marked the run shipped). Renderers use this to dim no-op rows so
      // the operator can tell at a glance that no work landed. Non-shipped
      // statuses still get a value but the renderer ignores it.
      outcome: sql<"shipped" | "shipped-noop">`CASE WHEN ${schema.oceanBotRun.commitSha} IS NULL THEN 'shipped-noop' ELSE 'shipped' END`,
    })
    .from(schema.oceanBotRun)
    .orderBy(desc(schema.oceanBotRun.startedAt))
    .limit(limit);
}

/**
 * Last N shipped (commit-bearing) runs per project, grouped into a
 * Record<project, rows[]>. Returns empty record when no runs match.
 *
 * Implementation: one query with ROW_NUMBER() OVER (PARTITION BY project)
 * + an outer rn-cap filter. Single round trip, server-side compute, no
 * per-project N+1. The commit_sha IS NOT NULL filter excludes no-op
 * ships (the bot ran, decided no commit was needed, marked the row
 * 'shipped'); a noop shouldn't show up as "last shipped" on the home
 * grid because nothing actually landed for that project.
 *
 * Date column: started_at (the run table doesn't carry a created_at;
 * see schema.ts oceanBotRun). Ordering by started_at DESC gives the
 * newest commit-bearing ship per project, which is what the home grid
 * "by project" section wants to surface.
 */
// Filters for the /runs list page. All fields optional; omitting a field
// means no constraint on that column. `since` is an exclusive lower-bound
// on startedAt (runs started strictly after the given Date are included).
export interface RunsFilter {
  project?: string;
  queue?: string;
  status?: string;
  since?: Date;
}

// Page-based pagination result. Fetches pageSize+1 internally so callers
// know whether more rows exist without issuing a separate COUNT query.
// `hasMore=true` means there is at least one row beyond the current page.
export async function listRuns(
  filter: RunsFilter = {},
  page = 1,
  pageSize = 25,
) {
  const offset = (Math.max(1, page) - 1) * pageSize;
  const rows = await getDb()
    .select({
      ...getTableColumns(schema.oceanBotRun),
      outcome: sql<"shipped" | "shipped-noop">`CASE WHEN ${schema.oceanBotRun.commitSha} IS NULL THEN 'shipped-noop' ELSE 'shipped' END`,
    })
    .from(schema.oceanBotRun)
    .where(
      and(
        filter.project
          ? eq(schema.oceanBotRun.project, filter.project)
          : undefined,
        filter.queue
          ? eq(schema.oceanBotRun.queue, filter.queue)
          : undefined,
        filter.status
          ? eq(schema.oceanBotRun.status, filter.status)
          : undefined,
        filter.since
          ? gte(schema.oceanBotRun.startedAt, filter.since)
          : undefined,
      ),
    )
    .orderBy(desc(schema.oceanBotRun.startedAt))
    .limit(pageSize + 1)
    .offset(offset);

  const hasMore = rows.length > pageSize;
  return {
    runs: hasMore ? rows.slice(0, pageSize) : rows,
    hasMore,
  };
}

export interface LastShippedRow {
  id: string;
  project: string;
  taskSummary: string;
  startedAt: Date;
  commitSha: string;
}

export async function lastShippedByProject(
  perProject = 5,
): Promise<Record<string, LastShippedRow[]>> {
  const result = await getDb().execute(sql`
    WITH ranked AS (
      SELECT
        id,
        project,
        task_summary,
        started_at,
        commit_sha,
        ROW_NUMBER() OVER (PARTITION BY project ORDER BY started_at DESC) AS rn
      FROM ocean_bot_run
      WHERE status = 'shipped' AND commit_sha IS NOT NULL
    )
    SELECT id, project, task_summary, started_at, commit_sha
    FROM ranked
    WHERE rn <= ${perProject}
    ORDER BY project ASC, started_at DESC
  `);

  const out: Record<string, LastShippedRow[]> = {};
  for (const raw of result.rows as Array<{
    id: string;
    project: string;
    task_summary: string;
    started_at: Date | string;
    commit_sha: string;
  }>) {
    const row: LastShippedRow = {
      id: raw.id,
      project: raw.project,
      taskSummary: raw.task_summary,
      startedAt:
        raw.started_at instanceof Date
          ? raw.started_at
          : new Date(raw.started_at),
      commitSha: raw.commit_sha,
    };
    (out[row.project] ??= []).push(row);
  }
  return out;
}

// Failed runs in the last `sinceMin` minutes that have a commit SHA.
// Used by the dashboard's reclassify step to ask GitHub whether each
// commit landed on origin/main via another channel (operator push
// after the bot's push-step failed). Returns only the columns the
// reclassifier needs, not the full row, to keep the payload small.
export async function failedRunsWithCommitSinceMin(sinceMin: number) {
  const since = new Date(Date.now() - sinceMin * 60 * 1000);
  return getDb()
    .select({
      id: schema.oceanBotRun.id,
      project: schema.oceanBotRun.project,
      branch: schema.oceanBotRun.branch,
      commitSha: schema.oceanBotRun.commitSha,
      status: schema.oceanBotRun.status,
    })
    .from(schema.oceanBotRun)
    .where(
      and(
        gte(schema.oceanBotRun.startedAt, since),
        eq(schema.oceanBotRun.status, "failed"),
        sql`${schema.oceanBotRun.commitSha} IS NOT NULL`,
      ),
    );
}

export async function pendingApprovals() {
  return getDb()
    .select()
    .from(schema.oceanBotRun)
    .where(eq(schema.oceanBotRun.status, "awaiting-approval"))
    .orderBy(desc(schema.oceanBotRun.startedAt));
}

export async function runById(id: string) {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotRun)
    .where(eq(schema.oceanBotRun.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function eventsForRun(runId: string, limit = 500) {
  return getDb()
    .select()
    .from(schema.oceanBotEvent)
    .where(eq(schema.oceanBotEvent.runId, runId))
    .orderBy(schema.oceanBotEvent.ts)
    .limit(limit);
}

export async function budgetState() {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "budget"))
    .limit(1);
  return rows[0]?.value ?? null;
}

// Reads the unix-ms anchor that the bot stamps at the first bot-attributed
// token of each fresh 5hr Anthropic billing window (see
// tools/ocean-bot/src/journal.ts:getFiveHrWindowStart). Returns null when
// no window is active, the row is missing, or the stored value is anything
// other than a finite number. The /budget page uses this to show explicit
// "started X ago / resets in Y" text instead of inferring the boundary
// from the oldest usage row.
export async function fiveHrWindowStart(): Promise<Date | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "fiveHr_window_start_ts"))
    .limit(1);
  const v = rows[0]?.value;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return new Date(v);
}

export async function botStateFlags() {
  const rows = await getDb().select().from(schema.oceanBotState);
  const out: Record<string, unknown> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Read pause flag plus the timestamp it was last toggled. updatedAt on
// the `paused` row tracks the last write; while value=true it is when
// the operator paused the bot. Returns null pausedSince when the row
// is missing or value is anything other than true, so callers can
// branch on `paused`.
export async function pausedState(): Promise<{
  paused: boolean;
  pausedSince: Date | null;
}> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "paused"))
    .limit(1);
  const row = rows[0];
  const paused = row?.value === true;
  return { paused, pausedSince: paused ? row?.updatedAt ?? null : null };
}

// Phantom-row health surface. Bot writes a `phantom_cleanup_last_run`
// row to ocean_bot_state every time the cleanup tick fires (or skips);
// we read it back here for /health. See tools/ocean-bot/src/phantom-cleanup.ts.
export async function phantomRowCount(daysBack = 7): Promise<number> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const rows = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.oceanBotRun)
    .where(
      and(
        eq(schema.oceanBotRun.status, "shipped"),
        eq(schema.oceanBotRun.pushState, "local"),
        sql`${schema.oceanBotRun.userDecision} IS NULL`,
        sql`${schema.oceanBotRun.commitSha} IS NULL`,
        gte(schema.oceanBotRun.startedAt, since),
      ),
    );
  return rows[0]?.count ?? 0;
}

export interface PhantomCleanupRun {
  ranAt: Date | null;
  flipped: number;
  runIds: string[];
}

export async function lastPhantomCleanupRun(): Promise<PhantomCleanupRun | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "phantom_cleanup_last_run"))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const v = row.value as {
    ranAt?: string;
    flipped?: number;
    runIds?: string[];
  } | null;
  if (!v) return null;
  const parsed = v.ranAt ? new Date(v.ranAt) : null;
  return {
    ranAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    flipped: typeof v.flipped === "number" ? v.flipped : 0,
    runIds: Array.isArray(v.runIds) ? v.runIds : [],
  };
}

// usageWindows() was removed in the v1 review, the ocean_bot_usage
// table doesn't have a watermark scheme yet, so summing it would
// double-count rows on each tick write. The /budget page now relies
// solely on the bot's last-tick snapshot in ocean_bot_state. Historical
// chart is a phase-2 item, when wired, this is where the SUM lives.

// Health-sweep surface (auto self-checks). Bot writes
// `health_sweep_last_run` every tick after running runHealthSweep().
// See tools/ocean-bot/src/health-sweep.ts. We render the result on
// /health alongside drift + phantom counters.
export interface HealthSweepStuckGroup {
  project: string;
  taskId: string;
  count: number;
  lastSeen: string;
  lastBlocker: string | null;
}

export interface HealthSweepSnapshot {
  ranAt: Date | null;
  fixedStaleOpen: number;
  fixedStaleOpenIds: string[];
  stuckNoop: HealthSweepStuckGroup[];
  stuckPreflight: HealthSweepStuckGroup[];
  staleApproved: HealthSweepStuckGroup[];
  /** Phantom 'running' rows flipped to 'failed' by the last sweep
   *  because they sat past the stale-running window (default 24h) with
   *  no terminal event. Pre-sweep installs see 0; legitimately-active
   *  runs are below the cutoff so the steady-state target is 0. */
  fixedStalePhantomRunning: number;
  fixedStalePhantomRunningIds: string[];
}

export async function lastHealthSweep(): Promise<HealthSweepSnapshot | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "health_sweep_last_run"))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const v = row.value as
    | {
        ranAt?: string;
        stale?: { fixedCount?: number; fixedIds?: string[] };
        stuckNoop?: HealthSweepStuckGroup[];
        stuckPreflight?: HealthSweepStuckGroup[];
        staleApproved?: HealthSweepStuckGroup[];
        stalePhantomRunning?: { fixedCount?: number; fixedIds?: string[] };
      }
    | null;
  if (!v) return null;
  const parsed = v.ranAt ? new Date(v.ranAt) : null;
  return {
    ranAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    fixedStaleOpen:
      typeof v.stale?.fixedCount === "number" ? v.stale.fixedCount : 0,
    fixedStaleOpenIds: Array.isArray(v.stale?.fixedIds) ? v.stale.fixedIds : [],
    stuckNoop: Array.isArray(v.stuckNoop) ? v.stuckNoop : [],
    stuckPreflight: Array.isArray(v.stuckPreflight) ? v.stuckPreflight : [],
    staleApproved: Array.isArray(v.staleApproved) ? v.staleApproved : [],
    fixedStalePhantomRunning:
      typeof v.stalePhantomRunning?.fixedCount === "number"
        ? v.stalePhantomRunning.fixedCount
        : 0,
    fixedStalePhantomRunningIds: Array.isArray(v.stalePhantomRunning?.fixedIds)
      ? v.stalePhantomRunning.fixedIds
      : [],
  };
}
