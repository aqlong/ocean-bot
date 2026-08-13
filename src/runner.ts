// Task runner. Spawns `claude -p <task>` in the project directory,
// streams stream-json output, parses tool-use + final-message events,
// and writes structured events to the journal.
//
// Bot-attributed session attribution: we capture the session-file path
// from the first stream-json `system` event, then write a line to
// ~/.ocean-bot/sessions.jsonl so the budget broker can later identify
// this session's transcript as bot-owned.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log } from "./util/log.js";
import { appendBotSession } from "./budget.js";
import { appendEvent, getState, setState } from "./journal.js";
import { isClean, stashUncommittedToRef, git, commitMessage } from "./util/git.js";
import { buildSafeChildEnv } from "./util/safe-env.js";
import { isBacklogIdReferenced } from "./util/backlog-id-match.js";

export interface RunnerInputs {
  runId: string;
  prompt: string;
  cwd: string;
  /** Path to bot session log (~/.ocean-bot/sessions.jsonl). */
  sessionsLogPath: string;
  /** Adapter / project name (e.g. "code2wiki", "ocean-bot"). Written to
   *  sessions.jsonl so the budget broker can group rows per project. */
  project?: string;
  /** Model override. Defaults to claude's default. */
  model?: "haiku" | "sonnet" | "opus" | string;
  /** Max output tokens per assistant turn. Forwarded to claude as
   *  `--max-tokens N`. Omit to let claude default. */
  outputTokenCap?: number;
  /** Max walltime, milliseconds. */
  timeoutMs?: number;
  /** Max tool_use events before SIGTERM. Defaults to DEFAULT_MAX_TOOL_USES.
   *  Catches runaway grep/read storms; protects against pathological
   *  sessions (chunk 2/5 of ai-usage-opt). */
  maxToolUses?: number;
  /** When set, spawn `claude --resume <id>` instead of a fresh session.
   *  Resumed sessions reuse Anthropic's prompt cache for the prior
   *  context, cutting input-token spend on follow-up runs in the same
   *  project (chunk 5/5 of ai-usage-opt). Caller is responsible for
   *  TTL + isolate gating, see pickResumeSessionId. */
  resumeSessionId?: string;
  /** Path to the `claude` CLI binary. Defaults to "claude" (resolved via
   *  PATH). Test-only escape hatch: tests inject a fake script that
   *  emits canned stream-json on stdout so the runtime token-cap
   *  enforcement can be exercised without burning real API tokens. */
  claudeBinPath?: string;
}

/** Build the argv passed to `claude -p`. Pure / synchronous so the
 *  output-cap-per-tier wiring can be unit-tested without spawning. */
export function buildSpawnArgs(input: RunnerInputs): string[] {
  const args: string[] = [];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  args.push(
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
  );
  if (input.model) args.push("--model", input.model);
  // NOTE 2026-05-16: outputTokenCap intentionally NOT forwarded as a
  // CLI flag. claude --help has no --max-tokens; passing it makes
  // claude exit 1 immediately, breaking every spawn. The wider
  // ai-usage-opt chunk-1 design needs a different enforcement
  // mechanism (post-hoc budget tracking, or --max-budget-usd as a
  // proxy). The field stays on RunnerInputs so callers + tests don't
  // break and so a future implementation can pick it up.
  void input.outputTokenCap;
  return args;
}

export interface RunnerResult {
  exitCode: number;
  durationMs: number;
  sessionPath?: string;
  /** UUID Claude assigned to the session (the basename of sessionPath
   *  without `.jsonl`). Persisted per-project so the next bot tick can
   *  spawn `claude --resume <id>` and reuse the prompt cache. */
  sessionId?: string;
  /** Final assistant message text, if observed. */
  finalText?: string;
  /** Aggregate counts. */
  toolUses: number;
  bytesIn: number;
  bytesOut: number;
  /** Cumulative output-token count observed across `assistant` events. Per-turn
   *  deltas from `evt.message.usage.output_tokens` summed by the streaming
   *  loop. Used by the per-task cap enforcement and surfaced to the blocker
   *  text for diagnostic purposes. */
  outputTokens: number;
  /** True if the streaming loop SIGTERM'd claude after toolUses exceeded
   *  the per-task cap. Surfaces a clearer blocker than a bare non-zero
   *  exit code. */
  toolUseCapHit: boolean;
  /** True if the streaming loop SIGTERM'd claude after outputTokens
   *  exceeded RunnerInputs.outputTokenCap. Parallel to toolUseCapHit;
   *  the index.ts classifier reads it to emit a "token-cap-overage"
   *  blocker rather than a generic SIGTERM exit. */
  tokenCapHit: boolean;
  /** True if a rate_limit_event was observed in the stream-json output
   *  or if 429 / credits-exhausted patterns appeared in stderr. When
   *  true, index.ts sets rate_limit_pause so the next tick backs off
   *  before spawning another claude session. */
  rateLimitHit: boolean;
  /** Specific reason for rateLimitHit; undefined when not hit. */
  rateLimitReason?: "429" | "credits-exhausted";
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap per task

/** Default cap on tool_use events per claude session. 200 is sized to
 *  comfortably cover deep-implement runs (which typically run 40-80
 *  Read/Grep/Edit calls) while catching the pathological case of a
 *  runaway grep storm. Tunable per-install via the dashboard
 *  (/settings writes ocean_bot_state.max_tool_uses). */
export const DEFAULT_MAX_TOOL_USES = 200;

/** Pure predicate, exported for unit tests. Returns true the moment
 *  toolUses strictly exceeds cap, i.e. cap=200 fires on the 201st
 *  event. */
export function shouldKillForToolUseCap(toolUses: number, cap: number): boolean {
  return toolUses > cap;
}

/** Pure predicate, exported for unit tests. Returns true the moment the
 *  running output-token total strictly exceeds the cap. cap undefined
 *  or 0 disables enforcement (the caller may legitimately omit a cap).
 *  Matches the toolUseCap semantics: cap=100 fires the first time the
 *  total observed crosses 101, not at exactly 100. */
export function shouldKillForOutputTokenCap(
  outputTokens: number,
  cap: number | undefined,
): boolean {
  if (!cap || cap <= 0) return false;
  return outputTokens > cap;
}

/** Pure: extract the per-turn output-token delta from a single
 *  stream-json event, or null when the event doesn't carry usage.
 *  Field shape captured 2026-05-16 from `claude -p --output-format
 *  stream-json --verbose`:
 *    assistant: evt.message.usage.output_tokens  (per-turn delta)
 *    result:    evt.usage.output_tokens          (cumulative, end-of-run)
 *  The runner accumulates from assistant events because the result
 *  event fires only after the run has already finished, too late for
 *  enforcement. The on-disk transcript format that budget.ts:parseLine
 *  parses uses the same per-message-delta semantics (sumRows there
 *  confirms accumulation is correct). */
export function extractOutputTokensDelta(
  evt: Record<string, unknown>,
): number | null {
  if (evt["type"] !== "assistant") return null;
  const msg = evt["message"] as Record<string, unknown> | undefined;
  const usage = msg?.["usage"] as Record<string, unknown> | undefined;
  if (!usage) return null;
  const n = usage["output_tokens"];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** TTL on a resume candidate. Anthropic's prompt cache evicts well
 *  before this for individual blocks, but at the conversation level
 *  resuming a 24h-old session still saves on context re-ingestion. */
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

/** Pure helper. Returns the sessionId to pass to `claude --resume` or
 *  undefined when the caller should spawn a fresh session. Decoupled
 *  from journal/DB so it's exhaustively unit-testable. Structural
 *  parameter type matches journal.LastSessionRow without coupling the
 *  modules. */
export function pickResumeSessionId(
  record: { sessionId: string; observedAt: number } | null,
  now: number,
  ttlMs: number = RESUME_TTL_MS,
): string | undefined {
  if (!record) return undefined;
  if (!record.sessionId) return undefined;
  if (now - record.observedAt > ttlMs) return undefined;
  return record.sessionId;
}

export async function runTask(input: RunnerInputs): Promise<RunnerResult> {
  const startedAt = Date.now();
  const args = buildSpawnArgs(input);

  log.info("runner.spawn", {
    runId: input.runId,
    cwd: input.cwd,
    model: input.model ?? "default",
    outputTokenCap: input.outputTokenCap ?? null,
    resumeSessionId: input.resumeSessionId ?? null,
  });

  return new Promise((resolve) => {
    const proc = spawn(input.claudeBinPath ?? "claude", args, {
      cwd: input.cwd,
      // Scrub bot-only secrets (OCEAN_BOT_DATABASE_URL, WORKER_TRIGGER_
      // SECRET, *_SECRET / *_TOKEN / *_PRIVATE_KEY patterns) so a
      // prompt-injected task description can't shell out and exfil
      // them via `env`, `psql $OCEAN_BOT_DATABASE_URL`, or
      // `curl -d $WORKER_TRIGGER_SECRET`. See util/safe-env.ts.
      env: {
        ...buildSafeChildEnv(process.env),
        OCEAN_BOT_RUN_ID: input.runId,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Stamp the child PID onto current_run so the dashboard's cancel
    // button can SIGTERM it. Best-effort; failures here must not crash
    // the runner (the cancel button just stops working, the run still
    // proceeds normally).
    void stampChildPid(proc.pid ?? null);

    const result: RunnerResult = {
      exitCode: -1,
      durationMs: 0,
      toolUses: 0,
      bytesIn: 0,
      bytesOut: 0,
      outputTokens: 0,
      toolUseCapHit: false,
      tokenCapHit: false,
      rateLimitHit: false,
    };

    const maxToolUses = input.maxToolUses ?? DEFAULT_MAX_TOOL_USES;
    let buffer = "";
    let finalText = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("runner.timeout, killing claude", { runId: input.runId });
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.stdout.on("data", async (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line) as Record<string, unknown>;
          await onEvent(input, result, evt);
          if (
            !result.toolUseCapHit &&
            shouldKillForToolUseCap(result.toolUses, maxToolUses)
          ) {
            result.toolUseCapHit = true;
            log.warn("runner.tool_use_cap, killing claude", {
              runId: input.runId,
              toolUses: result.toolUses,
              cap: maxToolUses,
            });
            await appendEvent(input.runId, "message", {
              kind: "tool_use_cap_hit",
              toolUses: result.toolUses,
              cap: maxToolUses,
            });
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 5000);
          }
          // Output-token cap, fires the first time accumulated output
          // strictly exceeds RunnerInputs.outputTokenCap. Same SIGTERM +
          // 5s SIGKILL pattern as the tool-use cap; the index.ts
          // classifier reads result.tokenCapHit to emit the
          // "token-cap-overage" blocker. Guard on !tokenCapHit so a
          // burst of assistant events past the cap only fires the kill
          // once.
          if (
            !result.tokenCapHit &&
            shouldKillForOutputTokenCap(result.outputTokens, input.outputTokenCap)
          ) {
            result.tokenCapHit = true;
            log.warn("runner.output_token_cap, killing claude", {
              runId: input.runId,
              outputTokens: result.outputTokens,
              cap: input.outputTokenCap,
            });
            await appendEvent(input.runId, "message", {
              kind: "output_token_cap_hit",
              outputTokens: result.outputTokens,
              cap: input.outputTokenCap,
            });
            proc.kill("SIGTERM");
            setTimeout(() => proc.kill("SIGKILL"), 5000);
          }
          if (evt["type"] === "assistant") {
            const msg = evt["message"] as Record<string, unknown> | undefined;
            const content = msg?.["content"];
            if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  typeof block === "object" &&
                  block !== null &&
                  (block as Record<string, unknown>)["type"] === "text"
                ) {
                  const t = (block as Record<string, unknown>)["text"];
                  if (typeof t === "string") finalText = t;
                }
              }
            }
          }
        } catch {
          // not JSON; ignore
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      result.bytesOut += chunk.length;
      const s = chunk.toString("utf-8");
      // claude stderr is mostly progress noise; only log warning-and-above.
      if (/error|panic|fatal/i.test(s)) {
        log.warn("runner.stderr", { runId: input.runId, snippet: s.slice(0, 500) });
      }
      // Detect 429 / credits-exhaustion in stderr as a fallback for when
      // no rate_limit_event fired on stdout (e.g. claude exits immediately
      // rather than streaming the event). Guard !rateLimitHit so multiple
      // stderr chunks from the same failure only log once.
      if (
        !result.rateLimitHit &&
        /429|rate[_\s-]?limit|credit[s]?[_\s-]?exhaust|insufficient_quota|usage_limit/i.test(s)
      ) {
        result.rateLimitHit = true;
        result.rateLimitReason =
          /credit[s]?[_\s-]?exhaust|insufficient_quota|usage_limit/i.test(s)
            ? "credits-exhausted"
            : "429";
        log.warn("runner.rate_limit_stderr", {
          runId: input.runId,
          reason: result.rateLimitReason,
          snippet: s.slice(0, 200),
        });
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      result.exitCode = timedOut ? 124 : (code ?? 0);
      result.durationMs = Date.now() - startedAt;
      result.finalText = finalText || undefined;
      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      log.error("runner.spawn failed", {
        runId: input.runId,
        err: err.message,
      });
      result.exitCode = -1;
      result.durationMs = Date.now() - startedAt;
      resolve(result);
    });
  });
}

async function onEvent(
  input: RunnerInputs,
  result: RunnerResult,
  evt: Record<string, unknown>,
): Promise<void> {
  const type = evt["type"];

  // Attribution: extract the transcript path from the first event that
  // identifies the session. See extractSessionAttribution() below for
  // the field-shape table and historical context.
  if (!result.sessionPath) {
    const sessionPath = extractSessionAttribution(evt, input.cwd);
    if (sessionPath) {
      result.sessionPath = sessionPath;
      // Strip the `.jsonl` extension to recover the UUID Claude assigned
      // to this session. Used by the per-project resume gate in index.ts.
      result.sessionId = path.basename(sessionPath, ".jsonl");
      try {
        await appendBotSession(input.sessionsLogPath, {
          sessionPath,
          runId: input.runId,
          startedAt: Date.now(),
          project: input.project,
        });
      } catch (e) {
        log.warn("runner.appendBotSession failed", {
          runId: input.runId,
          err: errMsg(e),
        });
      }
    }
  }

  if (type === "system" && evt["subtype"] === "init") {
    await appendEvent(input.runId, "message", { kind: "init", evt });
    return;
  }

  if (type === "tool_use" || type === "assistant" || type === "user") {
    if (type === "tool_use") result.toolUses++;
    if (type === "assistant") {
      const delta = extractOutputTokensDelta(evt);
      if (delta !== null) result.outputTokens += delta;
    }
    await appendEvent(input.runId, "tool_use", evt);
    return;
  }

  if (type === "result") {
    await appendEvent(input.runId, "message", { kind: "result", evt });
    return;
  }

  // rate_limit_event is emitted by the Claude Code SDK when the underlying
  // API call returns 429. Claude Code may auto-retry, so we don't kill the
  // process here; we just flag it so index.ts can set a backoff pause after
  // the run finishes. The flag is sticky: once set it stays true for the
  // lifetime of the run even if Claude Code's retry succeeds.
  if (type === "rate_limit_event") {
    if (!result.rateLimitHit) {
      result.rateLimitHit = true;
      result.rateLimitReason = "429";
      log.warn("runner.rate_limit_event", { runId: input.runId });
    }
    await appendEvent(input.runId, "message", { kind: "rate_limit_event", evt });
    return;
  }

  // Default: forward as-is.
  await appendEvent(input.runId, "message", evt);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Merge the spawned claude PID into the existing current_run state
 *  row. Read-modify-write race vs the index.ts writer is acceptable:
 *  index.ts writes first (before runTask awaits), then we write here.
 *  If current_run was already cleared (e.g. tick exited fast on error),
 *  we no-op rather than resurrecting a stale row. */
async function stampChildPid(pid: number | null): Promise<void> {
  if (pid === null) return;
  try {
    const cur = await getState<Record<string, unknown> | null>("current_run");
    if (!cur || typeof cur !== "object") return;
    await setState("current_run", { ...cur, childPid: pid });
  } catch (e) {
    log.warn("runner.stampChildPid failed", { pid, err: errMsg(e) });
  }
}

/**
 * Reconstruct the Claude Code transcript file path from (cwd, sessionId).
 *
 * Claude Code stores per-session JSONL transcripts at:
 *   ~/.claude/projects/<cwd-as-dashes>/<sessionId>.jsonl
 *
 * where <cwd-as-dashes> replaces every `/` and `.` in the absolute cwd
 * with `-`. The directory's first character is always `-` (the leading
 * slash maps to the leading dash). Exported for unit tests + the
 * sessions-backlog backfill script.
 */
export function sessionPathFromSessionId(cwd: string, sessionId: string): string {
  // Claude Code's per-project transcript dir replaces every `/` and `.`
  // in the absolute cwd with `-`. E.g. cwd `/Users/x/code2wiki` →
  // dirName `-Users-x-code2wiki`.
  const dirName = cwd.replace(/[/.]/g, "-");
  return path.join(os.homedir(), ".claude", "projects", dirName, `${sessionId}.jsonl`);
}

/**
 * Pull the transcript path out of a single stream-json event, or return
 * null if this event doesn't carry attribution. Pure / synchronous so
 * the runner-events test can exercise it against fixture events.
 *
 * Field shapes observed (Claude Code 2.1.x, 2026-05):
 *   - stdout `system/init`: { type:"system", subtype:"init", session_id, cwd }
 *     This is the authoritative signal, read session_id (snake_case)
 *     and the resolved cwd from the event itself (Claude resolves the
 *     cwd through realpath before naming the projects dir, so
 *     `/tmp` → `/private/tmp` → `-private-tmp`).
 *   - on-disk transcript line 1 `queue-operation`: { type:"queue-operation",
 *     operation:"enqueue", sessionId }, camelCase. Does NOT appear on
 *     stdout under current Claude versions, but kept as a forward-compat
 *     fallback in case it returns.
 *   - legacy shape: { type:"system", subtype:"init", session_file } or
 *     { ..., transcript_path }, preserved for forward-compat.
 *
 * Bug history: shipped 2026-05-12 (`f95103f`-era) reading only
 * `sessionId` (camelCase) on system/init; current Claude emits
 * `session_id` (snake_case). Result: 50+ bot sessions invisible to the
 * budget broker, 5hr window stuck at zero, sevenD frozen at the May 12
 * count. Bug confirmed by capturing real `claude -p --output-format
 * stream-json` output 2026-05-14.
 */
export function extractSessionAttribution(
  evt: Record<string, unknown>,
  fallbackCwd: string,
): string | null {
  const type = evt["type"];

  if (type === "system" && evt["subtype"] === "init") {
    // Legacy explicit-path fields first, if a future Claude version
    // adds them back, we get the exact path without reconstruction.
    const explicit =
      (evt["session_file"] as string | undefined) ??
      (evt["transcript_path"] as string | undefined);
    if (explicit) return explicit;
    const sessionId =
      (evt["session_id"] as string | undefined) ??
      (evt["sessionId"] as string | undefined);
    if (!sessionId) return null;
    const cwd = (evt["cwd"] as string | undefined) ?? fallbackCwd;
    return sessionPathFromSessionId(cwd, sessionId);
  }

  if (type === "queue-operation" && evt["operation"] === "enqueue") {
    const sessionId =
      (evt["session_id"] as string | undefined) ??
      (evt["sessionId"] as string | undefined);
    if (!sessionId) return null;
    return sessionPathFromSessionId(fallbackCwd, sessionId);
  }

  return null;
}

// ----------------------------------------------------------------------
// Idle / lock helpers, keep tick from racing the user's interactive
// session or another bot tick.
// ----------------------------------------------------------------------

/** Detect an interactive Claude Code session that the bot should not
 *  contend with. Heuristic: any `claude` process owned by us whose
 *  command line contains neither `-p` / `--print` (one-shot mode) nor
 *  OCEAN_BOT_RUN_ID (our own spawn). Returns false on any tooling
 *  error, we'd rather skip-rarely than skip-never. */
export async function isInteractiveClaudeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("ps", ["-axo", "command="], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const lines = out.split("\n");
      const myRun = process.env["OCEAN_BOT_RUN_ID"] ?? "";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (!/(^|\/)claude(\s|$)/.test(line)) continue;
        // Skip Code Helper / Code Editor false positives.
        if (/Visual Studio Code|Code Helper|node_modules/.test(line)) continue;
        // Our own runs are tagged.
        if (myRun && line.includes(myRun)) continue;
        // One-shot mode is `claude -p` or `claude --print`.
        if (/(^|\s)(-p|--print)(\s|$)/.test(line)) continue;
        resolve(true);
        return;
      }
      resolve(false);
    });
    p.on("error", () => resolve(false));
  });
}

// Stale-lock threshold. Sized just over the default 3-minute tick interval
// (cfg.tickIntervalSec = 180) so a crashed prior tick is recovered after
// at most 1-2 normal ticks. A tick that legitimately runs >5min could see
// the next wake-up barge in, that race is tolerated because each tick's
// audit/journal events are tagged with a unique OCEAN_BOT_RUN_ID, so the
// two-tick output stays attributable.
const LOCK_STALE_MS = 5 * 60 * 1000;

/** Acquire the tick lock. If a stale lock (>5 min old) is found we
 *  forcibly take it over, without this the bot freezes forever after
 *  a crash since the lock file persists. */
export async function acquireLock(dataDir: string): Promise<boolean> {
  const lockPath = path.join(dataDir, "tick.lock");
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const fh = await fs.open(lockPath, "wx");
    await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await fh.close();
    return true;
  } catch (err) {
    // Lock exists. If it's stale, take it over; otherwise concede.
    const stat = await fs.stat(lockPath).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      try {
        await fs.unlink(lockPath);
        const fh = await fs.open(lockPath, "wx");
        await fh.writeFile(
          `${process.pid}\n${new Date().toISOString()}\nrecovered-stale\n`,
        );
        await fh.close();
        return true;
      } catch {
        return false;
      }
    }
    void err;
    return false;
  }
}

// ----------------------------------------------------------------------
// Noop classification, split the "no commit produced" path on whether
// the working tree is clean. A claude session that edits files but never
// commits looks identical to a real noop by HEAD sha; without this check
// the tick was being marked `shipped+local` and the dirty tree blocked
// every subsequent tick with `dirty_tree_stale`. Prod halted 16+ hours
// in this mode 2026-05-13.
// ----------------------------------------------------------------------

export type NoopOutcome =
  | { kind: "clean" }
  | {
      kind: "dirty";
      stashed: boolean;
      sha: string | null;
      ref: string;
      changedFiles: number;
      blocker: string;
    };

export async function classifyNoopRun(
  cwd: string,
  runId: string,
): Promise<NoopOutcome> {
  if (await isClean(cwd)) return { kind: "clean" };
  const ref = `refs/ocean-bot/orphan-edits/${runId}`;
  const stash = await stashUncommittedToRef(cwd, ref);
  const blocker = stash.stashed
    ? `task left ${stash.changedFiles} file${stash.changedFiles === 1 ? "" : "s"} uncommitted; edits stashed at ${ref}`
    : "task left uncommitted edits but stash failed; operator must inspect working tree";
  return {
    kind: "dirty",
    stashed: stash.stashed,
    sha: stash.sha,
    ref,
    changedFiles: stash.changedFiles,
    blocker,
  };
}

export async function releaseLock(dataDir: string): Promise<void> {
  const lockPath = path.join(dataDir, "tick.lock");
  try {
    await fs.unlink(lockPath);
  } catch {
    // ignore
  }
}

/**
 * Ship-gate for bot/backlog runs. If the HEAD commit message omits the
 * backlog item id as a whole token, amends the commit to append a
 * "Closes backlog item: <id>" footer.
 *
 * Scoped to taskId strings starting with "backlog:" so operator commits
 * and non-backlog bot runs are never touched.
 *
 * Returns the new HEAD SHA after amendment, or the original sha when no
 * amendment was needed or on any git failure (best-effort, never throws).
 */
export async function ensureBacklogIdFooter(
  cwd: string,
  currentSha: string,
  taskId: string | null | undefined,
): Promise<string> {
  if (!taskId?.startsWith("backlog:")) return currentSha;
  const backlogId = taskId.slice("backlog:".length);
  if (!backlogId) return currentSha;
  const msg = await commitMessage(cwd, currentSha);
  if (isBacklogIdReferenced(msg, backlogId)) return currentSha;
  const newMsg = `${msg.trimEnd()}\n\nCloses backlog item: ${backlogId}`;
  const r = await git(cwd, ["commit", "--amend", "-m", newMsg]);
  if (r.code !== 0) {
    log.warn("runner.ensureBacklogIdFooter.amend_failed", {
      taskId,
      backlogId,
      stderr: r.stderr.slice(0, 200),
    });
    return currentSha;
  }
  const newSha = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  log.info("runner.ensureBacklogIdFooter.amended", {
    taskId,
    backlogId,
    oldSha: currentSha.slice(0, 8),
    newSha: newSha.slice(0, 8),
  });
  return newSha;
}
