// Budget broker. Observational, not predictive:
//
//   1. Parse Claude Code transcripts at ~/.claude/projects/.../*.jsonl
//   2. Attribute each session as bot-tagged or interactive (via
//      ~/.ocean-bot/sessions.jsonl written by runner.ts at spawn time)
//   3. Sum tokens over rolling 5hr + 7d windows
//   4. Compare bot-attributed usage to configured caps
//   5. Return ok | wait | stop
//
// No exact-Max-plan numbers are baked in, caps come from config and
// the dashboard surfaces actual usage so Ocean tunes within a day.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FIVE_HR_MS = 5 * 60 * 60 * 1000;
const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;

// /goal evaluator overhead (Haiku tokens per evaluator turn, not visible in stream-json).
// Measured 2026-05-22: 3-turn /goal session billed 520 total output tokens, stream
// showed 16 from main turns, leaving 504 for evaluator (168 per turn). Fudge factor
// accounts for evaluator cost that doesn't appear in stream events but IS billed.
const GOAL_EVALUATOR_OUTPUT_OVERHEAD = 168;

export interface BudgetCaps {
  /** Bot-attributed input tokens allowed per 5hr rolling window. */
  fiveHrInput: number;
  /** Bot-attributed output tokens allowed per 5hr rolling window. */
  fiveHrOutput: number;
  /** Bot-attributed input tokens allowed per 7d rolling window. */
  sevenDInput: number;
  /** Bot-attributed output tokens allowed per 7d rolling window. */
  sevenDOutput: number;
  /** Threshold (0..1) at which gate returns "wait" instead of "ok".
   *  Default 0.9, back off when within 10% of cap. */
  warnRatio: number;
  /** Optional per-project sub-caps. When absent (the v1 case), behavior
   *  is identical to the single-pool gate — `decideProjectBudgets`
   *  returns an empty map and the picker exclude-list is empty.
   *
   *  Overlapping shares (e.g., 0.6 + 0.6) are intentional: each
   *  project's sub-cap is an INDEPENDENT slice against the global pool,
   *  not a mutually exclusive partition. Two projects each at share=0.6
   *  can coexist because their actual usage is rarely simultaneous and
   *  the global gate still binds first when both are active. The
   *  per-project gate's job is to bound runaway behavior on a SINGLE
   *  project (e.g., a malformed task triggers retry-forever and burns
   *  the whole pool on one project), not to enforce fair-share. */
  perProject?: Record<string, ProjectShare>;
}

export interface ProjectShare {
  /** Fraction of each global cap this project may consume. 0..1.
   *  Values > 1 are NOT clamped — operator can pin a project to a
   *  larger-than-global cap as an explicit "this project is allowed to
   *  exceed the pool" override (useful pre-rebalance). */
  share: number;
}

export const DEFAULT_CAPS: BudgetCaps = {
  fiveHrInput: 2_500_000,
  fiveHrOutput: 500_000,
  sevenDInput: 17_500_000,
  sevenDOutput: 3_500_000,
  warnRatio: 0.9,
};

/** Per-field Max-20x reference points, used by the dashboard to show
 *  "X% of Max-20x" labels. These are 2x DEFAULT_CAPS (since defaults
 *  are 50% of Max-20x by intent), keep in sync if DEFAULT_CAPS shifts. */
export const MAX_20X_REFERENCE = {
  fiveHrInput: 5_000_000,
  fiveHrOutput: 1_000_000,
  sevenDInput: 35_000_000,
  sevenDOutput: 7_000_000,
} as const;

export type CapsSource = "dashboard" | "config.json" | "default";

/** Resolve which caps are active for a given tick. Precedence:
 *    state (operator's dashboard edit) > config.json > DEFAULT_CAPS. */
export function resolveCaps(args: {
  stateCaps: BudgetCaps | null;
  configCaps: BudgetCaps;
  configHasCaps: boolean;
}): { caps: BudgetCaps; source: CapsSource } {
  if (args.stateCaps) return { caps: args.stateCaps, source: "dashboard" };
  if (args.configHasCaps) return { caps: args.configCaps, source: "config.json" };
  return { caps: args.configCaps, source: "default" };
}

export interface UsageRow {
  /** Unix ms timestamp. */
  ts: number;
  /** Session file path (used for bot/interactive attribution). */
  sessionPath: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  model: string;
}

export interface WindowTotals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export type BudgetGate = "ok" | "wait" | "stop";

export interface BudgetDecision {
  gate: BudgetGate;
  reason?: string;
  fiveHr: WindowTotals;
  sevenD: WindowTotals;
  caps: BudgetCaps;
  /** Highest cap-utilization across all four dimensions, 0..1+. */
  worstRatio: number;
  /** Unix ms when the binding constraint window will reset.
   *  Anchored 5hr window → anchor + 5hr; rolling → oldest in-window row + window. */
  nextResetMs?: number;
  /** Per-dimension reset times (Unix ms). Both 5hr dimensions reset at the
   *  same time; both 7d dimensions reset at the same time. Used by the
   *  dashboard to show per-dimension reset countdowns. */
  dimensionResets?: DimensionReset;
  /** True when the supplied fiveHrWindowStart anchor is older than the
   *  5hr window. The caller should clearFiveHrWindowStart() so the next
   *  tick with bot activity can re-stamp a fresh anchor. The decision's
   *  fiveHr totals fall back to rolling now-5hr math while the flag is
   *  set, so the gate still works during the cleanup transition. */
  fiveHrWindowExpired?: boolean;
}

const EMPTY_TOTALS: WindowTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export interface DimensionReset {
  fiveHrInput: number;
  fiveHrOutput: number;
  sevenDInput: number;
  sevenDOutput: number;
}

export interface BudgetInputs {
  rows: UsageRow[];
  botSessionPaths: Set<string>;
  caps: BudgetCaps;
  now: number;
  /** Anchored start of the current 5hr Anthropic-Max-aligned window
   *  (read from ocean_bot_state via journal.getFiveHrWindowStart()).
   *  - null/undefined: rolling now-5hr fallback (back-compat).
   *  - set + unexpired: 5hr cap counts rows with ts >= anchor.
   *  - set + expired (now - anchor > 5hr): result.fiveHrWindowExpired is
   *    true and 5hr math falls back to rolling, caller clears the
   *    anchor so the next tick with bot activity stamps a fresh one. */
  fiveHrWindowStart?: number | null;
}

/** Account for /goal evaluator overhead by estimating evaluator turns based
 *  on output tokens. If output suggests /goal was used (evaluator cost not
 *  visible in stream-json), add the fudge factor per estimated turn. */
export function estimateGoalOverhead(outputTokens: number): number {
  // /goal evaluator runs once per main turn. If output_tokens seem suspiciously
  // low relative to input (common with cache hits + evaluator overhead), estimate
  // and add overhead. Heuristic: if output < input/100 and output > 0, likely /goal.
  // For now, conservatively add 1-turn overhead if the ratio suggests evaluator was active.
  // This is imperfect but safer than undercounting.
  if (outputTokens > 0 && outputTokens < 500) {
    // Conservative: add overhead for 1 evaluator turn (1-turn safety margin).
    // Real sessions may use 1-5 turns; 1 is the safe underestimate.
    return GOAL_EVALUATOR_OUTPUT_OVERHEAD;
  }
  return 0;
}

/** Compute Unix-ms reset times for each dimension. Both 5hr dimensions
 *  reset at the same time (anchor + 5hr or oldest 5hr row + 5hr); both
 *  7d dimensions reset at the same time (oldest 7d row + 7d). Returns
 *  reset times for all four dimensions for dashboard display. */
export function computeDimensionResets(input: {
  rows: UsageRow[];
  botSessionPaths: Set<string>;
  now: number;
  fiveHrWindowStart?: number | null;
}): DimensionReset {
  const { rows, botSessionPaths, now } = input;
  const anchor = input.fiveHrWindowStart ?? null;

  const botRows = rows.filter((r) => botSessionPaths.has(r.sessionPath));
  const fiveHrRows = botRows.filter((r) => now - r.ts <= FIVE_HR_MS);
  const sevenDRows = botRows.filter((r) => now - r.ts <= SEVEN_D_MS);

  // 5hr reset: anchor + 5hr if anchor is set, else oldest 5hr row + 5hr, else now
  const fiveHrResetMs = (() => {
    if (anchor !== null && anchor !== undefined) return anchor + FIVE_HR_MS;
    if (fiveHrRows.length === 0) return now;
    const oldest = Math.min(...fiveHrRows.map((r) => r.ts));
    return oldest + FIVE_HR_MS;
  })();

  // 7d reset: oldest 7d row + 7d, else now
  const sevenDResetMs = (() => {
    if (sevenDRows.length === 0) return now;
    const oldest = Math.min(...sevenDRows.map((r) => r.ts));
    return oldest + SEVEN_D_MS;
  })();

  return {
    fiveHrInput: fiveHrResetMs,
    fiveHrOutput: fiveHrResetMs,
    sevenDInput: sevenDResetMs,
    sevenDOutput: sevenDResetMs,
  };
}

export function decideBudget(input: BudgetInputs): BudgetDecision {
  const { rows, botSessionPaths, caps, now } = input;
  const anchor = input.fiveHrWindowStart ?? null;
  const anchorExpired = anchor !== null && now - anchor > FIVE_HR_MS;
  const effectiveAnchor = anchorExpired ? null : anchor;

  const botRows = rows.filter((r) => botSessionPaths.has(r.sessionPath));

  const fiveHrRows =
    effectiveAnchor !== null
      ? botRows.filter((r) => r.ts >= effectiveAnchor)
      : botRows.filter((r) => now - r.ts <= FIVE_HR_MS);
  const sevenDRows = botRows.filter((r) => now - r.ts <= SEVEN_D_MS);

  const fiveHr = sumRows(fiveHrRows);
  const sevenD = sumRows(sevenDRows);

  // Add /goal evaluator overhead estimate to output tokens (not visible in stream-json but billed).
  // This makes cap comparisons account for the hidden evaluator cost per turn.
  const fiveHrWithGoalOverhead = {
    ...fiveHr,
    outputTokens: fiveHr.outputTokens + estimateGoalOverhead(fiveHr.outputTokens),
  };
  const sevenDWithGoalOverhead = {
    ...sevenD,
    outputTokens: sevenD.outputTokens + estimateGoalOverhead(sevenD.outputTokens),
  };

  const ratios = [
    fiveHrWithGoalOverhead.inputTokens / caps.fiveHrInput,
    fiveHrWithGoalOverhead.outputTokens / caps.fiveHrOutput,
    sevenDWithGoalOverhead.inputTokens / caps.sevenDInput,
    sevenDWithGoalOverhead.outputTokens / caps.sevenDOutput,
  ];
  const worstRatio = Math.max(...ratios);

  // Which window is the binding constraint? Used to compute nextResetMs.
  // Use overhead-adjusted values to match the worstRatio calculation.
  const bindingIs5hr =
    Math.max(
      fiveHrWithGoalOverhead.inputTokens / caps.fiveHrInput,
      fiveHrWithGoalOverhead.outputTokens / caps.fiveHrOutput,
    ) === worstRatio;

  let nextResetMs: number | undefined;
  if (worstRatio > 0) {
    if (bindingIs5hr && effectiveAnchor !== null) {
      nextResetMs = effectiveAnchor + FIVE_HR_MS;
    } else {
      const windowRows = bindingIs5hr ? fiveHrRows : sevenDRows;
      const windowMs = bindingIs5hr ? FIVE_HR_MS : SEVEN_D_MS;
      if (windowRows.length > 0) {
        const oldest = Math.min(...windowRows.map((r) => r.ts));
        nextResetMs = oldest + windowMs;
      }
    }
  }

  const dimensionResets = computeDimensionResets({
    rows,
    botSessionPaths,
    now,
    fiveHrWindowStart: effectiveAnchor,
  });

  const base = {
    fiveHr,
    sevenD,
    caps,
    worstRatio,
    nextResetMs,
    dimensionResets,
    ...(anchorExpired ? { fiveHrWindowExpired: true as const } : {}),
  };

  if (worstRatio >= 1.0) {
    return {
      gate: "stop",
      reason: bindingIs5hr ? "5hr window at cap" : "7d window at cap",
      ...base,
    };
  }

  if (worstRatio >= caps.warnRatio) {
    return {
      gate: "wait",
      reason: `within ${Math.round((1 - caps.warnRatio) * 100)}% of cap`,
      ...base,
    };
  }

  return {
    gate: "ok",
    ...base,
  };
}

// ----------------------------------------------------------------------
// Per-project budget gates (security-per-project-token-cap).
// ----------------------------------------------------------------------

export interface ProjectGate {
  /** Project name (adapter name, e.g., "code2wiki"). */
  project: string;
  gate: BudgetGate;
  reason?: string;
  worstRatio: number;
  /** Resolved sub-caps (share * global cap, per dimension). Useful for
   *  the dashboard's per-project bars. */
  subCaps: {
    fiveHrInput: number;
    fiveHrOutput: number;
    sevenDInput: number;
    sevenDOutput: number;
  };
  fiveHr: WindowTotals;
  sevenD: WindowTotals;
}

export interface DecideProjectBudgetsInput {
  /** Pre-grouped per-project usage rows. Caller (index.ts) is
   *  responsible for the grouping. See planning gap above. */
  rowsByProject: Map<string, UsageRow[]>;
  caps: BudgetCaps;
  now: number;
  /** Same anchor semantics as `decideBudget`. The 5hr window math here
   *  mirrors the global path: if an anchor is set and unexpired, the
   *  per-project 5hr count uses ts >= anchor; otherwise rolling now-5hr. */
  fiveHrWindowStart?: number | null;
}

/**
 * Compute a per-project gate for each project with a `perProject`
 * sub-cap configured. Returns an empty map when `caps.perProject` is
 * undefined (graceful fallback — behavior identical to today's single
 * pool). Projects configured in `perProject` but absent from
 * `rowsByProject` still get a gate row with zero usage (so the
 * dashboard can render their bars at 0%).
 */
export function decideProjectBudgets(
  input: DecideProjectBudgetsInput,
): Map<string, ProjectGate> {
  const { rowsByProject, caps, now } = input;
  const out = new Map<string, ProjectGate>();
  if (!caps.perProject) return out;

  const anchor = input.fiveHrWindowStart ?? null;
  const anchorExpired = anchor !== null && now - anchor > FIVE_HR_MS;
  const effectiveAnchor = anchorExpired ? null : anchor;

  for (const [project, { share }] of Object.entries(caps.perProject)) {
    const projectRows = rowsByProject.get(project) ?? [];
    const fiveHrRows =
      effectiveAnchor !== null
        ? projectRows.filter((r) => r.ts >= effectiveAnchor)
        : projectRows.filter((r) => now - r.ts <= FIVE_HR_MS);
    const sevenDRows = projectRows.filter((r) => now - r.ts <= SEVEN_D_MS);
    const fiveHr = sumRows(fiveHrRows);
    const sevenD = sumRows(sevenDRows);

    const subCaps = {
      fiveHrInput: caps.fiveHrInput * share,
      fiveHrOutput: caps.fiveHrOutput * share,
      sevenDInput: caps.sevenDInput * share,
      sevenDOutput: caps.sevenDOutput * share,
    };

    // Mirror decideBudget: add hidden /goal evaluator overhead to output
    // before ratio math. Per-project totals stay untouched (display value)
    // but the ratio adjustment matches what we do at the global gate so
    // sub-cap triggers fire at the same evaluator-aware threshold.
    const fiveHrOutputAdjusted =
      fiveHr.outputTokens + estimateGoalOverhead(fiveHr.outputTokens);
    const sevenDOutputAdjusted =
      sevenD.outputTokens + estimateGoalOverhead(sevenD.outputTokens);

    const ratios = [
      subCaps.fiveHrInput > 0 ? fiveHr.inputTokens / subCaps.fiveHrInput : 0,
      subCaps.fiveHrOutput > 0 ? fiveHrOutputAdjusted / subCaps.fiveHrOutput : 0,
      subCaps.sevenDInput > 0 ? sevenD.inputTokens / subCaps.sevenDInput : 0,
      subCaps.sevenDOutput > 0 ? sevenDOutputAdjusted / subCaps.sevenDOutput : 0,
    ];
    const worstRatio = Math.max(...ratios);

    let gate: BudgetGate;
    let reason: string | undefined;
    if (worstRatio >= 1.0) {
      gate = "stop";
      reason = `project ${project} at sub-cap (share ${share})`;
    } else if (worstRatio >= caps.warnRatio) {
      gate = "wait";
      reason = `project ${project} within ${Math.round(
        (1 - caps.warnRatio) * 100,
      )}% of sub-cap`;
    } else {
      gate = "ok";
    }

    out.set(project, {
      project,
      gate,
      ...(reason !== undefined ? { reason } : {}),
      worstRatio,
      subCaps,
      fiveHr,
      sevenD,
    });
  }
  return out;
}

function sumRows(rows: UsageRow[]): WindowTotals {
  if (rows.length === 0) return { ...EMPTY_TOTALS };
  return rows.reduce(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheRead: acc.cacheRead + r.cacheRead,
      cacheWrite: acc.cacheWrite + r.cacheWrite,
    }),
    { ...EMPTY_TOTALS },
  );
}

// ----------------------------------------------------------------------
// Transcript loading. Tolerant of Claude Code's evolving JSONL shape,
// any line that doesn't parse as JSON, or doesn't have a usage block,
// is silently skipped.
// ----------------------------------------------------------------------

export interface LoadOptions {
  /** Root directory containing per-project Claude Code transcript dirs.
   * Defaults to ~/.claude/projects/ */
  claudeProjectsDir?: string;
  /** Skip rows older than this Unix ms (inclusive). Defaults to 7d ago. */
  sinceMs?: number;
}

export async function loadUsageRows(
  opts: LoadOptions = {},
): Promise<UsageRow[]> {
  const root =
    opts.claudeProjectsDir ?? path.join(os.homedir(), ".claude", "projects");
  const since = opts.sinceMs ?? Date.now() - SEVEN_D_MS;

  let projectDirs: string[];
  try {
    projectDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }

  const rows: UsageRow[] = [];
  for (const dir of projectDirs) {
    const files = await listJsonlRecursive(dir);
    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        // Cheap skip: file's last modification before our window.
        if (stat.mtimeMs < since) continue;
        const text = await fs.readFile(file, "utf-8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          const row = parseLine(line, file);
          if (row && row.ts >= since) rows.push(row);
        }
      } catch {
        // ignore unreadable files
      }
    }
  }
  return rows;
}

async function listJsonlRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listJsonlRecursive(p)));
    } else if (e.isFile() && p.endsWith(".jsonl")) {
      out.push(p);
    }
  }
  return out;
}

export function parseLine(line: string, sessionPath: string): UsageRow | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  // Claude Code's transcript format varies; try a few shapes.
  const msg = (o["message"] as Record<string, unknown> | undefined) ?? undefined;
  const usage = (msg?.["usage"] ?? o["usage"]) as
    | Record<string, unknown>
    | undefined;
  if (!usage) return null;

  const tsRaw = o["timestamp"] ?? o["ts"] ?? msg?.["timestamp"];
  const ts = parseTs(tsRaw);
  if (ts === null) return null;

  const modelRaw = msg?.["model"] ?? o["model"];
  const model = typeof modelRaw === "string" ? modelRaw : "unknown";

  return {
    ts,
    sessionPath,
    inputTokens: numField(usage, "input_tokens"),
    outputTokens: numField(usage, "output_tokens"),
    cacheRead: numField(usage, "cache_read_input_tokens"),
    cacheWrite: numField(usage, "cache_creation_input_tokens"),
    model,
  };
}

function parseTs(v: unknown): number | null {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function numField(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ----------------------------------------------------------------------
// Bot session attribution. Runner writes one JSONL line per spawned
// `claude -p` session into ~/.ocean-bot/sessions.jsonl with
// { sessionPath, runId, startedAt, project }. We read those to filter
// usage. `project` may be absent on sessions written before this was
// added; loadBotSessions normalises those to project="unknown".
// ----------------------------------------------------------------------

export interface BotSession {
  sessionPath: string;
  runId: string;
  startedAt: number;
  /** Adapter name (e.g. "code2wiki", "ocean-bot"). Absent on sessions
   *  written before project attribution shipped; loaded as "unknown". */
  project?: string;
}

export async function loadBotSessions(filePath: string): Promise<BotSession[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf-8");
  } catch {
    return [];
  }
  const out: BotSession[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const sp = o["sessionPath"];
      const id = o["runId"];
      const sa = o["startedAt"];
      if (typeof sp === "string" && typeof id === "string" && typeof sa === "number") {
        const proj = typeof o["project"] === "string" ? o["project"] : "unknown";
        out.push({ sessionPath: sp, runId: id, startedAt: sa, project: proj });
      }
    } catch {
      // skip malformed
    }
  }
  return out;
}

export async function appendBotSession(
  filePath: string,
  session: BotSession,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(session) + "\n", "utf-8");
}
