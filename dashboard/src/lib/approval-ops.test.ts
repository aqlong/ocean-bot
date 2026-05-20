// Integration tests for the pure-DB approval operations. Skipped
// automatically when OCEAN_BOT_TEST_DATABASE_URL isn't set.

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

import {
  applyApproval,
  setStateValue,
  isValidApprovalAction,
  isValidMode,
  isAuthBypassedForDev,
} from "./approval-ops";
import { getDb, schema } from "./db";
import { eq } from "drizzle-orm";

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

async function seedAwaiting(id: string): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    `INSERT INTO ocean_bot_run
     (id, project, queue, task_summary, status, approval_mode, branch, commit_sha, started_at)
     VALUES ($1, 'code2wiki', 'bug-fix', 'fix', 'awaiting-approval', 'manual', 'main', 'abc1234', NOW())`,
    [id],
  );
  await c.end();
}

async function getRun(id: string) {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotRun)
    .where(eq(schema.oceanBotRun.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getState(key: string) {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

describe("isValidApprovalAction", () => {
  it.each(["ship", "skip", "block"])("accepts %s", (v) => {
    expect(isValidApprovalAction(v)).toBe(true);
  });
  it.each(["", "nuke", "approve", null, undefined, 42])("rejects %p", (v) => {
    expect(isValidApprovalAction(v)).toBe(false);
  });
});

describe("isValidMode", () => {
  it.each(["manual", "auto", "auto-with-visual"])("accepts %s", (v) => {
    expect(isValidMode(v)).toBe(true);
  });
  it.each(["", "yolo", "AUTO", null])("rejects %p", (v) => {
    expect(isValidMode(v)).toBe(false);
  });
});

describe("isAuthBypassedForDev", () => {
  const origBypass = process.env["OCEAN_BOT_DEV_BYPASS_AUTH"];
  const origEnv = process.env["NODE_ENV"];

  afterEach(() => {
    if (origBypass === undefined) delete process.env["OCEAN_BOT_DEV_BYPASS_AUTH"];
    else process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = origBypass;
    if (origEnv === undefined)
      delete (process.env as Record<string, string | undefined>)["NODE_ENV"];
    else (process.env as Record<string, string>)["NODE_ENV"] = origEnv;
  });

  it("true when bypass=1 and NODE_ENV != production", () => {
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = "1";
    (process.env as Record<string, string>)["NODE_ENV"] = "development";
    expect(isAuthBypassedForDev()).toBe(true);
    (process.env as Record<string, string>)["NODE_ENV"] = "test";
    expect(isAuthBypassedForDev()).toBe(true);
  });

  it("false in production even when bypass=1", () => {
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = "1";
    (process.env as Record<string, string>)["NODE_ENV"] = "production";
    expect(isAuthBypassedForDev()).toBe(false);
  });

  it("false when bypass env not set", () => {
    delete process.env["OCEAN_BOT_DEV_BYPASS_AUTH"];
    (process.env as Record<string, string>)["NODE_ENV"] = "development";
    expect(isAuthBypassedForDev()).toBe(false);
  });
});

D("applyApproval, ship/skip/block", () => {
  beforeEach(truncate);

  it("ship → status=approved + user_decision=ship + decisionAt set", async () => {
    await seedAwaiting("R1");
    await applyApproval("R1", "ship");
    const r = await getRun("R1");
    expect(r?.status).toBe("approved");
    expect(r?.userDecision).toBe("ship");
    expect(r?.userDecisionAt).not.toBeNull();
  });

  it("skip → status=rejected + endedAt set", async () => {
    await seedAwaiting("R2");
    await applyApproval("R2", "skip");
    const r = await getRun("R2");
    expect(r?.status).toBe("rejected");
    expect(r?.userDecision).toBe("skip");
    expect(r?.endedAt).not.toBeNull();
  });

  it("block → status=rejected + blocker note set", async () => {
    await seedAwaiting("R3");
    await applyApproval("R3", "block");
    const r = await getRun("R3");
    expect(r?.status).toBe("rejected");
    expect(r?.userDecision).toBe("block");
    expect(r?.blocker).toMatch(/user-blocked/);
  });

  it("throws when run id doesn't exist", async () => {
    await expect(applyApproval("does-not-exist", "ship")).rejects.toThrow(
      /not found/,
    );
  });
});

D("setStateValue, upsert", () => {
  beforeEach(truncate);

  it("inserts new key", async () => {
    await setStateValue("paused", true);
    expect(await getState("paused")).toBe(true);
  });

  it("updates existing key (last-write-wins)", async () => {
    await setStateValue("paused", true);
    await setStateValue("paused", false);
    expect(await getState("paused")).toBe(false);
  });

  it("handles structured string values", async () => {
    await setStateValue("global_approval_mode", "manual");
    expect(await getState("global_approval_mode")).toBe("manual");
  });

  it("handles structured object values", async () => {
    await setStateValue("budget", { gate: "ok", worstRatio: 0.42 });
    const v = (await getState("budget")) as { gate: string; worstRatio: number };
    expect(v.gate).toBe("ok");
    expect(v.worstRatio).toBe(0.42);
  });
});
