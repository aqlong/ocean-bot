import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  ProjectAdapter,
  DiffSummary,
  DangerReason,
} from "./adapters/types.js";
import type { BotConfig, ApprovalMode } from "./config.js";
import type { PreflightResult, PushResult } from "./push.js";
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
  blockBacklogItemForOperatorAction: vi.fn(async () => {}),
  countOrphanFailuresForTaskId: vi.fn(async () => 0),
  blockBacklogItemForOrphanRetries: vi.fn(async () => {}),
  lastFailedModelForTaskId: vi.fn(async () => null),
  getFiveHrWindowStart: vi.fn(async () => null),
  setFiveHrWindowStart: vi.fn(async () => {}),
  clearFiveHrWindowStart: vi.fn(async () => {}),
  getLastSessionForProject: vi.fn(async () => null),
  setLastSessionForProject: vi.fn(async () => {}),
  getRateLimitPause: vi.fn(async () => null),
  clearRateLimitPause: vi.fn(async () => {}),
  setRateLimitPause: vi.fn(async () => {}),
  appendRateLimitHistory: vi.fn(async () => {}),
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
  } as ScoredCandidate;
}

const OK_BUDGET: BudgetDecision = { gate: "ok", worstRatio: 0.1 } as BudgetDecision;

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
