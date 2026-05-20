// Backlog read + write operations. Pure DB code, the server-action
// wrappers in app/backlog/actions.ts handle auth + revalidatePath.
//
// IMPORTANT: this module imports `pg` indirectly. Don't import it from
// client components, they should pull from `./backlog-types` instead.

import { getDb, schema } from "./db";
import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

export {
  BACKLOG_CATEGORIES,
  BACKLOG_STATUSES,
  BACKLOG_SEVERITIES,
  SEVERITY_RANK,
  isValidCategory,
  isValidStatus,
  isValidSeverity,
  type BacklogCategory,
  type BacklogStatus,
  type BacklogSeverity,
} from "./backlog-types";
import {
  BACKLOG_SEVERITIES,
  SEVERITY_RANK,
  type BacklogCategory,
  type BacklogStatus,
  type BacklogSeverity,
} from "./backlog-types";

export type BacklogSort = "priority" | "created_at" | "updated_at" | "severity";
export type BacklogSortOrder = "asc" | "desc";
export const VALID_SORT: readonly BacklogSort[] = [
  "priority",
  "created_at",
  "updated_at",
  "severity",
];
export const VALID_ORDER: readonly BacklogSortOrder[] = ["asc", "desc"];

export interface BacklogFilter {
  /** Free-text, matched against title + description with ILIKE. */
  q?: string;
  /** Filter by exact category. */
  category?: BacklogCategory;
  /** Filter by exact severity. */
  severity?: BacklogSeverity;
  /** Filter by exact project. */
  project?: string;
  /** Filter by status. Default: 'open'. Pass 'all' for everything. */
  status?: BacklogStatus | "all";
  /** Created on or after this Date. */
  createdSince?: Date;
  /** Created on or before this Date. */
  createdUntil?: Date;
}

/** Distinct values currently in use, fuels filter dropdowns. */
export async function listBacklogFacets() {
  const db = getDb();
  const [projects, categories] = await Promise.all([
    db
      .selectDistinct({ project: schema.oceanBotBacklogItem.project })
      .from(schema.oceanBotBacklogItem)
      .orderBy(asc(schema.oceanBotBacklogItem.project)),
    db
      .selectDistinct({ category: schema.oceanBotBacklogItem.category })
      .from(schema.oceanBotBacklogItem)
      .orderBy(asc(schema.oceanBotBacklogItem.category)),
  ]);
  return {
    projects: projects.map((p) => p.project),
    categories: categories.map((c) => c.category),
  };
}

function buildBacklogWhere(filter: BacklogFilter) {
  const t = schema.oceanBotBacklogItem;
  const conds = [] as ReturnType<typeof eq>[];

  const status = filter.status ?? "open";
  if (status !== "all") conds.push(eq(t.status, status));
  if (filter.project) conds.push(eq(t.project, filter.project));
  if (filter.category) conds.push(eq(t.category, filter.category));
  if (filter.severity) conds.push(eq(t.severity, filter.severity));
  if (filter.createdSince) conds.push(gte(t.createdAt, filter.createdSince));
  if (filter.createdUntil) conds.push(lte(t.createdAt, filter.createdUntil));

  if (filter.q) {
    const pattern = `%${filter.q}%`;
    const textCond = or(ilike(t.title, pattern), ilike(t.description, pattern));
    if (textCond) conds.push(textCond);
  }

  return conds.length ? and(...conds) : undefined;
}

export async function countBacklog(filter: BacklogFilter = {}): Promise<number> {
  const t = schema.oceanBotBacklogItem;
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(t)
    .where(buildBacklogWhere(filter));
  return rows[0]?.n ?? 0;
}

export async function listBacklog(
  filter: BacklogFilter = {},
  page = 1,
  pageSize = 25,
  sort: BacklogSort = "priority",
  sortOrder: BacklogSortOrder = "asc",
) {
  const t = schema.oceanBotBacklogItem;
  const where = buildBacklogWhere(filter);

  const safeSortOrder = VALID_ORDER.includes(sortOrder) ? sortOrder : "asc";
  // Built from SEVERITY_RANK so the SQL ORDER BY stays in lockstep with
  // higherBugSeverities; both derive from the same single source of truth.
  // unspecified falls through ELSE since it's only ever stored verbatim
  // (typed via BacklogSeverity) but doubly-defended against a future
  // string drift on the column.
  const severityRank = buildSeverityRankSql(t.severity);
  const primaryOrder =
    sort === "created_at"
      ? safeSortOrder === "asc" ? asc(t.createdAt) : desc(t.createdAt)
      : sort === "updated_at"
        ? safeSortOrder === "asc" ? asc(t.updatedAt) : desc(t.updatedAt)
        : sort === "severity"
          ? safeSortOrder === "asc" ? asc(severityRank) : desc(severityRank)
          : asc(t.priority);

  const offset = (Math.max(1, page) - 1) * pageSize;
  const rows = await getDb()
    .select()
    .from(t)
    .where(where)
    .orderBy(primaryOrder, sort === "priority" ? desc(t.createdAt) : asc(t.createdAt))
    .limit(pageSize + 1)
    .offset(offset);

  const hasMore = rows.length > pageSize;
  return { items: hasMore ? rows.slice(0, pageSize) : rows, hasMore };
}

export async function getBacklogItem(id: string) {
  const rows = await getDb()
    .select()
    .from(schema.oceanBotBacklogItem)
    .where(eq(schema.oceanBotBacklogItem.id, id))
    .limit(1);
  return rows[0] ?? null;
}

// ---- mutations ----------------------------------------------------------

export interface CreateBacklogInput {
  id: string;
  project: string;
  category: BacklogCategory;
  title: string;
  description?: string | null;
  status?: BacklogStatus;
  severity?: BacklogSeverity;
  source?: string;
  sourceRef?: string | null;
}

// Auto-placement priority rules: a NEW bug+<severity> lands above lower
// severities and below same-or-higher severities of the same tier. The
// computed insert priority is then injected via "shift rows >= P by +1"
// inside the per-project advisory lock.
//
// "Anything else" includes non-bug rows AND bug+unspecified, both go to
// the bottom (preserves the legacy default behavior for items where the
// operator hasn't classified severity).
//
// Exported so the auto-placement invariant is testable directly without
// spinning up a TEST_URL Postgres. The DB-backed describe blocks cover
// the end-to-end shift behavior; these pure tests guard against a silent
// refactor (e.g., swapping severity strings, accidentally including
// "unspecified" in a higher list) that would still compile + still pass
// every existing DB-skipped CI run.
export function isAutoPlacedBug(
  category: BacklogCategory,
  severity: BacklogSeverity,
): boolean {
  if (category !== "bug") return false;
  return (
    severity === "critical" ||
    severity === "major" ||
    severity === "minor" ||
    severity === "cosmetic"
  );
}

// Builds the ORDER BY CASE expression that maps a severity column to
// its rank. Sibling to higherBugSeverities, both derive from
// SEVERITY_RANK so any future tweak (new tier, reordering) updates
// both call sites in lockstep. unspecified is the ELSE branch (rank 5)
// to defend against a future stored value drift on the column.
export function buildSeverityRankSql<T>(severityCol: T) {
  const cases = BACKLOG_SEVERITIES
    .filter((s) => s !== "unspecified")
    .map((s) => sql`WHEN ${s} THEN ${SEVERITY_RANK[s]}`);
  return sql`CASE ${severityCol} ${sql.join(cases, sql` `)} ELSE ${SEVERITY_RANK.unspecified} END`;
}

// For a bug at the given severity, list the severities that should sort
// ABOVE it (i.e. precondition rows whose count + 1 is the insert slot).
// Derived from SEVERITY_RANK so a future severity tweak only needs to
// touch the rank table; the SQL ORDER BY CASE built above uses the
// same source, keeping in-memory placement and DB sort in lockstep.
// unspecified is excluded from every higher-list by design: bug+unspecified
// bypasses auto-placement (see isAutoPlacedBug), so it never sorts above
// or below real-severity bugs in this helper's view.
export function higherBugSeverities(severity: BacklogSeverity): BacklogSeverity[] {
  if (severity === "unspecified") return [];
  const targetRank = SEVERITY_RANK[severity];
  return BACKLOG_SEVERITIES.filter(
    (s) => s !== "unspecified" && SEVERITY_RANK[s] < targetRank,
  );
}

export async function createBacklogItem(input: CreateBacklogInput) {
  const t = schema.oceanBotBacklogItem;
  const severity: BacklogSeverity = input.severity ?? "unspecified";
  const category = input.category;

  // Atomic priority assignment via per-project advisory lock, without
  // it, two concurrent creates in READ COMMITTED both see the same
  // MAX(priority) and produce duplicate priorities. The lock is held
  // for the transaction's duration and released on commit.
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${input.project}))`,
    );

    let insertPriority: number;
    const autoPlaced = isAutoPlacedBug(category, severity);

    if (autoPlaced) {
      // Count rows in this project that sort strictly above the new item:
      // any bug whose severity is in `higher`. New item slots in directly
      // after that block (count + 1), then everything >= that slot is
      // bumped by +1 to make room.
      const higher = higherBugSeverities(severity);
      const aboveRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(
          and(
            eq(t.project, input.project),
            eq(t.category, "bug"),
            higher.length > 0
              ? inArray(t.severity, higher)
              : sql`false`,
          ),
        );
      insertPriority = (aboveRows[0]?.n ?? 0) + 1;
      await tx
        .update(t)
        .set({ priority: sql`${t.priority} + 1` })
        .where(
          and(eq(t.project, input.project), gte(t.priority, insertPriority)),
        );
    } else {
      const maxRows = await tx
        .select({ maxP: sql<number>`coalesce(max(${t.priority}), 0)::int` })
        .from(t)
        .where(eq(t.project, input.project));
      insertPriority = (maxRows[0]?.maxP ?? 0) + 1;
    }

    await tx.insert(t).values({
      id: input.id,
      project: input.project,
      category,
      title: input.title,
      description: input.description ?? null,
      priority: insertPriority,
      status: input.status ?? "open",
      severity,
      source: input.source ?? "manual",
      sourceRef: input.sourceRef ?? null,
    });
  });
}

export interface UpdateBacklogInput {
  title?: string;
  description?: string | null;
  category?: BacklogCategory;
  status?: BacklogStatus;
  project?: string;
}

export async function updateBacklogItem(id: string, patch: UpdateBacklogInput) {
  const t = schema.oceanBotBacklogItem;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) set["title"] = patch.title;
  if (patch.description !== undefined) set["description"] = patch.description;
  if (patch.category !== undefined) set["category"] = patch.category;
  if (patch.status !== undefined) set["status"] = patch.status;
  if (patch.project !== undefined) set["project"] = patch.project;

  const result = await getDb().update(t).set(set).where(eq(t.id, id)).returning();
  if (result.length === 0) throw new Error("backlog item not found");
}

/** Change an item's severity AND re-run auto-placement under the same
 *  per-project advisory lock. The row is removed from its current slot
 *  (everything strictly below shifts up by 1), then reinserted at the
 *  priority dictated by the new (category, severity) tuple. Same
 *  invariant as createBacklogItem: priorities stay dense, no dupes. */
export async function updateBacklogItemSeverity(
  id: string,
  severity: BacklogSeverity,
) {
  const t = schema.oceanBotBacklogItem;
  await getDb().transaction(async (tx) => {
    const rows = await tx
      .select({
        project: t.project,
        category: t.category,
        priority: t.priority,
      })
      .from(t)
      .where(eq(t.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("backlog item not found");
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${row.project}))`,
    );
    // Close the gap left by the row's current slot before computing the
    // new slot, so the count-based math sees a clean per-project density.
    await tx
      .update(t)
      .set({ priority: sql`${t.priority} - 1` })
      .where(
        and(eq(t.project, row.project), gte(t.priority, row.priority + 1)),
      );

    const category = row.category as BacklogCategory;
    const autoPlaced = isAutoPlacedBug(category, severity);
    let nextP: number;
    if (autoPlaced) {
      const higher = higherBugSeverities(severity);
      const aboveRows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(
          and(
            eq(t.project, row.project),
            eq(t.category, "bug"),
            higher.length > 0
              ? inArray(t.severity, higher)
              : sql`false`,
            // Exclude the row being moved, its current slot was already
            // collapsed above, so the count reflects "rows that should
            // sort above the new placement," nothing more.
            sql`${t.id} <> ${id}`,
          ),
        );
      nextP = (aboveRows[0]?.n ?? 0) + 1;
      await tx
        .update(t)
        .set({ priority: sql`${t.priority} + 1` })
        .where(
          and(
            eq(t.project, row.project),
            gte(t.priority, nextP),
            sql`${t.id} <> ${id}`,
          ),
        );
    } else {
      const maxRows = await tx
        .select({ maxP: sql<number>`coalesce(max(${t.priority}), 0)::int` })
        .from(t)
        .where(and(eq(t.project, row.project), sql`${t.id} <> ${id}`));
      nextP = (maxRows[0]?.maxP ?? 0) + 1;
    }
    await tx
      .update(t)
      .set({ severity, priority: nextP, updatedAt: new Date() })
      .where(eq(t.id, id));
  });
}

/** Bulk priority rewrite. `orderedIds` is the new top-down order; index 0
 *  becomes priority 1, index 1 becomes 2, etc. */
export async function reorderBacklog(orderedIds: string[]) {
  if (orderedIds.length === 0) return;
  const t = schema.oceanBotBacklogItem;
  const db = getDb();
  const now = new Date();
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(t)
        .set({ priority: i + 1, updatedAt: now })
        .where(eq(t.id, orderedIds[i]!));
    }
  });
}

export async function archiveBacklogItem(id: string) {
  await updateBacklogItem(id, { status: "archived" });
}

export async function deleteBacklogItem(id: string) {
  await getDb()
    .delete(schema.oceanBotBacklogItem)
    .where(eq(schema.oceanBotBacklogItem.id, id));
}
