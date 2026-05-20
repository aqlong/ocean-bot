// Read side of the bot's drift state. Bot writes `drift` to
// `ocean_bot_state` every tick (see tools/ocean-bot/src/drift.ts and
// tools/ocean-bot/src/index.ts); /health and the home hero card read
// it back here. Kept separate from queries.ts so /health concerns
// don't bleed into the main dashboard query surface.

import { getDb, schema } from "./db";
import { eq } from "drizzle-orm";

const DRIFT_STATE_KEY = "drift";

export interface DriftSnapshot {
  drift: boolean;
  reason:
    | "missing_built_from_sha"
    | "head_unreadable"
    | "sha_mismatch"
    | null;
  builtFromSha: string | null;
  headSha: string | null;
  branch: string | null;
  /** ISO timestamp from the bot's last successful build (mtime of
   *  dist/.built-from-sha). null when the wrapper hasn't stamped one,
   *  e.g. fresh bot host or wrapper never ran. */
  builtAt: string | null;
  /** ISO timestamp from the bot's most recent tick that wrote this
   *  state. Used to age out stale readings on the UI. */
  observedAt: string | null;
}

export async function driftSnapshot(): Promise<DriftSnapshot | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, DRIFT_STATE_KEY))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const v = row.value as Partial<DriftSnapshot> | null;
  if (!v) return null;
  return {
    drift: v.drift === true,
    reason: v.reason ?? null,
    builtFromSha: v.builtFromSha ?? null,
    headSha: v.headSha ?? null,
    branch: v.branch ?? null,
    builtAt: v.builtAt ?? null,
    observedAt: v.observedAt ?? null,
  };
}
