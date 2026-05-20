import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CAPS,
  MAX_20X_REFERENCE,
  validateBudgetCaps,
  type BudgetCaps,
} from "./budget-ops";

// Importing budget-ops is safe at module load: getDb()/Pool are lazy,
// so no Postgres connection is opened by these pure-helper tests. The
// integration-style functions (readBudgetCaps / writeBudgetCaps /
// clearBudgetCaps) require a live OCEAN_BOT_DATABASE_URL and are out
// of scope here; the approval-ops.test.ts pattern is what to follow
// when those land.

const BOT_BUDGET_TS = join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "budget.ts",
);

function extractObjectLiteralFields(src: string, marker: string): Record<string, number> {
  // Find `export const <marker>` and capture the first balanced `{...}`
  // block after it. Numeric values may use _ separators (2_500_000) and
  // floats (0.9). String values are NOT supported (this helper exists
  // only for BudgetCaps + MAX_20X_REFERENCE which are all numbers).
  const startIdx = src.indexOf(`export const ${marker}`);
  if (startIdx === -1) throw new Error(`${marker} not found in budget.ts`);
  const braceStart = src.indexOf("{", startIdx);
  const braceEnd = src.indexOf("}", braceStart);
  if (braceStart === -1 || braceEnd === -1) {
    throw new Error(`${marker} object literal not found`);
  }
  const body = src.slice(braceStart + 1, braceEnd);
  const out: Record<string, number> = {};
  // Match `key: 1_234_567` or `key: 0.9`. Stops at comma / newline /
  // end-of-block. Keys are JS identifiers; values are digit / underscore
  // / dot only (no expressions).
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\d_.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]] = Number(m[2].replace(/_/g, ""));
  }
  return out;
}

describe("validateBudgetCaps", () => {
  const VALID: BudgetCaps = {
    fiveHrInput: 1_000_000,
    fiveHrOutput: 200_000,
    sevenDInput: 7_000_000,
    sevenDOutput: 1_400_000,
    warnRatio: 0.9,
  };

  describe("payload-shape gate", () => {
    it("rejects null", () => {
      const r = validateBudgetCaps(null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("payload must be an object");
    });

    it("rejects undefined", () => {
      const r = validateBudgetCaps(undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("payload must be an object");
    });

    it("rejects a primitive (number)", () => {
      const r = validateBudgetCaps(42);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("payload must be an object");
    });

    it("rejects a primitive (string)", () => {
      const r = validateBudgetCaps("caps");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("payload must be an object");
    });
  });

  describe("per-field type gate", () => {
    it("rejects missing fiveHrInput", () => {
      const { fiveHrInput: _, ...rest } = VALID;
      void _;
      const r = validateBudgetCaps(rest);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("fiveHrInput must be a finite number");
    });

    it("rejects non-numeric warnRatio (string)", () => {
      const r = validateBudgetCaps({ ...VALID, warnRatio: "0.9" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("warnRatio must be a finite number");
    });

    it("rejects NaN", () => {
      const r = validateBudgetCaps({ ...VALID, fiveHrInput: Number.NaN });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("fiveHrInput must be a finite number");
    });

    it("rejects Infinity", () => {
      const r = validateBudgetCaps({ ...VALID, fiveHrInput: Number.POSITIVE_INFINITY });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("fiveHrInput must be a finite number");
    });

    it("aggregates errors when multiple fields are missing", () => {
      const r = validateBudgetCaps({ warnRatio: 0.9 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // 4 of 5 fields missing -> 4 distinct error messages.
        expect(r.errors).toHaveLength(4);
        expect(r.errors).toEqual(
          expect.arrayContaining([
            "fiveHrInput must be a finite number",
            "fiveHrOutput must be a finite number",
            "sevenDInput must be a finite number",
            "sevenDOutput must be a finite number",
          ]),
        );
      }
    });

    it("short-circuits the range gate when the type gate fails", () => {
      // sevenDInput is a string AND fiveHrInput is also missing the
      // range invariant would flag (5hr > 7d). The type-gate failure
      // should suppress the downstream range error -- the implementation
      // returns early once any field fails the finite-number check.
      const r = validateBudgetCaps({
        ...VALID,
        sevenDInput: "huge",
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors).toEqual(["sevenDInput must be a finite number"]);
      }
    });
  });

  describe("per-field range gate", () => {
    it("rejects fiveHrInput = 0", () => {
      const r = validateBudgetCaps({ ...VALID, fiveHrInput: 0, sevenDInput: 100 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("fiveHrInput must be > 0");
    });

    it("rejects negative fiveHrOutput", () => {
      const r = validateBudgetCaps({
        ...VALID,
        fiveHrOutput: -1,
        sevenDOutput: 100,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("fiveHrOutput must be > 0");
    });

    it("accepts warnRatio = 1.0 (inclusive upper bound)", () => {
      const r = validateBudgetCaps({ ...VALID, warnRatio: 1 });
      expect(r.ok).toBe(true);
    });

    it("rejects warnRatio = 0 (exclusive lower bound)", () => {
      const r = validateBudgetCaps({ ...VALID, warnRatio: 0 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("warnRatio must be in (0, 1]");
    });

    it("rejects warnRatio > 1", () => {
      const r = validateBudgetCaps({ ...VALID, warnRatio: 1.01 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("warnRatio must be in (0, 1]");
    });

    it("rejects sevenDInput equal to fiveHrInput (strict >)", () => {
      // 7d cap == 5hr cap can never bind beyond the 5hr cap, so it's
      // a useless config. The validator enforces strict >.
      const r = validateBudgetCaps({
        ...VALID,
        fiveHrInput: 1_000,
        sevenDInput: 1_000,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("sevenDInput must be > fiveHrInput");
    });

    it("rejects sevenDOutput < fiveHrOutput", () => {
      const r = validateBudgetCaps({
        ...VALID,
        fiveHrOutput: 500,
        sevenDOutput: 400,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors).toContain("sevenDOutput must be > fiveHrOutput");
    });

    it("aggregates multiple range errors", () => {
      const r = validateBudgetCaps({
        fiveHrInput: 1,
        fiveHrOutput: 1,
        sevenDInput: 1,
        sevenDOutput: 1,
        warnRatio: 5,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.errors).toEqual(
          expect.arrayContaining([
            "warnRatio must be in (0, 1]",
            "sevenDInput must be > fiveHrInput",
            "sevenDOutput must be > fiveHrOutput",
          ]),
        );
      }
    });
  });

  describe("happy path", () => {
    it("returns ok with a typed BudgetCaps that ignores extra keys", () => {
      const r = validateBudgetCaps({ ...VALID, junk: "ignored" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.caps).toEqual(VALID);
        // Narrowed type carries exactly the BudgetCaps surface; extra
        // keys are discarded by the field-by-field copy.
        expect(Object.keys(r.caps).sort()).toEqual(
          ["fiveHrInput", "fiveHrOutput", "sevenDInput", "sevenDOutput", "warnRatio"].sort(),
        );
      }
    });

    it("accepts DEFAULT_CAPS as a valid payload (self-consistency)", () => {
      // Documents that the shipped defaults satisfy every gate. A
      // future tweak to DEFAULT_CAPS that crosses a range threshold
      // (e.g. accidentally setting sevenDInput < fiveHrInput) would
      // surface here before it surfaces in prod.
      const r = validateBudgetCaps(DEFAULT_CAPS);
      expect(r.ok).toBe(true);
    });
  });
});

describe("DEFAULT_CAPS / MAX_20X_REFERENCE lockstep with tools/ocean-bot/src/budget.ts", () => {
  // budget-ops.ts ships its own copy of DEFAULT_CAPS + MAX_20X_REFERENCE
  // because the dashboard is a standalone npm project and cannot import
  // from tools/ocean-bot/src (ADR-021 boundary, same pattern as
  // apps/dashboard/src/lib/feedback/fence.test.ts). The header comment
  // on budget-ops.ts:17-20 promises this test is the canary if either
  // constant drifts. Reads bot src via node:fs and regex-extracts the
  // object-literal fields rather than re-evaluating the TS (no
  // cross-package import).

  it("DEFAULT_CAPS matches bot-side budget.ts byte-for-byte (per-field)", () => {
    const botSrc = readFileSync(BOT_BUDGET_TS, "utf8");
    const botDefaults = extractObjectLiteralFields(botSrc, "DEFAULT_CAPS");
    expect(botDefaults).toEqual({
      fiveHrInput: DEFAULT_CAPS.fiveHrInput,
      fiveHrOutput: DEFAULT_CAPS.fiveHrOutput,
      sevenDInput: DEFAULT_CAPS.sevenDInput,
      sevenDOutput: DEFAULT_CAPS.sevenDOutput,
      warnRatio: DEFAULT_CAPS.warnRatio,
    });
  });

  it("MAX_20X_REFERENCE matches bot-side budget.ts byte-for-byte (per-field)", () => {
    const botSrc = readFileSync(BOT_BUDGET_TS, "utf8");
    const botMax = extractObjectLiteralFields(botSrc, "MAX_20X_REFERENCE");
    expect(botMax).toEqual({
      fiveHrInput: MAX_20X_REFERENCE.fiveHrInput,
      fiveHrOutput: MAX_20X_REFERENCE.fiveHrOutput,
      sevenDInput: MAX_20X_REFERENCE.sevenDInput,
      sevenDOutput: MAX_20X_REFERENCE.sevenDOutput,
    });
  });

  it("MAX_20X_REFERENCE is 2x DEFAULT_CAPS on every numeric field (per the inline doc)", () => {
    // budget.ts:42-44 promises MAX_20X_REFERENCE values are 2x
    // DEFAULT_CAPS. If a future caps bump breaks the ratio, the
    // dashboard's "X% of Max-20x" labels silently mislead the
    // operator and this test surfaces it.
    expect(MAX_20X_REFERENCE.fiveHrInput).toBe(DEFAULT_CAPS.fiveHrInput * 2);
    expect(MAX_20X_REFERENCE.fiveHrOutput).toBe(DEFAULT_CAPS.fiveHrOutput * 2);
    expect(MAX_20X_REFERENCE.sevenDInput).toBe(DEFAULT_CAPS.sevenDInput * 2);
    expect(MAX_20X_REFERENCE.sevenDOutput).toBe(DEFAULT_CAPS.sevenDOutput * 2);
  });
});
