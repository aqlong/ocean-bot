// Pure DB operations for the budget-caps editor on /settings.
// Caller (server action) validates auth + invokes these. Splitting them
// out of actions.ts mirrors the approval-ops convention so tests can
// exercise the DB path without pulling in next-auth.

import { getDb, schema } from "./db";
import { eq } from "drizzle-orm";

export interface BudgetCaps {
  fiveHrInput: number;
  fiveHrOutput: number;
  sevenDInput: number;
  sevenDOutput: number;
  warnRatio: number;
}

// Duplicated from tools/ocean-bot/src/budget.ts. Dashboard is a
// standalone npm project and can't import bot src directly; keep these
// in sync (no compile-time linkage). If DEFAULT_CAPS drifts in the bot,
// the test in budget-ops.test.ts is the canary.
export const DEFAULT_CAPS: BudgetCaps = {
  fiveHrInput: 2_500_000,
  fiveHrOutput: 500_000,
  sevenDInput: 17_500_000,
  sevenDOutput: 3_500_000,
  warnRatio: 0.9,
};

export const MAX_20X_REFERENCE = {
  fiveHrInput: 5_000_000,
  fiveHrOutput: 1_000_000,
  sevenDInput: 35_000_000,
  sevenDOutput: 7_000_000,
} as const;

export type CapsSource = "dashboard" | "config.json" | "default";

export interface BudgetCapsMeta {
  configHasCaps: boolean;
  configCaps: BudgetCaps;
  activeSource: CapsSource;
  observedAt: number;
}

export interface CapsChange {
  before: BudgetCaps;
  after: BudgetCaps;
  changedBy: string;
  changedAt: string;
}

export type ValidationOk = { ok: true; caps: BudgetCaps };
export type ValidationErr = { ok: false; errors: string[] };
export type ValidationResult = ValidationOk | ValidationErr;

const HISTORY_LIMIT = 5;

export function validateBudgetCaps(input: unknown): ValidationResult {
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["payload must be an object"] };
  }
  const i = input as Record<string, unknown>;
  const errors: string[] = [];
  const fields: Array<keyof BudgetCaps> = [
    "fiveHrInput",
    "fiveHrOutput",
    "sevenDInput",
    "sevenDOutput",
    "warnRatio",
  ];
  const num: Partial<BudgetCaps> = {};
  for (const f of fields) {
    const v = i[f];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      errors.push(`${f} must be a finite number`);
      continue;
    }
    num[f] = v;
  }
  if (errors.length > 0) return { ok: false, errors };

  const caps = num as BudgetCaps;
  if (caps.fiveHrInput <= 0) errors.push("fiveHrInput must be > 0");
  if (caps.fiveHrOutput <= 0) errors.push("fiveHrOutput must be > 0");
  if (caps.sevenDInput <= 0) errors.push("sevenDInput must be > 0");
  if (caps.sevenDOutput <= 0) errors.push("sevenDOutput must be > 0");
  if (caps.warnRatio <= 0 || caps.warnRatio > 1) {
    errors.push("warnRatio must be in (0, 1]");
  }
  // Sanity: 7d caps must be > 5hr caps. A 5hr cap above the 7d cap
  // can never bind (the 7d window encloses the 5hr one).
  if (caps.sevenDInput <= caps.fiveHrInput) {
    errors.push("sevenDInput must be > fiveHrInput");
  }
  if (caps.sevenDOutput <= caps.fiveHrOutput) {
    errors.push("sevenDOutput must be > fiveHrOutput");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, caps };
}

export async function readBudgetCaps(): Promise<BudgetCaps | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "budget_caps"))
    .limit(1);
  const v = rows[0]?.value;
  if (!v || typeof v !== "object") return null;
  const validated = validateBudgetCaps(v);
  return validated.ok ? validated.caps : null;
}

export async function readBudgetCapsMeta(): Promise<BudgetCapsMeta | null> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "budget_caps_meta"))
    .limit(1);
  const v = rows[0]?.value as Partial<BudgetCapsMeta> | undefined;
  if (!v || typeof v !== "object") return null;
  if (
    typeof v.configHasCaps !== "boolean" ||
    !v.configCaps ||
    typeof v.activeSource !== "string"
  ) {
    return null;
  }
  return v as BudgetCapsMeta;
}

export async function readBudgetCapsHistory(
  limit = HISTORY_LIMIT,
): Promise<CapsChange[]> {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "budget_caps_history"))
    .limit(1);
  const v = rows[0]?.value;
  if (!Array.isArray(v)) return [];
  return (v as CapsChange[]).slice(0, limit);
}

async function setStateValue(key: string, value: unknown): Promise<void> {
  await getDb()
    .insert(schema.oceanBotState)
    .values({ key, value: value as object })
    .onConflictDoUpdate({
      target: schema.oceanBotState.key,
      set: { value: value as object, updatedAt: new Date() },
    });
}

export async function writeBudgetCaps(
  next: BudgetCaps,
  changedBy: string,
  now: Date = new Date(),
): Promise<void> {
  const validated = validateBudgetCaps(next);
  if (!validated.ok) {
    throw new Error(`invalid caps: ${validated.errors.join("; ")}`);
  }
  const before = (await readBudgetCaps()) ?? DEFAULT_CAPS;

  await setStateValue("budget_caps", validated.caps);

  const change: CapsChange = {
    before,
    after: validated.caps,
    changedBy,
    changedAt: now.toISOString(),
  };
  const prior = await readBudgetCapsHistory(HISTORY_LIMIT);
  const nextHistory = [change, ...prior].slice(0, HISTORY_LIMIT);
  await setStateValue("budget_caps_history", nextHistory);
}

export async function clearBudgetCaps(
  changedBy: string,
  now: Date = new Date(),
): Promise<void> {
  const before = await readBudgetCaps();
  if (!before) return;
  // Remove the override entirely so the bot falls back to config.json
  // or DEFAULT_CAPS on its next tick.
  await getDb()
    .delete(schema.oceanBotState)
    .where(eq(schema.oceanBotState.key, "budget_caps"));

  const change: CapsChange = {
    before,
    after: DEFAULT_CAPS,
    changedBy: `${changedBy} (reset)`,
    changedAt: now.toISOString(),
  };
  const prior = await readBudgetCapsHistory(HISTORY_LIMIT);
  const nextHistory = [change, ...prior].slice(0, HISTORY_LIMIT);
  await setStateValue("budget_caps_history", nextHistory);
}
