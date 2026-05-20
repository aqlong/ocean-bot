// Integration tests for dashboard queries against ocean_bot_test DB.
// Skipped automatically when OCEAN_BOT_TEST_DATABASE_URL isn't set.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

if (TEST_URL) process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL;

type QueriesModule = typeof import("./queries");
let queries: QueriesModule;

beforeAll(async () => {
  if (!TEST_URL) return;
  queries = await import("./queries");
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

async function seedRun(
  id: string,
  status: string,
  ageMin = 5,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    `INSERT INTO ocean_bot_run
     (id, project, queue, task_summary, status, approval_mode, started_at, danger_level)
     VALUES ($1, 'code2wiki', $2, $3, $4, 'manual', NOW() - ($5 || ' minutes')::interval, $6)`,
    [
      id,
      (extra["queue"] as string) ?? "bug-fix",
      (extra["taskSummary"] as string) ?? `summary for ${id}`,
      status,
      String(ageMin),
      (extra["dangerLevel"] as string) ?? "safe",
    ],
  );
  await c.end();
}

D("queries, summaryToday + summaryWeek", () => {
  beforeEach(truncate);

  it("tallies by status within the last 24h", async () => {
    await seedRun("r1", "shipped", 5);
    await seedRun("r2", "shipped", 10);
    await seedRun("r3", "awaiting-approval", 15);
    await seedRun("r4", "failed", 20);
    const out = await queries.summaryToday();
    expect(out.shipped).toBe(2);
    expect(out.awaitingApproval).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.total).toBe(4);
  });

  it("excludes runs older than 24h from summaryToday but counts in summaryWeek", async () => {
    await seedRun("old", "shipped", 60 * 30); // 30h
    await seedRun("recent", "shipped", 5);
    const today = await queries.summaryToday();
    const week = await queries.summaryWeek();
    expect(today.total).toBe(1);
    expect(week.total).toBe(2);
  });

  it("excludes runs older than 7d from summaryWeek", async () => {
    await seedRun("ancient", "shipped", 60 * 24 * 8); // 8 days old
    const week = await queries.summaryWeek();
    expect(week.total).toBe(0);
  });
});

D("queries, recentRuns + pendingApprovals + runById", () => {
  beforeEach(truncate);

  it("recentRuns returns newest-first up to limit", async () => {
    await seedRun("a", "shipped", 30);
    await seedRun("b", "shipped", 10);
    await seedRun("c", "shipped", 20);
    const runs = await queries.recentRuns(10);
    expect(runs.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("recentRuns derives outcome from commit_sha (null -> shipped-noop)", async () => {
    // Two shipped runs: one with a commit sha (real ship), one without
    // (no-op ship). The CASE expression in recentRuns should split them.
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query(
      `INSERT INTO ocean_bot_run
       (id, project, queue, task_summary, status, approval_mode, started_at, commit_sha)
       VALUES
         ('r-noop', 'code2wiki', 'roadmap', 'no-op task', 'shipped', 'auto', NOW() - INTERVAL '1 minute', NULL),
         ('r-ship', 'code2wiki', 'roadmap', 'real ship',  'shipped', 'auto', NOW() - INTERVAL '2 minutes', 'abc1234')`,
    );
    await c.end();
    const runs = await queries.recentRuns(10);
    const noop = runs.find((r) => r.id === "r-noop");
    const ship = runs.find((r) => r.id === "r-ship");
    expect(noop?.outcome).toBe("shipped-noop");
    expect(ship?.outcome).toBe("shipped");
  });

  it("lastShippedByProject groups by project and excludes noops (commit_sha NULL)", async () => {
    // Three projects in play; for each, mix commit-bearing ships,
    // noop ships, and a non-shipped row that should never appear.
    // Newest-first within each project.
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query(`
      INSERT INTO ocean_bot_run
        (id, project, queue, task_summary, status, approval_mode, started_at, commit_sha)
      VALUES
        -- code2wiki: 2 real ships + 1 noop
        ('c2w-ship-old',  'code2wiki', 'roadmap', 'older c2w ship', 'shipped', 'auto', NOW() - INTERVAL '10 minutes', 'aaa1111'),
        ('c2w-ship-new',  'code2wiki', 'roadmap', 'newer c2w ship', 'shipped', 'auto', NOW() - INTERVAL '2 minutes',  'bbb2222'),
        ('c2w-noop',      'code2wiki', 'roadmap', 'noop hidden',    'shipped', 'auto', NOW() - INTERVAL '1 minute',   NULL),
        -- ocean-bot: 1 real ship + 1 noop + 1 failed
        ('ob-ship',       'ocean-bot', 'backlog', 'ob real ship',   'shipped', 'auto', NOW() - INTERVAL '5 minutes',  'ccc3333'),
        ('ob-noop',       'ocean-bot', 'backlog', 'ob noop hidden', 'shipped', 'auto', NOW() - INTERVAL '4 minutes',  NULL),
        ('ob-failed',     'ocean-bot', 'backlog', 'ob failed',      'failed',  'auto', NOW() - INTERVAL '3 minutes',  'ddd4444'),
        -- cas: only noops + non-shipped, should NOT appear in result
        ('cas-noop',      'cas',       'roadmap', 'cas noop',       'shipped', 'auto', NOW() - INTERVAL '1 minute',   NULL),
        ('cas-pending',   'cas',       'roadmap', 'cas pending',    'awaiting-approval', 'manual', NOW() - INTERVAL '1 minute', 'eee5555')
    `);
    await c.end();

    const byProj = await queries.lastShippedByProject(5);
    // Only projects with at least one commit-bearing shipped run are keyed.
    expect(Object.keys(byProj).sort()).toEqual(["code2wiki", "ocean-bot"]);
    // code2wiki: newest-first, noop excluded
    expect(byProj["code2wiki"]?.map((r) => r.id)).toEqual([
      "c2w-ship-new",
      "c2w-ship-old",
    ]);
    expect(byProj["code2wiki"]?.every((r) => r.commitSha !== null)).toBe(true);
    // ocean-bot: failed row (with commit_sha) excluded because status != 'shipped';
    // noop excluded because commit_sha IS NULL
    expect(byProj["ocean-bot"]?.map((r) => r.id)).toEqual(["ob-ship"]);
    // cas never made the cut: noop + non-shipped only
    expect(byProj["cas"]).toBeUndefined();
  });

  it("pendingApprovals returns only awaiting-approval", async () => {
    await seedRun("ship", "shipped", 5);
    await seedRun("await", "awaiting-approval", 10);
    await seedRun("fail", "failed", 15);
    const pending = await queries.pendingApprovals();
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe("await");
  });

  it("runById returns matching row or null", async () => {
    await seedRun("hello", "shipped", 5);
    expect((await queries.runById("hello"))?.id).toBe("hello");
    expect(await queries.runById("nope")).toBeNull();
  });
});

D("queries, eventsForRun", () => {
  beforeEach(truncate);

  it("returns empty list for run with no events", async () => {
    await seedRun("solo", "shipped", 5);
    expect(await queries.eventsForRun("solo")).toEqual([]);
  });

  it("returns events ordered by ts ascending", async () => {
    await seedRun("withev", "shipped", 5);
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query(
      `INSERT INTO ocean_bot_event (run_id, type, payload, ts) VALUES
        ('withev', 'message', '{"kind":"init"}', NOW() - INTERVAL '2 minutes'),
        ('withev', 'tool_use', '{}', NOW() - INTERVAL '1 minute'),
        ('withev', 'commit', '{"sha":"abc"}', NOW())`,
    );
    await c.end();
    const events = await queries.eventsForRun("withev");
    expect(events.map((e) => e.type)).toEqual(["message", "tool_use", "commit"]);
  });
});

D("queries, botStateFlags + budgetState", () => {
  beforeEach(truncate);

  it("botStateFlags collects all state rows into a single object", async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query(
      `INSERT INTO ocean_bot_state (key, value) VALUES
        ('paused', 'true'::jsonb),
        ('global_approval_mode', '"manual"'::jsonb)`,
    );
    await c.end();
    const flags = await queries.botStateFlags();
    expect(flags["paused"]).toBe(true);
    expect(flags["global_approval_mode"]).toBe("manual");
  });

  it("botStateFlags returns {} when no state rows", async () => {
    expect(await queries.botStateFlags()).toEqual({});
  });

  it("pausedState returns paused + pausedSince from the paused row's updated_at", async () => {
    // No row → paused:false, pausedSince:null
    const empty = await queries.pausedState();
    expect(empty.paused).toBe(false);
    expect(empty.pausedSince).toBeNull();

    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    // Resumed state (value=false), paused:false, pausedSince:null
    await c.query(
      `INSERT INTO ocean_bot_state (key, value, updated_at)
       VALUES ('paused', 'false'::jsonb, NOW() - INTERVAL '1 hour')`,
    );
    const resumed = await queries.pausedState();
    expect(resumed.paused).toBe(false);
    expect(resumed.pausedSince).toBeNull();

    // Paused 90 minutes ago
    await c.query(
      `UPDATE ocean_bot_state
       SET value = 'true'::jsonb, updated_at = NOW() - INTERVAL '90 minutes'
       WHERE key = 'paused'`,
    );
    await c.end();
    const paused = await queries.pausedState();
    expect(paused.paused).toBe(true);
    expect(paused.pausedSince).toBeInstanceOf(Date);
    const ageMs = Date.now() - (paused.pausedSince?.getTime() ?? 0);
    expect(ageMs).toBeGreaterThan(89 * 60 * 1000);
    expect(ageMs).toBeLessThan(91 * 60 * 1000);
  });

  it("phantomRowCount counts rows matching the phantom signature", async () => {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    // Phantom: shipped+local+no commit+no decision
    await c.query(
      `INSERT INTO ocean_bot_run
       (id, project, queue, task_summary, status, approval_mode, started_at,
        push_state, commit_sha, user_decision)
       VALUES
         ('ph-1', 'code2wiki', 'roadmap', 'x', 'shipped', 'auto', NOW() - INTERVAL '2 hours', 'local', NULL, NULL),
         ('ph-2', 'code2wiki', 'roadmap', 'x', 'shipped', 'auto', NOW() - INTERVAL '3 hours', 'local', NULL, NULL),
         ('healthy', 'code2wiki', 'bug-fix', 'x', 'shipped', 'auto', NOW() - INTERVAL '2 hours', 'pushed', 'abc1234', NULL)`,
    );
    await c.end();
    expect(await queries.phantomRowCount(7)).toBe(2);
  });

  it("lastPhantomCleanupRun returns parsed state or null", async () => {
    expect(await queries.lastPhantomCleanupRun()).toBeNull();
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    const ranAt = new Date(Date.now() - 60 * 1000).toISOString();
    await c.query(
      `INSERT INTO ocean_bot_state (key, value) VALUES
        ('phantom_cleanup_last_run', $1::jsonb)`,
      [JSON.stringify({ ranAt, flipped: 3, runIds: ["a", "b", "c"] })],
    );
    await c.end();
    const last = await queries.lastPhantomCleanupRun();
    expect(last?.flipped).toBe(3);
    expect(last?.runIds).toEqual(["a", "b", "c"]);
    expect(last?.ranAt).toBeInstanceOf(Date);
  });

  it("budgetState returns the budget value or null", async () => {
    expect(await queries.budgetState()).toBeNull();
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query(
      `INSERT INTO ocean_bot_state (key, value) VALUES
        ('budget', '{"gate":"wait","worstRatio":0.91}'::jsonb)`,
    );
    await c.end();
    const v = (await queries.budgetState()) as {
      gate: string;
      worstRatio: number;
    } | null;
    expect(v?.gate).toBe("wait");
    expect(v?.worstRatio).toBe(0.91);
  });

  it("fiveHrWindowStart returns Date for a numeric stamp, null otherwise", async () => {
    // No row -> null
    expect(await queries.fiveHrWindowStart()).toBeNull();
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    const ts = Date.now() - 30 * 60 * 1000; // 30 min ago
    await c.query(
      `INSERT INTO ocean_bot_state (key, value) VALUES
        ('fiveHr_window_start_ts', $1::jsonb)`,
      [String(ts)],
    );
    const got = await queries.fiveHrWindowStart();
    expect(got).toBeInstanceOf(Date);
    expect(got?.getTime()).toBe(ts);

    // Garbage stored (e.g. older format) -> null, fail-soft
    await c.query(
      `UPDATE ocean_bot_state SET value = '"not-a-number"'::jsonb
       WHERE key = 'fiveHr_window_start_ts'`,
    );
    await c.end();
    expect(await queries.fiveHrWindowStart()).toBeNull();
  });
});

D("queries, listRuns paging", () => {
  beforeEach(truncate);

  it("returns all rows with hasMore=false when fewer than pageSize exist", async () => {
    await seedRun("a", "shipped", 30);
    await seedRun("b", "failed", 10);
    const { runs, hasMore } = await queries.listRuns({}, 1, 25);
    expect(runs.length).toBe(2);
    expect(hasMore).toBe(false);
    // newest first
    expect(runs[0]?.id).toBe("b");
    expect(runs[1]?.id).toBe("a");
  });

  it("sets hasMore=true and returns exactly pageSize rows when more exist", async () => {
    // Seed pageSize+1 rows so the query fetches pageSize+2 internally
    // and correctly identifies there are further rows beyond the page.
    for (let i = 0; i < 3; i++) {
      await seedRun(`r${i}`, "shipped", (i + 1) * 10);
    }
    const { runs, hasMore } = await queries.listRuns({}, 1, 2);
    expect(runs.length).toBe(2);
    expect(hasMore).toBe(true);
  });

  it("returns the correct offset slice on page 2", async () => {
    await seedRun("newest", "shipped", 5);
    await seedRun("middle", "shipped", 15);
    await seedRun("oldest", "shipped", 25);
    // page 1 with pageSize=2 → newest + middle, hasMore=true
    const page1 = await queries.listRuns({}, 1, 2);
    expect(page1.runs.map((r) => r.id)).toEqual(["newest", "middle"]);
    expect(page1.hasMore).toBe(true);
    // page 2 with pageSize=2 → oldest only, hasMore=false
    const page2 = await queries.listRuns({}, 2, 2);
    expect(page2.runs.map((r) => r.id)).toEqual(["oldest"]);
    expect(page2.hasMore).toBe(false);
  });

  it("filters by status, excluding non-matching rows", async () => {
    await seedRun("shipped-run", "shipped", 5);
    await seedRun("failed-run", "failed", 10);
    await seedRun("awaiting-run", "awaiting-approval", 15);
    const { runs, hasMore } = await queries.listRuns({ status: "failed" }, 1, 25);
    expect(runs.length).toBe(1);
    expect(runs[0]?.id).toBe("failed-run");
    expect(hasMore).toBe(false);
  });
});
