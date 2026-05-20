import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, mergeConfig, type BotConfig } from "./config.js";

describe("mergeConfig, deep project merge", () => {
  it("returns base when no override", () => {
    const out = mergeConfig(DEFAULT_CONFIG, {});
    expect(out.projects).toEqual(DEFAULT_CONFIG.projects);
  });

  it("overlays caps without dropping unspecified fields", () => {
    const out = mergeConfig(DEFAULT_CONFIG, {
      caps: { ...DEFAULT_CONFIG.caps, fiveHrInput: 999_999 },
    });
    expect(out.caps.fiveHrInput).toBe(999_999);
    expect(out.caps.sevenDInput).toBe(DEFAULT_CONFIG.caps.sevenDInput);
  });

  it("deep-merges a partial project override, keeps rootDir/memoryDir", () => {
    const out = mergeConfig(DEFAULT_CONFIG, {
      projects: [
        // partial override: only flipping enabled
        { name: "code2wiki", rootDir: "", memoryDir: "", enabled: false },
      ] as BotConfig["projects"],
    });
    const code2wiki = out.projects.find((p) => p.name === "code2wiki");
    expect(code2wiki?.enabled).toBe(false);
    expect(code2wiki?.rootDir).toBe(DEFAULT_CONFIG.projects[0]?.rootDir);
    expect(code2wiki?.memoryDir).toBe(DEFAULT_CONFIG.projects[0]?.memoryDir);
  });

  it("deep-merges approvalMode, overrides preserve sibling defaults", () => {
    const base: BotConfig = {
      ...DEFAULT_CONFIG,
      projects: [
        {
          name: "code2wiki",
          rootDir: "/r",
          memoryDir: "/m",
          enabled: true,
          approvalMode: { "bug-fix": "auto", "roadmap": "manual" },
        },
      ],
    };
    const out = mergeConfig(base, {
      projects: [
        {
          name: "code2wiki",
          rootDir: "/r",
          memoryDir: "/m",
          enabled: true,
          approvalMode: { "roadmap": "auto-with-visual" },
        },
      ],
    });
    const cw = out.projects[0];
    expect(cw?.approvalMode?.["bug-fix"]).toBe("auto");
    expect(cw?.approvalMode?.["roadmap"]).toBe("auto-with-visual");
  });

  it("accepts a brand-new project not in base", () => {
    const out = mergeConfig(DEFAULT_CONFIG, {
      projects: [
        {
          name: "cas",
          rootDir: "/cas",
          memoryDir: "/m-cas",
          enabled: true,
        },
      ],
    });
    expect(out.projects.find((p) => p.name === "cas")).toBeDefined();
  });
});
