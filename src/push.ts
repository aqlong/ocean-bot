// Push gate. After the bot has made edits and committed locally, this
// module runs preflight commands, classifies danger, and either pushes
// (if mode allows + diff is safe) or marks the run awaiting-approval.

import { spawn } from "node:child_process";
import type {
  ProjectAdapter,
  DiffSummary,
  DangerReason,
} from "./adapters/types.js";
import { splitDangerReasons } from "./classifier.js";
import { log } from "./util/log.js";
import { git, isClean } from "./util/git.js";

export interface PreflightResult {
  ok: boolean;
  failures: PreflightFailure[];
}

export interface PreflightFailure {
  command: string;
  exitCode: number;
  tailLog: string;
}

export async function runPreflight(
  adapter: ProjectAdapter,
): Promise<PreflightResult> {
  const failures: PreflightFailure[] = [];
  for (const cmd of adapter.preflightCommands()) {
    const res = await runShell(cmd, adapter.rootDir);
    if (res.exitCode !== 0) {
      failures.push({
        command: cmd,
        exitCode: res.exitCode,
        tailLog: res.combined.slice(-2000),
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

function runShell(
  cmd: string,
  cwd: string,
): Promise<{ exitCode: number; combined: string }> {
  return new Promise((resolve) => {
    const p = spawn("bash", ["-lc", cmd], { cwd });
    let combined = "";
    p.stdout.on("data", (d) => (combined += d.toString()));
    p.stderr.on("data", (d) => (combined += d.toString()));
    p.on("close", (code) => resolve({ exitCode: code ?? 0, combined }));
    p.on("error", (err) => {
      combined += `\n${err.message}`;
      resolve({ exitCode: -1, combined });
    });
  });
}

export interface PushDecisionInputs {
  adapter: ProjectAdapter;
  diff: DiffSummary;
  preflight: PreflightResult;
  approvalMode: "manual" | "auto" | "auto-with-visual";
  /** Visual review verdict, if it ran. */
  visualVerdict?: "ok" | "regression" | "skipped";
}

export interface PushDecision {
  /** Final decision. */
  action: "push" | "await-approval" | "block";
  /** Human-readable reason, surfaced on dashboard. */
  reason: string;
  /** Super-dangerous rule hits, if any. */
  dangerReasons: DangerReason[];
}

export function decidePush(input: PushDecisionInputs): PushDecision {
  const dangerReasons = input.adapter.classifyDanger(input.diff);
  const { critical, advisory } = splitDangerReasons(dangerReasons);

  if (!input.preflight.ok) {
    return {
      action: "block",
      reason: `Preflight failed: ${input.preflight.failures.map((f) => f.command).join(", ")}`,
      dangerReasons,
    };
  }

  if (input.approvalMode === "manual") {
    return {
      action: "await-approval",
      reason: "approval mode = manual",
      dangerReasons,
    };
  }

  // Critical rules block under any non-manual mode. Advisory rules are
  // logged on the run (still in dangerReasons) but do not block.
  if (critical.length > 0) {
    return {
      action: "await-approval",
      reason: `Critical classifier hit${critical.length === 1 ? "" : "s"} (${critical.map((r) => `#${r.ruleId}`).join(", ")})`,
      dangerReasons,
    };
  }

  if (
    input.approvalMode === "auto-with-visual" &&
    input.visualVerdict === "regression"
  ) {
    return {
      action: "await-approval",
      reason: "visual reviewer flagged a regression",
      dangerReasons,
    };
  }

  const advisoryNote =
    advisory.length > 0
      ? `; advisory hits ignored under auto mode: ${advisory.map((r) => `#${r.ruleId}`).join(", ")}`
      : "";
  return {
    action: "push",
    reason: `preflight green, no critical classifier hits, approval mode permits${advisoryNote}`,
    dangerReasons,
  };
}

export interface PushResult {
  pushed: boolean;
  branch: string;
  reason?: string;
}

export async function pushToTarget(
  adapter: ProjectAdapter,
  branch: string,
): Promise<PushResult> {
  const target = adapter.pushTarget(branch);
  if (target === "pr-only") {
    return { pushed: false, branch, reason: "adapter requires PR-only" };
  }

  const remoteBranch = target === "main" ? "main" : "staging";
  log.info("push.attempt", {
    project: adapter.name,
    branch,
    remoteBranch,
  });
  // First push: simple no-force push to remote ref of same name.
  let r = await git(adapter.rootDir, ["push", "origin", `${branch}:${remoteBranch}`]);
  if (r.code === 0) {
    return { pushed: true, branch };
  }
  // If remote is ahead, fetch + rebase + retry once. NEVER force-push.
  log.warn("push.first_attempt_failed_attempting_rebase", {
    project: adapter.name,
    stderr: r.stderr.slice(-500),
  });
  // Rebase needs a clean tree. The tick-start isClean() check ran before
  // the claude run committed; an external process (the operator's editor
  // saving a file, another cron job) may have introduced unstaged changes
  // since. Bail out cleanly rather than letting `git rebase` fail with
  // "cannot rebase: You have unstaged changes." which leaves no useful
  // signal for the operator.
  if (!(await isClean(adapter.rootDir))) {
    return {
      pushed: false,
      branch,
      reason:
        "local tree dirty during rebase fallback, operator action required (git status)",
    };
  }
  const fetch = await git(adapter.rootDir, ["fetch", "origin", remoteBranch]);
  if (fetch.code !== 0) {
    return {
      pushed: false,
      branch,
      reason: `fetch failed: ${fetch.stderr.slice(-200)}`,
    };
  }
  const rebase = await git(adapter.rootDir, [
    "rebase",
    `origin/${remoteBranch}`,
  ]);
  if (rebase.code !== 0) {
    // Abort the rebase so we leave a clean working tree.
    await git(adapter.rootDir, ["rebase", "--abort"]);
    return {
      pushed: false,
      branch,
      reason: `rebase failed: ${rebase.stderr.slice(-200)}`,
    };
  }
  r = await git(adapter.rootDir, ["push", "origin", `${branch}:${remoteBranch}`]);
  if (r.code === 0) return { pushed: true, branch };
  return {
    pushed: false,
    branch,
    reason: `second push failed: ${r.stderr.slice(-200)}`,
  };
}
