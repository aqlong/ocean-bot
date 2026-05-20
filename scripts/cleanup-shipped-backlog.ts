#!/usr/bin/env tsx
/**
 * One-shot: find every backlog item that already has at least one
 * `shipped` run and mark it `done`. Cleans up the duplicate-ship
 * loop that ran before commit `<this commit>` taught the ship handler
 * to update the backlog item's status itself.
 *
 * Safe to re-run: items already in `done` status stay there. Items
 * that have shipped runs AND a non-`open` current status are left
 * alone (e.g., the operator may have manually archived them).
 *
 * Usage:
 *   cd /tmp && railway link --project ocean-bot-dashboard
 *   railway run --service ocean-bot-dashboard bash -c \
 *     'cd ~/code2wiki/tools/ocean-bot && npx tsx scripts/cleanup-shipped-backlog.ts'
 */

import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db/index.js";
import { oceanBotBacklogItem, oceanBotRun } from "../src/db/schema.js";

async function main() {
  if (!process.env["OCEAN_BOT_DATABASE_URL"]) {
    console.error(
      "OCEAN_BOT_DATABASE_URL is not set. Run via `railway run --service ocean-bot-dashboard`.",
    );
    process.exit(2);
  }

  const db = getDb();

  // Find every distinct taskId from runs.metadata->>'taskId' that
  // ended in `shipped`. Filter to backlog: prefix.
  const shippedRuns = await db
    .select({
      taskId: sql<string>`${oceanBotRun.metadata} ->> 'taskId'`,
    })
    .from(oceanBotRun)
    .where(eq(oceanBotRun.status, "shipped"));

  const backlogIds = new Set<string>();
  for (const row of shippedRuns) {
    const t = row.taskId;
    if (typeof t === "string" && t.startsWith("backlog:")) {
      backlogIds.add(t.slice("backlog:".length));
    }
  }
  console.log(`[cleanup] ${backlogIds.size} backlog items have shipped runs`);

  // For each, set status='done' WHERE status='open' (idempotent, leaves
  // archived / already-done rows alone).
  let updated = 0;
  let unchanged = 0;
  for (const id of backlogIds) {
    const res = await db
      .update(oceanBotBacklogItem)
      .set({ status: "done", updatedAt: new Date() })
      .where(
        sql`${oceanBotBacklogItem.id} = ${id} AND ${oceanBotBacklogItem.status} = 'open'`,
      )
      .returning({ id: oceanBotBacklogItem.id });
    if (res.length > 0) {
      updated++;
      console.log(`  ✓ ${id} → done`);
    } else {
      unchanged++;
      console.log(`  · ${id} (not open; left alone)`);
    }
  }

  console.log(
    `\n[cleanup] ${updated} marked done, ${unchanged} left alone (already done / archived)`,
  );
}

main().catch((err) => {
  console.error("[cleanup] failed:", err);
  process.exit(1);
});
