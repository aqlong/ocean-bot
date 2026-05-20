// Reclassify `failed` bot runs whose commit IS on origin/{branch}.
// Surfaced 2026-05-12: the bot's push-step can fail (network blip,
// pre-push hook, GH auth) while the commit itself is fine; the
// operator then pushes manually. The run row stays `failed` in the
// DB but reality is "shipped via another channel." This module is
// the dashboard's render-time correction so counters and badges
// reflect reality without rewriting audit-bearing run state.

import { isCommitOnRemote } from "./github/commit-reach";
import { repoForProject } from "./github/project-repos";

export interface RunForReclassify {
  status: string;
  project: string;
  branch: string | null;
  commitSha: string | null;
}

export type Annotated<T> = T & { outOfBandShipped?: boolean };

/** Adds `outOfBandShipped: true` to every failed run whose commit is
 *  reachable from origin/{run.branch ?? "main"}. Non-failed runs and
 *  runs without a commit pass through unchanged. Network failures are
 *  swallowed inside `isCommitOnRemote`, so this never throws. */
export async function annotateFailedRuns<T extends RunForReclassify>(
  runs: readonly T[],
): Promise<Annotated<T>[]> {
  return Promise.all(
    runs.map(async (run): Promise<Annotated<T>> => {
      if (run.status !== "failed" || !run.commitSha) return run;
      const repo = repoForProject(run.project);
      if (!repo) return run;
      const branch = run.branch && run.branch.trim() ? run.branch : "main";
      const on = await isCommitOnRemote(run.commitSha, branch, repo);
      return on ? { ...run, outOfBandShipped: true } : run;
    }),
  );
}

export interface StatusTally {
  shipped: number;
  awaitingApproval: number;
  running: number;
  failed: number;
  rejected: number;
  total: number;
}

/** Returns a copy of `tally` with `outOfBand` moved from `failed`
 *  into `shipped`. Total is preserved. */
export function applyOutOfBandShipped(
  tally: StatusTally,
  outOfBand: number,
): StatusTally {
  const n = Math.max(0, Math.min(outOfBand, tally.failed));
  return {
    ...tally,
    failed: tally.failed - n,
    shipped: tally.shipped + n,
  };
}
