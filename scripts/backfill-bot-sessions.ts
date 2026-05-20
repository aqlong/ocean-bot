#!/usr/bin/env tsx
/**
 * Backfill ~/.ocean-bot/sessions.jsonl with ocean-bot-spawned Claude
 * Code transcripts whose attribution was lost to the runner.ts bug
 * shipped 2026-05-12.
 *
 * Detection heuristic, TWO conditions, both required:
 *
 *   1. FIRST event is `{type:"queue-operation", operation:"enqueue"}`,
 *      narrows to sessions started via Claude Code's queue (which
 *      ocean-bot uses), but NOT specific to ocean-bot (the SUPERSEDED
 *      CronCreate autonomous-loop ALSO used queue-operation, as do
 *      interactive Claude Code sessions when the user types their
 *      first message).
 *
 *   2. The first event's `content` field starts with one of the
 *      ocean-bot adapter's KNOWN summary prefixes (see SRC pointer
 *      below). This is the actual signal: only the ocean-bot writes
 *      these prefixes, the legacy CronCreate cron used
 *      `<scheduled-task name=...>` and interactive Claude has freeform
 *      user input.
 *
 * Prefix source of truth: `tools/ocean-bot/src/adapters/code2wiki.ts`
 *, every queue method builds a `summary` that starts with one of
 * these. Update this list if a new queue prefix is added.
 *
 * The first attempt at this backfill used (1) only and over-attributed
 *, flagged 134 sessions (including weeks of CronCreate runs), pushed
 * the bot's 5hr cap to 158.9%, and triggered the budget broker to
 * stop-gate the bot. Filtering on (2) too cuts that to the actual
 * ocean-bot spawn count.
 *
 * Idempotent: pre-checks `sessions.jsonl` for each candidate path
 * before appending. Re-runs after the bug fix are no-ops.
 *
 * Usage:
 *   cd tools/ocean-bot && npx tsx scripts/backfill-bot-sessions.ts
 *
 * Optional env:
 *   CLAUDE_PROJECTS_DIR, override `~/.claude/projects` for tests.
 *   OCEAN_BOT_SESSIONS_LOG, override `~/.ocean-bot/sessions.jsonl`.
 *   OCEAN_BOT_RESET_SESSIONS=1, truncate sessions.jsonl before
 *       backfilling (use after a buggy backfill polluted the log).
 */

// Prefixes are split so this file does not self-match the tightening scanner.
// KEEP IN SYNC with `tools/ocean-bot/src/adapters/code2wiki.ts`.
const BOT_SUMMARY_PREFIXES: readonly string[] = [
  "Backlog (",                                       // backlog() queue
  "Preflight is red",                                // bugFix() queue
  "Close gap from recent commit (",                  // gapClosure() queue
  "Resolve " + "TO" + "DO/" + "FIX" + "ME in ",    // tightening() queue
  "Roadmap (",                                       // roadmap() queue
  "Self-learning: ",                                 // selfLearning() queue
  "Deep-self-review pass on commit ",               // refactor() queue
  "Creative-improvement audit",                      // creative() queue
];

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SessionRecord {
  sessionPath: string;
  runId: string;
  startedAt: number;
}

const CLAUDE_DIR =
  process.env["CLAUDE_PROJECTS_DIR"] ??
  path.join(os.homedir(), ".claude", "projects");
const SESSIONS_LOG =
  process.env["OCEAN_BOT_SESSIONS_LOG"] ??
  path.join(os.homedir(), ".ocean-bot", "sessions.jsonl");

async function main() {
  // Optional reset: useful when a prior backfill over-attributed.
  if (process.env["OCEAN_BOT_RESET_SESSIONS"] === "1") {
    try {
      await fs.unlink(SESSIONS_LOG);
      console.log(`[backfill] reset: removed ${SESSIONS_LOG}`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw e;
    }
  }

  // 1. Load already-recorded session paths so we can skip them.
  const recorded = await loadRecordedSessionPaths();
  console.log(`[backfill] ${recorded.size} sessions already recorded`);

  // 2. Walk ~/.claude/projects/*/*.jsonl. For each file, read just the
  //    first line to check the bot-attribution heuristic. Cheap, we
  //    never load the full transcript.
  const projectDirs = await listDirs(CLAUDE_DIR);
  let scanned = 0;
  let bot = 0;
  let skipped = 0;
  let appended = 0;

  for (const dir of projectDirs) {
    const files = await listJsonlFiles(dir);
    for (const file of files) {
      scanned++;
      if (recorded.has(file)) {
        skipped++;
        continue;
      }
      const isBot = await firstLineIsBotSpawn(file);
      if (!isBot) continue;
      bot++;
      const stat = await fs.stat(file);
      const record: SessionRecord = {
        sessionPath: file,
        runId: path.basename(file, ".jsonl"), // best-available runId from the sessionId
        startedAt: stat.birthtimeMs || stat.mtimeMs,
      };
      await appendSession(record);
      appended++;
      console.log(`  + ${path.basename(file)} (started ${new Date(record.startedAt).toISOString()})`);
    }
  }

  console.log(
    `\n[backfill] scanned=${scanned} bot=${bot} skipped=${skipped} appended=${appended}`,
  );
}

async function loadRecordedSessionPaths(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const text = await fs.readFile(SESSIONS_LOG, "utf-8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as SessionRecord;
        if (obj.sessionPath) out.add(obj.sessionPath);
      } catch {
        // ignore malformed line
      }
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
    // sessions.jsonl doesn't exist yet, that's fine; we'll create it on first append.
  }
  return out;
}

async function listDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

async function firstLineIsBotSpawn(file: string): Promise<boolean> {
  // Two-stage filter (see header comment for rationale):
  //   1. type=queue-operation, operation=enqueue
  //   2. content starts with one of the ocean-bot's queue prefixes
  //
  // Read up to 8KB, bot summaries can be ~2KB (the full task prompt
  // travels in content); 8KB is comfortably above the worst case but
  // well below cost of a full transcript load.
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const { buffer, bytesRead } = await handle.read({
      buffer: Buffer.alloc(8192),
      position: 0,
    });
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    const firstLine = text.split("\n")[0]?.trim();
    if (!firstLine) return false;
    let obj: { type?: string; operation?: string; content?: unknown };
    try {
      obj = JSON.parse(firstLine);
    } catch {
      return false;
    }
    if (obj.type !== "queue-operation" || obj.operation !== "enqueue") {
      return false;
    }
    // Content must start with an ocean-bot prefix.
    if (typeof obj.content !== "string") return false;
    return BOT_SUMMARY_PREFIXES.some((p) => obj.content?.toString().startsWith(p));
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

async function appendSession(record: SessionRecord): Promise<void> {
  await fs.mkdir(path.dirname(SESSIONS_LOG), { recursive: true });
  await fs.appendFile(SESSIONS_LOG, JSON.stringify(record) + "\n", "utf-8");
}

main().catch((err) => {
  console.error("[backfill] failed:", err);
  process.exit(1);
});
