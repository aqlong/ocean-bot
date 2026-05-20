// Health-sweep, integrity + loop-detection checks that run once per
// tick to catch silent failure modes the bot won't notice on its own.
//
// Why this module exists: a bot bug landed 2026-05-16 where the auto-
// push ship path skipped markBacklogItemDone. Backlog items stayed
// `status='open'` after their commit landed; the bot re-picked them on
// the next tick, got a no-op (work was already done), and the no-op
// locked the task in recentlyNoopTaskIds for 24h. Top of backlog
// looked "frozen" without the operator noticing for hours.
//
// The fix (6a97bc5) closed the bug, but the class of failure remains:
// any future regression that silently breaks an invariant (item closes
// on ship, runs progress to terminal status, retries are bounded)
// will go undetected until the operator notices. Health-sweep is the
// auto-self-check that catches these BEFORE the operator notices.
//
// Each sweep falls into one of two categories:
//   - AUTO-FIX, the bot can repair the invariant violation itself
//     (e.g., a shipped backlog item that's still status='open'). Fix
//     in place, log how many were fixed, move on.
//   - DETECT-ONLY, surfacing the violation to the operator is the
//     right move (e.g., a task that's noop'd 4 times in a week is
//     probably mis-specified and needs a description rewrite). Write
//     to ocean_bot_state for the /health dashboard.
//
// All sweeps are read-only-friendly: failures are caught + logged,
// never thrown; the bot's tick proceeds regardless. The sweep is best-
// effort by design (a dropped sweep cycle is fine; the next tick re-
// runs it).

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDb, schema } from "./db/index.js";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { log } from "./util/log.js";
import { setState } from "./journal.js";

/** Sweep result for the auto-fix path: shipped backlog items that
 *  somehow stayed status='open' after the commit landed. */
export interface StaleOpenSweepResult {
  fixedCount: number;
  fixedIds: string[];
}

/** Sweep result for detect-only loop detection. The bot doesn't auto-
 *  block these (we'd risk false-positives killing legitimate retries);
 *  surface to the operator instead. */
export interface StuckTaskGroup {
  /** Project the task lives under. */
  project: string;
  /** Stable task id (e.g., "backlog:parser-filter-X"). */
  taskId: string;
  /** Count of matching runs in the lookback window. */
  count: number;
  /** Most recent run timestamp (ISO). Useful for sorting. */
  lastSeen: string;
  /** Most recent blocker text, truncated. Gives the operator a fast
   *  read on "what's going wrong." */
  lastBlocker: string | null;
}

/** Combined sweep state written to ocean_bot_state under
 *  HEALTH_SWEEP_STATE_KEY each tick. The /health dashboard reads this
 *  to render the auto-checks panel. */
export interface HealthSweepState {
  /** ISO timestamp of last sweep run. */
  ranAt: string;
  /** Auto-fixed items in this run. */
  stale: StaleOpenSweepResult;
  /** Read-only detection: tasks no-op'd >= threshold in the window. */
  stuckNoop: StuckTaskGroup[];
  /** Read-only detection: tasks preflight-failed >= threshold. */
  stuckPreflight: StuckTaskGroup[];
  /** Read-only detection: approved runs that never shipped. */
  staleApproved: StuckTaskGroup[];
}

export const HEALTH_SWEEP_STATE_KEY = "health_sweep_last_run";

const DEFAULT_NOOP_THRESHOLD = 3;
const DEFAULT_PREFLIGHT_THRESHOLD = 3;
const DEFAULT_LOOKBACK_HOURS = 7 * 24;
const DEFAULT_APPROVED_STALE_HOURS = 72;

/** AUTO-FIX: close backlog items that have a shipped run referencing
 *  them but somehow stayed status='open'. The query joins ocean_bot_run
 *  to ocean_bot_backlog_item via the `backlog:<id>` taskId encoding.
 *  Idempotent: a second call on the same DB state finds nothing. */
export async function sweepStaleOpenBacklogItems(): Promise<StaleOpenSweepResult> {
  try {
    // Drizzle doesn't have a clean "join + update returning" idiom for
    // this shape, so raw SQL. Returns ids of items we flipped from
    // 'open' to 'done'; safe because the only condition is "has at
    // least one shipped run with a non-null commit_sha for this item."
    const updated = await getDb().execute(sql`
      UPDATE ocean_bot_backlog_item AS b
      SET status = 'done', updated_at = now()
      FROM ocean_bot_run AS r
      WHERE b.status = 'open'
        AND r.status = 'shipped'
        AND r.commit_sha IS NOT NULL
        AND r.project = b.project
        AND r.metadata->>'taskId' = 'backlog:' || b.id
      RETURNING b.id;
    `);
    const fixedIds = (updated.rows as { id: string }[]).map((r) => r.id);
    if (fixedIds.length > 0) {
      log.warn("health_sweep.stale_open_backlog_items_fixed", {
        count: fixedIds.length,
        ids: fixedIds,
      });
    }
    return { fixedCount: fixedIds.length, fixedIds };
  } catch (e) {
    log.error("health_sweep.sweepStaleOpenBacklogItems failed", {
      err: errMsg(e),
    });
    return { fixedCount: 0, fixedIds: [] };
  }
}

/** DETECT-ONLY: tasks whose runs have produced "no commit" N+ times in
 *  the lookback window. Probably needs a backlog item description
 *  rewrite (the bot keeps thinking the work is done or doesn't know
 *  how to do it). Surfaces on /health for the operator. */
export async function findStuckNoopTasks(
  threshold = DEFAULT_NOOP_THRESHOLD,
  sinceHours = DEFAULT_LOOKBACK_HOURS,
): Promise<StuckTaskGroup[]> {
  return countRunsMatching({
    threshold,
    sinceHours,
    blockerLike: "no commit produced%",
    excludeBlockerLike: null,
    label: "stuck_noop",
  });
}

/** DETECT-ONLY: tasks whose preflight (npm test / typecheck) failed
 *  N+ times in the lookback. Often a test regression the bot can't
 *  resolve on its own, or a task spec that touches files outside its
 *  competence. */
export async function findStuckPreflightFails(
  threshold = DEFAULT_PREFLIGHT_THRESHOLD,
  sinceHours = DEFAULT_LOOKBACK_HOURS,
): Promise<StuckTaskGroup[]> {
  return countRunsMatching({
    threshold,
    sinceHours,
    blockerLike: "Preflight failed%",
    excludeBlockerLike: null,
    label: "stuck_preflight",
  });
}

/** DETECT-ONLY: runs that the operator approved but never reached
 *  status='shipped'. Usually means the auto-push retry path failed
 *  (orphan commit, rebase conflict, etc.) and the orphan-retry
 *  threshold didn't fire (e.g., 1 failure isn't enough to auto-block
 *  the backlog item). Worth a glance every day or so. */
export async function findStaleApprovedRuns(
  maxHours = DEFAULT_APPROVED_STALE_HOURS,
): Promise<StuckTaskGroup[]> {
  try {
    const cutoff = new Date(Date.now() - maxHours * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        project: schema.oceanBotRun.project,
        taskId: sql<string>`coalesce(${schema.oceanBotRun.metadata}->>'taskId', '(no-task-id)')`,
        count: sql<number>`count(*)::int`,
        lastSeen: sql<string>`max(${schema.oceanBotRun.startedAt})::text`,
        lastBlocker: sql<string>`max(${schema.oceanBotRun.blocker})`,
      })
      .from(schema.oceanBotRun)
      .where(
        and(
          eq(schema.oceanBotRun.status, "approved"),
          gte(schema.oceanBotRun.startedAt, cutoff),
        ),
      )
      .groupBy(
        schema.oceanBotRun.project,
        sql`coalesce(${schema.oceanBotRun.metadata}->>'taskId', '(no-task-id)')`,
      );
    return rows.map((r) => ({
      project: r.project,
      taskId: r.taskId,
      count: r.count,
      lastSeen: r.lastSeen,
      lastBlocker: r.lastBlocker ?? null,
    }));
  } catch (e) {
    log.error("health_sweep.findStaleApprovedRuns failed", {
      err: errMsg(e),
    });
    return [];
  }
}

interface CountRunsMatchingInputs {
  threshold: number;
  sinceHours: number;
  /** SQL ILIKE pattern (e.g., "no commit produced%"). */
  blockerLike: string;
  /** Optional negative match (e.g., exclude "no commit produced (scout
   *  resolver skipped)" if we want to count only the original noop
   *  class). Currently unused; reserved. */
  excludeBlockerLike: string | null;
  /** Log label for telemetry. */
  label: string;
}

async function countRunsMatching(
  input: CountRunsMatchingInputs,
): Promise<StuckTaskGroup[]> {
  try {
    const cutoff = new Date(Date.now() - input.sinceHours * 60 * 60 * 1000);
    const taskIdExpr = sql<string>`${schema.oceanBotRun.metadata}->>'taskId'`;
    const whereClauses = [
      gte(schema.oceanBotRun.startedAt, cutoff),
      isNotNull(schema.oceanBotRun.blocker),
      sql`${schema.oceanBotRun.blocker} ILIKE ${input.blockerLike}`,
      sql`${schema.oceanBotRun.metadata}->>'taskId' IS NOT NULL`,
      // Exclude runs whose backlog item is already status='done'. The
      // LEFT JOIN below resolves "backlog:<id>" task ids to their item;
      // a NULL match means either (a) no backlog prefix (e.g., a queue-0
      // taskId, operator-typed) or (b) prefix matched no item (item was
      // deleted). Both are still worth flagging, only `done` items are
      // suppressed. Surfaced 2026-05-17: /health was flagging tasks
      // for items the operator had already marked done.
      sql`(${schema.oceanBotBacklogItem.id} IS NULL OR ${schema.oceanBotBacklogItem.status} <> 'done')`,
    ];
    if (input.excludeBlockerLike) {
      whereClauses.push(
        sql`${schema.oceanBotRun.blocker} NOT ILIKE ${input.excludeBlockerLike}`,
      );
    }
    const rows = await getDb()
      .select({
        project: schema.oceanBotRun.project,
        taskId: taskIdExpr,
        count: sql<number>`count(*)::int`,
        lastSeen: sql<string>`max(${schema.oceanBotRun.startedAt})::text`,
        lastBlocker: sql<string>`max(${schema.oceanBotRun.blocker})`,
      })
      .from(schema.oceanBotRun)
      .leftJoin(
        schema.oceanBotBacklogItem,
        and(
          eq(
            schema.oceanBotBacklogItem.project,
            schema.oceanBotRun.project,
          ),
          sql`'backlog:' || ${schema.oceanBotBacklogItem.id} = ${schema.oceanBotRun.metadata}->>'taskId'`,
        ),
      )
      .where(and(...whereClauses))
      .groupBy(schema.oceanBotRun.project, taskIdExpr);
    const out = rows
      .filter((r) => r.count >= input.threshold)
      .map((r) => ({
        project: r.project,
        taskId: r.taskId,
        count: r.count,
        lastSeen: r.lastSeen,
        lastBlocker: r.lastBlocker ?? null,
      }));
    if (out.length > 0) {
      log.warn(`health_sweep.${input.label}_detected`, {
        threshold: input.threshold,
        sinceHours: input.sinceHours,
        groups: out.map((g) => ({
          project: g.project,
          taskId: g.taskId,
          count: g.count,
        })),
      });
    }
    return out;
  } catch (e) {
    log.error(`health_sweep.${input.label} failed`, { err: errMsg(e) });
    return [];
  }
}

/** Path the operator-action queue JSON gets written to. Default:
 *  $HOME/.ocean-bot/operator-action-queue.json. The c2w workflow
 *  HTML at .c2w-workflow.html reads this file to surface bot-
 *  identified operator actions alongside the docs/roadmap.md
 *  operator-only items, so the operator sees a single complete
 *  to-do list. */
export const OPERATOR_ACTION_QUEUE_PATH = path.join(
  os.homedir(),
  ".ocean-bot",
  "operator-action-queue.json",
);

export interface OperatorActionItem {
  /** Backlog item id (e.g., 'atlassian-marketplace-vendor-signup'). */
  id: string;
  /** Project that owns the item (code2wiki / ocean-bot). */
  project: string;
  /** One-line title rendered on the workflow dashboard. */
  title: string;
  /** Short reason from the scout-resolver's block verdict (or
   *  whatever process set auto_blocked_reason). Tells the operator
   *  WHAT external action is needed. */
  reason: string | null;
  /** ISO timestamp of when the item was blocked (auto-block metadata
   *  field). Helps the operator notice stale items. */
  blockedAt: string | null;
}

export interface OperatorActionQueueSnapshot {
  /** ISO timestamp of when the file was last written. The workflow
   *  script can show a "stale, bot may be down" warning if this is
   *  far in the past. */
  ranAt: string;
  /** All currently-blocked backlog items with
   *  auto_blocked_reason='operator-action-required'. Status='blocked'
   *  is the canonical signal that an item is in the operator's
   *  external-action queue. */
  items: OperatorActionItem[];
}

/** Read the bot's operator-action queue from Postgres and write a
 *  JSON snapshot to disk for the c2w workflow HTML to consume. Pure
 *  read on the DB side (no row mutations); pure write on the disk
 *  side (overwrites the file each tick).
 *
 *  Errors are caught + logged; the function never throws because
 *  health-sweep is best-effort. A missing or stale file is a
 *  signal the workflow script renders directly. */
export async function exportOperatorActionQueue(
  outPath = OPERATOR_ACTION_QUEUE_PATH,
): Promise<OperatorActionQueueSnapshot> {
  const snapshot: OperatorActionQueueSnapshot = {
    ranAt: new Date().toISOString(),
    items: [],
  };
  try {
    const rows = await getDb()
      .select({
        id: schema.oceanBotBacklogItem.id,
        project: schema.oceanBotBacklogItem.project,
        title: schema.oceanBotBacklogItem.title,
        metadata: schema.oceanBotBacklogItem.metadata,
      })
      .from(schema.oceanBotBacklogItem)
      .where(
        and(
          eq(schema.oceanBotBacklogItem.status, "blocked"),
          sql`${schema.oceanBotBacklogItem.metadata}->>'auto_blocked_reason' = 'operator-action-required'`,
        ),
      );
    snapshot.items = rows.map((r) => {
      const meta = (r.metadata ?? {}) as {
        operator_action_reason?: unknown;
        blocked_at?: unknown;
      };
      return {
        id: r.id,
        project: r.project,
        title: r.title,
        reason:
          typeof meta.operator_action_reason === "string"
            ? meta.operator_action_reason
            : null,
        blockedAt:
          typeof meta.blocked_at === "string" ? meta.blocked_at : null,
      };
    });
  } catch (e) {
    log.error("health_sweep.exportOperatorActionQueue.query_failed", {
      err: errMsg(e),
    });
    // Don't write a stale-or-empty file on query failure: the workflow
    // script will surface "stale" via the file's mtime + ranAt, which
    // is what we want. Returning the empty snapshot here means callers
    // see zero items, which is the safe default.
    return snapshot;
  }
  try {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(snapshot, null, 2), "utf8");
    log.info("health_sweep.operator_action_queue_written", {
      path: outPath,
      count: snapshot.items.length,
    });
  } catch (e) {
    log.error("health_sweep.exportOperatorActionQueue.write_failed", {
      path: outPath,
      err: errMsg(e),
    });
  }
  return snapshot;
}

/** Orchestrator: run all sweeps + write a single state row for the
 *  /health dashboard. Returns the same state for the caller to log /
 *  use. Called from the tick loop after the main work completes. */
export async function runHealthSweep(): Promise<HealthSweepState> {
  const ranAt = new Date().toISOString();
  const stale = await sweepStaleOpenBacklogItems();
  const stuckNoop = await findStuckNoopTasks();
  const stuckPreflight = await findStuckPreflightFails();
  const staleApproved = await findStaleApprovedRuns();
  const state: HealthSweepState = {
    ranAt,
    stale,
    stuckNoop,
    stuckPreflight,
    staleApproved,
  };
  await setState(HEALTH_SWEEP_STATE_KEY, state);
  // Mirror the blocked-operator-action items out to disk so the
  // c2w-workflow.html (file:// view, no DB) can surface them next to
  // the docs/roadmap.md operator-only items. Best-effort; failures
  // don't crash the sweep.
  const opQueue = await exportOperatorActionQueue();
  log.info("health_sweep.complete", {
    fixedStaleOpen: stale.fixedCount,
    stuckNoopGroups: stuckNoop.length,
    stuckPreflightGroups: stuckPreflight.length,
    staleApprovedGroups: staleApproved.length,
    operatorActionItems: opQueue.items.length,
  });
  return state;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
