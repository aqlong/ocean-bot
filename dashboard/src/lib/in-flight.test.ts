// Integration test against the ocean_bot_test DB. Mirrors the pattern in
// queries.test.ts: skipped automatically when OCEAN_BOT_TEST_DATABASE_URL
// isn't set. The resolver branches on three on-disk signals, all of which
// are easier to assert against real Postgres + jsonb than to fake.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

if (TEST_URL) process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL;

type InFlightModule = typeof import("./in-flight");
let inFlight: InFlightModule;

beforeAll(async () => {
  if (!TEST_URL) return;
  inFlight = await import("./in-flight");
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

async function seedState(key: string, value: unknown): Promise<void> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    `INSERT INTO ocean_bot_state (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
  await c.end();
}

async function seedRun(id: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    `INSERT INTO ocean_bot_run
     (id, project, queue, task_summary, status, approval_mode, started_at)
     VALUES ($1, 'code2wiki', $2, $3, $4, 'manual', NOW() - ($5 || ' seconds')::interval)`,
    [
      id,
      (extra["queue"] as string) ?? "bug-fix",
      (extra["taskSummary"] as string) ?? `summary for ${id}`,
      status,
      String((extra["ageSec"] as number) ?? 30),
    ],
  );
  await c.end();
}

D("in-flight: resolveInFlight", () => {
  beforeEach(truncate);

  it("returns idle when no current_run state and no awaiting rows", async () => {
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("idle");
  });

  it("returns idle when current_run was cleared to empty object (post-tick)", async () => {
    // The bot writes {} into current_run on tick-end (NOT NULL constraint
    // on the value column makes JS-null impossible). Resolver must treat
    // an empty / runId-less object identically to "no run".
    await seedState("current_run", {});
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("idle");
  });

  it("returns running when current_run is stamped AND a running row exists", async () => {
    const startedAt = new Date(Date.now() - 45_000).toISOString();
    await seedRun("01RUN", "running", { ageSec: 45 });
    await seedState("current_run", {
      runId: "01RUN",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "fix the test",
      model: "sonnet",
      startedAt,
      runnerPid: 1234,
      childPid: 5678,
    });
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("running");
    if (out.state === "running") {
      expect(out.run.runId).toBe("01RUN");
      expect(out.run.taskSummary).toBe("fix the test");
      expect(out.run.model).toBe("sonnet");
      expect(out.run.childPid).toBe(5678);
      expect(out.run.elapsedMs).toBeGreaterThan(0);
      expect(out.run.expectedTotalMs).toBe(5 * 60 * 1000);
    }
  });

  it("falls through to idle when current_run state references a no-longer-running row", async () => {
    // Simulates: bot wrote current_run, then crashed before clearing.
    // The run row was flipped to failed by an out-of-band cleanup.
    await seedRun("01STALE", "failed", { ageSec: 600 });
    await seedState("current_run", {
      runId: "01STALE",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "x",
      model: "sonnet",
      startedAt: new Date().toISOString(),
      runnerPid: 1,
      childPid: null,
    });
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("idle");
  });

  it("returns awaiting with the right count when no run is running but rows are awaiting", async () => {
    await seedRun("a1", "awaiting-approval", { ageSec: 10 });
    await seedRun("a2", "awaiting-approval", { ageSec: 20 });
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("awaiting");
    if (out.state === "awaiting") {
      expect(out.awaitingCount).toBe(2);
    }
  });

  it("computes nextTickAt from tick_meta in idle state", async () => {
    const lastEndedAt = new Date(Date.now() - 30_000).toISOString();
    await seedState("tick_meta", { lastEndedAt, intervalSec: 180 });
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("idle");
    if (out.state === "idle") {
      expect(out.lastTickEndedAt).toBe(lastEndedAt);
      expect(out.intervalSec).toBe(180);
      expect(out.nextTickAt).not.toBeNull();
      const next = Date.parse(out.nextTickAt!);
      const expected = Date.parse(lastEndedAt) + 180_000;
      expect(next).toBe(expected);
    }
  });

  it("running state takes precedence over awaiting", async () => {
    await seedRun("01RUN", "running", { ageSec: 5 });
    await seedRun("waiting", "awaiting-approval", { ageSec: 10 });
    await seedState("current_run", {
      runId: "01RUN",
      project: "code2wiki",
      queue: "bug-fix",
      taskSummary: "x",
      model: "haiku",
      startedAt: new Date().toISOString(),
      runnerPid: 1,
      childPid: null,
    });
    const out = await inFlight.resolveInFlight();
    expect(out.state).toBe("running");
  });
});
