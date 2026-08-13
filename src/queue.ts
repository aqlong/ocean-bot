// Leverage queue picker. Calls every adapter's queue methods, flattens
// candidates, scores them, picks the top one.
//
// Diversity guard: if the last N runs all came from the same queue,
// down-weight that queue to break tunnel vision.

import type {
  ProjectAdapter,
  TaskCandidate,
  Queue,
} from "./adapters/types.js";

export interface PickerContext {
  /** Queues of recent runs, newest-first. Used for diversity guard. */
  recentQueues: Queue[];
  /** Cap on est tokens above which we apply a leverage penalty. */
  expensiveTokenThreshold: number;
  /** How many recent runs constitute "same-queue tunnel vision". */
  diversityWindow: number;
}

export const DEFAULT_PICKER_CTX: PickerContext = {
  recentQueues: [],
  expensiveTokenThreshold: 50_000,
  diversityWindow: 3,
};

export interface ScoredCandidate extends TaskCandidate {
  score: number;
  scoreBreakdown: Record<string, number>;
  project: string;
}

export async function collectCandidates(
  adapter: ProjectAdapter,
): Promise<TaskCandidate[]> {
  const calls: Array<{ q: Queue; fn: () => Promise<TaskCandidate[]> }> = [
    { q: "backlog", fn: () => adapter.backlog() },
    { q: "bug-fix", fn: () => adapter.bugFix() },
    { q: "gap-closure", fn: () => adapter.gapClosure() },
    { q: "tightening", fn: () => adapter.tightening() },
    { q: "roadmap", fn: () => adapter.roadmap() },
    { q: "self-learning", fn: () => adapter.selfLearning() },
    { q: "refactor", fn: () => adapter.refactor() },
    { q: "creative", fn: () => adapter.creative() },
  ];

  const settled = await Promise.allSettled(calls.map((c) => c.fn()));
  const out: TaskCandidate[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const call = calls[i];
    if (!s || !call) continue;
    if (s.status === "fulfilled") {
      for (const c of s.value) {
        // Adapter is the source of truth for queue tag, but enforce
        // consistency just in case.
        out.push({ ...c, queue: call.q });
      }
    }
  }
  return out;
}

export function scoreCandidate(
  c: TaskCandidate,
  project: string,
  ctx: PickerContext,
): ScoredCandidate {
  const breakdown: Record<string, number> = {};
  let score = c.leverage;
  breakdown["base_leverage"] = c.leverage;

  if (c.estTokens > ctx.expensiveTokenThreshold) {
    breakdown["expensive_penalty"] = -10;
    score -= 10;
  }
  if (c.dangerHint === "caution") {
    breakdown["caution_penalty"] = -5;
    score -= 5;
  }
  if (c.dangerHint === "super-dangerous") {
    breakdown["super_dangerous_penalty"] = -25;
    score -= 25;
  }

  const recent = ctx.recentQueues.slice(0, ctx.diversityWindow);
  if (recent.length >= ctx.diversityWindow && recent.every((q) => q === c.queue)) {
    breakdown["diversity_penalty"] = -15;
    score -= 15;
  }

  return { ...c, score, scoreBreakdown: breakdown, project };
}

export function pickTop(
  candidates: ScoredCandidate[],
): ScoredCandidate | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b.score - a.score)[0] ?? null;
}

export interface PickNextInputs {
  adapters: ProjectAdapter[];
  ctx: PickerContext;
  /** taskIds that already have an in-flight run per project. Used to
   *  dedup so the picker doesn't keep creating duplicate runs. */
  excludeTaskIdsByProject?: Map<string, Set<string>>;
  /** Whole projects to skip this tick (e.g., over per-project budget
   *  sub-cap). When a project is excluded, its adapter is not consulted
   *  at all, the picker falls through to other projects. */
  excludeProjects?: Set<string>;
}

export async function pickNext(
  inputs: PickNextInputs,
): Promise<ScoredCandidate | null> {
  const { adapters, ctx, excludeTaskIdsByProject, excludeProjects } = inputs;
  const all: ScoredCandidate[] = [];
  for (const adapter of adapters) {
    if (excludeProjects?.has(adapter.name)) continue;
    const cands = await collectCandidates(adapter);
    const excluded = excludeTaskIdsByProject?.get(adapter.name);
    for (const c of cands) {
      if (excluded && c.taskId && excluded.has(c.taskId)) continue;
      all.push(scoreCandidate(c, adapter.name, ctx));
    }
  }
  return pickTop(all);
}
