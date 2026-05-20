// Integration tests for phantom-row cleanup. Same gating as
// journal.test.ts: skipped unless OCEAN_BOT_TEST_DATABASE_URL is set.

import { describe, it, expect, beforeEach, afterAll } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

import * as journal from "./journal.js";
import * as dbMod from "./db/index.js";
import {
  maybeRunPhantomCleanup,
  PHANTOM_CLEANUP_STATE_KEY,
} from "./phantom-cleanup.js";

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

interface PhantomSeed {
  id: string;
  endedAgoMs: number;
  blocker?: string | null;
}

async function seedPhantom(seed: PhantomSeed): Promise<void> {
  const started = new Date(Date.now() - seed.endedAgoMs - 5 * 60 * 1000);
  const ended = new Date(Date.now() - seed.endedAgoMs);
  await journal.createRun({
    id: seed.id,
    project: "code2wiki",
    queue: "roadmap",
    taskSummary: "phantom",
    status: "shipped",
    approvalMode: "auto",
    pushState: "local",
    startedAt: started,
    endedAt: ended,
    blocker: seed.blocker ?? null,
    metadata: { taskId: `task:${seed.id}` },
  });
}

async function seedHealthy(id: string): Promise<void> {
  await journal.createRun({
    id,
    project: "code2wiki",
    queue: "bug-fix",
    taskSummary: "healthy",
    status: "shipped",
    approvalMode: "auto",
    branch: "main",
    commitSha: "abc1234",
    pushState: "pushed",
    startedAt: new Date(Date.now() - 60 * 60 * 1000),
    endedAt: new Date(Date.now() - 59 * 60 * 1000),
    metadata: { taskId: `task:${id}` },
  });
}

async function statusOf(id: string): Promise<{
  status: string;
  blocker: string | null;
} | null> {
  const db = dbMod.getDb();
  const { eq } = await import("drizzle-orm");
  const rows = await db
    .select({
      status: dbMod.schema.oceanBotRun.status,
      blocker: dbMod.schema.oceanBotRun.blocker,
    })
    .from(dbMod.schema.oceanBotRun)
    .where(eq(dbMod.schema.oceanBotRun.id, id))
    .limit(1);
  return rows[0] ?? null;
}

D("journal.cleanupPhantomRuns", () => {
  beforeEach(truncate);

  it("flips eligible phantoms; leaves grace-window and healthy rows alone", async () => {
    // 5 phantoms older than grace window (2h ago)
    for (let i = 0; i < 5; i++) {
      await seedPhantom({ id: `P-old-${i}`, endedAgoMs: 2 * 60 * 60 * 1000 });
    }
    // 2 phantoms within the grace window (10min ago)
    for (let i = 0; i < 2; i++) {
      await seedPhantom({ id: `P-fresh-${i}`, endedAgoMs: 10 * 60 * 1000 });
    }
    // 3 healthy shipped runs
    for (let i = 0; i < 3; i++) {
      await seedHealthy(`H-${i}`);
    }

    const result = await journal.cleanupPhantomRuns();
    expect(result.flipped).toBe(5);
    expect(result.runIds.sort()).toEqual([
      "P-old-0",
      "P-old-1",
      "P-old-2",
      "P-old-3",
      "P-old-4",
    ]);

    for (let i = 0; i < 5; i++) {
      const r = await statusOf(`P-old-${i}`);
      expect(r?.status).toBe("failed");
    }
    for (let i = 0; i < 2; i++) {
      const r = await statusOf(`P-fresh-${i}`);
      expect(r?.status).toBe("shipped");
    }
    for (let i = 0; i < 3; i++) {
      const r = await statusOf(`H-${i}`);
      expect(r?.status).toBe("shipped");
    }
  });

  it("preserves existing blocker via COALESCE", async () => {
    await seedPhantom({
      id: "P-blocker",
      endedAgoMs: 2 * 60 * 60 * 1000,
      blocker: "no commit produced (no-op task)",
    });
    await journal.cleanupPhantomRuns();
    const r = await statusOf("P-blocker");
    expect(r?.status).toBe("failed");
    expect(r?.blocker).toBe("no commit produced (no-op task)");
  });

  it("stamps auto-cleanup blocker only when none exists", async () => {
    await seedPhantom({
      id: "P-noblocker",
      endedAgoMs: 2 * 60 * 60 * 1000,
      blocker: null,
    });
    await journal.cleanupPhantomRuns();
    const r = await statusOf("P-noblocker");
    expect(r?.status).toBe("failed");
    expect(r?.blocker).toContain("auto-cleanup");
  });

  it("ignores runs missing any phantom predicate (commit_sha set)", async () => {
    await journal.createRun({
      id: "P-withcommit",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      pushState: "local",
      commitSha: "abc1234",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      endedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const result = await journal.cleanupPhantomRuns();
    expect(result.flipped).toBe(0);
    const r = await statusOf("P-withcommit");
    expect(r?.status).toBe("shipped");
  });

  it("ignores rows whose ended_at is NULL (still running)", async () => {
    await journal.createRun({
      id: "P-noended",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      pushState: "local",
      startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    const result = await journal.cleanupPhantomRuns();
    expect(result.flipped).toBe(0);
  });
});

D("journal.phantomRowCount", () => {
  beforeEach(truncate);

  it("counts only current phantoms in the lookback window", async () => {
    await seedPhantom({ id: "P-a", endedAgoMs: 60 * 60 * 1000 });
    await seedPhantom({ id: "P-b", endedAgoMs: 60 * 60 * 1000 });
    await seedHealthy("H-a");
    expect(await journal.phantomRowCount()).toBe(2);
    // After cleanup, none remain
    await journal.cleanupPhantomRuns();
    expect(await journal.phantomRowCount()).toBe(0);
  });

  it("ignores phantoms outside the lookback window", async () => {
    // started 10 days ago
    const long = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await journal.createRun({
      id: "P-ancient",
      project: "code2wiki",
      queue: "roadmap",
      taskSummary: "x",
      status: "shipped",
      approvalMode: "auto",
      pushState: "local",
      startedAt: long,
      endedAt: long,
      metadata: { taskId: "x" },
    });
    expect(await journal.phantomRowCount(7)).toBe(0);
  });
});

D("maybeRunPhantomCleanup", () => {
  beforeEach(truncate);

  it("runs on first call when state is empty", async () => {
    await seedPhantom({ id: "P1", endedAgoMs: 2 * 60 * 60 * 1000 });
    const state = await maybeRunPhantomCleanup();
    expect(state).not.toBeNull();
    expect(state?.flipped).toBe(1);
    const r = await statusOf("P1");
    expect(r?.status).toBe("failed");

    const persisted = await journal.getState(PHANTOM_CLEANUP_STATE_KEY);
    expect(persisted).toMatchObject({ flipped: 1 });
  });

  it("skips when last run is within the interval", async () => {
    await seedPhantom({ id: "P2", endedAgoMs: 2 * 60 * 60 * 1000 });
    const first = await maybeRunPhantomCleanup();
    expect(first?.flipped).toBe(1);

    // Re-seed a fresh phantom; gate should skip the second call.
    await seedPhantom({ id: "P3", endedAgoMs: 2 * 60 * 60 * 1000 });
    const second = await maybeRunPhantomCleanup();
    expect(second).toBeNull();

    const r = await statusOf("P3");
    expect(r?.status).toBe("shipped"); // not yet flipped
  });

  it("re-runs after the interval elapses", async () => {
    await seedPhantom({ id: "P4", endedAgoMs: 2 * 60 * 60 * 1000 });
    const first = await maybeRunPhantomCleanup({ now: Date.now() });
    expect(first?.flipped).toBe(1);

    await seedPhantom({ id: "P5", endedAgoMs: 2 * 60 * 60 * 1000 });
    const second = await maybeRunPhantomCleanup({
      now: Date.now() + 25 * 60 * 60 * 1000,
    });
    expect(second?.flipped).toBe(1);
    const r = await statusOf("P5");
    expect(r?.status).toBe("failed");
  });
});
