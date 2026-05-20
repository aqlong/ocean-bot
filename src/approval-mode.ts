// Approval-mode resolver. Owns the precedence chain that turns
// "(project, queue)" into the concrete approval mode for a run.
//
// Precedence, highest first:
//   1. Per-project per-queue override from BotConfig (config-file only,
//      e.g. projects[*].approvalMode["bug-fix"] = "manual").
//   2. Dashboard /settings override stored in ocean_bot_state under the
//      `global_approval_mode` key. Lets the operator flip the global
//      mode at runtime without editing ~/.ocean-bot/config.json and
//      restarting the daemon. Invalid values fall through so a typo
//      can't disable the approval gate.
//   3. Config-file globalApprovalMode (default in DEFAULT_CONFIG is
//      "auto" since 2026-05-16; operators override via
//      ~/.ocean-bot/config.json).
//
// The DB-state path was added 2026-05-16. Before that the /settings
// radio wrote the value to DB but the runtime never read it back, so
// toggling the UI did nothing. The fix is purely additive: the config-
// file path remains the durable source of truth, the DB-state path is
// the runtime override.

import type { ApprovalMode, BotConfig } from "./config.js";
import type { Queue } from "./adapters/types.js";

export const GLOBAL_APPROVAL_MODE_STATE_KEY = "global_approval_mode";

/** Inject the state-reader so unit tests don't need a real DB. The
 *  bot wires this to journal.getState() at the call site. */
export type StateReader = <T>(key: string) => Promise<T | null>;

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return v === "manual" || v === "auto" || v === "auto-with-visual";
}

export async function resolveApprovalMode(args: {
  cfg: BotConfig;
  projectName: string;
  queue: Queue;
  getState: StateReader;
}): Promise<ApprovalMode> {
  const { cfg, projectName, queue, getState } = args;

  const p = cfg.projects.find((x) => x.name === projectName);
  const perQueue = p?.approvalMode?.[queue];
  if (perQueue) return perQueue;

  const dbValue = await getState<unknown>(GLOBAL_APPROVAL_MODE_STATE_KEY);
  if (isApprovalMode(dbValue)) return dbValue;

  return cfg.globalApprovalMode;
}
