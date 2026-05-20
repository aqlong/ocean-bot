import { describe, it, expect } from "vitest";
import {
  selectModel,
  BACKLOG_CATEGORY_DEFAULTS,
  type ModelSelectContext,
} from "./model-select.js";
import type {
  Model,
  Queue,
  Severity,
  TaskCandidate,
} from "./adapters/types.js";

function mk(over: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    summary: "do thing",
    leverage: 30,
    estTokens: 10_000,
    queue: "backlog" as Queue,
    ...over,
  };
}

describe("selectModel, baseline (per-queue defaults)", () => {
  const cases: Array<[Queue, Model]> = [
    ["backlog", "sonnet"],
    ["bug-fix", "sonnet"],
    ["gap-closure", "sonnet"],
    ["tightening", "sonnet"],
    ["roadmap", "opus"],
    ["self-learning", "sonnet"],
    ["refactor", "sonnet"],
    ["creative", "sonnet"],
  ];
  for (const [queue, expected] of cases) {
    it(`queue=${queue} → ${expected}`, () => {
      expect(selectModel(mk({ queue }))).toBe(expected);
    });
  }
});

describe("selectModel, suggestedModel wins over queue default", () => {
  it("adapter-set haiku overrides backlog default sonnet", () => {
    expect(selectModel(mk({ queue: "backlog", suggestedModel: "haiku" }))).toBe(
      "haiku",
    );
  });
  it("adapter-set sonnet overrides roadmap default opus", () => {
    expect(selectModel(mk({ queue: "roadmap", suggestedModel: "sonnet" }))).toBe(
      "sonnet",
    );
  });
});

describe("selectModel, opus keyword upgrades", () => {
  const opusWords = [
    "investigation",
    "design",
    "race",
    "concurrency",
    "unclear",
    "research",
    "tradeoff",
    "migration",
    "schema change",
    "subtle",
    "break",
  ];
  for (const w of opusWords) {
    it(`baseline=haiku + summary contains "${w}" → opus`, () => {
      const c = mk({ suggestedModel: "haiku", summary: `please ${w} the thing` });
      expect(selectModel(c)).toBe("opus");
    });
  }

  it("matches case-insensitively", () => {
    expect(
      selectModel(mk({ suggestedModel: "haiku", summary: "INVESTIGATION needed" })),
    ).toBe("opus");
  });

  it("requires word boundary, substring 'breakage' does NOT trigger", () => {
    // 'breakage' contains 'break' but as a substring; \b prevents the match
    // so we stay at the baseline (and any 'break' in a non-keyword sense
    // like 'breakage' is treated as ordinary text).
    const c = mk({
      queue: "backlog",
      suggestedModel: "haiku",
      summary: "tidy breakage in the readme",
    });
    expect(selectModel(c)).toBe("haiku");
  });

  it("matches 'schema change' as a two-word phrase", () => {
    expect(
      selectModel(mk({ suggestedModel: "haiku", summary: "do a schema change" })),
    ).toBe("opus");
  });
});

describe("selectModel, haiku keyword downgrades", () => {
  const haikuWords = [
    "rename",
    "delete",
    "format",
    "move file",
    "update copy",
    "typo",
    "whitespace",
    "prettier",
    "license header",
  ];
  for (const w of haikuWords) {
    it(`baseline=opus + summary contains "${w}" → haiku`, () => {
      const c = mk({ suggestedModel: "opus", summary: `please ${w} now` });
      expect(selectModel(c)).toBe("haiku");
    });
  }

  it("haiku keyword wins when both fire (mechanical action dominates)", () => {
    // summary contains BOTH 'rename' AND 'migration'. The rename is the
    // concrete action; the migration is incidental context. Haiku.
    const c = mk({
      suggestedModel: "sonnet",
      summary: "rename the field, see the migration note",
    });
    expect(selectModel(c)).toBe("haiku");
  });
});

describe("selectModel, severity overrides", () => {
  it("critical → opus, overriding haiku keyword", () => {
    const c = mk({
      suggestedModel: "haiku",
      severity: "critical",
      summary: "rename the field", // haiku-keyword present
    });
    expect(selectModel(c)).toBe("opus");
  });

  it("critical → opus, overriding sonnet baseline", () => {
    const c = mk({ queue: "backlog", severity: "critical" });
    expect(selectModel(c)).toBe("opus");
  });

  it("cosmetic caps at sonnet, even when opus keyword fires", () => {
    const c = mk({
      severity: "cosmetic",
      summary: "design improvement", // opus-keyword
    });
    expect(selectModel(c)).toBe("sonnet");
  });

  it("cosmetic preserves haiku (cap is upper bound, not floor)", () => {
    const c = mk({
      suggestedModel: "haiku",
      severity: "cosmetic",
    });
    expect(selectModel(c)).toBe("haiku");
  });

  it("minor + opus-baseline + no keyword → demoted to sonnet", () => {
    const c = mk({
      suggestedModel: "opus",
      severity: "minor",
      summary: "regular work",
    });
    expect(selectModel(c)).toBe("sonnet");
  });

  it("minor + opus-baseline + opus-keyword → STAYS opus", () => {
    const c = mk({
      suggestedModel: "opus",
      severity: "minor",
      summary: "concurrency tweak",
    });
    expect(selectModel(c)).toBe("opus");
  });

  it("unspecified severity is a no-op", () => {
    const c = mk({ severity: "unspecified", queue: "roadmap" });
    expect(selectModel(c)).toBe("opus"); // roadmap default
  });
});

describe("selectModel, failure-aware retry", () => {
  it("previous sonnet failure escalates to opus", () => {
    const c = mk({ suggestedModel: "sonnet" });
    const ctx: ModelSelectContext = { previousFailedModel: "sonnet" };
    expect(selectModel(c, ctx)).toBe("opus");
  });

  it("previous opus failure does NOT downgrade (operator routing)", () => {
    const c = mk({ suggestedModel: "opus" });
    const ctx: ModelSelectContext = { previousFailedModel: "opus" };
    expect(selectModel(c, ctx)).toBe("opus");
  });

  it("does not escalate when current pick is haiku (mechanical work; rerun haiku)", () => {
    const c = mk({ suggestedModel: "haiku" });
    const ctx: ModelSelectContext = { previousFailedModel: "sonnet" };
    expect(selectModel(c, ctx)).toBe("haiku");
  });
});

describe("selectModel, budget throttling", () => {
  it("budget at 0.50 is below threshold → no change", () => {
    const c = mk({ queue: "roadmap" }); // default opus
    expect(selectModel(c, { budgetWorstRatio: 0.5 })).toBe("opus");
  });

  it("budget at 0.80 downgrades opus → sonnet", () => {
    const c = mk({ queue: "roadmap" });
    expect(selectModel(c, { budgetWorstRatio: 0.8 })).toBe("sonnet");
  });

  it("budget at 0.80 downgrades sonnet → haiku", () => {
    const c = mk({ suggestedModel: "sonnet" });
    expect(selectModel(c, { budgetWorstRatio: 0.8 })).toBe("haiku");
  });

  it("budget at 0.80 keeps haiku at haiku", () => {
    const c = mk({ suggestedModel: "haiku" });
    expect(selectModel(c, { budgetWorstRatio: 0.8 })).toBe("haiku");
  });

  it("critical-severity bypasses budget throttle (cost reduction never blocks a critical fix)", () => {
    const c = mk({ severity: "critical", suggestedModel: "opus" });
    expect(selectModel(c, { budgetWorstRatio: 0.8 })).toBe("opus");
  });
});

describe("selectModel, interaction matrix (combined signals)", () => {
  it("opus-baseline + haiku-keyword + minor → haiku (keyword + severity stack)", () => {
    const c = mk({
      suggestedModel: "opus",
      severity: "minor",
      summary: "delete the dead config",
    });
    expect(selectModel(c)).toBe("haiku");
  });

  it("sonnet-baseline + opus-keyword + cosmetic → sonnet (cosmetic caps after keyword)", () => {
    const c = mk({
      suggestedModel: "sonnet",
      severity: "cosmetic",
      summary: "design review",
    });
    expect(selectModel(c)).toBe("sonnet");
  });

  it("critical + budget=0.95 → still opus (severity overrides budget)", () => {
    // ctx >0.9 wouldn't reach here in practice (gate='wait'), but the
    // helper still does the right thing.
    const c = mk({ severity: "critical" });
    expect(selectModel(c, { budgetWorstRatio: 0.95 })).toBe("opus");
  });

  it("sonnet + opus-keyword + previousFailedModel=sonnet + budget=0.8 → sonnet", () => {
    // baseline sonnet -> opus (keyword) -> opus (retry no-op since already opus)
    // -> sonnet (budget downgrade). Confirms the order of operations.
    const c = mk({
      suggestedModel: "sonnet",
      summary: "concurrency unclear",
    });
    const ctx: ModelSelectContext = {
      previousFailedModel: "sonnet",
      budgetWorstRatio: 0.8,
    };
    expect(selectModel(c, ctx)).toBe("sonnet");
  });
});

describe("BACKLOG_CATEGORY_DEFAULTS", () => {
  it("matches the spec", () => {
    expect(BACKLOG_CATEGORY_DEFAULTS).toEqual({
      docs: "haiku",
      chore: "haiku",
      test: "sonnet",
      refactor: "sonnet",
      feature: "sonnet",
      bug: "sonnet",
      roadmap: "opus",
      other: "sonnet",
    });
  });
});

describe("selectModel, defensive: severity values", () => {
  const allSeverities: Severity[] = [
    "critical",
    "major",
    "minor",
    "cosmetic",
    "unspecified",
  ];
  for (const sev of allSeverities) {
    it(`accepts severity=${sev} without throwing`, () => {
      expect(() => selectModel(mk({ severity: sev }))).not.toThrow();
    });
  }

  it("major severity is a no-op (no boost or cap)", () => {
    expect(selectModel(mk({ suggestedModel: "sonnet", severity: "major" }))).toBe(
      "sonnet",
    );
  });
});
