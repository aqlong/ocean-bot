// Integration tests for health-sweep. Same gating as journal.test.ts:
// requires OCEAN_BOT_TEST_DATABASE_URL pointed at a disposable Postgres
// instance with the bot schema migrated. Skipped silently when the env
// var is absent (CI without a test DB stays green; nightly with a
// staging DB exercises the queries).

import { describe, it, expect, beforeEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

const sweep = await import("./health-sweep.js");

async function truncate(): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    "TRUNCATE ocean_bot_backlog_item, ocean_bot_event, ocean_bot_run, ocean_bot_usage, ocean_bot_state RESTART IDENTITY CASCADE;",
  );
  await c.end();
}

async function seedBacklog(
  id: string,
  status: "open" | "done" | "blocked" = "open",
  project = "code2wiki",
): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO ocean_bot_backlog_item
         (id, project, category, title, priority, status)
       VALUES ($1, $2, 'bug', $3, 1, $4)`,
      [id, project, `seed ${id}`, status],
    );
  } finally {
    await c.end();
  }
}

async function seedRun(args: {
  id: string;
  project?: string;
  status: "shipped" | "failed" | "approved";
  taskId?: string | null;
  commitSha?: string | null;
  blocker?: string | null;
  startedAt?: Date;
}): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  try {
    const project = args.project ?? "code2wiki";
    const startedAt = args.startedAt ?? new Date();
    const metadata = args.taskId ? JSON.stringify({ taskId: args.taskId }) : "{}";
    await c.query(
      `INSERT INTO ocean_bot_run
         (id, project, queue, task_summary, status, approval_mode,
          commit_sha, blocker, started_at, metadata)
       VALUES ($1, $2, 'backlog', 'seed', $3, 'auto',
               $4, $5, $6, $7::jsonb)`,
      [
        args.id,
        project,
        args.status,
        args.commitSha ?? null,
        args.blocker ?? null,
        startedAt,
        metadata,
      ],
    );
  } finally {
    await c.end();
  }
}

D("health-sweep.sweepStaleOpenBacklogItems", () => {
  beforeEach(truncate);

  it("closes a backlog item whose shipped run referenced it via taskId", async () => {
    await seedBacklog("orphan-1", "open");
    await seedRun({
      id: "RUN_A",
      status: "shipped",
      taskId: "backlog:orphan-1",
      commitSha: "abc123def",
    });

    const r = await sweep.sweepStaleOpenBacklogItems();
    expect(r.fixedCount).toBe(1);
    expect(r.fixedIds).toEqual(["orphan-1"]);

    // Idempotent: second run finds nothing.
    const r2 = await sweep.sweepStaleOpenBacklogItems();
    expect(r2.fixedCount).toBe(0);
  });

  it("ignores items already 'done' (no-op idempotent on the closed set)", async () => {
    await seedBacklog("already-done", "done");
    await seedRun({
      id: "RUN_B",
      status: "shipped",
      taskId: "backlog:already-done",
      commitSha: "f00ba12",
    });
    const r = await sweep.sweepStaleOpenBacklogItems();
    expect(r.fixedCount).toBe(0);
  });

  it("ignores shipped runs that have no commit_sha (real no-ops, not real ships)", async () => {
    await seedBacklog("noop-task", "open");
    // A noop run lands as status='shipped' with commit_sha=NULL and
    // a "no commit produced" blocker. Should NOT trip the sweep.
    await seedRun({
      id: "RUN_C",
      status: "shipped",
      taskId: "backlog:noop-task",
      commitSha: null,
      blocker: "no commit produced (no-op task)",
    });
    const r = await sweep.sweepStaleOpenBacklogItems();
    expect(r.fixedCount).toBe(0);
  });

  it("scopes the join to the run's project (cross-project safety)", async () => {
    // Item with the same id exists under both projects (defensive).
    // A shipped run in project=ocean-bot must NOT close the code2wiki
    // sibling.
    await seedBacklog("same-id", "open", "code2wiki");
    await seedBacklog("same-id", "open", "ocean-bot");
    await seedRun({
      id: "RUN_D",
      project: "ocean-bot",
      status: "shipped",
      taskId: "backlog:same-id",
      commitSha: "11ee22",
    });

    const r = await sweep.sweepStaleOpenBacklogItems();
    expect(r.fixedCount).toBe(1);
    expect(r.fixedIds).toEqual(["same-id"]);
    // The code2wiki sibling stays open.
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      const { rows } = await c.query(
        "SELECT status FROM ocean_bot_backlog_item WHERE id=$1 AND project=$2",
        ["same-id", "code2wiki"],
      );
      expect(rows[0]?.status).toBe("open");
    } finally {
      await c.end();
    }
  });

  it("closes multiple stale items in one pass", async () => {
    for (const id of ["stale-a", "stale-b", "stale-c"]) {
      await seedBacklog(id, "open");
      await seedRun({
        id: `RUN_${id}`,
        status: "shipped",
        taskId: `backlog:${id}`,
        commitSha: `sha-${id}`,
      });
    }
    const r = await sweep.sweepStaleOpenBacklogItems();
    expect(r.fixedCount).toBe(3);
    expect(r.fixedIds.sort()).toEqual(["stale-a", "stale-b", "stale-c"]);
  });
});

D("health-sweep.findStuckNoopTasks", () => {
  beforeEach(truncate);

  it("flags tasks that no-op'd >= threshold within the lookback", async () => {
    for (let i = 0; i < 4; i++) {
      await seedRun({
        id: `RUN_NOOP_${i}`,
        status: "shipped",
        taskId: "backlog:stuck-noop-task",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
        startedAt: new Date(Date.now() - i * 60 * 60 * 1000),
      });
    }
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.taskId).toBe("backlog:stuck-noop-task");
    expect(stuck[0]?.count).toBe(4);
  });

  it("does not flag tasks below threshold", async () => {
    for (let i = 0; i < 2; i++) {
      await seedRun({
        id: `RUN_OK_${i}`,
        status: "shipped",
        taskId: "backlog:occasional-noop",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
    }
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    expect(stuck).toHaveLength(0);
  });

  it("excludes runs outside the lookback window", async () => {
    // 5 no-ops, 4 of them > 7 days ago, 1 recent. Threshold 3 should NOT fire.
    for (let i = 0; i < 4; i++) {
      await seedRun({
        id: `RUN_OLD_${i}`,
        status: "shipped",
        taskId: "backlog:old-noop",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
        startedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });
    }
    await seedRun({
      id: "RUN_RECENT",
      status: "shipped",
      taskId: "backlog:old-noop",
      commitSha: null,
      blocker: "no commit produced (no-op task)",
    });
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    expect(stuck).toHaveLength(0);
  });

  it("groups by taskId AND project (same id under different projects = different groups)", async () => {
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_C2W_${i}`,
        project: "code2wiki",
        status: "shipped",
        taskId: "backlog:shared-id",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
      await seedRun({
        id: `RUN_OB_${i}`,
        project: "ocean-bot",
        status: "shipped",
        taskId: "backlog:shared-id",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
    }
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    expect(stuck).toHaveLength(2);
    const projects = stuck.map((s) => s.project).sort();
    expect(projects).toEqual(["code2wiki", "ocean-bot"]);
  });

  it("matches scout-resolver skip blockers (still 'no commit produced ...')", async () => {
    // The scout-resolver skip path writes:
    //   "no commit produced (scout-resolver skip: ...)"
    // which starts with "no commit produced" and should count toward
    // the stuck-noop threshold. A task the resolver keeps skipping is
    // exactly the class of operator-needed signal we want surfaced.
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_SR_${i}`,
        status: "shipped",
        taskId: "backlog:scout-resolver-skip-loop",
        commitSha: null,
        blocker: "no commit produced (scout-resolver skip: ambiguous)",
      });
    }
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    expect(stuck.map((s) => s.taskId)).toContain(
      "backlog:scout-resolver-skip-loop",
    );
  });

  it("excludes tasks whose backlog item is already status='done'", async () => {
    // Seed two backlog items + 3 no-op runs each:
    //   - one already done (should be SUPPRESSED, operator already closed it)
    //   - one still open (should still be FLAGGED, operator needs to act)
    // Plus a third run group with a taskId pointing at no backlog item
    // (operator-typed / non-backlog taskId, should still be FLAGGED).
    await seedBacklog("done-item", "done");
    await seedBacklog("open-item", "open");
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_DONE_${i}`,
        status: "shipped",
        taskId: "backlog:done-item",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
      await seedRun({
        id: `RUN_OPEN_${i}`,
        status: "shipped",
        taskId: "backlog:open-item",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
      await seedRun({
        id: `RUN_NONBACKLOG_${i}`,
        status: "shipped",
        taskId: "queue-0:orphan-task",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
    }
    const stuck = await sweep.findStuckNoopTasks(3, 7 * 24);
    const taskIds = stuck.map((s) => s.taskId).sort();
    expect(taskIds).toEqual(["backlog:open-item", "queue-0:orphan-task"]);
  });
});

D("health-sweep.findStuckPreflightFails", () => {
  beforeEach(truncate);

  it("flags tasks that preflight-failed >= threshold within the lookback", async () => {
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_PF_${i}`,
        status: "failed",
        taskId: "backlog:flaky-tests",
        commitSha: null,
        blocker: "Preflight failed: npm test",
      });
    }
    const stuck = await sweep.findStuckPreflightFails(3, 7 * 24);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.taskId).toBe("backlog:flaky-tests");
    expect(stuck[0]?.count).toBe(3);
  });

  it("does not flag noop blockers as preflight failures", async () => {
    for (let i = 0; i < 5; i++) {
      await seedRun({
        id: `RUN_NOOP_PF_${i}`,
        status: "shipped",
        taskId: "backlog:pure-noop",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
    }
    const stuck = await sweep.findStuckPreflightFails(3, 7 * 24);
    expect(stuck).toHaveLength(0);
  });

  it("excludes tasks whose backlog item is already status='done'", async () => {
    // Same exclusion class as findStuckNoopTasks: a closed backlog
    // item shouldn't keep surfacing as actionable even if its run
    // history shows preflight failures.
    await seedBacklog("pf-done", "done");
    await seedBacklog("pf-open", "open");
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_PF_DONE_${i}`,
        status: "failed",
        taskId: "backlog:pf-done",
        blocker: "Preflight failed: npm test",
      });
      await seedRun({
        id: `RUN_PF_OPEN_${i}`,
        status: "failed",
        taskId: "backlog:pf-open",
        blocker: "Preflight failed: npm test",
      });
    }
    const stuck = await sweep.findStuckPreflightFails(3, 7 * 24);
    expect(stuck.map((s) => s.taskId)).toEqual(["backlog:pf-open"]);
  });
});

D("health-sweep.runHealthSweep (orchestrator)", () => {
  beforeEach(truncate);

  it("runs all sweeps and writes a state row", async () => {
    // 1 stale-open backlog item to auto-fix.
    await seedBacklog("orchestrator-stale", "open");
    await seedRun({
      id: "RUN_ORCH_A",
      status: "shipped",
      taskId: "backlog:orchestrator-stale",
      commitSha: "abc",
    });
    // 3 no-ops on a different task, to trigger stuck-noop detection.
    for (let i = 0; i < 3; i++) {
      await seedRun({
        id: `RUN_ORCH_NOOP_${i}`,
        status: "shipped",
        taskId: "backlog:noop-loop-task",
        commitSha: null,
        blocker: "no commit produced (no-op task)",
      });
    }

    const state = await sweep.runHealthSweep();
    expect(state.stale.fixedCount).toBe(1);
    expect(state.stale.fixedIds).toEqual(["orchestrator-stale"]);
    expect(state.stuckNoop).toHaveLength(1);
    expect(state.stuckNoop[0]?.taskId).toBe("backlog:noop-loop-task");
    expect(state.stuckPreflight).toHaveLength(0);
    expect(state.ranAt).toBeTruthy();

    // State row written for /health dashboard to read.
    const journal = await import("./journal.js");
    const stored = await journal.getState<typeof state>(
      sweep.HEALTH_SWEEP_STATE_KEY,
    );
    expect(stored?.stale.fixedCount).toBe(1);
    expect(stored?.stuckNoop[0]?.taskId).toBe("backlog:noop-loop-task");
  });
});
