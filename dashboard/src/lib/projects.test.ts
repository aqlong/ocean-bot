import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWN_PROJECTS,
  PROJECT_COLOR_FALLBACK,
  PROJECT_COLORS,
  projectColor,
} from "./projects";

// Drift guard: KNOWN_PROJECTS is the dropdown source of truth in three
// UI files (AddItemForm, BacklogTable, page.tsx). The bot writes runs
// with `project: this.name` from its adapters (tools/ocean-bot/src/
// adapters/*.ts). If the strings drift, dashboard filters silently
// match zero rows even when the bot is producing runs. The header
// comment on projects.ts asserts this lockstep contract; nothing
// enforced it before this test. Reads bot-side sources from disk
// instead of importing across the package boundary (same pattern as
// apps/dashboard/src/lib/feedback/fence.test.ts per ADR-021).

const BOT_SRC = join(__dirname, "..", "..", "..", "src");

function extractConfigNameUnion(src: string): string[] {
  // Match the `name: "a" | "b" | "c";` field of the ProjectConfig
  // interface. There's exactly one such union in config.ts; if a
  // refactor introduces another, the first occurrence is the load-
  // bearing one (ProjectConfig.name is the project-key contract).
  const re = /name:\s*("[^"]+"(?:\s*\|\s*"[^"]+")+)/;
  const match = re.exec(src);
  if (!match) throw new Error("config.ts ProjectConfig name union not found");
  const tokens = match[1].match(/"([^"]+)"/g);
  if (!tokens) throw new Error("config.ts name union had no string literals");
  return tokens.map((t) => t.slice(1, -1));
}

function extractAdapterName(src: string): string {
  // First `readonly name = "..."` declaration in an adapter class.
  // The second-onwards matches in code2wiki.ts/ocean-bot.ts are
  // smoke-test `name` keys (architecture screenshot URL labels), not
  // the project-key contract.
  const m = /readonly name\s*=\s*"([^"]+)"/.exec(src);
  if (!m) throw new Error("adapter readonly name not found");
  return m[1];
}

describe("KNOWN_PROJECTS", () => {
  it("contains exactly the four documented entries", () => {
    // Canary against accidental deletion. New entries are fine, but
    // any addition deserves a paired bot-side adapter registration,
    // so we make the size change visible.
    expect(KNOWN_PROJECTS).toEqual([
      "code2wiki",
      "ocean-bot",
      "cas",
      "inference-audit",
    ]);
  });

  it("each entry is non-empty, lowercase, kebab-case", () => {
    for (const p of KNOWN_PROJECTS) {
      expect(p).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    }
  });

  it("stays in lockstep with the ProjectConfig name union in tools/ocean-bot/src/config.ts", () => {
    // The bot's config typedef restricts `name` to one of four
    // strings. Dashboard's KNOWN_PROJECTS MUST mirror it byte-for-
    // byte or the dropdown surfaces an unselectable option (extra
    // on dashboard) OR misses a real one (missing on dashboard).
    const configSrc = readFileSync(join(BOT_SRC, "config.ts"), "utf8");
    const configNames = extractConfigNameUnion(configSrc);
    expect([...KNOWN_PROJECTS]).toEqual(configNames);
  });

  it("includes every adapter's readonly name (code2wiki + ocean-bot ship live)", () => {
    // Live adapters that the bot instantiates in DEFAULT_CONFIG must
    // have their `name` value present in KNOWN_PROJECTS or the
    // dashboard filter will fail to surface those runs. cas + inference-
    // audit adapters do NOT exist yet (per the split-adapter commit
    // 2145854 the two-adapter version was the salvaged scope); they're
    // pre-registered in KNOWN_PROJECTS for the eventual extend-to-cas
    // backlog item. This test only checks the adapters that DO exist.
    const c2w = extractAdapterName(
      readFileSync(join(BOT_SRC, "adapters", "code2wiki.ts"), "utf8"),
    );
    const ob = extractAdapterName(
      readFileSync(join(BOT_SRC, "adapters", "ocean-bot.ts"), "utf8"),
    );
    expect(c2w).toBe("code2wiki");
    expect(ob).toBe("ocean-bot");
    expect(KNOWN_PROJECTS).toContain(c2w);
    expect(KNOWN_PROJECTS).toContain(ob);
  });
});

describe("projectColor", () => {
  it("returns the configured token set for a known project", () => {
    // code2wiki is the load-bearing example; assert the full string AND
    // individual classes so a future refactor that drops one token is
    // caught rather than silently narrowing the chip style.
    expect(projectColor("code2wiki")).toBe(PROJECT_COLORS["code2wiki"]);
    expect(projectColor("code2wiki")).toContain("text-blue-300");
    expect(projectColor("code2wiki")).toContain("bg-blue-500/15");
    expect(projectColor("code2wiki")).toContain("border-blue-500/30");
  });

  it("returns the grey fallback for an unknown project string", () => {
    // Stray DB rows (e.g., a renamed adapter) must render inside
    // ProjectChip without throwing or producing an unstyled span.
    expect(projectColor("unknown-project")).toBe(PROJECT_COLOR_FALLBACK);
    expect(projectColor("")).toBe(PROJECT_COLOR_FALLBACK);
  });
});
