// Journal, Postgres event sink for all bot activity.
//
// Two write surfaces:
//   - createRun()    insert into ocean_bot_run when a tick fires
//   - appendEvent()  append per-event row for tool_use / commit / push / etc
//   - recordUsage()  bot-attributed token usage snapshot
//   - setRunFields() update run status / commit_sha / push_state / etc
//
// All writes are best-effort: failures are logged but do not crash the
// bot tick. The dashboard is read-only against these tables.

import { getDb, schema } from "./db/index.js";
import { eq, desc, and, gte, ilike, sql } from "drizzle-orm";
import { log } from "./util/log.js";
import type {
  NewOceanBotRun,
  NewOceanBotEvent,
  NewOceanBotUsage,
  OceanBotRun,
} from "./db/schema.js";

export async function createRun(
  row: NewOceanBotRun,
): Promise<void> {
  try {
    await getDb().insert(schema.oceanBotRun).values(row);
  } catch (e) {
    log.error("journal.createRun failed", {
      runId: row.id,
      err: errMsg(e),
    });
  }
}

export async function appendEvent(
  runId: string,
  type: NewOceanBotEvent["type"],
  payload: unknown,
): Promise<void> {
  try {
    await getDb()
      .insert(schema.oceanBotEvent)
      .values({ runId, type, payload: payload as object });
  } catch (e) {
    log.error("journal.appendEvent failed", {
      runId,
      type,
      err: errMsg(e),
    });
  }
}

export async function setRunFields(
  runId: string,
  fields: Partial<NewOceanBotRun>,
): Promise<void> {
  try {
    await getDb()
      .update(schema.oceanBotRun)
      .set(fields)
      .where(eq(schema.oceanBotRun.id, runId));
  } catch (e) {
    log.error("journal.setRunFields failed", { runId, err: errMsg(e) });
  }
}

export async function recordUsage(row: NewOceanBotUsage): Promise<void> {
  try {
    await getDb().insert(schema.oceanBotUsage).values(row);
  } catch (e) {
    log.error("journal.recordUsage failed", { err: errMsg(e) });
  }
}

export async function setState(key: string, value: unknown): Promise<void> {
  try {
    await getDb()
      .insert(schema.oceanBotState)
      .values({ key, value: value as object })
      .onConflictDoUpdate({
        target: schema.oceanBotState.key,
        set: { value: value as object, updatedAt: new Date() },
      });
  } catch (e) {
    log.error("journal.setState failed", { key, err: errMsg(e) });
  }
}

export async function getState<T = unknown>(key: string): Promise<T | null> {
  try {
    const rows = await getDb()
      .select()
      .from(schema.oceanBotState)
      .where(eq(schema.oceanBotState.key, key))
      .limit(1);
    const first = rows[0];
    return first ? (first.value as T) : null;
  } catch (e) {
    log.error("journal.getState failed", { key, err: errMsg(e) });
    return null;
  }
}

export async function clearState(key: string): Promise<void> {
  try {
    await getDb()
      .delete(schema.oceanBotState)
      .where(eq(schema.oceanBotState.key, key));
  } catch (e) {
    log.error("journal.clearState failed", { key, err: errMsg(e) });
  }
}

// ============================================================================
// Budget-window state. Chunk 1 of the budget-windows-align-with-anthropic-max
// split: schema + read/write helpers ONLY. decideBudget() does not consume
// these yet, chunk 2 will wire them into the gate.
//
// The 5hr window is Anthropic's reset cadence on Claude Code Max plans.
// Once the bot observes the first bot-attributed token of a fresh window,
// it stamps the start ts here; subsequent ticks read it back to align
// their "is this window over yet?" math with Anthropic's billing window
// rather than a sliding 5hr-ago wallclock.
// ============================================================================

const FIVE_HR_WINDOW_START_KEY = "fiveHr_window_start_ts";

/** Read the unix-ms start of the current 5hr budget window, or null if
 *  no window is active. Caller is responsible for deciding whether the
 *  returned ts is stale (i.e. the window has expired). */
export async function getFiveHrWindowStart(): Promise<number | null> {
  const v = await getState<unknown>(FIVE_HR_WINDOW_START_KEY);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

/** Stamp the start of the current 5hr budget window. Idempotent
 *  overwrite, last write wins. */
export async function setFiveHrWindowStart(ts: number): Promise<void> {
  await setState(FIVE_HR_WINDOW_START_KEY, ts);
}

/** Remove the 5hr-window stamp. Subsequent getFiveHrWindowStart()
 *  returns null until setFiveHrWindowStart() is called again. Used when
 *  the window expires and the next tick should start fresh. */
export async function clearFiveHrWindowStart(): Promise<void> {
  await clearState(FIVE_HR_WINDOW_START_KEY);
}

export async function findApprovedRuns(project: string): Promise<OceanBotRun[]> {
  try {
    return await getDb()
      .select()
      .from(schema.oceanBotRun)
      .where(eq(schema.oceanBotRun.status, "approved"))
      .orderBy(desc(schema.oceanBotRun.startedAt));
  } catch (e) {
    log.error("journal.findApprovedRuns failed", { project, err: errMsg(e) });
    return [];
  }
}

/** taskIds that have an in-flight (awaiting-approval or running) run.
 *  Used by the picker to dedup, if the same task keeps surfacing every
 *  tick, we'd flood the approval queue with duplicates. */
export async function activeTaskIds(project: string): Promise<Set<string>> {
  try {
    const rows = await getDb()
      .select({
        meta: schema.oceanBotRun.metadata,
        status: schema.oceanBotRun.status,
      })
      .from(schema.oceanBotRun)
      .where(eq(schema.oceanBotRun.project, project));
    const out = new Set<string>();
    for (const r of rows) {
      if (r.status !== "awaiting-approval" && r.status !== "running") continue;
      const taskId = (r.meta as { taskId?: unknown } | null)?.taskId;
      if (typeof taskId === "string") out.add(taskId);
    }
    return out;
  } catch (e) {
    log.error("journal.activeTaskIds failed", { project, err: errMsg(e) });
    return new Set();
  }
}

/** taskIds whose MOST RECENT run within the last `sinceHours` was a
 *  no-op (clean tree, no commit produced). Without this, the picker
 *  re-picks the same untouchable task every tick, five consecutive
 *  ticks (2026-05-13 14:23-14:42 UTC) burned a claude session each
 *  on the same `Roadmap (Pick 5 highest-trust LinkedIn connections ...)`
 *  task, every one shipped no-op. After `sinceHours` (default 24h)
 *  the taskId becomes eligible again, project state may have changed
 *  enough to make it tractable.
 *
 *  Semantics: we look at the most recent run per taskId in the window.
 *  If that latest run's blocker starts with "no commit produced", the
 *  taskId is excluded. A later successful run for the same taskId
 *  clears the exclusion. */
export async function recentlyNoopTaskIds(
  project: string,
  sinceHours = 24,
): Promise<Set<string>> {
  try {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        meta: schema.oceanBotRun.metadata,
        blocker: schema.oceanBotRun.blocker,
      })
      .from(schema.oceanBotRun)
      .where(
        and(
          eq(schema.oceanBotRun.project, project),
          gte(schema.oceanBotRun.startedAt, since),
        ),
      )
      .orderBy(desc(schema.oceanBotRun.startedAt));
    const seen = new Set<string>();
    const out = new Set<string>();
    for (const r of rows) {
      const taskId = (r.meta as { taskId?: unknown } | null)?.taskId;
      if (typeof taskId !== "string") continue;
      if (seen.has(taskId)) continue;
      seen.add(taskId);
      if (r.blocker && r.blocker.startsWith("no commit produced")) {
        out.add(taskId);
      }
    }
    return out;
  } catch (e) {
    log.error("journal.recentlyNoopTaskIds failed", {
      project,
      err: errMsg(e),
    });
    return new Set();
  }
}

/** Distinct substring of the orphan-failure blocker emitted in
 *  `pushApprovedRuns` (src/index.ts) when an approved commit is no
 *  longer reachable from its branch (rebase / reset dropped it). If
 *  you change the blocker wording in index.ts, change this substring
 *  in lockstep, otherwise the auto-block guard goes silently dark. */
const ORPHAN_BLOCKER_FRAGMENT = "no longer reachable from";

/** Count failed runs whose blocker matches the orphan-commit fault
 *  signature for a given taskId in the given window. Used by the orphan-
 *  retry-loop guard: once the count crosses a threshold for the same
 *  backlog taskId, the backlog item is auto-blocked so the bot stops
 *  spending tokens regenerating commits that keep getting rebased away. */
export async function countOrphanFailuresForTaskId(
  project: string,
  taskId: string,
  sinceHours = 24,
): Promise<{ count: number; runIds: string[] }> {
  try {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const rows = await getDb()
      .select({
        id: schema.oceanBotRun.id,
        meta: schema.oceanBotRun.metadata,
      })
      .from(schema.oceanBotRun)
      .where(
        and(
          eq(schema.oceanBotRun.project, project),
          eq(schema.oceanBotRun.status, "failed"),
          ilike(schema.oceanBotRun.blocker, `%${ORPHAN_BLOCKER_FRAGMENT}%`),
          gte(schema.oceanBotRun.startedAt, since),
        ),
      )
      .orderBy(desc(schema.oceanBotRun.startedAt));
    const runIds: string[] = [];
    for (const r of rows) {
      const t = (r.meta as { taskId?: unknown } | null)?.taskId;
      if (typeof t === "string" && t === taskId) runIds.push(r.id);
    }
    return { count: runIds.length, runIds };
  } catch (e) {
    log.error("journal.countOrphanFailuresForTaskId failed", {
      project,
      taskId,
      err: errMsg(e),
    });
    return { count: 0, runIds: [] };
  }
}

/** Flip a backlog item to status='blocked' and stamp metadata with the
 *  auto-block reason + the run ids that triggered it. Operator reviews
 *  the blocked section on /backlog and either reopens the item or
 *  archives it. Existing metadata keys are preserved via jsonb `||`. */
export async function blockBacklogItemForOrphanRetries(
  backlogId: string,
  details: { runIds: string[]; lastOrphanSha: string | null },
): Promise<void> {
  const meta = {
    auto_blocked_reason: "commit-reachability",
    failed_runs: details.runIds,
    last_orphan_sha: details.lastOrphanSha,
    blocked_at: new Date().toISOString(),
  };
  try {
    await getDb()
      .update(schema.oceanBotBacklogItem)
      .set({
        status: "blocked",
        updatedAt: new Date(),
        metadata: sql`COALESCE(${schema.oceanBotBacklogItem.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
      })
      .where(eq(schema.oceanBotBacklogItem.id, backlogId));
  } catch (e) {
    log.error("journal.blockBacklogItemForOrphanRetries failed", {
      backlogId,
      err: errMsg(e),
    });
  }
}

/** Flip a backlog item to status='blocked' because the scout-resolver
 *  identified it as requiring operator action (browser auth, external-
 *  portal form, manual install, etc.) that the bot literally can't
 *  perform. Distinct from `blockBacklogItemForOrphanRetries` (which
 *  fires after push retries fail). Distinct from escalate-to-approvals
 *  (which is for executive decisions the operator weighs in on);
 *  operator-action items have no decision to make, so they shouldn't
 *  flood /approvals.
 *
 *  Operator workflow: do the action externally, then re-open the
 *  backlog item (status='open') or archive it. The metadata trail
 *  records why it was blocked + which run triggered the block. */
export async function blockBacklogItemForOperatorAction(
  backlogId: string,
  details: { runId: string; reason: string },
): Promise<void> {
  const meta = {
    auto_blocked_reason: "operator-action-required",
    operator_action_reason: details.reason,
    blocking_run_id: details.runId,
    blocked_at: new Date().toISOString(),
  };
  try {
    await getDb()
      .update(schema.oceanBotBacklogItem)
      .set({
        status: "blocked",
        updatedAt: new Date(),
        metadata: sql`COALESCE(${schema.oceanBotBacklogItem.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
      })
      .where(eq(schema.oceanBotBacklogItem.id, backlogId));
  } catch (e) {
    log.error("journal.blockBacklogItemForOperatorAction failed", {
      backlogId,
      err: errMsg(e),
    });
  }
}

/**
 * Phantom-row cleanup. Flip stale `shipped+local+null-sha+null-decision`
 * runs to `failed` so they stop polluting summary counts.
 *
 * Background: a class of noop-task bugs (now patched in `a8e186e`) used
 * to leave runs in `status='shipped', push_state='local',
 * commit_sha=NULL, user_decision=NULL`. The /approvals UI hides them
 * (it filters on `status='awaiting-approval'`) but they accumulate in
 * the DB and distort weekly summaries. Two days of prod accumulated 29
 * such rows before the cleanup was wired up.
 *
 * The grace window guards against racing a still-finishing tick: a
 * legitimate shipped-noop row goes `running → shipped` in one
 * setRunFields call, so by the time `ended_at` is more than an hour old,
 * the row is truly stale.
 *
 * COALESCE on the blocker preserves whatever the original setRunFields
 * wrote (`no commit produced (no-op task)` for the legacy path), only
 * stamping the auto-cleanup reason on rows that somehow had no blocker.
 */
export async function cleanupPhantomRuns(
  graceHours = 1,
): Promise<{ flipped: number; runIds: string[] }> {
  try {
    const cutoff = new Date(Date.now() - graceHours * 60 * 60 * 1000);
    const rows = await getDb()
      .update(schema.oceanBotRun)
      .set({
        status: "failed",
        blocker: sql`COALESCE(${schema.oceanBotRun.blocker}, 'auto-cleanup: phantom row, shipped+local with no commit and no decision after grace window')`,
      })
      .where(
        and(
          eq(schema.oceanBotRun.status, "shipped"),
          eq(schema.oceanBotRun.pushState, "local"),
          sql`${schema.oceanBotRun.userDecision} IS NULL`,
          sql`${schema.oceanBotRun.commitSha} IS NULL`,
          sql`${schema.oceanBotRun.endedAt} < ${cutoff}`,
        ),
      )
      .returning({ id: schema.oceanBotRun.id });
    return { flipped: rows.length, runIds: rows.map((r) => r.id) };
  } catch (e) {
    log.error("journal.cleanupPhantomRuns failed", { err: errMsg(e) });
    return { flipped: 0, runIds: [] };
  }
}

/**
 * Count rows that currently match the phantom signature within the
 * lookback window. Powers the /health dashboard surface: if cleanup is
 * running on schedule and no new bug class is regressing, this trends
 * to zero.
 */
export async function phantomRowCount(daysBack = 7): Promise<number> {
  try {
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
  } catch (e) {
    log.error("journal.phantomRowCount failed", { err: errMsg(e) });
    return 0;
  }
}

/** Look up the model used in the most-recent failed run for a given
 *  (project, taskId) within the lookback window. Powers the failure-aware
 *  retry branch in selectModel(): if the last attempt failed on sonnet,
 *  this tick escalates to opus.
 *
 *  Returns null when no failed run exists, when the failed run's metadata
 *  lacks a `model` field (pre-rollout history), or when the value isn't
 *  one of haiku/sonnet/opus. */
export async function lastFailedModelForTaskId(
  project: string,
  taskId: string,
  sinceHours = 24,
): Promise<"haiku" | "sonnet" | "opus" | null> {
  try {
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
    const rows = await getDb()
      .select({ meta: schema.oceanBotRun.metadata })
      .from(schema.oceanBotRun)
      .where(
        and(
          eq(schema.oceanBotRun.project, project),
          eq(schema.oceanBotRun.status, "failed"),
          gte(schema.oceanBotRun.startedAt, since),
        ),
      )
      .orderBy(desc(schema.oceanBotRun.startedAt));
    for (const r of rows) {
      const meta = r.meta as { taskId?: unknown; model?: unknown } | null;
      if (typeof meta?.taskId !== "string" || meta.taskId !== taskId) continue;
      const m = meta.model;
      if (m === "haiku" || m === "sonnet" || m === "opus") return m;
      return null;
    }
    return null;
  } catch (e) {
    log.error("journal.lastFailedModelForTaskId failed", {
      project,
      taskId,
      err: errMsg(e),
    });
    return null;
  }
}

// ============================================================================
// Per-project last-session memory. Powers `claude --resume <id>` on
// follow-up bot ticks within the same project so the prompt cache and
// transcript context carry over (chunk 5/5 of ai-usage-opt). One row
// per project; last write wins. Pure JSON shape so it survives schema
// evolution without a migration.
// ============================================================================

export interface LastSessionRow {
  sessionId: string;
  observedAt: number;
}

function lastSessionKey(project: string): string {
  return `last_session:${project}`;
}

export async function getLastSessionForProject(
  project: string,
): Promise<LastSessionRow | null> {
  const v = await getState<unknown>(lastSessionKey(project));
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const sid = o["sessionId"];
  const observedAt = o["observedAt"];
  if (typeof sid !== "string" || !sid) return null;
  if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return null;
  return { sessionId: sid, observedAt };
}

export async function setLastSessionForProject(
  project: string,
  sessionId: string,
  observedAt: number = Date.now(),
): Promise<void> {
  await setState(lastSessionKey(project), { sessionId, observedAt });
}

/**
 * Mark a backlog item `done`. Called from the approved-run push
 * handler after a successful ship, without this, the backlog adapter
 * keeps picking the same `status='open'` item every tick (the bug
 * Ocean surfaced on 2026-05-12 when "Backlog (bug): webhook-dedupe..."
 * shipped three times in nine minutes).
 *
 * The runs table doesn't store backlog_item_id directly; the bot puts
 * `taskId` (e.g. `backlog:<uuid>`) in the run's metadata. This helper
 * accepts the raw taskId and only acts when it has the `backlog:`
 * prefix, non-backlog queues (bug-fix, gap-closure, etc.) don't have
 * a lifecycle store yet, so this no-ops for them.
 */
export async function markBacklogItemDone(
  taskId: string | undefined | null,
): Promise<void> {
  if (!taskId || !taskId.startsWith("backlog:")) return;
  const itemId = taskId.slice("backlog:".length);
  try {
    await getDb()
      .update(schema.oceanBotBacklogItem)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(schema.oceanBotBacklogItem.id, itemId));
  } catch (e) {
    log.error("journal.markBacklogItemDone failed", {
      itemId,
      err: errMsg(e),
    });
  }
}

/**
 * List ids of currently-open backlog items for a given project.
 *
 * Used by the receive-side auto-close path: after every ship, fetch
 * open ids, check if the commit message references any of them, close
 * those that match. Per-project filter is load-bearing, a code2wiki
 * ship must never close an ocean-bot item or vice versa.
 *
 * Best-effort: returns [] on db failure so the ship path doesn't break.
 */
export async function listOpenBacklogIds(project: string): Promise<string[]> {
  try {
    const rows = await getDb()
      .select({ id: schema.oceanBotBacklogItem.id })
      .from(schema.oceanBotBacklogItem)
      .where(
        and(
          eq(schema.oceanBotBacklogItem.status, "open"),
          eq(schema.oceanBotBacklogItem.project, project),
        ),
      );
    return rows.map((r) => r.id);
  } catch (e) {
    log.error("journal.listOpenBacklogIds failed", { err: errMsg(e) });
    return [];
  }
}

/**
 * Pure helper. Find backlog ids whose full string appears in the commit
 * message as a whole token (not a substring of another id).
 *
 * Kebab-case-id-safe: rejects substring matches like `dotnet-1` inside
 * `dotnet-10`. JS \b doesn't treat `-` as a word-boundary character
 * (hyphen is non-word, so \b fires AT the hyphen), so this uses explicit
 * lookarounds that include `-` in the "still inside an id" predicate.
 *
 * Exported (and unit-tested) because false-positive auto-closes are
 * expensive (an item is silently removed from the queue), and the only
 * way to keep them away is to be conservative + reviewable.
 */
export function findReferencedBacklogIds(
  message: string,
  openIds: readonly string[],
): string[] {
  if (!message || openIds.length === 0) return [];
  const found = new Set<string>();
  for (const id of openIds) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`);
    if (re.test(message)) found.add(id);
  }
  return [...found];
}

/**
 * Close one or more backlog items with audit metadata pointing at the
 * closing commit + run.
 *
 * Used by the receive-side auto-close path (creative / refactor / etc
 * ships whose commit message references an open backlog id).
 *
 * Idempotent: the WHERE-status='open' guard makes already-done items
 * no-op without overwriting their existing closed metadata. Per-item
 * try-catch so a single failure doesn't lose the rest.
 *
 * Fixes the stale-open class that bit dotnet-* 2026-05-22 -> 2026-05-26:
 * the C# parser shipped via creative queue (06e276f) and none of the
 * dotnet-2..10 backlog items got closed because markBacklogItemDone
 * only fires for taskIds with the `backlog:` prefix. Now any commit
 * message that names an open id closes that id.
 */
export async function closeBacklogItemsByIds(
  itemIds: readonly string[],
  closingCommit: string,
  runId: string,
  reason: string,
): Promise<void> {
  if (itemIds.length === 0) return;
  for (const itemId of itemIds) {
    const meta = {
      closed_reason: reason,
      closed_at: new Date().toISOString(),
      closing_commit: closingCommit,
      closing_run_id: runId,
    };
    try {
      await getDb()
        .update(schema.oceanBotBacklogItem)
        .set({
          status: "done",
          updatedAt: new Date(),
          metadata: sql`COALESCE(${schema.oceanBotBacklogItem.metadata}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
        })
        .where(
          and(
            eq(schema.oceanBotBacklogItem.id, itemId),
            eq(schema.oceanBotBacklogItem.status, "open"),
          ),
        );
    } catch (e) {
      log.error("journal.closeBacklogItemsByIds failed", {
        itemId,
        err: errMsg(e),
      });
    }
  }
}

// ============================================================================
// Rate-limit pause state (ADR-034 seed: 429-handling, pre-6/15-cutover).
// Two DB entries:
//   - rate_limit_pause: active gate (cleared on auto-resume after backoff)
//   - rate_limit_history_json: append-only JSONB array of past-24h events
//
// Pattern mirrors the fiveHr window helpers above: private KEY constant +
// typed read/write/clear helpers. The history key uses a JSONB array stored
// under a single ocean_bot_state row; no dedicated table needed.
// ============================================================================

export interface RateLimitPause {
  pausedAt: number;
  reason: "429" | "credits-exhausted";
  resumeAfter: number;
}

export interface RateLimitHistoryEntry {
  ts: number;
  reason: "429" | "credits-exhausted";
  runId?: string;
}

const RATE_LIMIT_PAUSE_KEY = "rate_limit_pause";
const RATE_LIMIT_HISTORY_KEY = "rate_limit_history_json";
const RATE_LIMIT_HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function getRateLimitPause(): Promise<RateLimitPause | null> {
  const v = await getState<unknown>(RATE_LIMIT_PAUSE_KEY);
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pausedAt = o["pausedAt"];
  const reason = o["reason"];
  const resumeAfter = o["resumeAfter"];
  if (typeof pausedAt !== "number" || !Number.isFinite(pausedAt)) return null;
  if (reason !== "429" && reason !== "credits-exhausted") return null;
  if (typeof resumeAfter !== "number" || !Number.isFinite(resumeAfter)) return null;
  return { pausedAt, reason, resumeAfter };
}

export async function setRateLimitPause(pause: RateLimitPause): Promise<void> {
  await setState(RATE_LIMIT_PAUSE_KEY, pause);
}

export async function clearRateLimitPause(): Promise<void> {
  await clearState(RATE_LIMIT_PAUSE_KEY);
}

/** Append an entry to the 24h rate-limit history ring, pruning entries
 *  older than 24h on each write so the array stays bounded. */
export async function appendRateLimitHistory(
  entry: RateLimitHistoryEntry,
): Promise<void> {
  const existing = await findRateLimitedHistory();
  const cutoff = Date.now() - RATE_LIMIT_HISTORY_MAX_AGE_MS;
  const pruned = existing.filter((e) => e.ts >= cutoff);
  pruned.push(entry);
  await setState(RATE_LIMIT_HISTORY_KEY, pruned);
}

/** Return rate-limit history entries within the given window (default 24h).
 *  Malformed rows (written by a future schema change or a corrupt state
 *  write) are silently dropped so the gate never hard-crashes on bad data. */
export async function findRateLimitedHistory(
  sinceMs: number = RATE_LIMIT_HISTORY_MAX_AGE_MS,
): Promise<RateLimitHistoryEntry[]> {
  const v = await getState<unknown>(RATE_LIMIT_HISTORY_KEY);
  if (!Array.isArray(v)) return [];
  const cutoff = Date.now() - sinceMs;
  const out: RateLimitHistoryEntry[] = [];
  for (const e of v) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    const ts = o["ts"];
    const reason = o["reason"];
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    if (reason !== "429" && reason !== "credits-exhausted") continue;
    if (ts < cutoff) continue;
    const entry: RateLimitHistoryEntry = { ts, reason };
    const runId = o["runId"];
    if (typeof runId === "string") entry.runId = runId;
    out.push(entry);
  }
  return out;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
