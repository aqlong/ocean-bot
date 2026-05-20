#!/usr/bin/env tsx
import { getDb } from "../src/db/index.js";
import { oceanBotBacklogItem } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

async function main(): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      status: oceanBotBacklogItem.status,
      category: oceanBotBacklogItem.category,
      id: oceanBotBacklogItem.id,
      title: oceanBotBacklogItem.title,
    })
    .from(oceanBotBacklogItem)
    .where(eq(oceanBotBacklogItem.project, "code2wiki"));

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log("counts:", byStatus);
  console.log("\nDONE:");
  for (const r of rows.filter((r) => r.status === "done"))
    console.log("  shipped", r.id);
  console.log("\nOPEN (by category):");
  const open = rows.filter((r) => r.status === "open");
  const byCat: Record<string, typeof open> = {};
  for (const r of open) (byCat[r.category] = byCat[r.category] || []).push(r);
  for (const [cat, items] of Object.entries(byCat)) {
    console.log(`  ${cat}: ${items.length}`);
    for (const i of items) console.log(`    -`, i.id);
  }
}

main();
