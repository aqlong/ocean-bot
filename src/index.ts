// Ocean-bot entry point. Long-running process; SIGTERM-safe.
//
// Architecture: every tickIntervalSec, run one pass:
//   1. Acquire tick lock; refuse if a prior tick is still running
//   2. Skip if budget broker says stop or wait
//   3. Skip if Ocean has an interactive claude session open (avoid contention)
//   4. For each enabled project: collect candidates, score, pick top across all
//   5. Skip if working tree dirty + recently touched (Ocean is editing)
//   6. Create run row in DB; spawn claude -p with the task
//   7. After run: diff, preflight, classify, decide push, push (or wait)
//   8. Mark run shipped/awaiting-approval/failed; update state; release lock

import * as path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  type ApprovalMode,
  type BotConfig,
  type ProjectConfig,
} from "./config.js";
import { resolveApprovalMode } from "./approval-mode.js";
import { detectDrift, isBotAffectingPath, resolveDriftPaths, DRIFT_STATE_KEY } from "./drift.js";
import { Code2wikiAdapter } from "./adapters/code2wiki.js";
import { OceanBotAdapter } from "./adapters/ocean-bot.js";
import type { ProjectAdapter, Queue } from "./adapters/types.js";
import {
  pickNext,
  DEFAULT_PICKER_CTX,
  type PickerContext,
  type ScoredCandidate,
} from "./queue.js";
import {
  decideBudget,
  decideProjectBudgets,
  loadBotSessions,
  loadUsageRows,
  resolveCaps,
  type BudgetCaps,
  type ProjectGate,
  type UsageRow,
} from "./budget.js";
import {
  runTask,
  isInteractiveClaudeRunning,
  acquireLock,
  releaseLock,
  classifyNoopRun,
  DEFAULT_MAX_TOOL_USES,
  pickResumeSessionId,
} from "./runner.js";
import {
  createRun,
  appendEvent,
  setRunFields,
  setState,
  getState,
  findApprovedRuns,
  activeTaskIds,
  recentlyNoopTaskIds,
  markBacklogItemDone,
  listOpenBacklogIds,
  findReferencedBacklogIds,
  closeBacklogItemsByIds,
  blockBacklogItemForOperatorAction,
  countOrphanFailuresForTaskId,
  blockBacklogItemForOrphanRetries,
  lastFailedModelForTaskId,
  getFiveHrWindowStart,
  setFiveHrWindowStart,
  clearFiveHrWindowStart,
  getLastSessionForProject,
  setLastSessionForProject,
  getRateLimitPause,
  clearRateLimitPause,
  setRateLimitPause,
  appendRateLimitHistory,
} from "./journal.js";
import { selectModel } from "./model-select.js";
import type { BudgetDecision } from "./budget.js";
import {
  runPreflight,
  decidePush,
  pushToTarget,
} from "./push.js";
import { maybeRunPhantomCleanup } from "./phantom-cleanup.js";
import { runHealthSweep } from "./health-sweep.js";
import { scoutTask, SCOUT_DESCRIPTION_THRESHOLD } from "./scout.js";
import {
  resolveScoutScope,
  fallbackOnFailure,
  applyGoalWrapper,
  DEFAULT_GOAL_TURN_CAP,
  type ScoutResolution,
} from "./scout-resolver.js";
import { ulid } from "./util/ulid.js";
import { log } from "./util/log.js";
import {
  isClean,
  currentBranch,
  headSha,
  diffSinceCommit,
  fileLastModified,
  commitReachable,
  commitMessage,
} from "./util/git.js";
import { closeDb } from "./db/index.js";

const DIRTY_GRACE_MS = 30 * 60 * 1000; // 30 min, Ocean is mid-edit window

// Directory of this module's compiled output, used by the drift gate
// to locate dist/.built-from-sha (written by the boot wrapper) and the
// repo root three levels up.
const BOT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// After this many orphan-failed runs for the same backlog taskId in a
// 24h window, auto-flip the backlog row to status='blocked'. 2 catches
// the loop on its second hit (one commit was a fluke; two means we're
// in a fight with a competing rebase the operator must arbitrate).
const ORPHAN_RETRY_THRESHOLD = 2;

// Backoff durations for the rate-limit gate.
//   - 429 (transient overload): 1h is plenty for Anthropic to shed load.
//   - credits-exhausted (pool depleted): 6h so the operator has time to
//     add credits before the bot burns remaining balance retrying.
const RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1000;
const CREDITS_EXHAUSTED_BACKOFF_MS = 6 * 60 * 60 * 1000;

// Per-tier output-token caps forwarded to `claude -p --max-tokens N`.
// Smaller models get smaller caps because (a) they're cheap and (b)
// blowing past the cap produces less waste; opus gets the largest cap
// because that's where verbose deep-implement runs land. Tunable per-
// install via the dashboard (/settings writes ocean_bot_state.
// output_token_caps); these defaults apply when no override is set.
const DEFAULT_OUTPUT_TOKEN_CAPS = {
  haiku: 8000,
  sonnet: 16000,
  opus: 32000,
} as const;
type ModelTier = keyof typeof DEFAULT_OUTPUT_TOKEN_CAPS;

function resolveOutputTokenCap(
  model: string,
  override: Partial<Record<ModelTier, unknown>> | null,
): number | undefined {
  if (model !== "haiku" && model !== "sonnet" && model !== "opus") return undefined;
  const tier = model as ModelTier;
  const candidate = override?.[tier];
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return Math.floor(candidate);
  }
  return DEFAULT_OUTPUT_TOKEN_CAPS[tier];
}

/** Read the operator-tunable tool_use cap from ocean_bot_state, falling
 *  back to DEFAULT_MAX_TOOL_USES. Negative / zero / non-finite values
 *  are ignored so a typo in /settings can't disable the cap entirely. */
async function resolveMaxToolUses(): Promise<number> {
  const v = await getState<unknown>("max_tool_uses");
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    return Math.floor(v);
  }
  return DEFAULT_MAX_TOOL_USES;
}

let shutdown = false;
let activeTick: Promise<void> | null = null;

async function main(): Promise<void> {
  const cfg = await loadConfig();
  await fs.mkdir(cfg.dataDir, { recursive: true });

  if (!process.env["OCEAN_BOT_DATABASE_URL"]) {
    log.error(
      "ocean-bot.boot_failed, OCEAN_BOT_DATABASE_URL not set. See tools/ocean-bot/README.md for setup.",
    );
    process.exit(2);
  }

  const dryRun = process.argv.includes("--dry-run");

  log.info("ocean-bot.boot", {
    tickIntervalSec: cfg.tickIntervalSec,
    projects: cfg.projects.filter((p) => p.enabled).map((p) => p.name),
    dryRun,
  });

  process.on("SIGTERM", () => {
    log.info("ocean-bot.sigterm, finishing current tick then exiting");
    shutdown = true;
  });
  process.on("SIGINT", () => {
    log.info("ocean-bot.sigint, finishing current tick then exiting");
    shutdown = true;
  });

  const adapters = buildAdapters(cfg);

  while (!shutdown) {
    activeTick = tick(cfg, adapters, { dryRun }).catch((e) => {
      log.error("tick.unhandled", { err: errMsg(e) });
    });
    await activeTick;
    activeTick = null;
    if (shutdown) break;
    // Stamp the tick boundary so the dashboard's in-flight card can
    // show "next tick in Xs" without guessing.
    await setState("tick_meta", {
      lastEndedAt: new Date().toISOString(),
      intervalSec: cfg.tickIntervalSec,
    });
    await sleepWithWakeup(cfg.tickIntervalSec * 1000);
  }
  await closeDb();
  log.info("ocean-bot.exit");
}

/** Sleep up to `totalMs`, but wake up early if the operator hits the
 *  "Tick now" button on the dashboard. The button sets a `tick_requested`
 *  row in ocean_bot_state; we poll every 2s. Polling cadence is a balance
 *  between feels-instant and DB-noise. */
async function sleepWithWakeup(totalMs: number): Promise<void> {
  const POLL_MS = 2000;
  const deadline = Date.now() + totalMs;
  while (!shutdown && Date.now() < deadline) {
    const wait = Math.min(POLL_MS, deadline - Date.now());
    await sleep(wait);
    if (shutdown) return;
    const requested = await getState<boolean>("tick_requested");
    if (requested === true) {
      log.info("tick.wakeup_requested");
      // Clear before returning so we don't wake again next loop.
      await setState("tick_requested", false);
      return;
    }
  }
}

interface TickOpts {
  dryRun: boolean;
}

function buildAdapters(cfg: BotConfig): ProjectAdapter[] {
  const out: ProjectAdapter[] = [];
  for (const p of cfg.projects) {
    if (!p.enabled) continue;
    if (p.name === "code2wiki") {
      out.push(new Code2wikiAdapter({ rootDir: p.rootDir, memoryDir: p.memoryDir }));
    } else if (p.name === "ocean-bot") {
      out.push(new OceanBotAdapter({ rootDir: p.rootDir, memoryDir: p.memoryDir }));
    }
    // cas + inference-audit adapters wired in Phase 2
  }
  return out;
}

async function tick(
  cfg: BotConfig,
  adapters: ProjectAdapter[],
  opts: TickOpts,
): Promise<void> {
  if (!(await acquireLock(cfg.dataDir))) {
    log.debug("tick.skip lock_held");
    return;
  }

  try {
    // ---- Drift gate ----
    // Boot wrapper stamped dist/.built-from-sha at exec time. If the
    // repo's HEAD has moved since (operator checkout / pull / rebase),
    // the running JS is stale, refuse to do real work and surface the
    // gap to the dashboard. Recovery is a launchd restart; the wrapper
    // re-pulls + re-builds + re-stamps. resolveDriftPaths returns null
    // in dev (running via tsx, not dist), so this is a no-op there.
    const driftPaths = resolveDriftPaths(BOT_MODULE_DIR);
    if (driftPaths) {
      const drift = await detectDrift(
        driftPaths.repoDir,
        driftPaths.builtFromShaPath,
      );
      await setState(DRIFT_STATE_KEY, {
        ...drift,
        observedAt: new Date().toISOString(),
      });
      if (drift.drift) {
        log.warn("tick.skip stale_dist", {
          reason: drift.reason,
          builtFromSha: drift.builtFromSha,
          headSha: drift.headSha,
        });
        // Drift = running dist is older than origin's bot-affecting src.
        // Layer 3 catches the bot's OWN pushes; this catches everything
        // else (parallel claude sessions pushing directly to origin, or
        // operator-side pushes). Set shutdown so KeepAlive respawns via
        // wrapper, which rebuilds dist + re-stamps. Without this, the
        // bot loops on tick.skip stale_dist until manual restart.
        // Shipped 2026-05-16 after 3+ false-positive-style drift loops
        // requiring kickstart -k. Idempotent: multiple drift-skip
        // ticks all just set shutdown=true.
        log.info("tick.skip stale_dist, scheduling restart");
        shutdown = true;
        return;
      }
    }

    // ---- Pause gate (dashboard /settings) ----
    const paused = await getState<boolean>("paused");
    if (paused === true) {
      log.debug("tick.skip user_paused");
      return;
    }

    // ---- Rate-limit gate ----
    // Cleared automatically when the backoff window expires (auto-resume),
    // or manually by the operator via the /settings page. If the window
    // has already elapsed, clear the stale key and continue normally so
    // the bot self-heals without operator intervention.
    const rlPause = await getRateLimitPause();
    if (rlPause) {
      const now = Date.now();
      if (now < rlPause.resumeAfter) {
        log.info("tick.skip rate_limited", {
          reason: rlPause.reason,
          resumeAfter: new Date(rlPause.resumeAfter).toISOString(),
          remainMinutes: Math.ceil((rlPause.resumeAfter - now) / 60_000),
        });
        return;
      }
      // Backoff elapsed: clear the key before continuing.
      await clearRateLimitPause();
      log.info("tick.rate_limit.auto_resumed", { reason: rlPause.reason });
    }

    // ---- Phantom-row cleanup (once per 24h) ----
    // Rate-limited by a row in ocean_bot_state. Cheap and idempotent;
    // skipped in --dry-run mode (dry-run should never mutate the DB)
    // and isolated in try/catch so a cleanup error never crashes the
    // tick.
    if (!opts.dryRun) {
      await maybeRunPhantomCleanup().catch((e) => {
        log.error("phantom_cleanup.failed", { err: errMsg(e) });
      });
    }

    // ---- Health sweep (every tick) ----
    // Catches silent invariant violations the bot won't notice on its
    // own: stale-open backlog items (auto-fixed), tasks no-op'd repeat-
    // edly, preflight-fail loops, stale approved runs. Runs every tick
    // because it's pure SQL (no LLM calls, no shell-outs) and the auto-
    // fix path's value is "the NEXT tick's task picker sees fresh
    // state." Detect-only sweeps surface to /health via setState; the
    // operator reads them when convenient. Skipped in --dry-run; iso-
    // lated in try/catch like phantom cleanup. Shipped 2026-05-16
    // after the markBacklogItemDone regression buried 3 items in
    // recentlyNoopTaskIds for 24h.
    if (!opts.dryRun) {
      await runHealthSweep().catch((e) => {
        log.error("health_sweep.failed", { err: errMsg(e) });
      });
    }

    // ---- Approved-run pickup ----
    // Before considering new work, push any runs Ocean has approved from
    // the dashboard. Their commits are already local on the project's
    // current branch; we just need to push them. Skip in dry-run mode.
    if (!opts.dryRun) {
      for (const adapter of adapters) {
        await pushApprovedRuns(adapter);
      }
    }

    // ---- Budget gate ----
    const rows = await loadUsageRows();
    const sessions = await loadBotSessions(cfg.sessionsLogPath);
    const botSessionPaths = new Set(sessions.map((s) => s.sessionPath));
    const stateCaps = await getState<BudgetCaps>("budget_caps");
    const resolved = resolveCaps({
      stateCaps,
      configCaps: cfg.caps,
      configHasCaps: cfg.capsFromConfigFile,
    });
    // Surface to /settings so the dashboard can render the
    // "config.json caps are overridden by dashboard" banner.
    await setState("budget_caps_meta", {
      configHasCaps: cfg.capsFromConfigFile,
      configCaps: cfg.caps,
      activeSource: resolved.source,
      observedAt: Date.now(),
    });
    const fiveHrWindowStart = await getFiveHrWindowStart();
    const tickNow = Date.now();
    const budget = decideBudget({
      rows,
      botSessionPaths,
      caps: resolved.caps,
      now: tickNow,
      fiveHrWindowStart,
    });
    // 5hr anchor lifecycle (chunk 2 of budget-windows-align):
    //   - expired anchor → clear so the next tick with bot activity re-stamps.
    //   - no anchor + bot-attributed activity in rolling 5hr → stamp now to
    //     align the bot's 5hr cap accounting with Anthropic's Max window.
    if (budget.fiveHrWindowExpired) {
      await clearFiveHrWindowStart();
    } else if (
      fiveHrWindowStart === null &&
      (budget.fiveHr.inputTokens > 0 || budget.fiveHr.outputTokens > 0)
    ) {
      await setFiveHrWindowStart(tickNow);
    }
    // Per-project sub-cap gates. Build the project-keyed row map by
    // joining each UsageRow's sessionPath against the BotSession project
    // tag written by runner.ts at spawn. Sessions from before this was
    // added carry project="unknown" and are skipped here (they still
    // count against the global gate via botSessionPaths).
    const sessionPathToProject = new Map<string, string>();
    for (const s of sessions) {
      if (s.project && s.project !== "unknown") {
        sessionPathToProject.set(s.sessionPath, s.project);
      }
    }
    const rowsByProject = new Map<string, UsageRow[]>();
    for (const r of rows) {
      const project = sessionPathToProject.get(r.sessionPath);
      if (!project) continue;
      const existing = rowsByProject.get(project) ?? [];
      existing.push(r);
      rowsByProject.set(project, existing);
    }
    const projectGates = decideProjectBudgets({
      rowsByProject,
      caps: resolved.caps,
      now: tickNow,
      fiveHrWindowStart,
    });
    const excludeProjects = new Set<string>();
    for (const [name, pg] of projectGates) {
      if (pg.gate !== "ok") excludeProjects.add(name);
    }
    const snapshot = {
      ...budget,
      source: resolved.source,
      observedAt: tickNow,
      perProject: Object.fromEntries(projectGates) as Record<
        string,
        ProjectGate
      >,
    };
    if (budget.gate !== "ok") {
      log.info("tick.skip budget", {
        gate: budget.gate,
        worstRatio: Number(budget.worstRatio.toFixed(3)),
        reason: budget.reason,
        source: resolved.source,
      });
      await setState("budget", snapshot);
      return;
    }
    if (excludeProjects.size > 0) {
      log.info("tick.exclude_projects_over_subcap", {
        excluded: Array.from(excludeProjects),
      });
    }
    await setState("budget", snapshot);

    // ---- Idle gate ----
    // Skipped when --dry-run (whole point of dry-run is to demonstrate
    // what the bot WOULD do) OR OCEAN_BOT_SKIP_INTERACTIVE_CHECK=1
    // (smoke tests / first-tick experiments where the operator wants
    // ticks to fire even while another Claude session is open).
    const skipIdleCheck =
      opts.dryRun || process.env["OCEAN_BOT_SKIP_INTERACTIVE_CHECK"] === "1";
    if (!skipIdleCheck && (await isInteractiveClaudeRunning())) {
      log.info("tick.skip interactive_claude_running");
      return;
    }

    // ---- Pick a project + task ----
    const recentQueues = await loadRecentQueues();
    const ctx: PickerContext = { ...DEFAULT_PICKER_CTX, recentQueues };

    // Dedup: don't re-pick a taskId that
    //  (a) already has an in-flight run (awaiting-approval / running), or
    //  (b) most-recently no-op'd within the last 24h.
    // Without (a) the picker floods the approval queue. Without (b)
    // the picker burns a claude session per tick on an untouchable task
    // (prod 2026-05-13: 5 ticks, same roadmap pick, every one no-op).
    const excludeTaskIdsByProject = new Map<string, Set<string>>();
    for (const a of adapters) {
      const [active, noops] = await Promise.all([
        activeTaskIds(a.name),
        recentlyNoopTaskIds(a.name),
      ]);
      excludeTaskIdsByProject.set(a.name, new Set([...active, ...noops]));
    }

    const pick = await pickNext({
      adapters,
      ctx,
      excludeTaskIdsByProject,
      excludeProjects,
    });
    if (!pick) {
      log.info("tick.skip no_candidates");
      return;
    }

    const adapter = adapters.find((a) => a.name === pick.project);
    if (!adapter) {
      log.warn("tick.skip adapter_missing", { project: pick.project });
      return;
    }

    // ---- Working tree gate ----
    const clean = await isClean(adapter.rootDir);
    if (!clean) {
      const lastMod = await fileLastModified(adapter.rootDir);
      if (lastMod && Date.now() - lastMod < DIRTY_GRACE_MS) {
        log.info("tick.skip dirty_tree_recent_edit", {
          project: adapter.name,
        });
        return;
      }
      log.warn("tick.skip dirty_tree_stale", { project: adapter.name });
      // Auto-stash policy is deferred, for v1, we just skip when dirty
      // beyond the grace window. Less surprising than auto-stashing.
      return;
    }

    // ---- Run ----
    if (opts.dryRun) {
      log.info("tick.dry_run pick", {
        project: adapter.name,
        queue: pick.queue,
        leverage: pick.leverage,
        score: pick.score,
        taskId: pick.taskId,
        summary: pick.summary.slice(0, 120),
      });
      return;
    }
    await executeRun(cfg, adapter, pick, budget);
  } finally {
    await releaseLock(cfg.dataDir);
  }
}

/**
 * Receive-side auto-close for the stale-open backlog class.
 *
 * Reads the commit message, fetches currently-open backlog ids for the
 * adapter's project, finds any whose id appears as a whole token in the
 * message (kebab-case-id-safe match), and closes them with audit metadata
 * pointing at the commit + runId. Skips the run's own taskId because the
 * caller has already invoked `markBacklogItemDone`.
 *
 * All operations are best-effort: a git or db failure logs + falls
 * through so the ship path still succeeds. Worst case: we miss closing
 * a referenced item, which the operator can do manually -- strictly
 * better than the pre-fix state (NEVER auto-closed for non-backlog
 * queue ships).
 *
 * Called from both ship paths: auto-push (executeRun) and approved-
 * shipped (pushApprovedRuns). Bit dotnet-* 2026-05-22 -> 2026-05-26.
 */
async function autoCloseReferencedBacklogItems(
  adapter: ProjectAdapter,
  runId: string,
  commitSha: string,
  ownTaskId: string | undefined | null,
): Promise<void> {
  try {
    const message = await commitMessage(adapter.rootDir, commitSha);
    if (!message) return;
    const openIds = await listOpenBacklogIds(adapter.name);
    if (openIds.length === 0) return;
    const referenced = findReferencedBacklogIds(message, openIds);
    if (referenced.length === 0) return;
    const ownId =
      ownTaskId && ownTaskId.startsWith("backlog:")
        ? ownTaskId.slice("backlog:".length)
        : null;
    const toClose = ownId
      ? referenced.filter((id) => id !== ownId)
      : referenced;
    if (toClose.length === 0) return;
    await closeBacklogItemsByIds(
      toClose,
      commitSha,
      runId,
      "auto-closed: commit message references backlog item id",
    );
    log.info("tick.run.shipped.auto_closed_backlog_refs", {
      runId,
      closedIds: toClose,
      commitSha,
    });
  } catch (e) {
    log.error("tick.run.shipped.auto_close_failed", {
      runId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

async function executeRun(
  cfg: BotConfig,
  adapter: ProjectAdapter,
  pick: ScoredCandidate,
  budget: BudgetDecision,
): Promise<void> {
  const runId = ulid();
  const startBranch = await currentBranch(adapter.rootDir);
  const baseSha = await headSha(adapter.rootDir);
  const approvalMode = await approvalModeFor(cfg, adapter.name, pick.queue);

  const previousFailedModel = pick.taskId
    ? (await lastFailedModelForTaskId(adapter.name, pick.taskId)) ?? undefined
    : undefined;
  const model = selectModel(pick, {
    budgetWorstRatio: budget.worstRatio,
    previousFailedModel,
  });
  const capsOverride = await getState<Partial<Record<ModelTier, unknown>>>(
    "output_token_caps",
  );
  const outputTokenCap = resolveOutputTokenCap(model, capsOverride);
  const maxToolUses = await resolveMaxToolUses();

  // Per-project session resume (chunk 5/5 of ai-usage-opt). `isolate`
  // on the pick forces a fresh session for cross-project / super-
  // dangerous work where the prior transcript would mislead. Outside
  // that, resume when the cached id is < 24h old.
  const resumeSessionId = pick.isolate
    ? undefined
    : pickResumeSessionId(
        await getLastSessionForProject(adapter.name),
        Date.now(),
      );

  await createRun({
    id: runId,
    project: adapter.name,
    queue: pick.queue,
    taskSummary: pick.summary,
    status: "running",
    approvalMode,
    branch: startBranch,
    startedAt: new Date(),
    metadata: {
      taskId: pick.taskId,
      leverage: pick.leverage,
      score: pick.score,
      estTokens: pick.estTokens,
      complex: pick.complex ?? false,
      // Recorded so /budget can break spend down by tier and so
      // lastFailedModelForTaskId() can drive the next-tick retry decision.
      model,
      // Surfaced on /runs/[id] so the operator can see which --max-tokens
      // value the spawned claude was capped at.
      outputTokenCap: outputTokenCap ?? null,
      // Cap on tool_use events per run (chunk 2/5 of ai-usage-opt).
      // Read off ocean_bot_state.max_tool_uses if set, falls back to the
      // bot's default. Surfaced so the operator can correlate cap-hit
      // blockers with the value in force at the time.
      maxToolUses,
      // Resumed session id (chunk 5/5 of ai-usage-opt) or null when the
      // run spawned a fresh session. Surfaced on /runs/[id] so the
      // operator can see when the prompt cache was reused.
      resumeSessionId: resumeSessionId ?? null,
      isolate: pick.isolate ?? false,
      suggestedModel: pick.suggestedModel ?? null,
      severity: pick.severity ?? null,
      retryReason: previousFailedModel ? `prev_failed:${previousFailedModel}` : null,
    },
  });

  log.info("tick.run.started", {
    runId,
    project: adapter.name,
    queue: pick.queue,
    model,
    summary: pick.summary.slice(0, 100),
  });

  // Haiku scout (chunk 4/5 of ai-usage-opt). For long complex tasks, run
  // a 60s haiku scope-check BEFORE spawning the real (probably opus)
  // session. Catches scope explosions (unbounded asks, dangerous ops,
  // ambiguous targets) early so the operator can re-scope rather than
  // burning a 30min opus session on a task that was always going to need
  // human disambiguation. Scout failures (timeout / unparseable) are
  // logged + ignored: we'd rather over-spawn-opus once than block work on
  // a flaky pre-check.
  if (pick.complex && pick.summary.length > SCOUT_DESCRIPTION_THRESHOLD) {
    const scoutOutcome = await scoutTask({
      description: pick.summary,
      cwd: adapter.rootDir,
    });
    await appendEvent(runId, "gate", {
      kind: "scout",
      result: scoutOutcome.result,
      hasScopeWarnings: scoutOutcome.hasScopeWarnings,
      failure: scoutOutcome.failure,
      cached: scoutOutcome.cached,
    });
    if (scoutOutcome.hasScopeWarnings) {
      const warnings = scoutOutcome.result?.scopeWarnings ?? [];
      log.info("tick.run.scout_blocked", {
        runId,
        warnings,
        suggestedModel: scoutOutcome.result?.model ?? null,
        estimatedTurns: scoutOutcome.result?.estimatedTurns ?? null,
        approvalMode,
      });

      // Manual mode: route directly to approval as before. The operator
      // is reading every run anyway; the scout-block is just one of
      // many gates they're already paying attention to.
      if (approvalMode === "manual") {
        await setRunFields(runId, {
          status: "awaiting-approval",
          pushState: "local",
          blocker: `scout flagged scope risk before spawn: ${warnings.join("; ")}`,
        });
        return;
      }

      // Auto / auto-with-visual: run the resolver (sonnet) to triage.
      // The scout uses haiku and is intentionally conservative; most
      // warnings are technical scope questions the resolver can answer
      // without operator input. Only genuinely executive decisions
      // (pricing, brand, product direction) should escalate.
      const resolverOutcome = await resolveScoutScope({
        description: pick.summary,
        scopeWarnings: warnings,
        cwd: adapter.rootDir,
      });
      const resolution: ScoutResolution =
        resolverOutcome.result ??
        fallbackOnFailure(resolverOutcome.failure ?? "unknown resolver error");
      await appendEvent(runId, "gate", {
        kind: "scout_resolver",
        verdict: resolution.verdict,
        explanation: resolution.explanation,
        clarifiedScope: resolution.clarifiedScope ?? null,
        acceptanceCriteria: resolution.acceptanceCriteria ?? null,
        failure: resolverOutcome.failure,
        cached: resolverOutcome.cached,
      });
      log.info("tick.run.scout_resolver", {
        runId,
        verdict: resolution.verdict,
        explanation: resolution.explanation,
        cached: resolverOutcome.cached,
        failure: resolverOutcome.failure,
      });

      if (resolution.verdict === "skip") {
        // Use the "no commit produced" prefix so recentlyNoopTaskIds
        // dedup picks this up, the bot will pick a different task
        // next tick instead of re-trying this one immediately.
        await setRunFields(runId, {
          status: "failed",
          pushState: "local",
          blocker: `no commit produced (scout-resolver skip: ${resolution.explanation})`,
        });
        return;
      }

      if (resolution.verdict === "escalate") {
        await setRunFields(runId, {
          status: "awaiting-approval",
          pushState: "local",
          blocker: `scout-resolver escalated (${resolution.explanation}); original warnings: ${warnings.join("; ")}`,
        });
        return;
      }

      if (resolution.verdict === "block") {
        // Operator-action task: the bot literally can't do it (browser
        // auth, external-portal form, manual install, etc.). Mark the
        // run as failed AND flip the backlog item to status='blocked'
        // with the resolver's reason. Operator does the action
        // externally, then reopens or archives the backlog item.
        //
        // Crucially distinct from escalate: blocked items do NOT
        // surface on /approvals (there's no Ship/Skip decision to
        // make). They appear in /backlog's blocked section instead.
        //
        // Extract the backlog item id from the taskId encoding so we
        // can flip the right row. Non-backlog picks (creative, etc.)
        // shouldn't reach 'block' under normal use, but the helper
        // no-ops gracefully when taskId is null or not 'backlog:'-
        // prefixed.
        await setRunFields(runId, {
          status: "failed",
          pushState: "local",
          blocker: `scout-resolver blocked (operator action required: ${resolution.explanation}); original warnings: ${warnings.join("; ")}`,
        });
        if (pick.taskId && pick.taskId.startsWith("backlog:")) {
          const backlogId = pick.taskId.slice("backlog:".length);
          await blockBacklogItemForOperatorAction(backlogId, {
            runId,
            reason: resolution.explanation,
          });
          log.info("tick.run.scout_resolver.block_backlog_item", {
            runId,
            backlogId,
            reason: resolution.explanation,
          });
        }
        return;
      }

      // verdict === "proceed". If the resolver wrote a clarifiedScope,
      // use it as the task description for the rest of the run, the
      // tightened wording reduces ambiguity for the main opus/sonnet
      // session. Falling through (no return) continues into the runTask
      // path below.
      if (resolution.clarifiedScope) {
        log.info("tick.run.scout_resolver.scope_clarified", {
          runId,
          originalLen: pick.summary.length,
          clarifiedLen: resolution.clarifiedScope.length,
        });
        pick.summary = resolution.clarifiedScope;
      }
      // /goal wrapper. When the resolver emitted acceptanceCriteria,
      // wrap the (possibly clarified) prompt with a /goal envelope so
      // Anthropic's per-turn Haiku evaluator judges progress between
      // turns. The 5-turn cap is baked INTO the condition itself per
      // Anthropic docs, not a separate CLI flag. Composes with the
      // process-level timeout, output-token cap, tool-use cap, and
      // rate-limit gate already in place. Skipped for routine
      // clarifications (the resolver omits acceptanceCriteria there)
      // so the evaluator's ~168 Haiku tokens per turn is paid only on
      // scout-uncertain runs.
      if (resolution.acceptanceCriteria) {
        const wrapped = applyGoalWrapper(pick.summary, resolution);
        await appendEvent(runId, "gate", {
          kind: "goal_set",
          acceptanceCriteria: resolution.acceptanceCriteria,
          turnCap: DEFAULT_GOAL_TURN_CAP,
        });
        log.info("tick.run.scout_resolver.goal_set", {
          runId,
          turnCap: DEFAULT_GOAL_TURN_CAP,
          criteriaLen: resolution.acceptanceCriteria.length,
        });
        pick.summary = wrapped;
      }
    }
  }

  // In-flight snapshot for the dashboard's hero card. Cleared in the
  // finally below so the next idle window shows correctly even if the
  // run errors. The child claude PID is stamped separately by runner.ts
  // on spawn; until then current_run.childPid is null.
  await setState("current_run", {
    runId,
    project: adapter.name,
    queue: pick.queue,
    taskSummary: pick.summary,
    model,
    startedAt: new Date().toISOString(),
    runnerPid: process.pid,
    childPid: null,
  });

  let result: Awaited<ReturnType<typeof runTask>>;
  try {
    result = await runTask({
      runId,
      prompt: pick.summary,
      cwd: adapter.rootDir,
      sessionsLogPath: cfg.sessionsLogPath,
      project: adapter.name,
      model,
      outputTokenCap,
      maxToolUses,
      resumeSessionId,
    });
  } finally {
    await setState("current_run", {});
  }

  // Persist this run's session id so the next tick on the same project
  // can resume. We only stamp on clean runner exit, a SIGTERM'd or
  // crashed session may have left the transcript mid-tool-use, in which
  // case resuming would feed bad context to the next prompt.
  //
  // Known limitation: if Claude's local session file is later deleted
  // (operator wipe of ~/.claude/projects/) the stamped id becomes
  // unreachable and the next tick burns one resume attempt before
  // failing. Recovery is to delete the `last_session:<project>` row
  // from ocean_bot_state. Rare enough not to instrument now.
  if (result.exitCode === 0 && result.sessionId) {
    await setLastSessionForProject(adapter.name, result.sessionId);
  }

  await appendEvent(runId, "message", {
    kind: "runner_finished",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    toolUses: result.toolUses,
  });

  if (result.exitCode !== 0) {
    // Non-zero exit (including 124 timeout from SIGKILL after SIGTERM)
    // CAN leave WIP dirty in the working tree (claude may have edited
    // files but been killed before commit). Without stashing, the bot
    // self-blocks every subsequent tick with dirty_tree_stale until an
    // operator manually intervenes. Reuse classifyNoopRun to stash any
    // orphan edits to refs/ocean-bot/orphan-edits/<runId> so the work is
    // recoverable but the tree is clean. Surfaces both pieces in blocker.
    // Hit prod twice in 24h on 2026-05-15 (drift-gate + split-adapter
    // timeouts); this fix exits the salvage loop structurally.
    const exitDescriptor = result.rateLimitHit
      ? `rate limited (${result.rateLimitReason ?? "429"}): claude exited ${result.exitCode}`
      : result.tokenCapHit
        ? `runner killed at output-token cap (token-cap-overage: observed ${result.outputTokens} output tokens, cap=${outputTokenCap ?? "n/a"})`
        : result.toolUseCapHit
          ? `runner killed at tool-use cap (${maxToolUses} tool_use events, observed ${result.toolUses})`
          : `runner exit ${result.exitCode}${result.exitCode === 124 ? " (timeout)" : ""}`;
    const outcome = await classifyNoopRun(adapter.rootDir, runId);
    let blocker = exitDescriptor;
    if (outcome.kind === "dirty") {
      await appendEvent(runId, "message", {
        kind: "exit_dirty_stash",
        exitCode: result.exitCode,
        stashed: outcome.stashed,
        sha: outcome.sha,
        ref: outcome.ref,
        changedFiles: outcome.changedFiles,
      });
      blocker = `${exitDescriptor}; ${outcome.blocker}`;
    }
    await setRunFields(runId, {
      status: "failed",
      endedAt: new Date(),
      blocker,
    });
    log.warn("tick.run.runner_failed", {
      runId,
      exitCode: result.exitCode,
      stashed: outcome.kind === "dirty" ? outcome.stashed : false,
    });

    // Rate-limit gate: set the active pause so the next tick backs off
    // before spawning another claude session. The key auto-clears once
    // the backoff window elapses (see the gate at the top of tick()). We
    // only set this on non-zero exit: if Claude Code's internal retry
    // recovered and the run succeeded, no pause is needed.
    if (result.rateLimitHit) {
      const backoffMs =
        result.rateLimitReason === "credits-exhausted"
          ? CREDITS_EXHAUSTED_BACKOFF_MS
          : RATE_LIMIT_BACKOFF_MS;
      const now = Date.now();
      await setRateLimitPause({
        pausedAt: now,
        reason: result.rateLimitReason ?? "429",
        resumeAfter: now + backoffMs,
      });
      await appendRateLimitHistory({
        ts: now,
        reason: result.rateLimitReason ?? "429",
        runId,
      });
      log.warn("tick.run.rate_limit_pause_set", {
        runId,
        reason: result.rateLimitReason,
        backoffMs,
        resumeAfter: new Date(now + backoffMs).toISOString(),
      });
    }
    return;
  }

  const headAfter = await headSha(adapter.rootDir);
  if (headAfter === baseSha) {
    // Two sub-cases on no-new-commit:
    //  - Clean tree: genuine no-op. Existing behavior (shipped+local).
    //  - Dirty tree: claude edited files but never committed. Stash to a
    //    recoverable ref + reset, mark failed. Without this, every
    //    subsequent tick skips with dirty_tree_stale (16+h prod halt
    //    2026-05-13).
    const outcome = await classifyNoopRun(adapter.rootDir, runId);
    if (outcome.kind === "clean") {
      await setRunFields(runId, {
        status: "shipped",
        pushState: "local",
        endedAt: new Date(),
        blocker: "no commit produced (no-op task)",
      });
      log.info("tick.run.noop", { runId });
      return;
    }
    await appendEvent(runId, "message", {
      kind: "noop_dirty_stash",
      stashed: outcome.stashed,
      sha: outcome.sha,
      ref: outcome.ref,
      changedFiles: outcome.changedFiles,
    });
    await setRunFields(runId, {
      status: "failed",
      pushState: "local",
      endedAt: new Date(),
      blocker: outcome.blocker,
    });
    log.warn("tick.run.noop_dirty", {
      runId,
      stashed: outcome.stashed,
      ref: outcome.ref,
      changedFiles: outcome.changedFiles,
    });
    return;
  }

  const diff = await diffSinceCommit(adapter.rootDir, baseSha);
  await appendEvent(runId, "commit", {
    sha: headAfter,
    files: diff.files,
    added: diff.added,
    removed: diff.removed,
  });

  const preflight = await runPreflight(adapter);
  await appendEvent(runId, "gate", { kind: "preflight", ...preflight });

  // visual review is wired but not running yet, Playwright MCP integration
  // is its own milestone. Mark as 'skipped' for v1.
  const decision = decidePush({
    adapter,
    diff,
    preflight,
    approvalMode,
    visualVerdict: "skipped",
  });
  await appendEvent(runId, "gate", { kind: "push_decision", ...decision });

  if (decision.action === "block") {
    await setRunFields(runId, {
      status: "failed",
      commitSha: headAfter,
      pushState: "local",
      dangerLevel: decision.dangerReasons.length > 0 ? "super-dangerous" : "safe",
      dangerReasons: decision.dangerReasons.length > 0 ? decision.dangerReasons : null,
      blocker: decision.reason,
      endedAt: new Date(),
    });
    return;
  }

  if (decision.action === "await-approval") {
    await setRunFields(runId, {
      status: "awaiting-approval",
      commitSha: headAfter,
      pushState: "local",
      dangerLevel: decision.dangerReasons.length > 0 ? "super-dangerous" : "safe",
      dangerReasons: decision.dangerReasons.length > 0 ? decision.dangerReasons : null,
      blocker: decision.reason,
    });
    log.info("tick.run.awaiting_approval", { runId, reason: decision.reason });
    return;
  }

  // action === 'push'
  const pushRes = await pushToTarget(adapter, startBranch);
  await appendEvent(runId, "push", pushRes);
  if (pushRes.pushed) {
    await setRunFields(runId, {
      status: "shipped",
      commitSha: headAfter,
      pushState: "pushed",
      dangerLevel: "safe",
      endedAt: new Date(),
    });
    // Close the backlog item now that the work is on origin. The
    // approved-then-shipped path (pushApprovedRuns) calls
    // markBacklogItemDone too, but auto-push takes a different code
    // path: without this call, backlog items stay status='open'
    // forever despite the commit landing, the bot re-picks them on
    // the next tick, gets a no-op (work already shipped), and the
    // no-op locks the task in recentlyNoopTaskIds for 24h. Surfaced
    // 2026-05-16 on the parser-filter-constant-return-methods task,
    // which shipped at 16:31 but stayed open. Idempotent: markBacklog-
    // ItemDone no-ops when taskId is null / missing / not prefixed
    // 'backlog:' (creative / refactor / tightening picks all skip).
    await markBacklogItemDone(pick.taskId);
    // Receive-side defense for the stale-open class. If this commit's
    // message names any OPEN backlog item id (creative / refactor
    // ships often satisfy a backlog item incidentally), auto-close
    // those too. Skips the pick's own id (markBacklogItemDone handled
    // it). Bit dotnet-* 2026-05-22 -> 2026-05-26 when the C# parser
    // shipped via creative queue and 4 dotnet-* backlog items rotted
    // open for 4 days. See memory/feedback_auth_trust_host_required.md
    // (4th lesson) + journal.ts#closeBacklogItemsByIds.
    await autoCloseReferencedBacklogItems(
      adapter,
      runId,
      headAfter,
      pick.taskId,
    );
    log.info("tick.run.shipped", { runId, sha: headAfter, taskId: pick.taskId });
  } else {
    await setRunFields(runId, {
      status: "failed",
      commitSha: headAfter,
      pushState: "local",
      blocker: `push failed: ${pushRes.reason}`,
      endedAt: new Date(),
    });
    log.warn("tick.run.push_failed", { runId, reason: pushRes.reason });
  }
}

async function pushApprovedRuns(adapter: ProjectAdapter): Promise<void> {
  const approved = await findApprovedRuns(adapter.name);
  for (const run of approved) {
    if (run.project !== adapter.name) continue;
    const taskId = extractTaskId(run.metadata);
    if (!run.branch) {
      log.warn("approved.no_branch", { runId: run.id });
      await setRunFields(run.id, {
        status: "failed",
        blocker: "approved but no branch recorded",
        endedAt: new Date(),
      });
      continue;
    }
    // Defensive: if Ocean has rebased / reset away from the bot's
    // commit between approval and push, DO NOT push a different commit.
    // Fail with a clear reason so Ocean knows to re-trigger.
    if (run.commitSha) {
      const reachable = await commitReachable(
        adapter.rootDir,
        run.commitSha,
        run.branch,
      );
      if (!reachable) {
        await setRunFields(run.id, {
          status: "failed",
          blocker: `approved commit ${run.commitSha.slice(0, 7)} no longer reachable from ${run.branch} — branch was rebased / reset since approval`,
          endedAt: new Date(),
        });
        log.warn("approved.commit_unreachable", {
          runId: run.id,
          sha: run.commitSha,
          branch: run.branch,
        });
        // After ORPHAN_RETRY_THRESHOLD consecutive orphan-failed runs
        // for the same backlog taskId, auto-block the backlog row.
        // Without this, the picker happily re-selects the same open
        // item next tick and the bot writes commit B that gets
        // rebased away in turn, token-burn loop where each commit
        // IS valuable but keeps getting orphaned.
        if (taskId && taskId.startsWith("backlog:")) {
          const backlogId = taskId.slice("backlog:".length);
          const { count, runIds } = await countOrphanFailuresForTaskId(
            adapter.name,
            taskId,
          );
          if (count >= ORPHAN_RETRY_THRESHOLD) {
            await blockBacklogItemForOrphanRetries(backlogId, {
              runIds,
              lastOrphanSha: run.commitSha,
            });
            log.warn("approved.backlog_auto_blocked", {
              backlogId,
              taskId,
              failedRuns: runIds.length,
              lastOrphanSha: run.commitSha,
            });
          }
        }
        continue;
      }
    }
    const pushRes = await pushToTarget(adapter, run.branch);
    await appendEvent(run.id, "push", { ...pushRes, trigger: "user-approved" });
    if (pushRes.pushed) {
      await setRunFields(run.id, {
        status: "shipped",
        pushState: "pushed",
        endedAt: new Date(),
      });
      // Mark the source backlog item `done` so it doesn't get re-picked
      // next tick. No-ops for non-backlog runs (taskId without the
      // `backlog:` prefix). Without this, the adapter's `status='open'`
      // filter never removes the item, bot ships the same fix every
      // tick until manual intervention. Surfaced on 2026-05-12 when
      // webhook-dedupe shipped 3x in 9min.
      await markBacklogItemDone(taskId);
      // Receive-side defense (same as the auto-push path): if the
      // commit's message references any other open backlog item id,
      // close it too. Commit sha already in run.commitSha.
      const shippedSha = run.commitSha;
      if (shippedSha) {
        await autoCloseReferencedBacklogItems(
          adapter,
          run.id,
          shippedSha,
          taskId,
        );
      }
      log.info("approved.shipped", { runId: run.id, taskId });
      // Layer 3 of stale-prevention: if the just-pushed commit touches
      // any bot-affecting path, the running JS is now stale (drift gate
      // will fire on the very next tick). Schedule a graceful self-
      // restart so KeepAlive can respawn via the wrapper, rebuild dist,
      // and re-stamp .built-from-sha. No operator restart needed.
      // 2026-05-15: 5x manual launchctl kickstart cycles in one day
      // motivated this.
      if (run.commitSha) {
        try {
          const diff = await diffSinceCommit(adapter.rootDir, run.commitSha + "^");
          if (diff.files.some(isBotAffectingPath)) {
            log.info("approved.shipped.self_mod_detected, scheduling restart", {
              runId: run.id,
              commitSha: run.commitSha,
              botAffectingFiles: diff.files.filter(isBotAffectingPath),
            });
            shutdown = true;
          }
        } catch (e) {
          // Diff lookup failure is non-fatal; worst case the next tick's
          // drift gate catches the stale dist and operator does the
          // manual restart. Don't crash the push flow.
          log.warn("approved.shipped.self_mod_check_failed", {
            runId: run.id,
            err: errMsg(e),
          });
        }
      }
    } else {
      await setRunFields(run.id, {
        status: "failed",
        pushState: "local",
        blocker: `approved push failed: ${pushRes.reason}`,
        endedAt: new Date(),
      });
      log.warn("approved.push_failed", { runId: run.id, reason: pushRes.reason });
    }
  }
}

function extractTaskId(meta: unknown): string | null {
  if (meta && typeof meta === "object") {
    const t = (meta as { taskId?: unknown }).taskId;
    if (typeof t === "string") return t;
  }
  return null;
}

/** Thin wrapper that injects the journal's getState as the StateReader.
 *  Precedence chain + DB-state override semantics live in approval-mode.ts. */
async function approvalModeFor(
  cfg: BotConfig,
  projectName: string,
  queue: Queue,
): Promise<ApprovalMode> {
  return resolveApprovalMode({ cfg, projectName, queue, getState });
}

async function loadRecentQueues(): Promise<Queue[]> {
  const v = await getState<Queue[]>("recent_queues");
  return v ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

main().catch((e) => {
  log.error("ocean-bot.fatal", { err: errMsg(e) });
  process.exit(1);
});
