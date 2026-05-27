// code2wiki adapter. Mirrors the Queues A-E logic from docs/autonomous-loop.md
// with a leverage score per item. Source signals are all local filesystem +
// git, no API calls.
//
// Queues:
//   gap-closure  , unclosed gaps in recent commits / project state file
//   tightening   , recently-shipped surfaces with small loose ends
//   roadmap      , next unchecked item under current week
//   self-learning, signals #1-#5 from docs/self-learning.md
//   refactor     , deep-self-review-flagged items on last 2 commits
//   creative     , once / 24h: "audit for creative improvements"

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
  VisualInspectConfig,
} from "./types.js";
import { BACKLOG_CATEGORY_DEFAULTS } from "../model-select.js";
import { git, headSha } from "../util/git.js";
import {
  parseTscOutput,
  parseVitestOutput,
  summarizeFailures,
  type ParsedFailure,
} from "../util/failures.js";
import { BOT_SELF_PREFIX, isOceanBotOnly } from "./ocean-bot.js";

export interface Code2wikiAdapterOptions {
  /** Absolute path to the code2wiki repo root. */
  rootDir: string;
  /** Absolute path to per-project memory dir. */
  memoryDir: string;
  /** Optional override of the classifier config. */
  classifierConfig?: ClassifierConfig;
  /** When was the last creative-audit task issued (unix ms)? */
  lastCreativeAuditAt?: number;
}

const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  publisherPaths: ["src/core/publishers/"],
  auditPaths: ["src/core/audit.ts", "src/core/audit/"],
  schemaPaths: ["apps/dashboard/src/lib/db/schema.ts"],
  stripePaths: ["apps/dashboard/src/lib/stripe/"],
  onboardingDocPaths: ["apps/dashboard/SETUP.md", "README.md"],
  botSelfPaths: ["tools/ocean-bot/"],
  knownFetchHosts: [
    "api.anthropic.com",
    "api.github.com",
    "api.stripe.com",
    "api.notion.com",
    "code2wiki-app-production.up.railway.app",
    "smee.io",
  ],
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Matches TODO/FIXME/XXX only when preceded by a JS/TS comment delimiter:
// `//`, `/*`, `/**`, or a block-comment continuation `*` at the start of a
// line. String literals and prose mentions (e.g. "todo"/"fixme" descriptively
// or a taskId prefixed with todo:) don't match, so the scanner never
// self-queues its own source. The `m` flag makes ^ match line-starts so
// JSDoc/block-comment ` * TODO:` continuation lines are caught.
const TIGHTENING_RE =
  /(?:\/\/|\/\*+|^\s*\*)\s*(?:TODO|FIXME|XXX)\b/im;
const TIGHTENING_LABEL = "TODO/FIXME";

/** Per-category map of CLAUDE.md sections most relevant to that task type.
 *  Prepended to the prompt so claude can skip past sections that aren't
 *  load-bearing for this task (saves ~300-2000 input tokens per spawn). */
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

/** Map a non-backlog queue to a hint category. backlog uses the DB row's
 *  category directly; other queues map to their natural category. */
const QUEUE_CATEGORY: Record<Exclude<Queue, "backlog">, string> = {
  "bug-fix": "bug",
  "gap-closure": "bug",
  tightening: "refactor",
  roadmap: "roadmap",
  "self-learning": "feature",
  refactor: "refactor",
  creative: "other",
};

/** Returns the hint line for a category, or "" when no hint applies. No
 *  trailing newline; callers add separators in the style of their summary. */
function sectionHintFor(category: string): string {
  const sections = CATEGORY_SECTION_HINTS[category] ?? "";
  if (!sections) return "";
  return `CLAUDE.md sections most relevant for this task: ${sections}.`;
}

/** Prepend the section hint to a multi-line summary that uses "\n" joins. */
function withHint(category: string, lines: string[]): string {
  const hint = sectionHintFor(category);
  if (!hint) return lines.join("\n");
  return [hint, "", ...lines].join("\n");
}

interface PreflightCache {
  sha: string;
  failures: ParsedFailure[];
  observedAt: number;
}

export class Code2wikiAdapter implements ProjectAdapter {
  readonly name = "code2wiki";
  readonly rootDir: string;
  readonly claudeMdPath: string;
  readonly memoryDir: string;
  readonly visualInspectConfig: VisualInspectConfig;
  private readonly classifier: ClassifierConfig;
  private readonly lastCreativeAuditAt: number;
  /** Process-memory preflight cache, keyed by HEAD SHA. Cleared when
   *  bot restarts. Cheap: a clean tree means one cached "no failures"
   *  result re-used until the SHA changes. */
  private preflightCache: PreflightCache | null = null;

  constructor(opts: Code2wikiAdapterOptions) {
    this.rootDir = opts.rootDir;
    this.claudeMdPath = path.join(opts.rootDir, "CLAUDE.md");
    this.memoryDir = opts.memoryDir;
    this.visualInspectConfig = {
      enabled: true,
      detectOnly: true, // v1: detect-only mode
      pixelDiffThreshold: 0.05, // 5%
      fallbackRoutes: ["/dashboard"],
    };
    this.classifier = opts.classifierConfig ?? DEFAULT_CLASSIFIER_CONFIG;
    this.lastCreativeAuditAt = opts.lastCreativeAuditAt ?? 0;
  }

  // ---- Queues ----

  async backlog(): Promise<TaskCandidate[]> {
    // User-curated backlog. Leverage 80-85 (position-boosted), second
    // only to bug-fix (85). Highest deterministic source of work.
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
      // Surface DB failures so we don't silently lose work-picking
      // capability. Other queues still run via Promise.allSettled.
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

    // Pin leverage above gap-closure so a red tree always wins.
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
          `Preflight is red${fileLabel}. Fix the failing test(s) or type error(s) on the current HEAD.`,
          "",
          summary,
          "",
          "Workflow:",
          "1. Read the failing test / type error to understand what's broken.",
          "2. Make the smallest change that fixes the root cause.",
          "3. Run `npm test` and `npm run typecheck` yourself to confirm green BEFORE finishing, don't trust that an edit worked without running.",
          "4. If you fixed the code but tests still fail in a different way, iterate. If you can't fix it in one pass, stop and write a one-line summary of where you got stuck.",
          "",
          "Rules:",
          "- Do NOT modify the assertion in a failing test to make it pass, fix the code under test.",
          "- If the test looks intentional (new test for unimplemented code), implement the missing code.",
          "- Don't touch unrelated files. If the fix needs a sibling change, mention it but don't sprawl.",
          "- Commit with a clear message describing the bug + the fix.",
        ]),
        leverage: 85,
        estTokens: 18_000,
        queue: "bug-fix",
        taskId: `bug:${failures[0]?.label ?? "unknown"}`,
      },
    ];
  }

  async gapClosure(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recent = await recentCommitsWithFiles(this.rootDir, 5);
    // Structured-footer match only: marker must start a line (after
    // optional bullet/whitespace), MUST be followed by a colon, and the
    // captured content must look like a real sentence. This rejects:
    //   - mid-sentence "did NOT run" (no colon → no match)
    //   - stray semicolons / punctuation-only captures (post-filter)
    //   - "Gaps: none" sentinels (post-filter)
    //
    // Multiline mode (`m`) anchors ^ to start of each line in the body.
    const gapMarkers =
      /^[\s\-*•]*(Did NOT verify|Did NOT|Skipped|Memory-only|Deferred|Gaps):\s*(.+)$/gim;
    for (const c of recent) {
      // Ownership filter: commits whose entire file set lives under
      // tools/ocean-bot/ belong to the ocean-bot adapter; skip them so
      // the operator sees that work tagged with project='ocean-bot' on
      // the dashboard instead of mixed in with c2w gaps.
      if (isOceanBotOnly(c.files)) continue;
      for (const m of c.message.matchAll(gapMarkers)) {
        const marker = m[1]?.trim() ?? "";
        const text = m[2]?.trim() ?? "";
        if (!isPlausibleGap(text)) continue;
        out.push({
          summary: withHint(QUEUE_CATEGORY["gap-closure"], [
            `Close gap from recent commit (${marker}): ${truncate(text, 240)}`,
          ]),
          leverage: 70,
          estTokens: 15_000,
          queue: "gap-closure",
          taskId: `gap:${hashish(text)}`,
        });
      }
    }
    return out;
  }

  async tightening(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recentFiles = await filesChangedSince(this.rootDir, "7 days ago");
    // Only scan JS/TS source files: non-source files (.md, .gitignore, config,
    // etc.) contain "todo"/"fixme" descriptively or as filename patterns, not
    // as actionable work items. Test files and bot-self source are excluded.
    // The [cm]? prefix covers .mjs/.cjs/.mts/.cts (ESM/CommonJS variants used
    // by this repo's helper scripts + next.config.mjs).
    const sourceFiles = recentFiles.filter(
      (f) =>
        /\.[cm]?[jt]sx?$/.test(f) &&
        !/\.(test|spec)\.[cm]?[jt]sx?$/.test(f) &&
        !f.startsWith(BOT_SELF_PREFIX),
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
    const out: TaskCandidate[] = [];
    const roadmap = await readIfExists(path.join(this.rootDir, "docs", "roadmap.md"));
    if (!roadmap) return out;
    const lines = roadmap.split("\n");
    let position = 0;
    for (const line of lines) {
      if (!/^\s*-\s+\[\s\]/.test(line)) continue;
      // Inline `<!-- bot: operator-only -->` marker means the operator
      // tagged this as a business/outreach/billing item the bot can't
      // autonomously action. Skip BEFORE stripping the checkbox so the
      // marker stays in the raw line we matched.
      if (/<!--\s*bot:\s*operator-only\s*-->/i.test(line)) continue;
      const text = line.replace(/^\s*-\s+\[\s\]\s*/, "").trim();
      // Skip items tagged for human attention.
      if (/\[(manual|needs-design|blocked|wip)\]/i.test(text)) continue;
      // First items get higher leverage (typically the next-best work).
      const positionalBoost = Math.max(0, 10 - position * 3);
      const complex = text.length > 150;
      out.push({
        summary: withHint(QUEUE_CATEGORY.roadmap, [
          `Roadmap (${text}). Read docs/roadmap.md for full context. Ship the smallest reversible slice that delivers this item; if it requires a non-trivial design decision, write a planning note instead.`,
        ]),
        leverage: 50 + positionalBoost,
        estTokens: complex ? 60_000 : 30_000,
        queue: "roadmap",
        complex,
        // Roadmap items are typically architectural, opus baseline matches
        // the per-category default in the spec ("roadmap: opus"). Keyword /
        // severity rules in selectModel can still downgrade trivial items.
        suggestedModel: "opus",
        taskId: `roadmap:${hashish(text)}`,
      });
      position++;
      if (position >= 3) break;
    }
    return out;
  }

  async selfLearning(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const doc = await readIfExists(
      path.join(this.rootDir, "docs", "self-learning.md"),
    );
    if (!doc) return out;
    // Pick up to two "Phase 1" or "Phase 2" prep items that look unstarted.
    const candidates = doc
      .split("\n")
      .filter((l) => /^\s*-\s+\[\s\]/.test(l))
      .slice(0, 2);
    for (const line of candidates) {
      const text = line.replace(/^\s*-\s+\[\s\]\s*/, "").trim();
      out.push({
        summary: withHint(QUEUE_CATEGORY["self-learning"], [
          `Self-learning: ${text}`,
        ]),
        leverage: 40,
        estTokens: 25_000,
        queue: "self-learning",
        taskId: `selflearn:${hashish(text)}`,
      });
    }
    return out;
  }

  async refactor(): Promise<TaskCandidate[]> {
    const out: TaskCandidate[] = [];
    const recent = await recentCommitShasAndFiles(this.rootDir, 2);
    for (const c of recent) {
      // Mirror the gapClosure ownership filter: ocean-bot-only commits
      // are surfaced by the ocean-bot adapter's refactor() instead.
      if (isOceanBotOnly(c.files)) continue;
      const big = c.files.filter((f) => f.endsWith(".ts")).length;
      if (big >= 3) {
        out.push({
          summary: withHint(QUEUE_CATEGORY.refactor, [
            `Deep-self-review pass on commit ${c.sha.slice(0, 7)} (${c.files.length} files)`,
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
    if (Date.now() - this.lastCreativeAuditAt < ONE_DAY_MS) return [];
    return [
      {
        summary: withHint(QUEUE_CATEGORY.creative, [
          "Creative-improvement audit: read CLAUDE.md, scan recent commits, propose ONE small high-leverage improvement and ship it",
        ]),
        leverage: 15,
        estTokens: 35_000,
        queue: "creative",
        taskId: `creative:${Math.floor(Date.now() / ONE_DAY_MS)}`,
      },
    ];
  }

  // ---- Push rules ----

  pushTarget(_branch: string): PushTarget {
    // code2wiki, direct push to main per feedback_release_flow.md.
    return "main";
  }

  classifyDanger(diff: DiffSummary): DangerReason[] {
    return applyRules(diff, this.classifier);
  }

  // ---- Verification ----

  preflightCommands(): string[] {
    return ["npm test --silent", "npm run typecheck"];
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

    const [testRes, typeRes] = await Promise.all([
      runCmd("npm", ["test", "--silent"], this.rootDir),
      runCmd("npm", ["run", "typecheck"], this.rootDir),
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

  async visualSurfaces(diff: DiffSummary): Promise<VisualSurface[]> {
    const touchesDashboard = diff.files.some((f) =>
      f.startsWith("apps/dashboard/"),
    );
    if (!touchesDashboard) return [];
    // Visual review URL is opt-in. Without it set, return no surfaces
    // → visualVerdict='skipped' → push gate ignores visual.
    // Set OCEAN_BOT_CODE2WIKI_DASHBOARD_URL to a staging / preview URL
    // (never prod) once you're comfortable letting the bot screenshot.
    const base = process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"];
    if (!base) return [];
    return [
      { url: `${base}/architecture`, name: "architecture", viewport: "desktop" },
      { url: `${base}/architecture`, name: "architecture-mobile", viewport: "mobile" },
    ];
  }
}

// ---- helpers ----

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

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
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

/** Reject gap captures that are punctuation-only, "none" sentinels,
 *  too short to act on, or fragments of regex-eaten code. */
function isPlausibleGap(text: string): boolean {
  if (!text) return false;
  if (text.length < 5) return false;
  // Require at least 4 contiguous letters somewhere, filters out
  // punctuation-only, "TBD"-style stubs, and code fragments.
  if (!/[A-Za-z]{4,}/.test(text)) return false;
  // Explicit "no gap" sentinels per the honest-completion protocol.
  if (/^(none|n\/a|n\.a\.|, |--)\b/i.test(text)) return false;
  // Looks like a code fragment we accidentally captured (closing brace,
  // pipe-delimited regex, etc.) rather than prose.
  if (/^[(){}\[\]<>|;,.+\-=*\\/`]+/.test(text)) return false;
  return true;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/** Coerce a DB severity string into the Severity union. Defaults to
 *  'unspecified' for null / empty / unknown values so selectModel() always
 *  gets a valid value. */
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
  // Cheap non-crypto hash; just for taskId uniqueness across ticks.
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}
