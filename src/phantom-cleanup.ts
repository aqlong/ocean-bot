// Phantom-row cleanup orchestration.
//
// The tick loop calls maybeRunPhantomCleanup() once per tick; this
// module is the gate. We rate-limit to once per 24 hours via a row in
// ocean_bot_state so the cleanup runs nightly even though the bot
// ticks every few minutes. Wall-clock-anchoring to 04:00 was on the
// table but anchoring a continually-ticking process to a specific
// local hour is fiddly and brings no extra value over "at most once
// per day, whenever the next tick is due."
//
// The state row also feeds the /health dashboard surface: the last
// flipped count answers "did the cleanup do anything last night?" and
// the timestamp answers "is the cleanup actually running?"

import { cleanupPhantomRuns, getState, setState } from "./journal.js";
import { log } from "./util/log.js";

const STATE_KEY = "phantom_cleanup_last_run";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_HOURS = 1;

export interface PhantomCleanupState {
  ranAt: string;
  flipped: number;
  runIds: string[];
}

export interface MaybeRunArgs {
  /** Override "now" for tests. */
  now?: number;
  /** Minimum gap between cleanup runs. */
  intervalMs?: number;
  /** Grace window before a phantom row is eligible. */
  graceHours?: number;
}

export async function maybeRunPhantomCleanup(
  args: MaybeRunArgs = {},
): Promise<PhantomCleanupState | null> {
  const now = args.now ?? Date.now();
  const intervalMs = args.intervalMs ?? DEFAULT_INTERVAL_MS;
  const graceHours = args.graceHours ?? DEFAULT_GRACE_HOURS;

  const last = await getState<PhantomCleanupState>(STATE_KEY);
  if (last?.ranAt) {
    const lastMs = Date.parse(last.ranAt);
    if (Number.isFinite(lastMs) && now - lastMs < intervalMs) {
      return null;
    }
  }

  const result = await cleanupPhantomRuns(graceHours);
  const state: PhantomCleanupState = {
    ranAt: new Date(now).toISOString(),
    flipped: result.flipped,
    runIds: result.runIds,
  };
  await setState(STATE_KEY, state);

  if (result.flipped > 0) {
    log.info("phantom_cleanup.flipped", {
      flipped: result.flipped,
      sampleRunIds: result.runIds.slice(0, 5),
    });
  } else {
    log.debug("phantom_cleanup.no_phantoms");
  }

  return state;
}

export { STATE_KEY as PHANTOM_CLEANUP_STATE_KEY };
