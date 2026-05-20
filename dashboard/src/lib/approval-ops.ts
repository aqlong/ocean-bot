// Pure DB operations used by the approval server actions. Keeping these
// separate from actions.ts means tests can call them directly without
// pulling in `next-auth`, which doesn't resolve under Vitest.

import { getDb, schema } from "./db";
import { eq } from "drizzle-orm";

export type ApprovalAction = "ship" | "skip" | "block";

export function isValidApprovalAction(v: unknown): v is ApprovalAction {
  return v === "ship" || v === "skip" || v === "block";
}

export type Mode = "manual" | "auto" | "auto-with-visual";

export function isValidMode(v: unknown): v is Mode {
  return v === "manual" || v === "auto" || v === "auto-with-visual";
}

export async function applyApproval(
  runId: string,
  action: ApprovalAction,
  now: Date = new Date(),
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.oceanBotRun)
    .where(eq(schema.oceanBotRun.id, runId))
    .limit(1);
  if (rows.length === 0) throw new Error("run not found");

  if (action === "ship") {
    await db
      .update(schema.oceanBotRun)
      .set({ status: "approved", userDecision: "ship", userDecisionAt: now })
      .where(eq(schema.oceanBotRun.id, runId));
  } else if (action === "skip") {
    await db
      .update(schema.oceanBotRun)
      .set({
        status: "rejected",
        userDecision: "skip",
        userDecisionAt: now,
        endedAt: now,
      })
      .where(eq(schema.oceanBotRun.id, runId));
  } else {
    // block
    await db
      .update(schema.oceanBotRun)
      .set({
        status: "rejected",
        userDecision: "block",
        userDecisionAt: now,
        endedAt: now,
        blocker: "user-blocked: do not re-queue this task",
      })
      .where(eq(schema.oceanBotRun.id, runId));
  }
}

export async function setStateValue(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(schema.oceanBotState)
    .values({ key, value: value as object })
    .onConflictDoUpdate({
      target: schema.oceanBotState.key,
      set: { value: value as object, updatedAt: new Date() },
    });
}

export function isAuthBypassedForDev(): boolean {
  return (
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] === "1" &&
    process.env["NODE_ENV"] !== "production"
  );
}
