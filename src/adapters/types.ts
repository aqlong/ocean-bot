// Project adapter interface. Each project (code2wiki, cas, inference-audit)
// implements this to plug into the bot's leverage queue + push gate +
// visual reviewer. Multi-project extensibility from day one, v1 wires
// only code2wiki, but the shape is stable.

export type Queue =
  | "backlog"
  | "bug-fix"
  | "gap-closure"
  | "tightening"
  | "roadmap"
  | "self-learning"
  | "refactor"
  | "creative";

export type DangerLevel = "safe" | "caution" | "super-dangerous";

export type Model = "haiku" | "sonnet" | "opus";

export type Severity =
  | "critical"
  | "major"
  | "minor"
  | "cosmetic"
  | "unspecified";

export interface TaskCandidate {
  /** One-line summary fed to `claude -p` as the task prompt. */
  summary: string;
  /** 0..100, queue picker sorts by this. */
  leverage: number;
  /** Rough estimate; budget broker uses for predictive gating. */
  estTokens: number;
  /** Queue this candidate came from (filled by adapter). */
  queue: Queue;
  /** Adapter hint; classifier still runs after the run. */
  dangerHint?: DangerLevel;
  /** Legacy: true → routes to opus in the old length-based heuristic.
   *  Superseded by suggestedModel + selectModel(). Kept for back-compat
   *  with run metadata historians. */
  complex?: boolean;
  /** Adapter-set baseline model. selectModel() refines this with keyword
   *  / severity / budget / failure-history. Null/undefined → queue default. */
  suggestedModel?: Model;
  /** Backlog-item severity (when sourced from oceanBotBacklogItem); empty
   *  for other queues. Drives the severity-override branch of selectModel. */
  severity?: Severity;
  /** Optional stable id for de-duplication across ticks. */
  taskId?: string;
  /** Force a fresh `claude` session even when a same-project resume id
   *  is cached. Set for cross-project work, super-dangerous changes, or
   *  any task where the previous transcript would mislead. Unset (the
   *  default) lets the runner resume within 24h. */
  isolate?: boolean;
}

export interface DiffSummary {
  /** Files changed, relative to repo root. */
  files: string[];
  /** Total lines added. */
  added: number;
  /** Total lines removed. */
  removed: number;
  /** Raw `git diff` for substring/regex inspection. */
  patch: string;
}

export interface DangerReason {
  /** Rule number 1..11 from docs/ocean-bot.md. */
  ruleId: number;
  /** Human-readable explanation; surfaced on the approval card. */
  explanation: string;
}

export interface VisualSurface {
  /** URL to screenshot. May be a localhost dev server URL, adapter is
   * responsible for spinning that up before visualSurfaces() returns. */
  url: string;
  /** Stable name; used as the baseline filename. */
  name: string;
  /** Viewport: 'desktop' | 'mobile'. Both run if both listed. */
  viewport: "desktop" | "mobile";
  /** Optional assertion text, fed to the reviewer LLM. */
  assertion?: string;
}

export type PushTarget = "main" | "staging" | "pr-only";

export interface VisualInspectConfig {
  /** Enable automatic pixel-diff detection for UI changes. */
  enabled: boolean;
  /** Detect-only mode (default true): flag regressions but don't revise. */
  detectOnly?: boolean;
  /** Pixel-diff threshold (0-1, default 0.05 = 5%). */
  pixelDiffThreshold?: number;
  /** Fallback routes if grep can't infer from imports. */
  fallbackRoutes?: string[];
}

export interface ProjectAdapter {
  /** Stable project key. Matches the `project` column in ocean_bot_run. */
  name: string;
  /** Absolute path to the project root. */
  rootDir: string;
  /** Absolute path to CLAUDE.md (used to confirm the dir is the right project). */
  claudeMdPath: string;
  /** Memory directory for this project's per-project memory files. */
  memoryDir: string;
  /** Visual inspection config (Playwright pixel-diff detection). */
  visualInspectConfig?: VisualInspectConfig;

  // ---- Queue sources ----
  // Each returns 0..N candidate tasks for this tick. Empty array is fine.
  // Errors should be caught + logged, not thrown, one queue's failure
  // shouldn't block the others.
  backlog(): Promise<TaskCandidate[]>;
  bugFix(): Promise<TaskCandidate[]>;
  gapClosure(): Promise<TaskCandidate[]>;
  tightening(): Promise<TaskCandidate[]>;
  roadmap(): Promise<TaskCandidate[]>;
  selfLearning(): Promise<TaskCandidate[]>;
  refactor(): Promise<TaskCandidate[]>;
  creative(): Promise<TaskCandidate[]>;

  // ---- Push rules ----
  pushTarget(branch: string): PushTarget;
  /** Returns DangerReason[] if super-dangerous; empty array if safe. */
  classifyDanger(diff: DiffSummary): DangerReason[];

  // ---- Verification ----
  /** Commands run after the bot's edits, in order. Non-zero exit blocks push. */
  preflightCommands(): string[];
  /** Visual surfaces to screenshot + review. Empty if non-UI. */
  visualSurfaces(diff: DiffSummary): Promise<VisualSurface[]>;
}
