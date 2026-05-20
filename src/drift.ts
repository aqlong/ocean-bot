// Per-tick drift gate. The boot wrapper (scripts/ocean-bot-launch.sh)
// stamps the SHA it built dist/ from into dist/.built-from-sha. Each
// tick compares that SHA to the repo's current HEAD: if they diverge,
// the operator has moved the working tree under us (checkout, pull,
// rebase) and the running JS is now stale. We surface the gap to the
// dashboard and skip the tick instead of executing stale code.
//
// Recovery is via launchd: bot exits → KeepAlive restarts → wrapper
// runs → re-pulls + re-builds + re-stamps. We deliberately do NOT
// auto-rebuild from inside the running process; hot-swapping a Node
// runtime is risky (require-cache, in-flight handlers).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { currentBranch, git, headSha } from "./util/git.js";

export const DRIFT_STATE_KEY = "drift";

export type DriftReason =
  | "missing_built_from_sha"
  | "head_unreadable"
  | "sha_mismatch"
  | "sha_mismatch_non_bot_paths";

export interface DriftResult {
  drift: boolean;
  reason: DriftReason | null;
  builtFromSha: string | null;
  headSha: string | null;
  branch: string | null;
  /** ISO timestamp of dist/.built-from-sha mtime, i.e. when the boot
   *  wrapper last stamped a build. null when the file is missing. */
  builtAt: string | null;
  /** When sha_mismatch is downgraded to non_bot_paths, the list of
   *  paths inspected. Lets /health show "5 docs commits since build,
   *  bot OK" without re-running git. Empty otherwise. */
  nonBotPaths: string[];
}

/** Paths whose changes REQUIRE a bot rebuild (drift fires).
 *  Anything outside these prefixes is treated as a docs/dashboard/c2w
 *  change that does NOT affect the running JS, so drift downgrades to
 *  sha_mismatch_non_bot_paths and the tick proceeds. */
const BOT_AFFECTING_PREFIXES = [
  "tools/ocean-bot/src/",
  "tools/ocean-bot/scripts/",
  "tools/ocean-bot/package.json",
  "tools/ocean-bot/package-lock.json",
  "tools/ocean-bot/tsconfig.json",
  "tools/ocean-bot/tsconfig.build.json",
];

export function isBotAffectingPath(p: string): boolean {
  for (const prefix of BOT_AFFECTING_PREFIXES) {
    if (p === prefix || p.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Compare the SHA the wrapper stamped at boot to the repo's current
 * HEAD. Returns a non-drift result only when both reads succeed AND
 * the SHAs match.
 *
 * Pure-ish: takes the directories as arguments so tests can stand
 * up synthetic layouts. Errors reading either path surface as a
 * drift result, never an exception, so the tick loop can decide
 * what to do without a try/catch.
 */
export async function detectDrift(
  repoDir: string,
  builtFromShaPath: string,
): Promise<DriftResult> {
  let builtFromSha: string | null = null;
  let builtAt: string | null = null;
  try {
    const raw = await fs.readFile(builtFromShaPath, "utf8");
    const trimmed = raw.trim();
    if (trimmed === "") {
      return {
        drift: true,
        reason: "missing_built_from_sha",
        builtFromSha: null,
        headSha: null,
        branch: await currentBranchOrNull(repoDir),
        builtAt: null,
        nonBotPaths: [],
      };
    }
    builtFromSha = trimmed;
    const st = await fs.stat(builtFromShaPath);
    builtAt = new Date(st.mtimeMs).toISOString();
  } catch {
    return {
      drift: true,
      reason: "missing_built_from_sha",
      builtFromSha: null,
      headSha: null,
      branch: await currentBranchOrNull(repoDir),
      builtAt: null,
      nonBotPaths: [],
    };
  }

  const branch = await currentBranchOrNull(repoDir);
  const head = await headSha(repoDir);
  if (!head) {
    return {
      drift: true,
      reason: "head_unreadable",
      builtFromSha,
      headSha: null,
      branch,
      builtAt,
      nonBotPaths: [],
    };
  }

  // The reference for drift is `origin/main`, NOT local HEAD. Reason:
  // when claude makes a commit during a bot run, it lands on LOCAL main
  // and bumps HEAD even though nothing has been pushed. The dist on disk
  // is still consistent with origin/main (the wrapper built from that
  // exact SHA). Comparing to local HEAD would treat the bot's own WIP
  // commit as "drift", fire the gate, skip the tick, and prevent the
  // push that would actually advance origin/main. Result: bot stuck in
  // drift skip loop until manual restart, fix shipped 2026-05-16.
  //
  // Falls back to local HEAD when origin/main is unreadable (offline /
  // detached / fresh clone with no remote tracking). In that mode the
  // gate behaves as before.
  const referenceSha = (await readOriginMain(repoDir)) ?? head;

  if (referenceSha !== builtFromSha) {
    // Direction matters. We only care about commits in `reference` that
    // built doesn't have (reference is AHEAD of built → potentially stale
    // dist). If reference is BEHIND built (built has un-pushed commits
    // like claude's bot-run WIP), there is no drift, we're running JS
    // built from MORE-RECENT src than what's on origin. Use `rev-list
    // built..reference` to ask the directional question; an empty result
    // means reference is an ancestor of built (or equal), so dist is up
    // to date or even newer. Surfacing this as `drift=false reason=null`
    // keeps the state-row simple. Bug shipped + fixed 2026-05-16 after
    // bot's local WIP commit caused a false drift on first tick after
    // restart.
    const aheadResult = await git(repoDir, [
      "rev-list",
      "--count",
      `${builtFromSha}..${referenceSha}`,
    ]);
    const aheadCount =
      aheadResult.code === 0 ? parseInt(aheadResult.stdout.trim(), 10) : NaN;
    if (Number.isFinite(aheadCount) && aheadCount === 0) {
      // Reference is at-or-behind built. No new src to worry about.
      return {
        drift: false,
        reason: null,
        builtFromSha,
        headSha: head,
        branch,
        builtAt,
        nonBotPaths: [],
      };
    }

    // Reference IS ahead. Inspect the path-filter on the directional
    // diff (commits in reference not in built). If only docs / dashboard
    // / c2w paths changed, downgrade to non-bot-paths.
    const changedPaths = await diffPathsInRange(
      repoDir,
      builtFromSha,
      referenceSha,
    );
    const botPaths = changedPaths.filter(isBotAffectingPath);
    if (botPaths.length === 0) {
      return {
        drift: false,
        reason: "sha_mismatch_non_bot_paths",
        builtFromSha,
        headSha: head,
        branch,
        builtAt,
        nonBotPaths: changedPaths,
      };
    }
    return {
      drift: true,
      reason: "sha_mismatch",
      builtFromSha,
      headSha: head,
      branch,
      builtAt,
      nonBotPaths: [],
    };
  }

  return {
    drift: false,
    reason: null,
    builtFromSha,
    headSha: head,
    branch,
    builtAt,
    nonBotPaths: [],
  };
}

/** Read origin/main's SHA via git rev-parse. Returns null on any error
 *  (offline, no remote tracking, fresh clone). Caller falls back to
 *  local HEAD in that case for back-compat with single-machine dev. */
async function readOriginMain(repoDir: string): Promise<string | null> {
  const r = await git(repoDir, ["rev-parse", "--verify", "-q", "origin/main"]);
  if (r.code !== 0) return null;
  const trimmed = r.stdout.trim();
  return trimmed === "" ? null : trimmed;
}

/** Return the changed-path list for `<from>..<to>` via git. On any git
 *  error (e.g. one SHA missing from local refs), return an empty list
 *  so the caller treats it as a non-bot diff (lenient: drift won't
 *  fire on an unverifiable range). */
async function diffPathsInRange(
  repoDir: string,
  fromSha: string,
  toSha: string,
): Promise<string[]> {
  const r = await git(repoDir, [
    "diff",
    "--name-only",
    `${fromSha}..${toSha}`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function currentBranchOrNull(repoDir: string): Promise<string | null> {
  const b = await currentBranch(repoDir);
  return b === "" ? null : b;
}

/**
 * Resolve the dist/.built-from-sha path + repo root from the location
 * of the currently-executing compiled module. Layout under prod:
 *   <repo>/tools/ocean-bot/dist/index.js
 *   <repo>/tools/ocean-bot/dist/.built-from-sha
 * so the SHA file sits next to the entry point and the repo is three
 * levels up.
 *
 * Returns null when the layout doesn't match (e.g. running via tsx in
 * dev) so the caller can skip the gate cleanly instead of false-firing.
 */
export function resolveDriftPaths(moduleDirname: string): {
  repoDir: string;
  builtFromShaPath: string;
} | null {
  const distLeaf = path.basename(moduleDirname);
  if (distLeaf !== "dist") return null;
  const repoDir = path.resolve(moduleDirname, "..", "..", "..");
  const builtFromShaPath = path.join(moduleDirname, ".built-from-sha");
  return { repoDir, builtFromShaPath };
}
