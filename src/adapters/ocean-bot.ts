// Ocean-bot adapter. Mirrors the queue methods of Code2wikiAdapter but
// scopes every signal to the bot's own source tree under tools/ocean-bot/**.
//
// Why split (vs a single c2w adapter): bot infrastructure work has different
// risk + leverage profile than c2w product work, gets its own row in the
// /backlog filter, its own runs in /approvals + /budget, and (eventually)
// its own approval-mode / model-selection knobs. Rule #11 in the classifier
// already flags any tools/ocean-bot/** edit as super-dangerous; this adapter
// keeps that working but tags the run with project='ocean-bot' so the
// operator can tell at a glance which bucket the work belongs to.
//
// Shared root with Code2wikiAdapter (rootDir = ~/code2wiki). Ownership is
// decided at queue-collection time per the rule:
//   - Commit / file purely under tools/ocean-bot/** , ocean-bot.
//   - Anything else , code2wiki.
// Codified in isOceanBotOnly() and applied symmetrically (c2w adapter
// already excludes tools/ocean-bot/ from tightening()).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { log } from "../util/log.js";
import { applyRules, type ClassifierConfig } from "../classifier.js";
import type {
  ProjectAdapter,
  TaskCandidate,
  DiffSummary,
  DangerReason,
  VisualSurface,
  PushTarget,
  Severity,
  Queue,
} from "./types.js";
import { BACKLOG_CATEGORY_DEFAULTS } from "../model-select.js";
import { git, headSha } from "../util/git.js";
import {
  parseTscOutput,
  parseVitestOutput,
  summarizeFailures,
  type ParsedFailure,
} from "../util/failures.js";

/** Bot self-mod path prefix. Anything under here is ocean-bot's territory;
 *  anything else belongs to code2wiki. Mirrored as a constant on the c2w
 *  adapter so the inverse filter can't drift. */
export const BOT_SELF_PREFIX = "tools/ocean-bot/";

/** Sub-project package path (where `npm test` + `npm run typecheck` run
 *  for the bot's scoped preflight + bugFix observation). */
const BOT_PKG_DIR = "tools/ocean-bot";

export interface OceanBotAdapterOptions {
  /** Absolute path to the host repo root (same as the c2w adapter). */
  rootDir: string;
  /** Absolute path to per-project memory dir. */
  memoryDir: string;
  /** Optional override of the classifier config. */
  classifierConfig?: ClassifierConfig;
}

const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  // The bot itself has no publisher / audit / schema surfaces; rule 11
  // (botSelfPaths) catches every diff we'd ever ship from here. Leave the
  // other rule-prefix sets non-empty with the host-project paths so the
  // classifier's per-rule branches still trip if the bot ever stages a
  // commit that touches c2w surfaces (defense-in-depth, should never
  // happen with the ownership filter in place but cheap to keep).
  publisherPaths: ["src/core/publishers/"],
  auditPaths: ["src/core/audit.ts", "src/core/audit/"],
  schemaPaths: ["apps/dashboard/src/lib/db/schema.ts"],
  stripePaths: ["apps/dashboard/src/lib/stripe/"],
  onboardingDocPaths: ["apps/dashboard/SETUP.md", "README.md"],
  botSelfPaths: [BOT_SELF_PREFIX],
  knownFetchHosts: [
    "api.anthropic.com",
    "api.github.com",
    "api.stripe.com",
    "api.notion.com",
    "code2wiki-app-production.up.railway.app",
    "ocean-bot-dashboard-production.up.railway.app",
    "smee.io",
  ],
};

interface PreflightCache {
  sha: string;
  failures: ParsedFailure[];
  observedAt: number;
}

/** Per-category map of CLAUDE.md sections most relevant to that task type.
 *  Prepended to the prompt so claude can skip past sections that aren't
 *  load-bearing for this task (saves ~300-2000 input tokens per spawn).
 *  Same content as the c2w adapter today since both share the host CLAUDE.md;
 *  kept inline (rather than imported) to follow the "deliberately duplicated
 *  helpers" pattern noted below. */
const CATEGORY_SECTION_HINTS: Record<string, string> = {
  docs: "Where things live, Code style",
  chore: "Where things live",
  test: "Code style, Testing",
  bug: "Default code-change workflow, Rigor",
  feature: "Default code-change workflow, Active design work",
  refactor: "Default code-change workflow",
  roadmap: "Active design work, Honest-completion",
  other: "",
};

const QUEUE_CATEGORY: Record<Exclude<Queue, "backlog">, string> = {
  "bug-fix": "bug",
  "gap-closure": "bug",
  tightening: "refactor",
  roadmap: "roadmap",
  "self-learning": "feature",
  refactor: "refactor",
  creative: "other",
};

// Matches TODO/FIXME/XXX only when preceded by a JS/TS comment delimiter:
// `//`, `/*`, `/**`, or a block-comment continuation `*` at the start of a
// line. String literals and prose mentions don't match, so the scanner never
// self-queues its own source. The `m` flag makes ^ match line-starts so
// JSDoc/block-comment ` * TODO:` continuation lines are caught.
const TIGHTENING_RE =
  /(?:\/\/|\/\*+|^\s*\*)\s*(?:TODO|FIXME|XXX)\b/im;
const TIGHTENING_LABEL = "TODO/FIXME";

function sectionHintFor(category: string): string {
  const sections = CATEGORY_SECTION_HINTS[category] ?? "";
  if (!sections) return "";
  return `CLAUDE.md sections most relevant for this task: ${sections}.`;
}

function withHint(category: string, lines: string[]): string {
  const hint = sectionHintFor(category);
  if (!hint) return lines.join("\n");
  return [hint, "", ...lines].join("\n");
}

/** Decision rule: a set of files belongs to ocean-bot iff every file is
 *  under tools/ocean-bot/**. Empty list returns false (no signal → not
 *  ours). */
export function isOceanBotOnly(files: string[]): boolean {
  if (files.length === 0) return false;
  return files.every((f) => f.startsWith(BOT_SELF_PREFIX));
}

export class OceanBotAdapter implements ProjectAdapter {
  readonly name = "ocean-bot";
  readonly rootDir: string;
  readonly claudeMdPath: string;
  readonly memoryDir: string;
  private readonly classifier: ClassifierConfig;
  private preflightCache: PreflightCache | null = null;

  constructor(opts: OceanBotAdapterOptions) {
    this.rootDir = opts.rootDir;
    // Shared CLAUDE.md with code2wiki, the bot's instructions live in the
    // root CLAUDE.md alongside the host project's. No separate file today.
    this.claudeMdPath = path.join(opts.rootDir, "CLAUDE.md");
    this.memoryDir = opts.memoryDir;
    this.classifier = opts.classifierConfig ?? DEFAULT_CLASSIFIER_CONFIG;
  }

  // ---- Queues ----

  async backlog(): Promise<TaskCandidate[]> {
    try {
      const rows = await getDb()
        .select()
        .from(schema.oceanBotBacklogItem)
        .where(
          and(
            eq(schema.oceanBotBacklogItem.project, this.name),
            eq(schema.oceanBotBacklogItem.status, "open"),
          ),
        )
        .orderBy(asc(schema.oceanBotBacklogItem.priority))
        .limit(3);

      return rows.map((r, i) => {
        const positionalBoost = Math.max(0, 5 - i * 2);
        const suggestedModel =
          BACKLOG_CATEGORY_DEFAULTS[r.category] ?? "sonnet";
        const hint = sectionHintFor(r.category);
        const hintPrefix = hint ? `${hint}\n\n` : "";
        return {
          summary: [
            hintPrefix,
            `Backlog (${r.category}): ${r.title}`,
            r.description ? `\n${r.description}` : "",
            "\nWorkflow: read the relevant files, make the smallest reversible change, commit with a clear message. If it requires a design decision, write a planning note instead of guessing.",
          ].join(""),
          leverage: 80 + positionalBoost,
          estTokens: 25_000,
          queue: "backlog" as const,
          taskId: `backlog:${r.id}`,
          complex: (r.description?.length ?? 0) > 200,
          suggestedModel,
          severity: normalizeSeverity(r.severity),
        };
      });
    } catch (err) {
      log.warn("backlog.queue_query_failed", {
        project: this.name,
        err: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  async bugFix(): Promise<TaskCandidate[]> {
    const failures = await this.observeFailures();
    if (failures.length === 0) return [];

    const summary = summarizeFailures(failures);
    const fileHint = failures
      .map((f) => f.file)
      .filter((f): f is string => !!f);
    const fileLabel = fileHint.length
      ? ` in ${[...new Set(fileHint)].slice(0, 3).join(", ")}`
      : "";

    return [
      {
        summary: withHint(QUEUE_CATEGORY["bug-fix"], [
          `Preflight is red in ocean-bot${fileLabel}. Fix the failing test(s) or type error(s) on the current HEAD.`,
          "",
          summary,
          "",
          "Workflow:",
          `1. cd ${BOT_PKG_DIR} and read the failing test / type error to understand what's broken.`,
          "2. Make the smallest change that fixes the root cause.",
          `3. Run \`cd ${BOT_PKG_DIR} && npm test\` and \`npm run typecheck\` yourself to confirm green BEFORE finishing.`,
          "4. If you fixed the code but tests still fail in a different way, iterate. If you can't fix it in one pass, stop and write a one-line summary of where you got stuck.",
          "",
          "Rules:",
          "- Do NOT modify the assertion in a failing test to make it pass, fix the code under test.",
          "- If the test looks intentional (new test for unimplemented code), implement the missing code.",
          `- Stay inside ${BOT_PKG_DIR}, the bug is in the bot, not the host project.`,
          "- Commit with a clear message describing the bug + the fix.",
        ]),
        leverage: 85,
        estTokens: 18_000,
        queue: "bug-fix",
        taskId: `bug:ocean-bot:${failures[0]?.label ?? "unknown"}`,
      },
    ];
  }

  async gapClosure(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recent = await recentCommitsWithFiles(this.rootDir, 5);
    const gapMarkers =
      /^[\s\-*•]*(Did NOT verify|Did NOT|Skipped|Memory-only|Deferred|Gaps):\s*(.+?)\s*$/gim;
    for (const c of recent) {
      // Ownership filter: only surface gaps from commits whose entire
      // touched-file set lives under tools/ocean-bot/. Cross-cutting
      // commits are c2w's territory; the c2w adapter surfaces them.
      if (!isOceanBotOnly(c.files)) continue;
      for (const m of c.message.matchAll(gapMarkers)) {
        const marker = m[1]?.trim() ?? "";
        const text = m[2]?.trim() ?? "";
        if (!isPlausibleGap(text)) continue;
        out.push({
          summary: withHint(QUEUE_CATEGORY["gap-closure"], [
            `Close gap from ocean-bot commit (${marker}): ${truncate(text, 240)}`,
          ]),
          leverage: 70,
          estTokens: 15_000,
          queue: "gap-closure",
          taskId: `gap:ocean-bot:${hashish(text)}`,
        });
      }
    }
    return out;
  }

  async tightening(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recentFiles = await filesChangedSince(this.rootDir, "7 days ago");
    // Inverse of c2w's filter: include ONLY files under tools/ocean-bot/**.
    // Test files are still excluded; fixture action-item markers in test
    // strings would otherwise cause the bot to scan itself in a loop.
    const sourceFiles = recentFiles.filter(
      (f) =>
        f.startsWith(BOT_SELF_PREFIX) &&
        /\.[cm]?[jt]sx?$/.test(f) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f),
    );
    const todoFiles = await grepInFiles(
      this.rootDir,
      sourceFiles,
      TIGHTENING_RE,
    );
    for (const f of todoFiles) {
      out.push({
        summary: withHint(QUEUE_CATEGORY.tightening, [
          `Resolve ${TIGHTENING_LABEL} in ${f}`,
        ]),
        leverage: 35,
        estTokens: 12_000,
        queue: "tightening",
        taskId: `tighten:${f}`,
      });
    }
    return out;
  }

  async roadmap(): Promise<TaskCandidate[]> {
    // Ocean-bot has no separate roadmap.md today, the bot's roadmap lives
    // in the backlog table. Returning empty keeps the queue picker's
    // diversity guard honest (an always-empty queue won't suppress real
    // candidates).
    return [];
  }

  async selfLearning(): Promise<TaskCandidate[]> {
    // Same rationale as roadmap(), the bot's self-learning items live in
    // docs/ocean-bot.md + the backlog table, not a docs/self-learning.md.
    return [];
  }

  async refactor(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recent = await recentCommitShasAndFiles(this.rootDir, 2);
    for (const c of recent) {
      if (!isOceanBotOnly(c.files)) continue;
      const big = c.files.filter((f) => f.endsWith(".ts")).length;
      if (big >= 3) {
        out.push({
          summary: withHint(QUEUE_CATEGORY.refactor, [
            `Deep-self-review pass on ocean-bot commit ${c.sha.slice(0, 7)} (${c.files.length} files)`,
          ]),
          leverage: 25,
          estTokens: 20_000,
          queue: "refactor",
          taskId: `refactor:${c.sha}`,
        });
      }
    }
    return out;
  }

  async creative(): Promise<TaskCandidate[]> {
    // Creative-audit is shared across the host repo; the c2w adapter owns
    // it. Avoid duplicating the same prompt twice per 24h.
    return [];
  }

  // ---- Push rules ----

  pushTarget(_branch: string): PushTarget {
    return "main";
  }

  classifyDanger(diff: DiffSummary): DangerReason[] {
    // Rule 11 will ALWAYS trip on an ocean-bot run by definition (the
    // whole adapter is bot self-mod). That's the intended behavior:
    // every bot-self commit needs operator approval. The redundancy is
    // why the dashboard's approval card needs to surface project='ocean-bot'
    // clearly, so the operator sees "yes, bot is editing itself again"
    // instead of treating rule 11 as a one-off surprise.
    return applyRules(diff, this.classifier);
  }

  // ---- Verification ----

  preflightCommands(): string[] {
    // Scoped: bot has its own package + vitest config under tools/ocean-bot.
    // Root `npm test` doesn't cover it (root vitest config excludes
    // tools/ocean-bot/**/*.test.ts), so we need to invoke the bot's
    // package scripts directly.
    return [
      `cd ${BOT_PKG_DIR} && npm test --silent`,
      `cd ${BOT_PKG_DIR} && npm run typecheck`,
    ];
  }

  async visualSurfaces(diff: DiffSummary): Promise<VisualSurface[]> {
    const touchesDashboard = diff.files.some((f) =>
      f.startsWith(`${BOT_SELF_PREFIX}dashboard/`),
    );
    if (!touchesDashboard) return [];
    const base = process.env["OCEAN_BOT_DASHBOARD_URL"];
    if (!base) return [];
    return [
      { url: `${base}/`, name: "ocean-bot-home", viewport: "desktop" },
      { url: `${base}/`, name: "ocean-bot-home-mobile", viewport: "mobile" },
    ];
  }

  // ---- Internal: SHA-cached preflight observation for bug-fix queue ----

  private async observeFailures(): Promise<ParsedFailure[]> {
    let sha: string;
    try {
      sha = await headSha(this.rootDir);
    } catch {
      return [];
    }
    if (this.preflightCache?.sha === sha) {
      return this.preflightCache.failures;
    }

    const botDir = path.join(this.rootDir, BOT_PKG_DIR);
    const [testRes, typeRes] = await Promise.all([
      runCmd("npm", ["test", "--silent"], botDir),
      runCmd("npm", ["run", "typecheck"], botDir),
    ]);

    const failures: ParsedFailure[] = [];
    if (testRes.code !== 0) {
      failures.push(...parseVitestOutput(testRes.combined));
    }
    if (typeRes.code !== 0) {
      failures.push(...parseTscOutput(typeRes.combined));
    }

    this.preflightCache = { sha, failures, observedAt: Date.now() };
    return failures;
  }
}

// ---- helpers (deliberately duplicated with code2wiki.ts to keep the two
// adapters independently editable; the file-scanning shapes are stable) ----

interface CommitWithFiles {
  sha: string;
  message: string;
  files: string[];
}

async function recentCommitsWithFiles(
  cwd: string,
  n: number,
): Promise<CommitWithFiles[]> {
  const r = await git(cwd, ["log", `-${n}`, "--format=%H"]);
  if (r.code !== 0) return [];
  const shas = r.stdout.trim().split("\n").filter(Boolean);
  const out: CommitWithFiles[] = [];
  for (const sha of shas) {
    const [msg, files] = await Promise.all([
      git(cwd, ["log", "-1", "--format=%B", sha]),
      git(cwd, ["show", "--name-only", "--format=", sha]),
    ]);
    if (msg.code === 0 && files.code === 0) {
      out.push({
        sha,
        message: msg.stdout.trim(),
        files: files.stdout.trim().split("\n").filter(Boolean),
      });
    }
  }
  return out;
}

interface CommitInfo {
  sha: string;
  files: string[];
}

async function recentCommitShasAndFiles(
  cwd: string,
  n: number,
): Promise<CommitInfo[]> {
  const r = await git(cwd, ["log", `-${n}`, "--format=%H"]);
  if (r.code !== 0) return [];
  const shas = r.stdout.trim().split("\n").filter(Boolean);
  const out: CommitInfo[] = [];
  for (const sha of shas) {
    const f = await git(cwd, ["show", "--name-only", "--format=", sha]);
    if (f.code === 0) {
      out.push({ sha, files: f.stdout.trim().split("\n").filter(Boolean) });
    }
  }
  return out;
}

async function filesChangedSince(
  cwd: string,
  since: string,
): Promise<string[]> {
  const r = await git(cwd, [
    "log",
    `--since=${since}`,
    "--name-only",
    "--format=",
  ]);
  if (r.code !== 0) return [];
  return [...new Set(r.stdout.split("\n").filter(Boolean))];
}

async function grepInFiles(
  root: string,
  files: string[],
  re: RegExp,
): Promise<string[]> {
  const out: string[] = [];
  for (const rel of files) {
    try {
      const txt = await fs.readFile(path.join(root, rel), "utf-8");
      if (re.test(txt)) out.push(rel);
    } catch {
      // skip missing
    }
  }
  return out;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; combined: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let combined = "";
    p.stdout.on("data", (d) => (combined += d.toString()));
    p.stderr.on("data", (d) => (combined += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? 0, combined }));
    p.on("error", () => resolve({ code: -1, combined }));
  });
}

function isPlausibleGap(text: string): boolean {
  if (!text) return false;
  if (text.length < 5) return false;
  if (!/[A-Za-z]{4,}/.test(text)) return false;
  if (/^(none|n\/a|n\.a\.|, |--)\b/i.test(text)) return false;
  if (/^[(){}\[\]<>|;,.+\-=*\\/`]+/.test(text)) return false;
  return true;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function normalizeSeverity(s: string | null | undefined): Severity {
  switch (s) {
    case "critical":
    case "major":
    case "minor":
    case "cosmetic":
    case "unspecified":
      return s;
    default:
      return "unspecified";
  }
}

function hashish(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
