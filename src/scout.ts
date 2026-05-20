// Haiku scout. Spawned BEFORE a real opus/sonnet session on long, complex
// tasks. Asks haiku to predict {model, estimatedTurns, scopeWarnings};
// catches scope explosions (unbounded asks, dangerous ops, ambiguous
// targets) before opus tokens burn.
//
// Pure parsing + cache lookup is split out so unit tests can drive every
// branch without spawning a real claude. Default spawnFn invokes claude
// with --model haiku, plain text output, no tools beyond what haiku
// volunteers (the prompt asks for JSON-only; haiku honors it).
//
// Cache: module-level Map keyed by sha256(description) prefix. Re-picks
// of the same backlog item reuse the scout result instead of paying for
// it again. Bounded to SCOUT_CACHE_MAX entries with FIFO eviction; the
// only loss mode is a re-scout after a few dozen distinct tasks pass
// through, which is correct (the cache is best-effort, not a contract).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { log } from "./util/log.js";
import { buildSafeChildEnv } from "./util/safe-env.js";

/** Tasks shorter than this skip the scout (cheap tasks aren't worth a
 *  60s haiku call). Wired into the tick in index.ts. */
export const SCOUT_DESCRIPTION_THRESHOLD = 1500;

const SCOUT_TIMEOUT_MS = 60 * 1000;
const SCOUT_CACHE_MAX = 64;

export type ScoutModel = "haiku" | "sonnet" | "opus";

export interface ScoutResult {
  model: ScoutModel;
  estimatedTurns: number;
  scopeWarnings: string[];
}

export interface ScoutOutcome {
  /** Parsed scout result when claude returned valid JSON, else null. */
  result: ScoutResult | null;
  /** True iff result is non-null AND result.scopeWarnings is non-empty. */
  hasScopeWarnings: boolean;
  /** Populated on timeout / non-zero exit / unparseable output. */
  failure: string | null;
  /** True when the outcome was served from the cache. */
  cached: boolean;
}

export interface ScoutSpawnResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

export type ScoutSpawn = (prompt: string) => Promise<ScoutSpawnResult>;

export interface ScoutTaskInputs {
  description: string;
  /** cwd for the claude spawn (so it can resolve project context). */
  cwd: string;
  /** Injectable spawner for tests. Default invokes the real claude CLI. */
  spawnFn?: ScoutSpawn;
}

/** Hash used as the cache key. 16 hex chars is plenty to avoid collisions
 *  within a single bot process's cache lifetime. */
export function hashDescription(description: string): string {
  return createHash("sha256").update(description).digest("hex").slice(0, 16);
}

const cache = new Map<string, ScoutOutcome>();

/** Test-only: reset the scout cache between cases. */
export function clearScoutCache(): void {
  cache.clear();
}

/** Pure: extract the {model, estimatedTurns, scopeWarnings} object from
 *  arbitrary claude text output. Tries a ```json fenced block first, then
 *  falls back to the first balanced { ... } block in the text. Returns
 *  null if no candidate parses with the required shape. */
export function parseScoutResponse(text: string): ScoutResult | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const model = obj["model"];
    const turns = obj["estimatedTurns"];
    const warnings = obj["scopeWarnings"];
    if (model !== "haiku" && model !== "sonnet" && model !== "opus") continue;
    if (typeof turns !== "number" || !Number.isFinite(turns)) continue;
    if (!Array.isArray(warnings)) continue;
    if (!warnings.every((w) => typeof w === "string")) continue;
    return {
      model,
      estimatedTurns: Math.max(0, Math.floor(turns)),
      scopeWarnings: warnings.map((w) => w.trim()).filter((w) => w.length > 0),
    };
  }
  return null;
}

export function buildScoutPrompt(description: string): string {
  return [
    "You are a scoping scout for an autonomous coding bot. Read the task",
    "below and respond with ONE JSON object and nothing else. Do NOT do",
    "the task. Do NOT read files. Do NOT use any tools.",
    "",
    "Output JSON shape (exact keys):",
    '{ "model": "haiku" | "sonnet" | "opus",',
    '  "estimatedTurns": <integer 1..200, estimated assistant turns to complete>,',
    '  "scopeWarnings": [ "<short warning string>", ... ]',
    "}",
    "",
    "Populate scopeWarnings to flag risk: unbounded scope, unclear",
    "acceptance criteria, dangerous operations (force-push, deletes,",
    "schema migrations), ambiguous file targets, or `this looks bigger",
    "than it reads`. Empty array if the task is well-scoped.",
    "",
    "Task:",
    description,
  ].join("\n");
}

export async function scoutTask(input: ScoutTaskInputs): Promise<ScoutOutcome> {
  const key = hashDescription(input.description);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const spawnFn = input.spawnFn ?? ((prompt) => defaultScoutSpawn(prompt, input.cwd));
  const prompt = buildScoutPrompt(input.description);

  let outcome: ScoutOutcome;
  try {
    const r = await spawnFn(prompt);
    if (r.timedOut) {
      outcome = mkOutcome(null, `scout timed out after ${SCOUT_TIMEOUT_MS / 1000}s`);
    } else if (r.exitCode !== 0) {
      outcome = mkOutcome(null, `scout exited ${r.exitCode}`);
    } else {
      const parsed = parseScoutResponse(r.stdout);
      outcome = parsed
        ? mkOutcome(parsed, null)
        : mkOutcome(null, "scout output did not contain parseable JSON");
    }
  } catch (e) {
    outcome = mkOutcome(null, e instanceof Error ? e.message : String(e));
  }

  storeInCache(key, outcome);
  return outcome;
}

function mkOutcome(result: ScoutResult | null, failure: string | null): ScoutOutcome {
  return {
    result,
    hasScopeWarnings: result !== null && result.scopeWarnings.length > 0,
    failure,
    cached: false,
  };
}

function storeInCache(key: string, outcome: ScoutOutcome): void {
  if (cache.size >= SCOUT_CACHE_MAX) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, outcome);
}

function defaultScoutSpawn(prompt: string, cwd: string): Promise<ScoutSpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["-p", prompt, "--model", "haiku"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...buildSafeChildEnv(process.env), OCEAN_BOT_SCOUT: "1" },
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("scout.timeout, killing claude");
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, SCOUT_TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, exitCode: timedOut ? 124 : code ?? 0, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn("scout.spawn_error", { err: err.message });
      resolve({ stdout, exitCode: -1, timedOut: false });
    });
  });
}
