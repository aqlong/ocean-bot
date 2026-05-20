import { describe, it, expect } from "vitest";
import {
  GLOBAL_APPROVAL_MODE_STATE_KEY,
  isApprovalMode,
  resolveApprovalMode,
} from "./approval-mode.js";
import type { BotConfig } from "./config.js";

function mkConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    tickIntervalSec: 180,
    dataDir: "/tmp",
    caps: {
      fiveHrInput: 1,
      fiveHrOutput: 1,
      sevenDInput: 1,
      sevenDOutput: 1,
      warnRatio: 0.5,
    },
    capsFromConfigFile: false,
    globalApprovalMode: "auto",
    sessionsLogPath: "/tmp/s.jsonl",
    projects: [
      {
        name: "code2wiki",
        rootDir: "/tmp/c2w",
        memoryDir: "/tmp/mem",
        enabled: true,
      },
    ],
    ...over,
  };
}

/** In-memory StateReader so tests don't touch Postgres. */
function mkReader(state: Record<string, unknown> = {}) {
  return async <T>(key: string): Promise<T | null> =>
    key in state ? (state[key] as T) : null;
}

describe("isApprovalMode", () => {
  it("accepts the three known modes", () => {
    expect(isApprovalMode("manual")).toBe(true);
    expect(isApprovalMode("auto")).toBe(true);
    expect(isApprovalMode("auto-with-visual")).toBe(true);
  });

  it("rejects typos / nullish / unrelated strings", () => {
    expect(isApprovalMode("AUTO")).toBe(false); // case-sensitive
    expect(isApprovalMode("yolo")).toBe(false);
    expect(isApprovalMode("")).toBe(false);
    expect(isApprovalMode(null)).toBe(false);
    expect(isApprovalMode(undefined)).toBe(false);
    expect(isApprovalMode(0)).toBe(false);
    expect(isApprovalMode({})).toBe(false);
  });
});

describe("resolveApprovalMode precedence", () => {
  it("uses config-file globalApprovalMode when nothing overrides it", async () => {
    const cfg = mkConfig({ globalApprovalMode: "auto" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({}),
    });
    expect(got).toBe("auto");
  });

  it("DB state global_approval_mode overrides config-file globalApprovalMode", async () => {
    const cfg = mkConfig({ globalApprovalMode: "auto" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({
        [GLOBAL_APPROVAL_MODE_STATE_KEY]: "manual",
      }),
    });
    expect(got).toBe("manual");
  });

  it("ignores DB-state values that don't match a known mode (typo guard)", async () => {
    // Real failure mode: dashboard writes a typo, runtime ignores it
    // rather than dropping into an unknown state. Config-file value wins.
    const cfg = mkConfig({ globalApprovalMode: "auto" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({
        [GLOBAL_APPROVAL_MODE_STATE_KEY]: "AUTO_WITH_TYPO",
      }),
    });
    expect(got).toBe("auto");
  });

  it("ignores DB-state null (key not yet written)", async () => {
    const cfg = mkConfig({ globalApprovalMode: "manual" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({}),
    });
    expect(got).toBe("manual");
  });

  it("per-project per-queue override wins over DB state AND config", async () => {
    // A project pinning bug-fix to "manual" should not be downgraded
    // to "auto" by a global DB-state override or config-file value.
    const cfg = mkConfig({
      globalApprovalMode: "auto",
      projects: [
        {
          name: "code2wiki",
          rootDir: "/tmp/c2w",
          memoryDir: "/tmp/mem",
          enabled: true,
          approvalMode: {
            "bug-fix": "manual",
          },
        },
      ],
    });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({
        [GLOBAL_APPROVAL_MODE_STATE_KEY]: "auto",
      }),
    });
    expect(got).toBe("manual");
  });

  it("per-queue override only applies to the matching queue", async () => {
    // Pinning bug-fix → manual should leave roadmap on the global default.
    const cfg = mkConfig({
      globalApprovalMode: "auto",
      projects: [
        {
          name: "code2wiki",
          rootDir: "/tmp/c2w",
          memoryDir: "/tmp/mem",
          enabled: true,
          approvalMode: {
            "bug-fix": "manual",
          },
        },
      ],
    });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "roadmap",
      getState: mkReader({}),
    });
    expect(got).toBe("auto");
  });

  it("unknown project name falls through to DB state / config (no project match)", async () => {
    const cfg = mkConfig({ globalApprovalMode: "auto" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "totally-not-a-real-project",
      queue: "bug-fix",
      getState: mkReader({
        [GLOBAL_APPROVAL_MODE_STATE_KEY]: "manual",
      }),
    });
    expect(got).toBe("manual");
  });

  it("auto-with-visual is a valid DB-state override value", async () => {
    const cfg = mkConfig({ globalApprovalMode: "auto" });
    const got = await resolveApprovalMode({
      cfg,
      projectName: "code2wiki",
      queue: "bug-fix",
      getState: mkReader({
        [GLOBAL_APPROVAL_MODE_STATE_KEY]: "auto-with-visual",
      }),
    });
    expect(got).toBe("auto-with-visual");
  });
});
