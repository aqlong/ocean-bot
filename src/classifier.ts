// Super-dangerous classifier. Project-agnostic rule library. Each
// project's adapter calls applyRules() with a project-specific config.
//
// Rules 1..11 mirror docs/ocean-bot.md "Super-dangerous classifier"
// section exactly. Edit there, mirror here. Tests pin the behavior.
//
// Severity split (2026-05-16): the 11 rules are partitioned into
// "critical" (operator must approve under any non-manual mode) and
// "advisory" (logged on the run but does not block auto-push). The
// operator's mental model: "critical = I'd lose data, money, audit
// chain integrity, or break the bot itself if a regression slipped
// through". Advisory rules are noisy-but-recoverable signals.

import type { DiffSummary, DangerReason } from "./adapters/types.js";

/** Rule IDs that block auto-push regardless of approval mode (other
 *  than manual). Hit list:
 *    1  publisher edits (customer page corruption)
 *    2  audit log changes (irreversible hash chain)
 *    3  destructive schema migration (data loss)
 *    4  Stripe charge path (real money)
 *    8  credential/secret-like paths
 *   10  destructive git commands in the diff
 *   11  bot self-modification (can put the bot in a crash loop only
 *       the operator can recover from)
 *  Rules 5, 6, 7, 9 are advisory (logged + surfaced on dashboard but
 *  do not block push under "auto"/"auto-with-visual"). */
export const CRITICAL_RULE_IDS: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 8, 10, 11,
]);

/** True iff this reason should block auto-push. */
export function isCriticalReason(r: DangerReason): boolean {
  return CRITICAL_RULE_IDS.has(r.ruleId);
}

/** Split a reasons list into critical (blocking) and advisory (logged). */
export function splitDangerReasons(reasons: DangerReason[]): {
  critical: DangerReason[];
  advisory: DangerReason[];
} {
  const critical: DangerReason[] = [];
  const advisory: DangerReason[] = [];
  for (const r of reasons) {
    if (isCriticalReason(r)) critical.push(r);
    else advisory.push(r);
  }
  return { critical, advisory };
}

export interface ClassifierConfig {
  /** Glob-like prefix matches (substring on path) that trigger rule 1. */
  publisherPaths: string[]; // e.g. ["src/core/publishers/"]
  /** Files that trigger rule 2 (audit). */
  auditPaths: string[]; // e.g. ["src/core/audit.ts", "src/core/audit/"]
  /** Schema file(s) for destructive-migration detection (rule 3). */
  schemaPaths: string[]; // e.g. ["apps/dashboard/src/lib/db/schema.ts"]
  /** Stripe / billing paths (rule 4). */
  stripePaths: string[];
  /** Customer-facing onboarding doc paths whose code-block examples
   *  are load-bearing (rule 5). */
  onboardingDocPaths: string[];
  /** Bot-self-modification root (rule 11). */
  botSelfPaths: string[];
  /** Known external API hosts the project already uses. New hosts in
   *  the diff trigger rule 7. */
  knownFetchHosts: string[];
}

const DESTRUCTIVE_SQL =
  /\b(drop\s+(?:column|table|index|constraint)|alter\s+type|truncate)\b/i;

const FETCH_HOST_RE =
  /(?:fetch|new\s+URL)\s*\(\s*["'`]https?:\/\/([a-z0-9.-]+)/gi;

const SECRET_PATH_RE =
  /(^|\/)(\.env(\..+)?|secrets?[^/]*|[^/]*key[^/]*\.pem|[^/]*\.pem)$/i;

const CI_WORKFLOW_RE = /^\.github\/workflows\/.+\.ya?ml$/;

const FORCE_PUSH_RE =
  /git\s+push\s+(?:[^&;|]*\s)?-(?:f|-force(?:-with-lease)?)|git\s+reset\s+--hard|git\s+branch\s+-D|git\s+rebase\s+\b(?!.*--abort)/i;

export function applyRules(
  diff: DiffSummary,
  cfg: ClassifierConfig,
): DangerReason[] {
  const reasons: DangerReason[] = [];

  const touched = (prefixes: string[]) =>
    diff.files.filter((f) => prefixes.some((p) => f.startsWith(p)));

  // Rule 1, publisher edits
  const publisherHits = touched(cfg.publisherPaths);
  if (publisherHits.length > 0) {
    reasons.push({
      ruleId: 1,
      explanation: `Publisher edits could break live customer pages: ${publisherHits.join(", ")}`,
    });
  }

  // Rule 2, audit log
  const auditHits = touched(cfg.auditPaths);
  if (auditHits.length > 0) {
    reasons.push({
      ruleId: 2,
      explanation: `Audit chain change is irreversible: ${auditHits.join(", ")}`,
    });
  }

  // Rule 3, destructive schema migration
  const schemaHits = touched(cfg.schemaPaths);
  if (schemaHits.length > 0 && DESTRUCTIVE_SQL.test(diff.patch)) {
    reasons.push({
      ruleId: 3,
      explanation: `Destructive schema migration in ${schemaHits.join(", ")}`,
    });
  }

  // Rule 4, Stripe charge path
  const stripeHits = touched(cfg.stripePaths);
  if (stripeHits.length > 0 && touchesChargePath(diff.patch)) {
    reasons.push({
      ruleId: 4,
      explanation: `Stripe charge-path edit: ${stripeHits.join(", ")}`,
    });
  }

  // Rule 5, onboarding docs with code-block examples
  const onboardingHits = touched(cfg.onboardingDocPaths);
  if (onboardingHits.length > 0 && /```/.test(diff.patch)) {
    reasons.push({
      ruleId: 5,
      explanation: `Customer-onboarding doc code example: ${onboardingHits.join(", ")}`,
    });
  }

  // Rule 6, diff size
  if (diff.added + diff.removed > 500 || diff.files.length > 10) {
    reasons.push({
      ruleId: 6,
      explanation: `Diff too large for auto-review: ${diff.files.length} files, ${diff.added + diff.removed} lines`,
    });
  }

  // Rule 7, new external fetch host
  const newHosts = newFetchHosts(diff.patch, cfg.knownFetchHosts);
  if (newHosts.length > 0) {
    reasons.push({
      ruleId: 7,
      explanation: `New external host(s) in diff: ${newHosts.join(", ")}`,
    });
  }

  // Rule 8, secret-like paths
  const secretHits = diff.files.filter((f) => SECRET_PATH_RE.test(f));
  if (secretHits.length > 0) {
    reasons.push({
      ruleId: 8,
      explanation: `Credential-like path touched: ${secretHits.join(", ")}`,
    });
  }

  // Rule 9, CI workflows
  const ciHits = diff.files.filter((f) => CI_WORKFLOW_RE.test(f));
  if (ciHits.length > 0) {
    reasons.push({
      ruleId: 9,
      explanation: `CI workflow change: ${ciHits.join(", ")}`,
    });
  }

  // Rule 10, force-push / rebase / branch-delete patterns in the patch
  if (FORCE_PUSH_RE.test(diff.patch)) {
    reasons.push({
      ruleId: 10,
      explanation: "Patch contains destructive git command (force-push / reset --hard / branch -D / rebase)",
    });
  }

  // Rule 11, bot self-modification
  const botSelfHits = touched(cfg.botSelfPaths);
  if (botSelfHits.length > 0) {
    reasons.push({
      ruleId: 11,
      explanation: `Bot self-modification: ${botSelfHits.join(", ")}`,
    });
  }

  return reasons;
}

function touchesChargePath(patch: string): boolean {
  // Heuristic: diff lines starting with + that reference Stripe charge / payment / subscription APIs.
  const re =
    /^\+.*\b(stripe\.charges|stripe\.paymentIntents|stripe\.subscriptions|stripe\.invoices)\b/m;
  return re.test(patch);
}

function newFetchHosts(patch: string, known: string[]): string[] {
  const found = new Set<string>();
  const knownSet = new Set(known.map((h) => h.toLowerCase()));

  for (const line of patch.split("\n")) {
    if (!line.startsWith("+")) continue;
    // Reset lastIndex since the regex uses /g.
    FETCH_HOST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FETCH_HOST_RE.exec(line))) {
      const host = m[1]?.toLowerCase();
      if (host && !knownSet.has(host)) found.add(host);
    }
  }
  return [...found].sort();
}
