// Git helpers used by the bot. Thin shell wrappers; child_process so
// the bot can run on any machine with git installed (no isomorphic-git
// dependency).

import { spawn } from "node:child_process";
import type { DiffSummary } from "../adapters/types.js";

export interface GitCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<GitCmdResult> {
  return new Promise((resolve) => {
    const p = spawn("git", args, { cwd, env: env ?? process.env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
    p.on("error", () => resolve({ code: -1, stdout: out, stderr: err }));
  });
}

export async function isClean(cwd: string): Promise<boolean> {
  // Ignore untracked files, the bot's own dist/, node_modules/, and
  // tooling output show up as untracked and would falsely block ticks.
  // What we actually care about is uncommitted changes to tracked files.
  const r = await git(cwd, ["status", "--porcelain", "--untracked-files=no"]);
  return r.code === 0 && r.stdout.trim() === "";
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

export async function headSha(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "HEAD"]);
  return r.stdout.trim();
}

/** Full commit message (subject + body, %B) for the given sha. Returns
 *  empty string on git failure so callers can treat it as "no info" and
 *  fall through to the no-op path rather than throwing. */
export async function commitMessage(cwd: string, sha: string): Promise<string> {
  const r = await git(cwd, ["show", "-s", "--format=%B", sha]);
  if (r.code !== 0) return "";
  return r.stdout;
}

export async function diffStaged(cwd: string): Promise<DiffSummary> {
  return parseGitDiff(await git(cwd, ["diff", "--cached"]));
}

export async function diffSinceCommit(
  cwd: string,
  baseSha: string,
): Promise<DiffSummary> {
  return parseGitDiff(await git(cwd, ["diff", baseSha, "HEAD"]));
}

export function parseGitDiff(r: GitCmdResult): DiffSummary {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  let inHunk = false;

  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) {
      files.add(line.slice(6));
      inHunk = false;
    } else if (line.startsWith("--- a/")) {
      // ignore, capture from +++ side which reflects the new path
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+") && !line.startsWith("+++")) {
      added++;
    } else if (inHunk && line.startsWith("-") && !line.startsWith("---")) {
      removed++;
    }
  }

  return {
    files: [...files].sort(),
    added,
    removed,
    patch: r.stdout,
  };
}

export async function fileLastModified(cwd: string): Promise<number | null> {
  const r = await git(cwd, ["log", "-1", "--format=%ct"]);
  if (r.code !== 0) return null;
  const n = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n * 1000 : null;
}

/**
 * Capture uncommitted changes to tracked files as a stash commit stored
 * at `refName` (e.g. `refs/ocean-bot/orphan-edits/<runId>`), then hard-reset
 * the working tree. Untracked files are left alone (matches `isClean`'s
 * scope; we use `--untracked-files=no` everywhere).
 *
 * Used by the noop classifier when a claude run produces no commit but
 * leaves the tree dirty. Without this, every subsequent tick skips with
 * `dirty_tree_stale` until an operator manually stashes the file,
 * 2026-05-13 prod incident halted the bot for 16+ hours in this mode.
 *
 * Returns `{stashed:false}` when there is nothing to stash, or when the
 * underlying git plumbing fails. Callers should treat `stashed:false`
 * combined with a dirty tree (caller checks via `isClean`) as the
 * "stash failed, operator must inspect" path.
 */
export async function stashUncommittedToRef(
  cwd: string,
  refName: string,
): Promise<{ stashed: boolean; sha: string | null; changedFiles: number }> {
  const status = await git(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);
  if (status.code !== 0) {
    return { stashed: false, sha: null, changedFiles: 0 };
  }
  const lines = status.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) {
    return { stashed: false, sha: null, changedFiles: 0 };
  }
  const create = await git(cwd, ["stash", "create"]);
  const sha = create.stdout.trim();
  if (create.code !== 0 || !sha) {
    return { stashed: false, sha: null, changedFiles: lines.length };
  }
  const ur = await git(cwd, ["update-ref", refName, sha]);
  if (ur.code !== 0) {
    return { stashed: false, sha: null, changedFiles: lines.length };
  }
  // Reset tracked files to HEAD. Untracked files remain (matches the
  // bot's isClean policy elsewhere).
  const reset = await git(cwd, ["reset", "--hard", "HEAD"]);
  if (reset.code !== 0) {
    return { stashed: false, sha, changedFiles: lines.length };
  }
  return { stashed: true, sha, changedFiles: lines.length };
}

/** Is `sha` reachable as an ancestor (or equal to) the tip of `branch`?
 *  Used before pushing an approved run, if Ocean has rebased or reset
 *  away from the bot's commit, we DO NOT push a different commit; we
 *  fail the run with a clear reason. */
export async function commitReachable(
  cwd: string,
  sha: string,
  branch: string,
): Promise<boolean> {
  const r = await git(cwd, [
    "merge-base",
    "--is-ancestor",
    sha,
    branch,
  ]);
  return r.code === 0;
}
