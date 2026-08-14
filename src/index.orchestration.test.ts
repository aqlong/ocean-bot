import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ProjectAdapter,
  DiffSummary,
  DangerReason,
} from "./adapters/types.js";
import type { BotConfig, ApprovalMode } from "./config.js";
import type { PreflightResult, PushResult } from "./push.js";
import { SCOUT_DESCRIPTION_THRESHOLD } from "./scout.js";
import type { ScoutOutcome } from "./scout.js";
import type { ResolverOutcome } from "./scout-resolver.js";
import type { RateLimitPause } from "./journal.js";
import type { ScoredCandidate } from "./queue.js";
import type { BudgetDecision } from "./budget.js";

// Orchestration tests for the tick loop.
//
// Every module index.ts wires is well covered on its own. What was not
// covered is index.ts itself, which decides the ORDER those pieces run in
// and what to do with their answers. That is not observable from any unit
// test of the parts: push.test.ts proves decidePush returns the right
// verdict, and nothing proved executeRun then RESPECTS it. A swapped
// comparison or a missing `return` in the verdict branches would auto-push
// work that should have required a human, with the entire suite green.
//
// The mocking line is drawn deliberately. Everything with a side effect
// (the spawn, the database, git, the actual push) is faked, but the real
// decidePush from push.ts runs, because the decision logic is precisely
// what these tests are checking the wiring against. Mocking decidePush
// too would leave the tests asserting that a stub returned what the stub
// was told to return.
//
// This file became possible when index.ts stopped calling main() at module
// scope. Importing it used to start the bot: connect to Postgres, take the
// tick lock, and begin spawning Claude sessions.

// ---------------------------------------------------------------- mocks

// Several of these are typed explicitly rather than inferred. `vi.fn(async
// () => {})` records its calls as the empty tuple, so mock.calls[1] is a
// type error even though the call is really made with two arguments, and
// the assertions below read those arguments.
const journal = vi.hoisted(() => ({
  createRun: vi.fn<(run: Record<string, unknown>) => Promise<void>>(async () => {}),
  appendEvent:
    vi.fn<(runId: string, kind: string, payload: Record<string, unknown>) => Promise<void>>(
      async () => {},
    ),
  setRunFields:
    vi.fn<(runId: string, fields: Record<string, unknown>) => Promise<void>>(
      async () => {},
    ),
  setState: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
  getState: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  findApprovedRuns: vi.fn<(project: string) => Promise<Record<string, unknown>[]>>(
    async () => [],
  ),
  activeTaskIds: vi.fn(async () => [] as string[]),
  recentlyNoopTaskIds: vi.fn(async () => [] as string[]),
  markBacklogItemDone: vi.fn(async () => {}),
  listOpenBacklogIds: vi.fn(async () => [] as string[]),
  findReferencedBacklogIds: vi.fn(() => [] as string[]),
  closeBacklogItemsByIds: vi.fn(async () => {}),
  blockBacklogItemForOperatorAction:
    vi.fn<(backlogId: string, meta: { runId: string; reason: string }) => Promise<void>>(
      async () => {},
    ),
  countOrphanFailuresForTaskId: vi.fn(async () => 0),
  blockBacklogItemForOrphanRetries: vi.fn(async () => {}),
  lastFailedModelForTaskId: vi.fn(async () => null),
  getFiveHrWindowStart: vi.fn(async () => null),
  setFiveHrWindowStart: vi.fn(async () => {}),
  clearFiveHrWindowStart: vi.fn(async () => {}),
  getLastSessionForProject: vi.fn(async () => null),
  setLastSessionForProject: vi.fn(async () => {}),
  getRateLimitPause: vi.fn<() => Promise<RateLimitPause | null>>(async () => null),
  clearRateLimitPause: vi.fn(async () => {}),
  setRateLimitPause: vi.fn<(pause: RateLimitPause) => Promise<void>>(async () => {}),
  appendRateLimitHistory:
    vi.fn<(entry: { ts: number; reason: string; runId: string }) => Promise<void>>(
      async () => {},
    ),
}));
vi.mock("./journal.js", () => journal);

const runner = vi.hoisted(() => ({
  runTask: vi.fn(),
  isInteractiveClaudeRunning: vi.fn(async () => false),
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => {}),
  classifyNoopRun: vi.fn(async () => ({ kind: "clean" as const })),
  DEFAULT_MAX_TOOL_USES: 100,
  pickResumeSessionId: vi.fn(() => undefined),
  ensureBacklogIdFooter: vi.fn(async (_dir: string, sha: string) => sha),
}));
vi.mock("./runner.js", () => runner);

const git = vi.hoisted(() => ({
  isClean: vi.fn(async () => true),
  currentBranch: vi.fn(async () => "main"),
  headSha: vi.fn(async () => "base-sha"),
  diffSinceCommit: vi.fn(async () => ({
    files: ["src/foo.ts"],
    added: 3,
    removed: 1,
    patch: "+const x = 1;",
  })),
  fileLastModified: vi.fn(async () => 0),
  commitReachable: vi.fn(async () => true),
  commitMessage: vi.fn(async () => "feat: work"),
}));
vi.mock("./util/git.js", () => git);

// Keep the REAL decidePush. Fake only the two functions with side effects:
// one shells out to run the project's test suite, the other pushes to a
// remote.
const pushMod = vi.hoisted(() => ({
  runPreflight: vi.fn<() => Promise<PreflightResult>>(async () => ({
    ok: true,
    failures: [],
  })),
  pushToTarget: vi.fn<() => Promise<PushResult>>(async () => ({
    pushed: true,
    branch: "main",
  })),
}));
vi.mock("./push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./push.js")>();
  return { ...actual, ...pushMod };
});

const drift = vi.hoisted(() => ({
  detectDrift: vi.fn(async () => ({ drifted: false })),
  isBotAffectingPath: vi.fn(() => false),
  resolveDriftPaths: vi.fn(() => []),
  DRIFT_STATE_KEY: "drift",
}));
vi.mock("./drift.js", () => drift);

const sweeps = vi.hoisted(() => ({
  runHealthSweep: vi.fn(async () => ({})),
  sweepOrphanRunningRunsOnBoot: vi.fn(async () => ({ fixedCount: 0, fixedIds: [] })),
  maybeRunPhantomCleanup: vi.fn(async () => {}),
}));
vi.mock("./health-sweep.js", () => ({
  runHealthSweep: sweeps.runHealthSweep,
  sweepOrphanRunningRunsOnBoot: sweeps.sweepOrphanRunningRunsOnBoot,
}));
vi.mock("./phantom-cleanup.js", () => ({
  maybeRunPhantomCleanup: sweeps.maybeRunPhantomCleanup,
}));

// Partial mocks: config.ts imports DEFAULT_CAPS from budget.js, and index.ts
// imports DEFAULT_PICKER_CTX from queue.js, so these modules have to keep
// their real constants. Only the functions that read the database or score
// candidates are faked.
const budgetMod = vi.hoisted(() => {
  const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
  const caps = {
    fiveHrInput: 1_000_000,
    fiveHrOutput: 200_000,
    sevenDInput: 7_000_000,
    sevenDOutput: 1_400_000,
    warnRatio: 0.9,
  };
  return {
    // The full BudgetDecision shape, not just `gate`. tick() reads
    // budget.fiveHr to decide whether to stamp the window anchor, so a
    // partial fake throws before reaching the gates under test.
    decideBudget: vi.fn(() => ({
      gate: "ok",
      worstRatio: 0.1,
      fiveHr: { ...totals },
      sevenD: { ...totals },
      caps,
    })),
    decideProjectBudgets: vi.fn(() => new Map()),
    loadBotSessions: vi.fn(async () => []),
    loadUsageRows: vi.fn(async () => []),
  };
});
vi.mock("./budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./budget.js")>();
  return { ...actual, ...budgetMod };
});

const queueMod = vi.hoisted(() => ({
  // Typed explicitly: inferring from `async () => null` narrows the mock's
  // return to `null`, and every mockResolvedValue(pick) below then fails
  // typecheck even though the tests pass at runtime.
  pickNext: vi.fn<() => Promise<ScoredCandidate | null>>(async () => null),
}));
vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return { ...actual, ...queueMod };
});

// Scout and resolver both spawn `claude -p`, so the spawning entry points
// are faked. Everything else in these modules stays REAL: SCOUT_DESCRIPTION_
// THRESHOLD decides whether the scout runs at all, and fallbackOnFailure /
// applyGoalWrapper are pure functions that encode behavior under test (the
// fail-safe verdict and the goal envelope). Faking those would test the
// stubs instead of the handoff.
const scoutMod = vi.hoisted(() => ({
  scoutTask: vi.fn<() => Promise<ScoutOutcome>>(),
}));
vi.mock("./scout.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout.js")>();
  return { ...actual, ...scoutMod };
});

const resolverMod = vi.hoisted(() => ({
  resolveScoutScope: vi.fn<() => Promise<ResolverOutcome>>(),
}));
vi.mock("./scout-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./scout-resolver.js")>();
  return { ...actual, ...resolverMod };
});

vi.mock("./db/index.js", () => ({ closeDb: vi.fn(async () => {}) }));

const { executeRun, tick, pushApprovedRuns } = await import("./index.js");

// ------------------------------------------------------------- fixtures

function mkAdapter(over: Partial<ProjectAdapter> = {}): ProjectAdapter {
  return {
    name: "ocean-bot",
    rootDir: "/tmp/repo",
    claudeMdPath: "/tmp/repo/CLAUDE.md",
    memoryDir: "/tmp/repo/memory",
    backlog: async () => [],
    bugFix: async () => [],
    gapClosure: async () => [],
    tightening: async () => [],
    roadmap: async () => [],
    selfLearning: async () => [],
    refactor: async () => [],
    creative: async () => [],
    pushTarget: () => "main",
    classifyDanger: () => [],
    preflightCommands: () => ["npm test"],
    visualSurfaces: async () => [],
    ...over,
  };
}

function mkCfg(globalApprovalMode: ApprovalMode = "auto"): BotConfig {
  return {
    tickIntervalSec: 180,
    dataDir: "/tmp/ocean-bot-data",
    caps: {
      fiveHrInput: 1_000_000,
      fiveHrOutput: 200_000,
      sevenDInput: 7_000_000,
      sevenDOutput: 1_400_000,
      warnRatio: 0.9,
    },
    capsFromConfigFile: false,
    globalApprovalMode,
    projects: [
      {
        name: "ocean-bot",
        rootDir: "/tmp/repo",
        memoryDir: "/tmp/repo/memory",
        enabled: true,
      },
    ],
    sessionsLogPath: "/tmp/ocean-bot-data/sessions.jsonl",
  } as BotConfig;
}

function mkPick(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    project: "ocean-bot",
    queue: "backlog",
    // Short and not complex, so the scout / resolver pre-check does not
    // fire and these tests stay focused on the push gate.
    summary: "small fix",
    taskId: "backlog:item-1",
    leverage: 50,
    estTokens: 1000,
    score: 50,
    complex: false,
    ...over,
  } as ScoredCandidate;
}

const OK_BUDGET: BudgetDecision = { gate: "ok", worstRatio: 0.1 } as BudgetDecision;

/**
 * A pick that trips the scout gate, which fires only on tasks flagged
 * complex whose description exceeds SCOUT_DESCRIPTION_THRESHOLD (1500).
 * The threshold is imported real rather than hardcoded here, so raising it
 * in scout.ts cannot leave these tests silently exercising the wrong path.
 */
function mkComplexPick(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return mkPick({
    complex: true,
    summary: `migrate the publisher layer. ${"detail ".repeat(
      Math.ceil((SCOUT_DESCRIPTION_THRESHOLD + 100) / 7),
    )}`,
    ...over,
  });
}

/** The two backoff windows, as asserted deltas rather than wall-clock. */
const ONE_HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** A runner result that hit a rate limit and exited non-zero. */
function rateLimited(reason: string | undefined) {
  return {
    exitCode: 1,
    durationMs: 500,
    toolUses: 0,
    bytesIn: 0,
    bytesOut: 0,
    outputTokens: 0,
    toolUseCapHit: false,
    tokenCapHit: false,
    rateLimitHit: true,
    ...(reason === undefined ? {} : { rateLimitReason: reason }),
  };
}

/** A run that produced a commit: HEAD moves off the base sha. */
function runProducedACommit(): void {
  git.headSha
    .mockResolvedValueOnce("base-sha") // baseSha, before the spawn
    .mockResolvedValueOnce("head-sha"); // headAfter, after the spawn
  runner.runTask.mockResolvedValue({
    exitCode: 0,
    durationMs: 1000,
    sessionId: "session-1",
    toolUses: 3,
    bytesIn: 10,
    bytesOut: 20,
    outputTokens: 100,
    toolUseCapHit: false,
    tokenCapHit: false,
  });
}

/** Read the terminal setRunFields payload (the one carrying a status). */
function terminalStatus(): string | undefined {
  const withStatus = journal.setRunFields.mock.calls.filter(
    (c) => (c[1] as { status?: string } | undefined)?.status !== undefined,
  );
  const last = withStatus.at(-1);
  return (last?.[1] as { status?: string } | undefined)?.status;
}

const CRITICAL_HIT: DangerReason = {
  ruleId: 11,
  explanation: "Bot self-modification: tools/ocean-bot/src/runner.ts",
};
const ADVISORY_HIT: DangerReason = {
  ruleId: 6,
  explanation: "Diff too large for auto-review: 12 files, 900 lines",
};

/**
 * Re-establish every default the happy path depends on.
 *
 * Paired with vi.resetAllMocks() rather than vi.clearAllMocks(), which
 * clears recorded calls but leaves both the implementations AND the
 * mockResolvedValueOnce queues in place. runProducedACommit() queues two
 * one-shot headSha values, so under clearAllMocks a test that consumed
 * only one leaked the other into whichever test ran next. That made the
 * lock-release case pass in isolation and fail in sequence, which is the
 * failure mode worth designing out: an order-dependent suite eventually
 * gets a real regression dismissed as flakiness.
 */
function setDefaults(): void {
  const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };

  journal.getState.mockResolvedValue(undefined);
  journal.findApprovedRuns.mockResolvedValue([]);
  journal.activeTaskIds.mockResolvedValue([]);
  journal.recentlyNoopTaskIds.mockResolvedValue([]);
  journal.listOpenBacklogIds.mockResolvedValue([]);
  journal.findReferencedBacklogIds.mockReturnValue([]);
  journal.countOrphanFailuresForTaskId.mockResolvedValue(0);
  journal.lastFailedModelForTaskId.mockResolvedValue(null);
  journal.getLastSessionForProject.mockResolvedValue(null);
  journal.getRateLimitPause.mockResolvedValue(null);
  journal.getFiveHrWindowStart.mockResolvedValue(null);

  runner.acquireLock.mockResolvedValue(true);
  runner.isInteractiveClaudeRunning.mockResolvedValue(false);
  // A clean session that produced no commit: HEAD stays at the default
  // base sha. Neutral, and it means a test that forgets to configure the
  // runner fails on its own assertion rather than on a confusing
  // "cannot read exitCode of undefined" from inside executeRun.
  runner.runTask.mockResolvedValue({
    exitCode: 0,
    durationMs: 10,
    sessionId: "session-default",
    toolUses: 0,
    bytesIn: 0,
    bytesOut: 0,
    outputTokens: 0,
    toolUseCapHit: false,
    tokenCapHit: false,
  });
  runner.classifyNoopRun.mockResolvedValue({ kind: "clean" });
  runner.pickResumeSessionId.mockReturnValue(undefined);
  runner.ensureBacklogIdFooter.mockImplementation(
    async (_dir: string, sha: string) => sha,
  );

  git.headSha.mockResolvedValue("base-sha");
  git.currentBranch.mockResolvedValue("main");
  git.isClean.mockResolvedValue(true);
  git.fileLastModified.mockResolvedValue(0);
  git.commitReachable.mockResolvedValue(true);
  git.commitMessage.mockResolvedValue("feat: work");
  git.diffSinceCommit.mockResolvedValue({
    files: ["src/foo.ts"],
    added: 3,
    removed: 1,
    patch: "+const x = 1;",
  });

  pushMod.runPreflight.mockResolvedValue({ ok: true, failures: [] });
  pushMod.pushToTarget.mockResolvedValue({ pushed: true, branch: "main" });

  drift.detectDrift.mockResolvedValue({ drifted: false });
  drift.isBotAffectingPath.mockReturnValue(false);
  drift.resolveDriftPaths.mockReturnValue([]);

  sweeps.runHealthSweep.mockResolvedValue({});
  sweeps.maybeRunPhantomCleanup.mockResolvedValue(undefined);

  budgetMod.decideBudget.mockReturnValue({
    gate: "ok",
    worstRatio: 0.1,
    fiveHr: { ...totals },
    sevenD: { ...totals },
    caps: mkCfg().caps,
  });
  budgetMod.decideProjectBudgets.mockReturnValue(new Map());
  budgetMod.loadBotSessions.mockResolvedValue([]);
  budgetMod.loadUsageRows.mockResolvedValue([]);

  queueMod.pickNext.mockResolvedValue(null);

  // Scout finds nothing by default, so the ordinary path never reaches the
  // resolver. Tests that exercise the handoff opt in explicitly.
  scoutMod.scoutTask.mockResolvedValue({
    result: null,
    hasScopeWarnings: false,
    failure: null,
    cached: false,
  });
  resolverMod.resolveScoutScope.mockResolvedValue({
    result: { verdict: "proceed", explanation: "technical scope, resolved" },
    failure: null,
    cached: false,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  setDefaults();
});

// ------------------------------------------------- executeRun push gate

describe("executeRun respects the push decision", () => {
  it("holds for approval on a CRITICAL classifier hit under auto mode", async () => {
    // The load-bearing case. Auto mode is the production default, so the
    // only thing standing between a self-modifying diff and origin/main is
    // executeRun honoring the await-approval verdict.
    runProducedACommit();
    const adapter = mkAdapter({ classifyDanger: () => [CRITICAL_HIT] });

    await executeRun(mkCfg("auto"), adapter, mkPick(), OK_BUDGET);

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("awaiting-approval");
    expect(terminalStatus()).not.toBe("shipped");
  });

  it("records the danger reasons on the held run", async () => {
    // The operator approves from a dashboard card that renders these. An
    // approval card with an empty reason is an approval nobody can make.
    runProducedACommit();
    const adapter = mkAdapter({ classifyDanger: () => [CRITICAL_HIT] });

    await executeRun(mkCfg("auto"), adapter, mkPick(), OK_BUDGET);

    const held = journal.setRunFields.mock.calls.at(-1)?.[1] as {
      dangerReasons?: DangerReason[] | null;
      dangerLevel?: string;
      blocker?: string;
    };
    expect(held.dangerLevel).toBe("super-dangerous");
    expect(held.dangerReasons).toEqual([CRITICAL_HIT]);
    expect(held.blocker).toMatch(/#11/);
  });

  it("blocks and never pushes when preflight fails", async () => {
    runProducedACommit();
    pushMod.runPreflight.mockResolvedValue({
      ok: false,
      failures: [{ command: "npm test", exitCode: 1, tailLog: "1 failed" }],
    });

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("failed");
    const failed = journal.setRunFields.mock.calls.at(-1)?.[1] as {
      blocker?: string;
      pushState?: string;
    };
    expect(failed.blocker).toMatch(/npm test/);
    // The commit stays local rather than being discarded, so the operator
    // can inspect it.
    expect(failed.pushState).toBe("local");
  });

  it("blocks on preflight failure even when the diff is otherwise clean", async () => {
    // Ordering guard: decidePush checks preflight BEFORE the classifier.
    // A future edit that reordered them would let a green classifier
    // override a red test suite.
    runProducedACommit();
    pushMod.runPreflight.mockResolvedValue({
      ok: false,
      failures: [{ command: "npm run typecheck", exitCode: 2, tailLog: "TS2345" }],
    });

    await executeRun(
      mkCfg("auto"),
      mkAdapter({ classifyDanger: () => [] }),
      mkPick(),
      OK_BUDGET,
    );

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("failed");
  });

  it("pushes exactly once on the clean path and marks the run shipped", async () => {
    runProducedACommit();

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(pushMod.pushToTarget).toHaveBeenCalledTimes(1);
    expect(terminalStatus()).toBe("shipped");
  });

  it("closes the backlog item only AFTER a successful push", async () => {
    // Ordering matters in both directions. Closing before the push would
    // mark work done that never left the machine; not closing after it is
    // the stale-open bug that froze the backlog for four days.
    const order: string[] = [];
    pushMod.pushToTarget.mockImplementation(async () => {
      order.push("push");
      return { pushed: true, branch: "main" };
    });
    journal.markBacklogItemDone.mockImplementation(async () => {
      order.push("markDone");
    });
    runProducedACommit();

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(order).toEqual(["push", "markDone"]);
  });

  it("does NOT close the backlog item when the push fails", async () => {
    runProducedACommit();
    pushMod.pushToTarget.mockResolvedValue({
      pushed: false,
      branch: "main",
      reason: "remote rejected",
    });

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(journal.markBacklogItemDone).not.toHaveBeenCalled();
    expect(journal.closeBacklogItemsByIds).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("failed");
  });

  it("holds every run for approval under manual mode, clean diff or not", async () => {
    runProducedACommit();

    await executeRun(
      mkCfg("manual"),
      mkAdapter({ classifyDanger: () => [] }),
      mkPick(),
      OK_BUDGET,
    );

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("awaiting-approval");
  });

  it("pushes through an advisory-only hit, and still records it", async () => {
    // The critical/advisory split is the reason unattended auto-push is
    // workable. If advisory hits blocked, the operator would face a queue
    // of "diff is large" cards and start clearing them unread.
    runProducedACommit();

    await executeRun(
      mkCfg("auto"),
      mkAdapter({ classifyDanger: () => [ADVISORY_HIT] }),
      mkPick(),
      OK_BUDGET,
    );

    expect(pushMod.pushToTarget).toHaveBeenCalledTimes(1);
    expect(terminalStatus()).toBe("shipped");
    // Recorded on the run even though it did not block, so the dashboard
    // can surface it.
    const decisionEvent = journal.appendEvent.mock.calls.find(
      (c) => (c[2] as { kind?: string } | undefined)?.kind === "push_decision",
    );
    expect(
      (decisionEvent?.[2] as { dangerReasons?: DangerReason[] })?.dangerReasons,
    ).toEqual([ADVISORY_HIT]);
  });

  it("never reaches the push gate when the run produced no commit", async () => {
    // HEAD unchanged means the session did nothing. Pushing here would at
    // best be a no-op and at worst ship someone else's uncommitted work.
    git.headSha.mockResolvedValue("base-sha");
    runner.runTask.mockResolvedValue({
      exitCode: 0,
      durationMs: 10,
      sessionId: "s",
      toolUses: 0,
      bytesIn: 0,
      bytesOut: 0,
      outputTokens: 0,
      toolUseCapHit: false,
      tokenCapHit: false,
    });

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(pushMod.runPreflight).not.toHaveBeenCalled();
    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
  });

  it("never reaches the push gate when the session exits non-zero", async () => {
    git.headSha
      .mockResolvedValueOnce("base-sha")
      .mockResolvedValueOnce("head-sha");
    runner.runTask.mockResolvedValue({
      exitCode: 1,
      durationMs: 10,
      toolUses: 0,
      bytesIn: 0,
      bytesOut: 0,
      outputTokens: 0,
      toolUseCapHit: false,
      tokenCapHit: false,
    });

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(terminalStatus()).toBe("failed");
  });

  it("runs preflight before deciding, not after", async () => {
    // decidePush reads the preflight result, so a reordering that decided
    // first would evaluate a stale or empty result.
    const order: string[] = [];
    pushMod.runPreflight.mockImplementation(async () => {
      order.push("preflight");
      return { ok: true, failures: [] };
    });
    pushMod.pushToTarget.mockImplementation(async () => {
      order.push("push");
      return { pushed: true, branch: "main" };
    });
    runProducedACommit();

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(order).toEqual(["preflight", "push"]);
  });
});

// ------------------------------------------------------- tick ordering

describe("tick gate ordering", () => {
  it("ships approved runs before consulting the budget", async () => {
    // Deliberate: a push spends no tokens. An operator's explicit approval
    // should not sit unexecuted because the bot is near a cap it is not
    // about to touch. Asserted by driving a budget that stops the tick and
    // confirming the approved-run pickup still happened.
    const totals = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };
    budgetMod.decideBudget.mockReturnValue({
      gate: "stop",
      worstRatio: 1.2,
      fiveHr: { ...totals },
      sevenD: { ...totals },
      caps: mkCfg().caps,
    });
    journal.findApprovedRuns.mockResolvedValue([]);

    await tick(mkCfg(), [mkAdapter()], { dryRun: false });

    expect(journal.findApprovedRuns).toHaveBeenCalled();
    // And the tick did stop there: no task was picked.
    expect(queueMod.pickNext).not.toHaveBeenCalled();
  });

  it("releases the tick lock even when the run throws", async () => {
    // The lock is a file. A tick that throws past its release strands it
    // and the bot silently stops working until someone deletes it by hand.
    queueMod.pickNext.mockResolvedValue({
      ...mkPick(),
      project: "ocean-bot",
    });
    runner.runTask.mockRejectedValue(new Error("spawn exploded"));
    git.headSha.mockResolvedValue("base-sha");

    await expect(
      tick(mkCfg(), [mkAdapter()], { dryRun: false }),
    ).rejects.toThrow(/spawn exploded/);

    expect(runner.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when a previous tick still holds the lock", async () => {
    runner.acquireLock.mockResolvedValue(false);

    await tick(mkCfg(), [mkAdapter()], { dryRun: false });

    expect(queueMod.pickNext).not.toHaveBeenCalled();
    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    // And it must NOT release a lock it never acquired, which would hand
    // the still-running tick's lock away to the next one.
    expect(runner.releaseLock).not.toHaveBeenCalled();
  });

  it("skips before picking a task when the working tree is dirty", async () => {
    // The operator is mid-edit. Building on top of a half-finished change
    // is how the bot and the human end up fighting over the same tree.
    queueMod.pickNext.mockResolvedValue({ ...mkPick(), project: "ocean-bot" });
    git.isClean.mockResolvedValue(false);
    git.fileLastModified.mockResolvedValue(Date.now());

    await tick(mkCfg(), [mkAdapter()], { dryRun: false });

    expect(runner.runTask).not.toHaveBeenCalled();
    expect(runner.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn anything in dry-run mode", async () => {
    queueMod.pickNext.mockResolvedValue({ ...mkPick(), project: "ocean-bot" });

    await tick(mkCfg(), [mkAdapter()], { dryRun: true });

    expect(runner.runTask).not.toHaveBeenCalled();
    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    expect(runner.releaseLock).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------- rate-limit backoff

describe("rate-limit backoff", () => {
  describe("the tick gate that honors an active pause", () => {
    it("skips the whole tick while the backoff window is open", async () => {
      journal.getRateLimitPause.mockResolvedValue({
        pausedAt: Date.now() - 60_000,
        reason: "429",
        resumeAfter: Date.now() + 30 * 60_000,
      });

      await tick(mkCfg(), [mkAdapter()], { dryRun: false });

      expect(queueMod.pickNext).not.toHaveBeenCalled();
      expect(runner.runTask).not.toHaveBeenCalled();
      // Still released: the gate sits inside the try/finally.
      expect(runner.releaseLock).toHaveBeenCalledTimes(1);
    });

    it("does not clear a pause that is still in force", async () => {
      // Clearing early would resume straight into the same 429 and burn
      // another request against a limit that has not reset.
      journal.getRateLimitPause.mockResolvedValue({
        pausedAt: Date.now(),
        reason: "429",
        resumeAfter: Date.now() + 30 * 60_000,
      });

      await tick(mkCfg(), [mkAdapter()], { dryRun: false });

      expect(journal.clearRateLimitPause).not.toHaveBeenCalled();
    });

    it("auto-resumes once the window has elapsed", async () => {
      // The bot has to recover without the operator. An expired key that
      // never gets cleared is an indefinite outage that looks like a
      // healthy idle loop.
      journal.getRateLimitPause.mockResolvedValue({
        pausedAt: Date.now() - 2 * 60 * 60_000,
        reason: "429",
        resumeAfter: Date.now() - 1000,
      });

      await tick(mkCfg(), [mkAdapter()], { dryRun: false });

      expect(journal.clearRateLimitPause).toHaveBeenCalledTimes(1);
      // And the tick carried on rather than returning after the cleanup.
      expect(queueMod.pickNext).toHaveBeenCalled();
    });

    it("touches nothing when no pause is recorded", async () => {
      journal.getRateLimitPause.mockResolvedValue(null);

      await tick(mkCfg(), [mkAdapter()], { dryRun: false });

      expect(journal.clearRateLimitPause).not.toHaveBeenCalled();
      expect(queueMod.pickNext).toHaveBeenCalled();
    });
  });

  describe("the run path that sets a pause", () => {
    it("backs off one hour on a generic 429", async () => {
      runner.runTask.mockResolvedValue(rateLimited(undefined));

      await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

      expect(journal.setRateLimitPause).toHaveBeenCalledTimes(1);
      const pause = journal.setRateLimitPause.mock.calls[0]?.[0] as {
        pausedAt: number;
        resumeAfter: number;
        reason: string;
      };
      // Asserted as a delta so the test does not depend on the clock.
      expect(pause.resumeAfter - pause.pausedAt).toBe(ONE_HOUR_MS);
      expect(pause.reason).toBe("429");
    });

    it("backs off six hours when credits are exhausted", async () => {
      // The distinction is the point. A 429 sheds load and clears in
      // minutes; an exhausted credit pool does not refill on its own, and
      // retrying hourly just burns whatever balance is left before the
      // operator can top it up.
      runner.runTask.mockResolvedValue(rateLimited("credits-exhausted"));

      await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

      const pause = journal.setRateLimitPause.mock.calls[0]?.[0] as {
        pausedAt: number;
        resumeAfter: number;
        reason: string;
      };
      expect(pause.resumeAfter - pause.pausedAt).toBe(SIX_HOURS_MS);
      expect(pause.reason).toBe("credits-exhausted");
      expect(pause.resumeAfter - pause.pausedAt).not.toBe(ONE_HOUR_MS);
    });

    it("records the rate limit in history with its run id", async () => {
      // /budget renders this to show how often the bot is hitting limits.
      runner.runTask.mockResolvedValue(rateLimited("credits-exhausted"));

      await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

      expect(journal.appendRateLimitHistory).toHaveBeenCalledTimes(1);
      const entry = journal.appendRateLimitHistory.mock.calls[0]?.[0] as {
        reason: string;
        runId: string;
      };
      expect(entry.reason).toBe("credits-exhausted");
      expect(entry.runId).toBeTruthy();
    });

    it("marks the run failed and never reaches the push gate", async () => {
      runner.runTask.mockResolvedValue(rateLimited("429"));

      await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

      expect(terminalStatus()).toBe("failed");
      expect(pushMod.runPreflight).not.toHaveBeenCalled();
      expect(pushMod.pushToTarget).not.toHaveBeenCalled();
    });

    it("does NOT pause the bot for an ordinary failure", async () => {
      // The negative case matters more than the positives here. Pausing on
      // every non-zero exit would idle the bot for an hour over one failing
      // test run.
      runner.runTask.mockResolvedValue({
        exitCode: 1,
        durationMs: 500,
        toolUses: 2,
        bytesIn: 0,
        bytesOut: 0,
        outputTokens: 0,
        toolUseCapHit: false,
        tokenCapHit: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

      expect(terminalStatus()).toBe("failed");
      expect(journal.setRateLimitPause).not.toHaveBeenCalled();
      expect(journal.appendRateLimitHistory).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------- scout handoff

describe("scout and resolver handoff", () => {
  it("does not scout a short, simple task", async () => {
    // The scout costs a Haiku call per run. Spending it on "fix a typo"
    // is pure overhead.
    runProducedACommit();

    await executeRun(mkCfg("auto"), mkAdapter(), mkPick(), OK_BUDGET);

    expect(scoutMod.scoutTask).not.toHaveBeenCalled();
    expect(runner.runTask).toHaveBeenCalledTimes(1);
  });

  it("scouts a complex task with a long description", async () => {
    runProducedACommit();

    await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

    expect(scoutMod.scoutTask).toHaveBeenCalledTimes(1);
  });

  it("skips the resolver when the scout raises no warnings", async () => {
    // The resolver is a Sonnet call. It should only run when there is
    // something to triage.
    runProducedACommit();
    scoutMod.scoutTask.mockResolvedValue({
      result: { model: "sonnet", estimatedTurns: 3, scopeWarnings: [] },
      hasScopeWarnings: false,
      failure: null,
      cached: false,
    });

    await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

    expect(resolverMod.resolveScoutScope).not.toHaveBeenCalled();
    expect(runner.runTask).toHaveBeenCalledTimes(1);
  });

  describe("when the scout raises warnings", () => {
    beforeEach(() => {
      scoutMod.scoutTask.mockResolvedValue({
        result: {
          model: "opus",
          estimatedTurns: 12,
          scopeWarnings: ["unbounded refactor", "ambiguous target"],
        },
        hasScopeWarnings: true,
        failure: null,
        cached: false,
      });
    });

    it("goes straight to approval under manual mode, without paying for a resolver", async () => {
      await executeRun(mkCfg("manual"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      expect(resolverMod.resolveScoutScope).not.toHaveBeenCalled();
      expect(runner.runTask).not.toHaveBeenCalled();
      expect(terminalStatus()).toBe("awaiting-approval");
    });

    it("skip: fails with the dedup-prefixed blocker and never spawns", async () => {
      // The "no commit produced" prefix is load-bearing, not cosmetic:
      // recentlyNoopTaskIds matches on it to keep the picker from
      // re-selecting this task on the very next tick.
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: { verdict: "skip", explanation: "dependency not ready" },
        failure: null,
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      expect(runner.runTask).not.toHaveBeenCalled();
      expect(terminalStatus()).toBe("failed");
      const fields = journal.setRunFields.mock.calls.at(-1)?.[1] as {
        blocker?: string;
      };
      expect(fields.blocker).toMatch(/^no commit produced/);
      expect(fields.blocker).toMatch(/dependency not ready/);
    });

    it("escalate: holds for approval and never spawns", async () => {
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: { verdict: "escalate", explanation: "product direction call" },
        failure: null,
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      expect(runner.runTask).not.toHaveBeenCalled();
      expect(terminalStatus()).toBe("awaiting-approval");
      expect(journal.blockBacklogItemForOperatorAction).not.toHaveBeenCalled();
    });

    it("block: fails the run AND flips the backlog item, with the prefix stripped", async () => {
      // Distinct from escalate on purpose. A blocked item has no Ship/Skip
      // decision for an operator to make, so it belongs in the backlog's
      // blocked section rather than on the approvals queue.
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: { verdict: "block", explanation: "needs browser auth" },
        failure: null,
        cached: false,
      });

      await executeRun(
        mkCfg("auto"),
        mkAdapter(),
        mkComplexPick({ taskId: "backlog:item-42" }),
        OK_BUDGET,
      );

      expect(runner.runTask).not.toHaveBeenCalled();
      expect(terminalStatus()).toBe("failed");
      expect(journal.blockBacklogItemForOperatorAction).toHaveBeenCalledTimes(1);
      const [backlogId, meta] =
        journal.blockBacklogItemForOperatorAction.mock.calls[0] ?? [];
      // The row id, not the queue-prefixed taskId.
      expect(backlogId).toBe("item-42");
      expect((meta as { reason?: string })?.reason).toBe("needs browser auth");
    });

    it("block: does not try to flip a non-backlog pick", async () => {
      // Creative and refactor picks have no backlog row behind them.
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: { verdict: "block", explanation: "needs browser auth" },
        failure: null,
        cached: false,
      });

      await executeRun(
        mkCfg("auto"),
        mkAdapter(),
        mkComplexPick({ taskId: "creative:abc123" }),
        OK_BUDGET,
      );

      expect(terminalStatus()).toBe("failed");
      expect(journal.blockBacklogItemForOperatorAction).not.toHaveBeenCalled();
    });

    it("proceed: falls through and spawns the run", async () => {
      // The proceed branch works by NOT returning. A future verdict added
      // without its own return would silently inherit this fall-through.
      runProducedACommit();
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: { verdict: "proceed", explanation: "technical scope only" },
        failure: null,
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      expect(runner.runTask).toHaveBeenCalledTimes(1);
    });

    it("proceed: a clarified scope replaces the prompt the run receives", async () => {
      runProducedACommit();
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: {
          verdict: "proceed",
          explanation: "narrowed",
          clarifiedScope: "rename publisher.ts only, leave callers alone",
        },
        failure: null,
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      const spawned = runner.runTask.mock.calls[0]?.[0] as { prompt: string };
      expect(spawned.prompt).toBe("rename publisher.ts only, leave callers alone");
    });

    it("proceed: acceptance criteria wrap the prompt in a capped goal", async () => {
      // Uses the real applyGoalWrapper, so this pins the envelope the
      // per-turn evaluator actually receives, not a stub's idea of it.
      runProducedACommit();
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: {
          verdict: "proceed",
          explanation: "narrowed",
          acceptanceCriteria: "npm test passes",
        },
        failure: null,
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      const spawned = runner.runTask.mock.calls[0]?.[0] as { prompt: string };
      expect(spawned.prompt).toMatch(/^\/goal npm test passes or stop after 5 turns/);
      // The original task text survives after the envelope.
      expect(spawned.prompt).toMatch(/migrate the publisher layer/);
    });

    it("a resolver failure escalates rather than proceeding", async () => {
      // The fail-safe. An unparseable or timed-out resolver must not be
      // read as permission to run: an operator is more annoyed by a
      // needless approval click than by a missed safety net. Uses the real
      // fallbackOnFailure.
      resolverMod.resolveScoutScope.mockResolvedValue({
        result: null,
        failure: "resolver timed out after 60s",
        cached: false,
      });

      await executeRun(mkCfg("auto"), mkAdapter(), mkComplexPick(), OK_BUDGET);

      expect(runner.runTask).not.toHaveBeenCalled();
      expect(terminalStatus()).toBe("awaiting-approval");
      const fields = journal.setRunFields.mock.calls.at(-1)?.[1] as {
        blocker?: string;
      };
      expect(fields.blocker).toMatch(/resolver timed out after 60s/);
    });
  });
});

// --------------------------------------------------- pushApprovedRuns

describe("pushApprovedRuns", () => {
  it("does nothing when there is nothing approved", async () => {
    journal.findApprovedRuns.mockResolvedValue([]);

    await pushApprovedRuns(mkAdapter());

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
  });

  it("ignores approved runs belonging to another project", async () => {
    // Adapters are per-project and the query is by name, but the loop
    // re-checks. Pushing another project's commit from this adapter's
    // rootDir would push the wrong repository.
    journal.findApprovedRuns.mockResolvedValue([
      {
        id: "r1",
        project: "some-other-project",
        branch: "main",
        commitSha: "abc123",
        metadata: {},
      },
    ]);

    await pushApprovedRuns(mkAdapter());

    expect(pushMod.pushToTarget).not.toHaveBeenCalled();
  });
});
