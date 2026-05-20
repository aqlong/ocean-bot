// Bot config. Loaded from ~/.ocean-bot/config.json (override path via
// OCEAN_BOT_CONFIG env var). Defaults baked in so the bot can boot
// without a config file, useful for the very first run.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_CAPS, type BudgetCaps } from "./budget.js";
import type { Queue } from "./adapters/types.js";

export interface ProjectConfig {
  /** Stable key matching the adapter `name`. */
  name: "code2wiki" | "ocean-bot" | "cas" | "inference-audit";
  /** Absolute path to the project root. */
  rootDir: string;
  /** Absolute path to the per-project memory dir. */
  memoryDir: string;
  /** Per-queue approval mode. Falls back to globalApprovalMode if unset. */
  approvalMode?: Partial<Record<Queue, ApprovalMode>>;
  /** When true, this project's queues are surveyed each tick. */
  enabled: boolean;
}

export type ApprovalMode = "manual" | "auto" | "auto-with-visual";

export interface BotConfig {
  /** Tick interval in seconds. Default 180s (3 min). */
  tickIntervalSec: number;
  /** Bot data directory, sessions log, baselines, lockfile. */
  dataDir: string;
  /** Budget caps. */
  caps: BudgetCaps;
  /** True iff `caps` originated from config.json (not DEFAULT_CAPS).
   *  Surfaces to the dashboard so /settings can warn when both a
   *  config.json override AND a dashboard state override are set. */
  capsFromConfigFile: boolean;
  /** Global approval mode. 'auto' is the default (2026-05-16); the
   *  classifier still routes CRITICAL-tier hits (rules 1, 2, 3, 4, 8,
   *  10, 11) to await-approval. Advisory rules (5, 6, 7, 9) are logged
   *  on the run but do not block. Set to 'manual' to require approval
   *  for every push regardless of classifier output. */
  globalApprovalMode: ApprovalMode;
  /** Projects the bot may work on. */
  projects: ProjectConfig[];
  /** Path to the bot session attribution log. */
  sessionsLogPath: string;
  /** Postgres URL, also read from env OCEAN_BOT_DATABASE_URL. */
  databaseUrl?: string;
}

const HOME = os.homedir();
const DEFAULT_DATA_DIR = path.join(HOME, ".ocean-bot");

/** Memory dir naming convention used by Claude Code: home path
 *  with slashes → dashes, prefixed with a dash. */
function memoryDirFor(projectRoot: string): string {
  const slug = projectRoot.replace(/\//g, "-");
  return path.join(HOME, ".claude", "projects", slug, "memory");
}

export const DEFAULT_CONFIG: BotConfig = {
  tickIntervalSec: 180,
  dataDir: DEFAULT_DATA_DIR,
  caps: DEFAULT_CAPS,
  capsFromConfigFile: false,
  // 'auto' since 2026-05-16: classifier CRITICAL-tier hits still block,
  // advisory hits are logged on the run but do not block. Operators
  // can pin back to 'manual' via ~/.ocean-bot/config.json or per-queue
  // overrides on individual projects.
  globalApprovalMode: "auto",
  sessionsLogPath: path.join(DEFAULT_DATA_DIR, "sessions.jsonl"),
  projects: [
    {
      name: "code2wiki",
      rootDir: path.join(HOME, "code2wiki"),
      memoryDir: memoryDirFor(path.join(HOME, "code2wiki")),
      enabled: true,
    },
    {
      // Ocean-bot self-mod. Shares the rootDir with code2wiki (same git
      // tree); ownership is decided at queue-pick time by isOceanBotOnly().
      // Memory dir matches the host project's so per-project memory files
      // stay co-located until ocean-bot extracts to its own repo.
      name: "ocean-bot",
      rootDir: path.join(HOME, "code2wiki"),
      memoryDir: memoryDirFor(path.join(HOME, "code2wiki")),
      enabled: true,
    },
  ],
};

export async function loadConfig(): Promise<BotConfig> {
  const customPath = process.env["OCEAN_BOT_CONFIG"];
  const cfgPath = customPath ?? path.join(DEFAULT_DATA_DIR, "config.json");
  try {
    const text = await fs.readFile(cfgPath, "utf-8");
    const parsed = JSON.parse(text) as Partial<BotConfig>;
    const merged = mergeConfig(DEFAULT_CONFIG, parsed);
    const capsFromConfigFile =
      typeof parsed.caps === "object" &&
      parsed.caps !== null &&
      Object.keys(parsed.caps).length > 0;
    return { ...merged, capsFromConfigFile };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function mergeConfig(base: BotConfig, over: Partial<BotConfig>): BotConfig {
  // Deep-merge projects so a user supplying `{name:"code2wiki", enabled:false}`
  // doesn't accidentally drop rootDir/memoryDir from the default. Empty
  // strings and undefined are treated as "not specified" → defaults win.
  const projects = over.projects
    ? over.projects.map((p) => {
        const baseP = base.projects.find((b) => b.name === p.name);
        if (!baseP) return p;
        return {
          ...baseP,
          ...p,
          // Restore defaults if the override left these blank.
          rootDir: p.rootDir || baseP.rootDir,
          memoryDir: p.memoryDir || baseP.memoryDir,
          approvalMode: {
            ...(baseP.approvalMode ?? {}),
            ...(p.approvalMode ?? {}),
          },
        };
      })
    : base.projects;

  return {
    ...base,
    ...over,
    caps: { ...base.caps, ...(over.caps ?? {}) },
    projects,
  };
}
