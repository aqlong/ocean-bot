// Pure snapshot function + DB fetcher for the header BotStatusBadge.
// Aggregation priority: paused > stale-dist > ci-red > running > idle > no-signal.
// botStatusSnapshot() is a pure function so unit tests need no DB.

import { getDb, schema } from "./db";
import { inArray } from "drizzle-orm";

export type BotStatus =
  | { kind: "paused"; since: string | null }
  | { kind: "stale-dist"; reason: string | null; observedAt: string | null }
  | { kind: "ci-red"; since: string | null }
  | { kind: "running"; lastTickAt: string }
  | { kind: "idle"; lastTickAt: string }
  | { kind: "no-signal" };

export interface BotStateMap {
  global_approval_mode?: unknown;
  paused?: unknown;
  /** ISO timestamp from the `paused` row's updatedAt, null when not paused. */
  pausedSince?: string | null;
  drift?: unknown;
  /** Defensive: field may not exist if the ci-status feature hasn't shipped. */
  ci_status?: unknown;
  tick_meta?: unknown;
}

// < 6 min ago → running; < 15 min ago → idle; beyond → no-signal.
const RUNNING_THRESHOLD_MS = 6 * 60 * 1000;
const IDLE_THRESHOLD_MS = 15 * 60 * 1000;

export function botStatusSnapshot(
  state: BotStateMap,
  now: number = Date.now(),
): BotStatus {
  // 1. Paused: operator explicitly stopped the bot.
  const isPaused =
    state.global_approval_mode === "paused" || state.paused === true;
  if (isPaused) {
    return { kind: "paused", since: state.pausedSince ?? null };
  }

  // 2. Stale-dist: bot dist is behind HEAD; bot will auto-restart.
  const drift = state.drift as Record<string, unknown> | null | undefined;
  if (drift && typeof drift === "object" && drift["drift"] === true) {
    return {
      kind: "stale-dist",
      reason: typeof drift["reason"] === "string" ? drift["reason"] : null,
      observedAt:
        typeof drift["observedAt"] === "string" ? drift["observedAt"] : null,
    };
  }

  // 3. CI-red: guard with null check, feature not yet shipped.
  if (state.ci_status !== undefined && state.ci_status !== null) {
    const ci = state.ci_status as Record<string, unknown>;
    if (typeof ci === "object" && ci["red"] === true) {
      return {
        kind: "ci-red",
        since: typeof ci["since"] === "string" ? ci["since"] : null,
      };
    }
  }

  // 4-5. Running / idle based on tick_meta.lastEndedAt age.
  const meta = state.tick_meta as Record<string, unknown> | null | undefined;
  const lastEndedAt =
    meta && typeof meta["lastEndedAt"] === "string"
      ? (meta["lastEndedAt"] as string)
      : null;

  if (lastEndedAt) {
    const tickMs = Date.parse(lastEndedAt);
    if (Number.isFinite(tickMs)) {
      const ageMs = now - tickMs;
      if (ageMs < RUNNING_THRESHOLD_MS) {
        return { kind: "running", lastTickAt: lastEndedAt };
      }
      if (ageMs < IDLE_THRESHOLD_MS) {
        return { kind: "idle", lastTickAt: lastEndedAt };
      }
    }
  }

  // 6. No-signal: no tick row, or last tick too stale to trust.
  return { kind: "no-signal" };
}

export interface BadgeDisplay {
  label: string;
  colorClass: string;
  ts: string | null;
}

// Pure mapping from a BotStatus into the badge's visual props.
// Kept in lib (no React import) so it's unit-testable without a DB or render harness.
export function badgeProps(status: BotStatus): BadgeDisplay {
  switch (status.kind) {
    case "paused":
      return {
        label: "paused",
        colorClass: "bg-warn/20 text-warn border-warn/30",
        ts: status.since,
      };
    case "stale-dist":
      return {
        label: "stale dist",
        colorClass: "bg-bad/20 text-bad border-bad/30",
        ts: status.observedAt,
      };
    case "ci-red":
      return {
        label: "CI red",
        colorClass: "bg-bad/20 text-bad border-bad/30",
        ts: status.since,
      };
    case "running":
      return {
        label: "running",
        colorClass: "bg-good/20 text-good border-good/30",
        ts: status.lastTickAt,
      };
    case "idle":
      return {
        label: "idle",
        colorClass: "bg-dim/20 text-dim border-line",
        ts: status.lastTickAt,
      };
    case "no-signal":
      return {
        label: "no signal",
        colorClass: "bg-dim/20 text-dim border-line",
        ts: null,
      };
  }
}

const STATE_KEYS = [
  "global_approval_mode",
  "paused",
  "drift",
  "ci_status",
  "tick_meta",
] as const;

export async function fetchBotStatus(): Promise<BotStatus> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(inArray(schema.oceanBotState.key, [...STATE_KEYS]));

  const state: BotStateMap = {};
  for (const row of rows) {
    switch (row.key) {
      case "global_approval_mode":
        state.global_approval_mode = row.value;
        break;
      case "paused":
        state.paused = row.value;
        state.pausedSince =
          row.value === true ? row.updatedAt.toISOString() : null;
        break;
      case "drift":
        state.drift = row.value;
        break;
      case "ci_status":
        state.ci_status = row.value;
        break;
      case "tick_meta":
        state.tick_meta = row.value;
        break;
    }
  }
  return botStatusSnapshot(state);
}
