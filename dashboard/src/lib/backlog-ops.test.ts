// Integration tests for backlog CRUD + reorder against ocean_bot_test.
// Skipped when OCEAN_BOT_TEST_DATABASE_URL isn't set.

import { describe, it, expect, beforeEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

import {
  createBacklogItem,
  countBacklog,
  updateBacklogItem,
  updateBacklogItemSeverity,
  reorderBacklog,
  archiveBacklogItem,
  deleteBacklogItem,
  listBacklog,
  getBacklogItem,
  listBacklogFacets,
  isValidCategory,
  isValidSeverity,
  isValidStatus,
  isAutoPlacedBug,
  higherBugSeverities,
  buildSeverityRankSql,
  SEVERITY_RANK,
  BACKLOG_SEVERITIES,
} from "./backlog-ops";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

async function truncate(): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    "TRUNCATE ocean_bot_backlog_item RESTART IDENTITY CASCADE;",
  );
  await c.end();
}

async function seed(
  id: string,
  over: Partial<{
    project: string;
    category: string;
    title: string;
    description: string;
    status: string;
    severity: string;
  }> = {},
): Promise<void> {
  await createBacklogItem({
    id,
    project: over.project ?? "code2wiki",
    category: (over.category ?? "bug") as never,
    title: over.title ?? `task ${id}`,
    description: over.description ?? null,
    status: (over.status ?? "open") as never,
    ...(over.severity ? { severity: over.severity as never } : {}),
  });
}

describe("isValidCategory / isValidStatus", () => {
  it.each(["bug", "test", "roadmap", "refactor", "docs", "chore", "feature", "other"])(
    "accepts %s",
    (v) => {
      expect(isValidCategory(v)).toBe(true);
    },
  );
  it("rejects unknown categories", () => {
    expect(isValidCategory("hot-fix")).toBe(false);
    expect(isValidCategory("")).toBe(false);
    expect(isValidCategory(null)).toBe(false);
  });
  it.each(["open", "in-progress", "done", "archived"])(
    "isValidStatus accepts %s",
    (v) => {
      expect(isValidStatus(v)).toBe(true);
    },
  );
});

D("createBacklogItem assigns next priority", () => {
  beforeEach(truncate);

  it("first item gets priority 1", async () => {
    await seed("R1");
    const { items: rows } = await listBacklog({ project: "code2wiki" });
    expect(rows[0]?.priority).toBe(1);
  });

  it("subsequent items get incrementing priority per project", async () => {
    await seed("A1", { project: "code2wiki" });
    await seed("A2", { project: "code2wiki" });
    await seed("B1", { project: "cas" });
    const { items: cw } = await listBacklog({ project: "code2wiki" });
    const { items: cas } = await listBacklog({ project: "cas" });
    expect(cw.map((r) => r.priority).sort()).toEqual([1, 2]);
    expect(cas.map((r) => r.priority)).toEqual([1]);
  });

  it("concurrent creates produce distinct priorities (atomic subquery)", async () => {
    // Issue 10 inserts in parallel. If priority assignment is non-atomic
    // (max+1 select then separate insert), we'd see duplicate priorities.
    // With the subquery + Postgres row-level locking we get 1..10.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        seed(`C${i}`, { project: "code2wiki" }),
      ),
    );
    const { items: rows } = await listBacklog({ project: "code2wiki" }, 1, 50);
    const priorities = rows.map((r) => r.priority).sort((a, b) => a - b);
    const unique = new Set(priorities);
    expect(unique.size).toBe(10);
    expect(priorities).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

D("listBacklog filtering", () => {
  beforeEach(truncate);

  it("text search matches title", async () => {
    await seed("A", { title: "fix the cfml parser" });
    await seed("B", { title: "add Notion publisher" });
    const { items: out } = await listBacklog({ q: "cfml" });
    expect(out.map((r) => r.id)).toEqual(["A"]);
  });

  it("text search matches description", async () => {
    await seed("A", { title: "x", description: "investigate edge cases in cfml" });
    await seed("B", { title: "y", description: "ship Notion v2" });
    const { items: out } = await listBacklog({ q: "edge cases" });
    expect(out.map((r) => r.id)).toEqual(["A"]);
  });

  it("category filter", async () => {
    await seed("A", { category: "bug" });
    await seed("B", { category: "feature" });
    const { items: bugs } = await listBacklog({ category: "bug" });
    expect(bugs.map((r) => r.id)).toEqual(["A"]);
  });

  it("project filter", async () => {
    await seed("A", { project: "code2wiki" });
    await seed("B", { project: "cas" });
    const { items: cw } = await listBacklog({ project: "code2wiki" });
    expect(cw.map((r) => r.id)).toEqual(["A"]);
  });

  it("status defaults to 'open' and excludes others", async () => {
    await seed("A", { status: "open" });
    await seed("B", { status: "done" });
    await seed("C", { status: "archived" });
    const { items: out } = await listBacklog({});
    expect(out.map((r) => r.id)).toEqual(["A"]);
  });

  it("status=all returns every status", async () => {
    await seed("A", { status: "open" });
    await seed("B", { status: "done" });
    const { items: out } = await listBacklog({ status: "all" });
    expect(out.map((r) => r.id).sort()).toEqual(["A", "B"]);
  });

  it("orders by priority ascending", async () => {
    await seed("A");
    await seed("B");
    await seed("C");
    await reorderBacklog(["C", "B", "A"]);
    const { items: out } = await listBacklog({});
    expect(out.map((r) => r.id)).toEqual(["C", "B", "A"]);
  });
});

D("listBacklogFacets returns distinct projects + categories", () => {
  beforeEach(truncate);

  it("returns deduped, sorted lists", async () => {
    await seed("A", { project: "code2wiki", category: "bug" });
    await seed("B", { project: "cas", category: "bug" });
    await seed("C", { project: "code2wiki", category: "test" });
    const f = await listBacklogFacets();
    expect(f.projects.sort()).toEqual(["cas", "code2wiki"]);
    expect(f.categories.sort()).toEqual(["bug", "test"]);
  });
});

D("updateBacklogItem partial patch", () => {
  beforeEach(truncate);

  it("updates only specified fields", async () => {
    await seed("X", { title: "old title", description: "old desc" });
    await updateBacklogItem("X", { title: "new title" });
    const row = await getBacklogItem("X");
    expect(row?.title).toBe("new title");
    expect(row?.description).toBe("old desc"); // untouched
  });

  it("rejects unknown id", async () => {
    await expect(updateBacklogItem("nope", { title: "x" })).rejects.toThrow(
      /not found/,
    );
  });
});

D("reorderBacklog assigns 1..N", () => {
  beforeEach(truncate);

  it("rewrites priority in array order", async () => {
    await seed("A");
    await seed("B");
    await seed("C");
    await reorderBacklog(["B", "C", "A"]);
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => ({ id: r.id, p: r.priority }))).toEqual([
      { id: "B", p: 1 },
      { id: "C", p: 2 },
      { id: "A", p: 3 },
    ]);
  });

  it("empty array is a no-op", async () => {
    await seed("A");
    await reorderBacklog([]);
    const { items: rows } = await listBacklog({});
    expect(rows[0]?.priority).toBe(1);
  });
});

D("archiveBacklogItem + deleteBacklogItem", () => {
  beforeEach(truncate);

  it("archive flips status, hides from default listing", async () => {
    await seed("A");
    await archiveBacklogItem("A");
    expect((await listBacklog({})).items.length).toBe(0);
    expect((await listBacklog({ status: "archived" })).items.length).toBe(1);
  });

  it("delete removes the row entirely", async () => {
    await seed("A");
    await deleteBacklogItem("A");
    expect(await getBacklogItem("A")).toBeNull();
  });
});

describe("isValidSeverity", () => {
  it.each(["critical", "major", "minor", "cosmetic", "unspecified"])(
    "accepts %s",
    (v) => {
      expect(isValidSeverity(v)).toBe(true);
    },
  );
  it("rejects unknown severities", () => {
    expect(isValidSeverity("blocker")).toBe(false);
    expect(isValidSeverity("")).toBe(false);
    expect(isValidSeverity(null)).toBe(false);
  });
});

// Pure-helper tests for the auto-placement invariant. The DB-backed
// describe blocks below cover the end-to-end shift behavior; these
// tests run without TEST_URL so CI catches refactor regressions even
// when the DB block is skipped.
describe("isAutoPlacedBug", () => {
  it.each(["critical", "major", "minor", "cosmetic"] as const)(
    "bug + %s is auto-placed",
    (sev) => {
      expect(isAutoPlacedBug("bug", sev)).toBe(true);
    },
  );

  it("bug + unspecified is NOT auto-placed (legacy bottom-fallback)", () => {
    // Load-bearing: bug+unspecified must skip the higher-list branch in
    // createBacklogItem so it lands at MAX(priority)+1 like non-bug rows.
    // A future refactor that conflates "is bug" with "is auto-placed"
    // would silently re-route unspecified bugs to slot 1.
    expect(isAutoPlacedBug("bug", "unspecified")).toBe(false);
  });

  it.each([
    ["test", "critical"],
    ["refactor", "major"],
    ["docs", "minor"],
    ["chore", "cosmetic"],
    ["roadmap", "unspecified"],
    ["feature", "critical"],
    ["other", "major"],
  ] as const)("non-bug %s + %s is NOT auto-placed", (cat, sev) => {
    expect(isAutoPlacedBug(cat, sev)).toBe(false);
  });
});

describe("higherBugSeverities", () => {
  it("critical has no higher severities (top of the order)", () => {
    expect(higherBugSeverities("critical")).toEqual([]);
  });

  it("major sits above only critical", () => {
    expect(higherBugSeverities("major")).toEqual(["critical"]);
  });

  it("minor sits above critical + major (in priority order)", () => {
    expect(higherBugSeverities("minor")).toEqual(["critical", "major"]);
  });

  it("cosmetic sits above critical + major + minor (in priority order)", () => {
    expect(higherBugSeverities("cosmetic")).toEqual([
      "critical",
      "major",
      "minor",
    ]);
  });

  it("unspecified returns empty (unreachable for callers; defensive default)", () => {
    // createBacklogItem only calls this when isAutoPlacedBug returned true,
    // and isAutoPlacedBug excludes unspecified. The empty-array return is
    // a defensive default; pinning it prevents a future refactor from
    // accidentally listing all four real severities as "higher than
    // unspecified" (which would push unspecified-severity bugs above
    // everything when the auto-placed gate eventually loosens).
    expect(higherBugSeverities("unspecified")).toEqual([]);
  });

  it("never includes unspecified in any higher-list (regression guard)", () => {
    // unspecified sits at the bottom by design; surfacing it in a higher
    // list for ANY severity would invert the bottom-fallback contract.
    for (const sev of ["critical", "major", "minor", "cosmetic", "unspecified"] as const) {
      expect(higherBugSeverities(sev)).not.toContain("unspecified");
    }
  });

  it("returned lists strictly grow from critical -> cosmetic (rank monotonicity)", () => {
    // The auto-placement slot for a new bug is count(higherBugSeverities)+1.
    // If the lists weren't monotone (e.g., minor returned 3 entries while
    // cosmetic returned 2), a new cosmetic bug could land ABOVE a minor
    // bug, silently corrupting the bug-priority order. Catch via lengths.
    expect(higherBugSeverities("critical").length).toBeLessThan(
      higherBugSeverities("major").length,
    );
    expect(higherBugSeverities("major").length).toBeLessThan(
      higherBugSeverities("minor").length,
    );
    expect(higherBugSeverities("minor").length).toBeLessThan(
      higherBugSeverities("cosmetic").length,
    );
  });

  it("higher-list is consistent with SEVERITY_RANK (single-source-of-truth invariant)", () => {
    // Independent re-derivation: for any non-unspecified severity, the
    // higher-list is exactly the non-unspecified severities whose rank is
    // strictly less than the target's rank, preserving the BACKLOG_SEVERITIES
    // declaration order. If a future refactor swapped higherBugSeverities to
    // hand-written branches that drifted from SEVERITY_RANK, this test
    // would fail before the DB-backed sort tests get a chance to.
    for (const sev of ["critical", "major", "minor", "cosmetic"] as const) {
      const expected = BACKLOG_SEVERITIES.filter(
        (s) => s !== "unspecified" && SEVERITY_RANK[s] < SEVERITY_RANK[sev],
      );
      expect(higherBugSeverities(sev)).toEqual(expected);
    }
  });
});

describe("SEVERITY_RANK", () => {
  it("ranks are distinct + strictly monotone in BACKLOG_SEVERITIES order", () => {
    // Two invariants in one test:
    // (1) no two severities share a rank (a tie would break ORDER BY CASE),
    // (2) ranks increase in declaration order so unspecified stays last.
    const ranks = BACKLOG_SEVERITIES.map((s) => SEVERITY_RANK[s]);
    expect(new Set(ranks).size).toBe(ranks.length);
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThan(ranks[i - 1]!);
    }
  });

  it("unspecified is the largest rank (bottom of the order)", () => {
    // Load-bearing: the SQL ORDER BY uses ELSE SEVERITY_RANK.unspecified
    // for any unexpected column value, so unspecified MUST be >= every
    // real severity or unknown values would sort above real bugs.
    for (const sev of ["critical", "major", "minor", "cosmetic"] as const) {
      expect(SEVERITY_RANK.unspecified).toBeGreaterThan(SEVERITY_RANK[sev]);
    }
  });

  it("covers every BacklogSeverity (no orphan + no extra key)", () => {
    // Defends against a future severity tier added to BACKLOG_SEVERITIES
    // without updating SEVERITY_RANK (or vice versa); that drift would
    // make the SQL CASE silently route the new tier through the ELSE.
    expect(Object.keys(SEVERITY_RANK).sort()).toEqual(
      [...BACKLOG_SEVERITIES].sort(),
    );
  });
});

describe("buildSeverityRankSql", () => {
  // Compile the dynamic CASE against the same dialect Postgres receives,
  // then snapshot-compare against the hand-written form that shipped before
  // SEVERITY_RANK was extracted. Catches a drift where either side of the
  // invariant gets touched without the other (e.g., a new severity added
  // to the rank table but not reflected in the ORDER BY column expression).
  const dialect = new PgDialect();

  it("compiles to a parameterized CASE covering every real severity in rank order", () => {
    const col = sql`severity`;
    const compiled = dialect.sqlToQuery(buildSeverityRankSql(col));
    expect(compiled.sql).toBe(
      "CASE severity WHEN $1 THEN $2 WHEN $3 THEN $4 WHEN $5 THEN $6 WHEN $7 THEN $8 ELSE $9 END",
    );
    expect(compiled.params).toEqual([
      "critical", 1,
      "major", 2,
      "minor", 3,
      "cosmetic", 4,
      5,
    ]);
  });

  it("produces equivalent ranks to the prior literal CASE for every severity", () => {
    // The pre-refactor SQL hand-encoded WHEN 'critical' THEN 1 ... ELSE 5.
    // Re-evaluate the dynamic form in-memory against each severity to pin
    // the same mapping; a future SEVERITY_RANK edit that diverges from
    // intent fails this test before any Postgres roundtrip.
    const col = sql`severity`;
    const compiled = dialect.sqlToQuery(buildSeverityRankSql(col));
    // Mimic Postgres' CASE evaluation: walk WHEN/THEN pairs, return ELSE
    // if no WHEN matches. The params array layout is [w1, t1, w2, t2, ..., elseRank].
    function evalRank(value: string): number {
      const params = compiled.params;
      for (let i = 0; i < params.length - 1; i += 2) {
        if (params[i] === value) return params[i + 1] as number;
      }
      return params[params.length - 1] as number;
    }
    expect(evalRank("critical")).toBe(1);
    expect(evalRank("major")).toBe(2);
    expect(evalRank("minor")).toBe(3);
    expect(evalRank("cosmetic")).toBe(4);
    expect(evalRank("unspecified")).toBe(5);
    // Defense against column drift: a value that's not in any WHEN falls
    // through ELSE to 5, the same bottom-of-the-order behavior as unspecified.
    expect(evalRank("not-a-real-severity")).toBe(5);
  });
});

D("createBacklogItem severity-aware auto-placement", () => {
  beforeEach(truncate);

  it("empty backlog: each severity lands at priority 1 (no precondition rows)", async () => {
    for (const sev of ["critical", "major", "minor", "cosmetic"] as const) {
      await truncate();
      await seed(`S-${sev}`, { severity: sev });
      const { items: rows } = await listBacklog({});
      expect(rows[0]?.priority).toBe(1);
      expect(rows[0]?.severity).toBe(sev);
    }
  });

  it("empty backlog: bug+unspecified and non-bug land at bottom (priority 1 when alone)", async () => {
    await seed("A", { severity: "unspecified" });
    await seed("B", { category: "feature", severity: "critical" });
    const { items: rows } = await listBacklog({});
    // Both come in via the default-bottom path; first gets 1, second gets 2.
    expect(rows.map((r) => ({ id: r.id, p: r.priority }))).toEqual([
      { id: "A", p: 1 },
      { id: "B", p: 2 },
    ]);
  });

  it("new bug+critical shifts everything down by 1", async () => {
    await seed("OLD1", { severity: "unspecified" });
    await seed("OLD2", { category: "feature" });
    await seed("CRIT", { severity: "critical" });
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => ({ id: r.id, p: r.priority }))).toEqual([
      { id: "CRIT", p: 1 },
      { id: "OLD1", p: 2 },
      { id: "OLD2", p: 3 },
    ]);
  });

  it("new bug+major lands at count(criticals)+1 and shifts the rest down", async () => {
    await seed("C1", { severity: "critical" });
    await seed("C2", { severity: "critical" });
    await seed("OLD", { category: "feature" });
    await seed("MAJ", { severity: "major" });
    const { items: rows } = await listBacklog({});
    // Expected: C1(crit)=1, C2(crit)=2, wait, second critical lands AT 1
    // shifting C1 to 2. So actually: C2=1, C1=2, then OLD lands at bottom
    // (priority 3), then MAJ lands at count(crit=2)+1 = 3, shifting
    // OLD → 4. Final: C2=1, C1=2, MAJ=3, OLD=4.
    expect(rows.map((r) => r.id)).toEqual(["C2", "C1", "MAJ", "OLD"]);
    expect(rows.map((r) => r.priority)).toEqual([1, 2, 3, 4]);
  });

  it("bug+minor lands after critical+major, before non-bug rows", async () => {
    await seed("C", { severity: "critical" });
    await seed("M", { severity: "major" });
    await seed("FEAT", { category: "feature" });
    await seed("MIN", { severity: "minor" });
    const { items: rows } = await listBacklog({});
    // count(crit+major) = 2 → MIN lands at 3, shifting FEAT 3 → 4.
    expect(rows.map((r) => r.id)).toEqual(["C", "M", "MIN", "FEAT"]);
    expect(rows.map((r) => r.priority)).toEqual([1, 2, 3, 4]);
  });

  it("bug+cosmetic lands after critical/major/minor bugs, before non-bug rows", async () => {
    await seed("C", { severity: "critical" });
    await seed("M", { severity: "major" });
    await seed("MN", { severity: "minor" });
    await seed("FEAT", { category: "feature" });
    await seed("COS", { severity: "cosmetic" });
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => r.id)).toEqual(["C", "M", "MN", "COS", "FEAT"]);
    expect(rows.map((r) => r.priority)).toEqual([1, 2, 3, 4, 5]);
  });

  it("non-bug rows ignore severity, always land at bottom", async () => {
    await seed("OLD");
    // category=feature but severity=critical, should NOT auto-place.
    await seed("FX", { category: "feature", severity: "critical" });
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => r.id)).toEqual(["OLD", "FX"]);
    expect(rows.map((r) => r.priority)).toEqual([1, 2]);
  });

  it("two parallel critical inserts produce distinct priorities (1 and 2)", async () => {
    // The advisory lock serializes both calls. After both commit the
    // second critical sits at priority 1 (pushed the first to 2).
    await Promise.all([
      seed("X", { severity: "critical" }),
      seed("Y", { severity: "critical" }),
    ]);
    const { items: rows } = await listBacklog({});
    const priorities = rows.map((r) => r.priority).sort((a, b) => a - b);
    expect(priorities).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["X", "Y"]));
  });
});

D("updateBacklogItemSeverity re-places under the same lock", () => {
  beforeEach(truncate);

  it("upgrading severity moves the row up", async () => {
    // Seed: B(bug+unspecified)=1, A(feature+unspecified)=2.
    // Upgrade B to critical: B vacates p=1 (A collapses 2 -> 1), then
    // the critical placement reclaims p=1 for B (A shifts back to 2).
    await seed("B", { severity: "unspecified" });
    await seed("A", { category: "feature" });
    expect((await listBacklog({})).items.map((r) => r.id)).toEqual(["B", "A"]);
    await updateBacklogItemSeverity("B", "critical");
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => ({ id: r.id, p: r.priority, sev: r.severity }))).toEqual([
      { id: "B", p: 1, sev: "critical" },
      { id: "A", p: 2, sev: "unspecified" },
    ]);
  });

  it("downgrading severity pushes the row toward the bottom", async () => {
    await seed("C", { severity: "critical" });
    await seed("M", { severity: "major" });
    await seed("MN", { severity: "minor" });
    // Downgrade C from critical → cosmetic. Expected ordering after:
    // M(major)=1, MN(minor)=2, C(cosmetic)=3.
    await updateBacklogItemSeverity("C", "cosmetic");
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => r.id)).toEqual(["M", "MN", "C"]);
    expect(rows.map((r) => r.priority)).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.id === "C")?.severity).toBe("cosmetic");
  });

  it("setting severity to unspecified on a bug sends it to the bottom", async () => {
    await seed("C", { severity: "critical" });
    await seed("MN", { severity: "minor" });
    await updateBacklogItemSeverity("C", "unspecified");
    const { items: rows } = await listBacklog({});
    expect(rows.map((r) => r.id)).toEqual(["MN", "C"]);
  });
});

D("countBacklog", () => {
  beforeEach(truncate);

  it("returns 0 for empty backlog", async () => {
    expect(await countBacklog({})).toBe(0);
  });

  it("matches row count for no filter", async () => {
    await seed("A");
    await seed("B");
    await seed("C");
    expect(await countBacklog({})).toBe(3);
  });

  it("shares the same WHERE predicate as listBacklog (project filter)", async () => {
    await seed("A", { project: "code2wiki" });
    await seed("B", { project: "cas" });
    const { items } = await listBacklog({ project: "code2wiki" });
    const n = await countBacklog({ project: "code2wiki" });
    expect(n).toBe(items.length);
    expect(n).toBe(1);
  });

  it("excludes archived items by default (status='open')", async () => {
    await seed("A", { status: "open" });
    await seed("B", { status: "archived" });
    expect(await countBacklog({})).toBe(1);
    expect(await countBacklog({ status: "all" })).toBe(2);
  });
});

D("listBacklog pagination", () => {
  beforeEach(truncate);

  it("hasMore=false when rows <= pageSize", async () => {
    await seed("A");
    await seed("B");
    const { items, hasMore } = await listBacklog({}, 1, 5);
    expect(hasMore).toBe(false);
    expect(items.length).toBe(2);
  });

  it("hasMore=true when rows > pageSize", async () => {
    for (let i = 0; i < 4; i++) await seed(`P${i}`);
    const { items, hasMore } = await listBacklog({}, 1, 3);
    expect(hasMore).toBe(true);
    expect(items.length).toBe(3);
  });

  it("page 2 returns the correct slice", async () => {
    await seed("A");
    await seed("B");
    await seed("C");
    await reorderBacklog(["A", "B", "C"]);
    const { items: p2 } = await listBacklog({}, 2, 2);
    expect(p2.map((r) => r.id)).toEqual(["C"]);
  });
});

D("listBacklog sort", () => {
  beforeEach(truncate);

  it("sort=severity asc places critical before major before minor", async () => {
    await seed("MN", { severity: "minor" });
    await seed("CR", { severity: "critical" });
    await seed("MA", { severity: "major" });
    const { items } = await listBacklog({}, 1, 25, "severity", "asc");
    expect(items.map((r) => r.severity)).toEqual(["critical", "major", "minor"]);
  });

  it("sort=severity desc reverses the order", async () => {
    await seed("MN", { severity: "minor" });
    await seed("CR", { severity: "critical" });
    await seed("MA", { severity: "major" });
    const { items } = await listBacklog({}, 1, 25, "severity", "desc");
    expect(items.map((r) => r.severity)).toEqual(["minor", "major", "critical"]);
  });
});
