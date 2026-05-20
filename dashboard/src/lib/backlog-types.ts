// Client-safe constants + types for the backlog. Kept separate from
// backlog-ops.ts because the latter imports `pg` which webpack refuses
// to bundle for client components.

export const BACKLOG_CATEGORIES = [
  "bug",
  "test",
  "roadmap",
  "refactor",
  "docs",
  "chore",
  "feature",
  "other",
] as const;
export type BacklogCategory = (typeof BACKLOG_CATEGORIES)[number];

export const BACKLOG_STATUSES = [
  "open",
  "in-progress",
  "done",
  "blocked",
  "archived",
] as const;
export type BacklogStatus = (typeof BACKLOG_STATUSES)[number];

// Severity captures "how bad", orthogonal to category. Combined with
// category to auto-place new items in the queue (see backlog-ops.ts).
// Order here is most -> least severe; the placement logic depends on
// the ordering only via explicit checks, not array index.
export const BACKLOG_SEVERITIES = [
  "critical",
  "major",
  "minor",
  "cosmetic",
  "unspecified",
] as const;
export type BacklogSeverity = (typeof BACKLOG_SEVERITIES)[number];

// Numeric rank used by BOTH the in-memory auto-placement helper
// (higherBugSeverities in backlog-ops.ts) AND the SQL `ORDER BY` CASE
// expression that powers `?sort=severity`. Sharing the table is
// load-bearing: a refactor that drifted one out of step with the other
// would corrupt either the auto-placement priority or the sort order
// for every backlog page, AND would only be caught by the DB-backed
// tests gated on OCEAN_BOT_TEST_DATABASE_URL (skipped in CI).
// Lower number = higher in the queue. unspecified sits at the bottom
// by design; bug+unspecified bypasses auto-placement entirely in
// createBacklogItem.
export const SEVERITY_RANK: Record<BacklogSeverity, number> = {
  critical: 1,
  major: 2,
  minor: 3,
  cosmetic: 4,
  unspecified: 5,
};

export function isValidCategory(v: unknown): v is BacklogCategory {
  return (
    typeof v === "string" &&
    (BACKLOG_CATEGORIES as readonly string[]).includes(v)
  );
}

export function isValidStatus(v: unknown): v is BacklogStatus {
  return (
    typeof v === "string" && (BACKLOG_STATUSES as readonly string[]).includes(v)
  );
}

export function isValidSeverity(v: unknown): v is BacklogSeverity {
  return (
    typeof v === "string" &&
    (BACKLOG_SEVERITIES as readonly string[]).includes(v)
  );
}
