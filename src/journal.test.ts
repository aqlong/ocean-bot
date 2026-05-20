// Integration tests against a local Postgres test DB.
// Skipped automatically when OCEAN_BOT_TEST_DATABASE_URL isn't set.
//
// Local setup:
//   createdb ocean_bot_test
//   psql -d ocean_bot_test -f tools/ocean-bot/drizzle/0000_aspiring_tusk.sql
//   OCEAN_BOT_TEST_DATABASE_URL=postgres://you@localhost:5432/ocean_bot_test npm test

import { describe, it, expect, beforeEach, afterAll } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

// Point production-style env at the test DB BEFORE importing journal,
// journal.ts caches the pool on first call. (Set unconditionally so
// the import doesn't crash when TEST_URL is unset; the describe.skip
// gate prevents the queries from running.)
process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

import * as journal from "./journal.js";
import * as dbMod from "./db/index.js";

afterAll(async () => {
  if (!TEST_URL) return;
  await dbMod.closeDb();
});

async function truncate(): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    "TRUNCATE ocean_bot_event, ocean_bot_run, ocean_bot_usage, ocean_bot_state RESTART IDENTITY CASCADE;",
  );
  await c.end();
}

D("journal, createRun / setRunFields / appendEvent", () => {
  beforeEach(truncate);

  it("creates a run row + retrieves it via approvals/active queries", async () => {
    await journal.createRun({
      id: "01R1",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "fix the test",
      status: "awaiting-approval",
      approvalMode: "manual",
      branch: "main",
      startedAt: new Date(),
      metadata: { taskId: "bug:abc" },
    });
    const ids = await journal.activeTaskIds("code2wiki");
    expect(ids.has("bug:abc")).toBe(true);
  });

  it("activeTaskIds excludes shipped / failed / rejected", async () => {
    await journal.createRun({
      id: "01R2-pending",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "x",
      status: "awaiting-approval",
      approvalMode: "manual",
      startedAt: new Date(),
      metadata: { taskId: "bug:pending" },
    });
    await journal.createRun({
      id: "01R2-shipped",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "y",
      status: "shipped",
      approvalMode: "manual",
      startedAt: new Date(),
      metadata: { taskId: "bug:shipped" },
    });
    await journal.createRun({
      id: "01R2-running",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "z",
      status: "running",
      approvalMode: "manual",
      startedAt: new Date(),
      metadata: { taskId: "bug:running" },
    });
    const ids = await journal.activeTaskIds("code2wiki");
    expect(ids.has("bug:pending")).toBe(true);
    expect(ids.has("bug:running")).toBe(true);
    expect(ids.has("bug:shipped")).toBe(false);
  });

  it("activeTaskIds scopes per-project", async () => {
    await journal.createRun({
      id: "01R3-a",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "x",
      status: "awaiting-approval",
      approvalMode: "manual",
      startedAt: new Date(),
      metadata: { taskId: "bug:shared" },
    });
    await journal.createRun({
      id: "01R3-b",
      project: "cas",
      queue: "bug-fix",
      taskSummary: "x",
      status: "awaiting-approval",
      approvalMode: "manual",
      startedAt: new Date(),
      metadata: { taskId: "bug:shared" },
    });
    expect((await journal.activeTaskIds("code2wiki")).has("bug:shared")).toBe(true);
    expect((await journal.activeTaskIds("inference-audit")).has("bug:shared")).toBe(
      false,
    );
  });

  it("recentlyNoopTaskIds excludes a taskId whose latest run was a clean no-op", async () => {
    await journal.createRun({
      id: "01N1",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      branch: "main",
      pushState: "local",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: "no commit produced (no-op task)",
      metadata: { taskId: "roadmap:noop-recent" },
    });
    const ids = await journal.recentlyNoopTaskIds("code2wiki");
    expect(ids.has("roadmap:noop-recent")).toBe(true);
  });

  it("recentlyNoopTaskIds ignores no-ops older than the window", async () => {
    const oldNoop = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await journal.createRun({
      id: "01N2",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      branch: "main",
      pushState: "local",
      startedAt: oldNoop,
      endedAt: oldNoop,
      blocker: "no commit produced (no-op task)",
      metadata: { taskId: "roadmap:noop-old" },
    });
    const ids = await journal.recentlyNoopTaskIds("code2wiki");
    expect(ids.has("roadmap:noop-old")).toBe(false);
  });

  it("recentlyNoopTaskIds checks ONLY the latest run per taskId, a later shipped run clears exclusion", async () => {
    const earlier = new Date(Date.now() - 60 * 60 * 1000);
    const later = new Date(Date.now() - 5 * 60 * 1000);
    await journal.createRun({
      id: "01N3-earlier-noop",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      branch: "main",
      pushState: "local",
      startedAt: earlier,
      endedAt: earlier,
      blocker: "no commit produced (no-op task)",
      metadata: { taskId: "roadmap:resumed" },
    });
    await journal.createRun({
      id: "01N3-later-ship",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "y",
      status: "shipped",
      approvalMode: "auto",
      branch: "main",
      commitSha: "abc1234",
      pushState: "pushed",
      startedAt: later,
      endedAt: later,
      metadata: { taskId: "roadmap:resumed" },
    });
    const ids = await journal.recentlyNoopTaskIds("code2wiki");
    expect(ids.has("roadmap:resumed")).toBe(false);
  });

  it("recentlyNoopTaskIds does not match dirty-tree noop blockers", async () => {
    await journal.createRun({
      id: "01N4",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      branch: "main",
      pushState: "local",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker:
        "task left 3 files uncommitted; edits stashed at refs/ocean-bot/orphan-edits/01N4",
      metadata: { taskId: "roadmap:dirty-stash" },
    });
    const ids = await journal.recentlyNoopTaskIds("code2wiki");
    expect(ids.has("roadmap:dirty-stash")).toBe(false);
  });

  it("recentlyNoopTaskIds scopes per-project", async () => {
    await journal.createRun({
      id: "01N5",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      pushState: "local",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: "no commit produced (no-op task)",
      metadata: { taskId: "roadmap:scoped" },
    });
    expect(
      (await journal.recentlyNoopTaskIds("code2wiki")).has("roadmap:scoped"),
    ).toBe(true);
    expect(
      (await journal.recentlyNoopTaskIds("inference-audit")).has(
        "roadmap:scoped",
      ),
    ).toBe(false);
  });

  it("findApprovedRuns returns runs with status='approved'", async () => {
    await journal.createRun({
      id: "01R4",
      project: "code2wiki",
      queue: "gap-closure",
      taskSummary: "x",
      status: "approved",
      approvalMode: "manual",
      branch: "main",
      commitSha: "abc1234",
      startedAt: new Date(),
    });
    const approved = await journal.findApprovedRuns("code2wiki");
    expect(approved.length).toBe(1);
    expect(approved[0]?.id).toBe("01R4");
  });

  it("setRunFields updates without touching other columns", async () => {
    const started = new Date();
    await journal.createRun({
      id: "01R5",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "fix",
      status: "running",
      approvalMode: "manual",
      branch: "main",
      startedAt: started,
    });
    await journal.setRunFields("01R5", {
      status: "awaiting-approval",
      commitSha: "deadbeef0",
      pushState: "local",
    });
    const db = dbMod.getDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(dbMod.schema.oceanBotRun)
      .where(eq(dbMod.schema.oceanBotRun.id, "01R5"))
      .limit(1);
    const r = rows[0];
    expect(r?.status).toBe("awaiting-approval");
    expect(r?.commitSha).toBe("deadbeef0");
    expect(r?.pushState).toBe("local");
    expect(r?.branch).toBe("main"); // unchanged
    expect(r?.taskSummary).toBe("fix"); // unchanged
  });

  it("appendEvent persists payload jsonb", async () => {
    await journal.createRun({
      id: "01R6",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "x",
      status: "running",
      approvalMode: "manual",
      startedAt: new Date(),
    });
    await journal.appendEvent("01R6", "commit", {
      sha: "abc",
      files: ["a.ts"],
    });
    await journal.appendEvent("01R6", "push", { pushed: true });

    const db = dbMod.getDb();
    const { eq } = await import("drizzle-orm");
    const events = await db
      .select()
      .from(dbMod.schema.oceanBotEvent)
      .where(eq(dbMod.schema.oceanBotEvent.runId, "01R6"));
    expect(events.length).toBe(2);
    const types = events.map((e) => e.type).sort();
    expect(types).toEqual(["commit", "push"]);
  });

  it("setState + getState roundtrip via upsert", async () => {
    await journal.setState("paused", true);
    expect(await journal.getState<boolean>("paused")).toBe(true);
    await journal.setState("paused", false);
    expect(await journal.getState<boolean>("paused")).toBe(false);
  });

  it("getState returns null for missing keys", async () => {
    expect(await journal.getState("does-not-exist")).toBeNull();
  });

  it("setState handles structured values (object jsonb)", async () => {
    await journal.setState("budget", { gate: "ok", worstRatio: 0.42 });
    const v = (await journal.getState("budget")) as
      | { gate: string; worstRatio: number }
      | null;
    expect(v?.gate).toBe("ok");
    expect(v?.worstRatio).toBe(0.42);
  });

  it("appendEvent on non-existent run errors quietly (FK)", async () => {
    // FK enforcement means this should fail; journal logs but doesn't throw.
    await expect(
      journal.appendEvent("nonexistent-run-id", "message", { x: 1 }),
    ).resolves.toBeUndefined();
  });

  // ---- Budget 5hr-window state helpers (chunk 1 of budget-windows-align). --
  // Set/get/clear pin the JSON round-trip + DELETE semantics so chunk 2
  // (decideBudget consuming these) can lean on the contract.

  it("setFiveHrWindowStart + getFiveHrWindowStart roundtrips a unix-ms number", async () => {
    const ts = Date.UTC(2026, 4, 15, 12, 0, 0); // 2026-05-15T12:00:00Z
    await journal.setFiveHrWindowStart(ts);
    expect(await journal.getFiveHrWindowStart()).toBe(ts);
  });

  it("getFiveHrWindowStart returns null when no window has been stamped", async () => {
    expect(await journal.getFiveHrWindowStart()).toBeNull();
  });

  it("clearFiveHrWindowStart removes the row so subsequent get returns null", async () => {
    await journal.setFiveHrWindowStart(1_700_000_000_000);
    expect(await journal.getFiveHrWindowStart()).toBe(1_700_000_000_000);
    await journal.clearFiveHrWindowStart();
    expect(await journal.getFiveHrWindowStart()).toBeNull();
  });

  it("setFiveHrWindowStart is last-write-wins under concurrent overwrites", async () => {
    const a = 1_700_000_000_000;
    const b = 1_700_000_001_000;
    const c = 1_700_000_002_000;
    // All three race the same key; whichever lands last is what `get`
    // returns. Without onConflictDoUpdate (the underlying setState
    // primitive uses), the second insert would crash on the PK.
    await Promise.all([
      journal.setFiveHrWindowStart(a),
      journal.setFiveHrWindowStart(b),
      journal.setFiveHrWindowStart(c),
    ]);
    const got = await journal.getFiveHrWindowStart();
    expect([a, b, c]).toContain(got);
  });

  it("clearFiveHrWindowStart on an absent key is a no-op (idempotent)", async () => {
    await journal.clearFiveHrWindowStart();
    await journal.clearFiveHrWindowStart();
    expect(await journal.getFiveHrWindowStart()).toBeNull();
  });
});

async function truncateBacklog(): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    "TRUNCATE ocean_bot_backlog_item, ocean_bot_event, ocean_bot_run, ocean_bot_usage, ocean_bot_state RESTART IDENTITY CASCADE;",
  );
  await c.end();
}

async function seedBacklog(id: string, project = "code2wiki"): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  try {
    await c.query(
      `INSERT INTO ocean_bot_backlog_item
         (id, project, category, title, priority, status)
       VALUES ($1, $2, 'bug', $3, 1, 'open')`,
      [id, project, `seed ${id}`],
    );
  } finally {
    await c.end();
  }
}

const ORPHAN_BLOCKER = (sha: string, branch = "main"): string =>
  `approved commit ${sha} no longer reachable from ${branch} — branch was rebased / reset since approval`;

D("journal, countOrphanFailuresForTaskId / blockBacklogItemForOrphanRetries", () => {
  beforeEach(truncateBacklog);

  it("counts failed runs with an orphan blocker matching the taskId", async () => {
    await journal.createRun({
      id: "O1",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("abc1234"),
      metadata: { taskId: "backlog:item-1" },
    });
    await journal.createRun({
      id: "O2",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("def5678"),
      metadata: { taskId: "backlog:item-1" },
    });
    const { count, runIds } = await journal.countOrphanFailuresForTaskId(
      "code2wiki",
      "backlog:item-1",
    );
    expect(count).toBe(2);
    expect(runIds.sort()).toEqual(["O1", "O2"]);
  });

  it("ignores failed runs with a non-orphan blocker", async () => {
    await journal.createRun({
      id: "O3-orphan",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("abc1234"),
      metadata: { taskId: "backlog:item-2" },
    });
    await journal.createRun({
      id: "O3-other",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: "runner exit 1",
      metadata: { taskId: "backlog:item-2" },
    });
    const { count } = await journal.countOrphanFailuresForTaskId(
      "code2wiki",
      "backlog:item-2",
    );
    expect(count).toBe(1);
  });

  it("ignores runs older than the lookback window", async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await journal.createRun({
      id: "O4-old",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: old,
      endedAt: old,
      blocker: ORPHAN_BLOCKER("abc1234"),
      metadata: { taskId: "backlog:item-3" },
    });
    const { count } = await journal.countOrphanFailuresForTaskId(
      "code2wiki",
      "backlog:item-3",
    );
    expect(count).toBe(0);
  });

  it("ignores runs with a different taskId", async () => {
    await journal.createRun({
      id: "O5-self",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("abc1234"),
      metadata: { taskId: "backlog:wanted" },
    });
    await journal.createRun({
      id: "O5-other",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("def5678"),
      metadata: { taskId: "backlog:other" },
    });
    const { count, runIds } = await journal.countOrphanFailuresForTaskId(
      "code2wiki",
      "backlog:wanted",
    );
    expect(count).toBe(1);
    expect(runIds).toEqual(["O5-self"]);
  });

  it("scopes per project", async () => {
    await journal.createRun({
      id: "O6-c2w",
      project: "code2wiki",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("abc1234"),
      metadata: { taskId: "backlog:shared" },
    });
    await journal.createRun({
      id: "O6-cas",
      project: "cas",
      queue: "backlog",
      taskSummary: "x",
      status: "failed",
      approvalMode: "auto",
      startedAt: new Date(),
      endedAt: new Date(),
      blocker: ORPHAN_BLOCKER("def5678"),
      metadata: { taskId: "backlog:shared" },
    });
    expect(
      (
        await journal.countOrphanFailuresForTaskId("code2wiki", "backlog:shared")
      ).count,
    ).toBe(1);
    expect(
      (await journal.countOrphanFailuresForTaskId("cas", "backlog:shared")).count,
    ).toBe(1);
    expect(
      (
        await journal.countOrphanFailuresForTaskId(
          "inference-audit",
          "backlog:shared",
        )
      ).count,
    ).toBe(0);
  });

  it("blockBacklogItemForOrphanRetries flips status + stamps metadata", async () => {
    await seedBacklog("BLK1");
    await journal.blockBacklogItemForOrphanRetries("BLK1", {
      runIds: ["RUN-A", "RUN-B"],
      lastOrphanSha: "deadbee",
    });
    const db = dbMod.getDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(dbMod.schema.oceanBotBacklogItem)
      .where(eq(dbMod.schema.oceanBotBacklogItem.id, "BLK1"))
      .limit(1);
    const r = rows[0];
    expect(r?.status).toBe("blocked");
    const meta = r?.metadata as {
      auto_blocked_reason?: string;
      failed_runs?: string[];
      last_orphan_sha?: string;
      blocked_at?: string;
    } | null;
    expect(meta?.auto_blocked_reason).toBe("commit-reachability");
    expect(meta?.failed_runs).toEqual(["RUN-A", "RUN-B"]);
    expect(meta?.last_orphan_sha).toBe("deadbee");
    expect(typeof meta?.blocked_at).toBe("string");
  });

  it("blockBacklogItemForOrphanRetries preserves existing metadata keys", async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO ocean_bot_backlog_item
           (id, project, category, title, priority, status, metadata)
         VALUES ('BLK2', 'code2wiki', 'bug', 'pre-existing', 1, 'open', $1::jsonb)`,
        [JSON.stringify({ origin: "seed", priority_hint: "urgent" })],
      );
    } finally {
      await c.end();
    }
    await journal.blockBacklogItemForOrphanRetries("BLK2", {
      runIds: ["RUN-X"],
      lastOrphanSha: null,
    });
    const db = dbMod.getDb();
    const { eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(dbMod.schema.oceanBotBacklogItem)
      .where(eq(dbMod.schema.oceanBotBacklogItem.id, "BLK2"))
      .limit(1);
    const meta = rows[0]?.metadata as {
      origin?: string;
      priority_hint?: string;
      auto_blocked_reason?: string;
      failed_runs?: string[];
      last_orphan_sha?: string | null;
    } | null;
    expect(meta?.origin).toBe("seed");
    expect(meta?.priority_hint).toBe("urgent");
    expect(meta?.auto_blocked_reason).toBe("commit-reachability");
    expect(meta?.failed_runs).toEqual(["RUN-X"]);
    expect(meta?.last_orphan_sha).toBe(null);
  });
});

D("rate-limit pause state", () => {
  beforeEach(truncate);

  it("getRateLimitPause returns null when no state exists", async () => {
    expect(await journal.getRateLimitPause()).toBeNull();
  });

  it("setRateLimitPause + getRateLimitPause roundtrip both reason values", async () => {
    const now = Date.now();
    await journal.setRateLimitPause({
      pausedAt: now,
      reason: "429",
      resumeAfter: now + 3600_000,
    });
    const got = await journal.getRateLimitPause();
    expect(got).not.toBeNull();
    expect(got!.reason).toBe("429");
    expect(got!.pausedAt).toBe(now);
    expect(got!.resumeAfter).toBe(now + 3600_000);

    await journal.setRateLimitPause({
      pausedAt: now,
      reason: "credits-exhausted",
      resumeAfter: now + 21_600_000,
    });
    const got2 = await journal.getRateLimitPause();
    expect(got2!.reason).toBe("credits-exhausted");
  });

  it("clearRateLimitPause removes the key so subsequent reads return null", async () => {
    await journal.setRateLimitPause({
      pausedAt: Date.now(),
      reason: "429",
      resumeAfter: Date.now() + 3600_000,
    });
    await journal.clearRateLimitPause();
    expect(await journal.getRateLimitPause()).toBeNull();
  });
});

D("rate-limit history", () => {
  beforeEach(truncate);

  it("findRateLimitedHistory returns empty array when no history exists", async () => {
    expect(await journal.findRateLimitedHistory()).toEqual([]);
  });

  it("appendRateLimitHistory accumulates entries and they survive roundtrip", async () => {
    const now = Date.now();
    await journal.appendRateLimitHistory({ ts: now, reason: "429", runId: "R1" });
    await journal.appendRateLimitHistory({ ts: now + 1000, reason: "credits-exhausted" });
    const history = await journal.findRateLimitedHistory();
    expect(history).toHaveLength(2);
    expect(history[0]!.reason).toBe("429");
    expect(history[0]!.runId).toBe("R1");
    expect(history[1]!.reason).toBe("credits-exhausted");
    expect(history[1]!.runId).toBeUndefined();
  });

  it("appendRateLimitHistory prunes entries older than 24h on each write", async () => {
    const OLD = Date.now() - 25 * 60 * 60 * 1000; // 25h ago, outside window
    const RECENT = Date.now() - 60_000;
    await journal.appendRateLimitHistory({ ts: OLD, reason: "429", runId: "old" });
    await journal.appendRateLimitHistory({ ts: RECENT, reason: "429", runId: "recent" });
    const history = await journal.findRateLimitedHistory();
    expect(history.map((e) => e.runId)).not.toContain("old");
    expect(history.map((e) => e.runId)).toContain("recent");
  });

  it("findRateLimitedHistory respects a custom sinceMs window", async () => {
    const now = Date.now();
    await journal.appendRateLimitHistory({ ts: now - 120_000, reason: "429", runId: "2m" });
    await journal.appendRateLimitHistory({ ts: now - 30_000, reason: "429", runId: "30s" });
    // 1 minute window excludes the 2m-old entry
    const recent = await journal.findRateLimitedHistory(60_000);
    expect(recent.map((e) => e.runId)).not.toContain("2m");
    expect(recent.map((e) => e.runId)).toContain("30s");
  });
});
