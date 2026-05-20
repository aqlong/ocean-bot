// Per-task model selection. Before this helper, model choice was a single
// `description.length > 200 ? opus : sonnet` line, every detailed backlog
// item burned opus, haiku was never used, no severity awareness, no budget
// awareness. Direct hit on the Max-plan budget.
//
// selectModel() combines five signals into the final pick, in this order:
//
//   1. Baseline      , candidate.suggestedModel (adapter hint) OR per-queue
//                       default. Roadmap defaults to opus (architectural);
//                       most other queues default to sonnet.
//   2. Keyword override, opus keywords ("investigation", "concurrency", ...)
//                       upgrade; haiku keywords ("rename", "format", ...)
//                       downgrade. Word-boundary match to avoid substring
//                       false positives.
//   3. Severity       , `critical` always opus; `cosmetic` capped at sonnet;
//                       `minor` opus only if an opus keyword fired.
//   4. Failure-retry  , if the same taskId failed on sonnet earlier, retry
//                       with opus. (Opus failures are not auto-retried,
//                       route to operator.)
//   5. Budget throttle, when budget worstRatio > 0.75, downgrade one tier.
//                       (> 0.9 returns gate='wait' upstream so we never get
//                       here.)
//
// Pure function. No DB, no env, no clock. Tests drive every branch directly.

import type { Model, Severity, TaskCandidate, Queue } from "./adapters/types.js";

const MODEL_ORDER: readonly Model[] = ["haiku", "sonnet", "opus"];

/** Default model per queue when the adapter doesn't supply one.
 *
 *  Backlog gets "sonnet" as a conservative fallback; the code2wiki adapter
 *  itself sets suggestedModel from BACKLOG_CATEGORY_DEFAULTS based on the
 *  backlog row's `category` column, so this fallback only fires when the
 *  adapter forgets to set it (defensive). */
const QUEUE_DEFAULTS: Record<Queue, Model> = {
  backlog: "sonnet",
  "bug-fix": "sonnet",
  "gap-closure": "sonnet",
  tightening: "sonnet",
  roadmap: "opus",
  "self-learning": "sonnet",
  refactor: "sonnet",
  creative: "sonnet",
};

/** Default model per backlog category. Exported so the adapter can populate
 *  candidate.suggestedModel uniformly. */
export const BACKLOG_CATEGORY_DEFAULTS: Record<string, Model> = {
  docs: "haiku",
  chore: "haiku",
  test: "sonnet",
  refactor: "sonnet",
  feature: "sonnet",
  bug: "sonnet",
  roadmap: "opus",
  other: "sonnet",
};

/** Keywords whose presence in a task summary upgrades the pick to opus.
 *  Matched with word boundaries; "schema change" must appear as that
 *  two-word phrase. */
const OPUS_KEYWORDS: readonly string[] = [
  "investigation",
  "design",
  "race",
  "concurrency",
  "unclear",
  "research",
  "tradeoff",
  "migration",
  "schema change",
  "subtle",
  "break",
];

/** Keywords whose presence downgrades to haiku (mechanical work). */
const HAIKU_KEYWORDS: readonly string[] = [
  "rename",
  "delete",
  "format",
  "move file",
  "update copy",
  "typo",
  "whitespace",
  "prettier",
  "license header",
];

export interface ModelSelectContext {
  /** Highest cap-utilization observed across all budget windows, 0..1+. */
  budgetWorstRatio?: number;
  /** If the same taskId failed in a prior tick, the model that failed.
   *  sonnet → opus retry; opus failures don't auto-retry. */
  previousFailedModel?: Model;
}

export function selectModel(
  candidate: TaskCandidate,
  ctx: ModelSelectContext = {},
): Model {
  const baseline =
    candidate.suggestedModel ?? QUEUE_DEFAULTS[candidate.queue] ?? "sonnet";

  const summary = candidate.summary;
  const opusKeyword = hasKeyword(summary, OPUS_KEYWORDS);
  const haikuKeyword = hasKeyword(summary, HAIKU_KEYWORDS);

  // Keyword overrides: haiku wins ties (last-write) because mechanical-work
  // signals are more reliable than complexity signals (a "rename" might also
  // mention "migration", the rename is the action, the migration context).
  let pick: Model = baseline;
  if (opusKeyword) pick = "opus";
  if (haikuKeyword) pick = "haiku";

  // Severity overrides. Critical wins over everything (a critical bug fix
  // gets opus even if the summary contains "rename"). Cosmetic caps at
  // sonnet (no need to burn opus on a typo even if "design" appears).
  const sev: Severity = candidate.severity ?? "unspecified";
  if (sev === "critical") {
    pick = "opus";
  } else if (sev === "cosmetic") {
    pick = capAt(pick, "sonnet");
  } else if (sev === "minor" && pick === "opus" && !opusKeyword) {
    pick = "sonnet";
  }

  // Failure-aware retry: a previous sonnet attempt failed → escalate to opus
  // on this retry. Don't downgrade an already-opus pick.
  if (ctx.previousFailedModel === "sonnet" && pick === "sonnet") {
    pick = "opus";
  }

  // Token-budget throttle: 75-90% utilization → downgrade one tier.
  // Above 90% the upstream gate returns "wait" so this branch is only the
  // 0.75..0.90 band in practice. Critical-severity opus picks bypass throttle.
  if (
    ctx.budgetWorstRatio !== undefined &&
    ctx.budgetWorstRatio > 0.75 &&
    sev !== "critical"
  ) {
    pick = downgrade(pick);
  }

  return pick;
}

function hasKeyword(text: string, keywords: readonly string[]): boolean {
  for (const k of keywords) {
    // Allow flexible whitespace between words in multi-word phrases.
    const escaped = k.replace(/\s+/g, "\\s+");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

function downgrade(m: Model): Model {
  const i = MODEL_ORDER.indexOf(m);
  if (i <= 0) return "haiku";
  return MODEL_ORDER[i - 1]!;
}

function capAt(m: Model, max: Model): Model {
  const mi = MODEL_ORDER.indexOf(m);
  const ci = MODEL_ORDER.indexOf(max);
  return MODEL_ORDER[Math.min(mi, ci)]!;
}
