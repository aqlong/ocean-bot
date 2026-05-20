import {
  listBacklog,
  countBacklog,
  listBacklogFacets,
  BACKLOG_CATEGORIES,
  BACKLOG_SEVERITIES,
  BACKLOG_STATUSES,
  VALID_SORT,
  VALID_ORDER,
  type BacklogCategory,
  type BacklogSeverity,
  type BacklogStatus,
  type BacklogFilter,
  type BacklogSort,
  type BacklogSortOrder,
} from "@/lib/backlog-ops";
import { BacklogTable } from "./BacklogTable";
import { AddItemForm } from "./AddItemForm";
import { KNOWN_PROJECTS } from "@/lib/projects";
import { Pagination } from "@/components/Pagination";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const revalidate = 5;

const PAGE_SIZE = 25;

type SP = Record<string, string | string[] | undefined>;

function readParam(sp: SP, key: string): string | undefined {
  const v = sp[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

function parseSort(v: string | undefined): BacklogSort {
  if (v && (VALID_SORT as readonly string[]).includes(v)) return v as BacklogSort;
  return "priority";
}

function parseSortOrder(v: string | undefined): BacklogSortOrder {
  if (v === "desc") return "desc";
  return "asc";
}

function parsePage(v: string | undefined): number {
  const n = parseInt(v ?? "1", 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function parseFilter(sp: SP): BacklogFilter & { activeStatus: BacklogStatus | "all" } {
  const filter: BacklogFilter = {};
  const status = readParam(sp, "status") ?? "open";
  if (status === "all" || (BACKLOG_STATUSES as readonly string[]).includes(status)) {
    filter.status = status as BacklogStatus | "all";
  }
  const q = readParam(sp, "q");
  if (q) filter.q = q;
  const project = readParam(sp, "project");
  if (project) filter.project = project;
  const cat = readParam(sp, "category");
  if (cat && (BACKLOG_CATEGORIES as readonly string[]).includes(cat)) {
    filter.category = cat as BacklogCategory;
  }
  const sev = readParam(sp, "severity");
  if (sev && (BACKLOG_SEVERITIES as readonly string[]).includes(sev)) {
    filter.severity = sev as BacklogSeverity;
  }
  const since = readParam(sp, "since");
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) filter.createdSince = d;
  }
  const until = readParam(sp, "until");
  if (until) {
    const d = new Date(until);
    if (!Number.isNaN(d.getTime())) filter.createdUntil = d;
  }
  return { ...filter, activeStatus: (filter.status ?? "open") };
}

/** Build a /backlog href by merging current sp with overrides, resetting page. */
function backlogHref(base: SP, overrides: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === "string" && v) p.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === "") {
      p.delete(k);
    } else {
      p.set(k, v);
    }
  }
  p.delete("page");
  const q = p.toString();
  return q ? `/backlog?${q}` : "/backlog";
}

function toStringRecord(sp: SP): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sp)
      .filter(([, v]) => typeof v === "string" && v !== "")
      .map(([k, v]) => [k, v as string]),
  );
}

export default async function BacklogPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const filter = parseFilter(sp);
  const sort = parseSort(readParam(sp, "sort"));
  const sortOrder = parseSortOrder(readParam(sp, "order"));
  const page = parsePage(readParam(sp, "page"));

  const showBlockedBanner =
    filter.activeStatus !== "blocked" && filter.activeStatus !== "all";

  const [{ items, hasMore }, total, facets, blocked] = await Promise.all([
    listBacklog(filter, page, PAGE_SIZE, sort, sortOrder),
    countBacklog(filter),
    listBacklogFacets(),
    showBlockedBanner
      ? listBacklog(
          { status: "blocked", ...(filter.project ? { project: filter.project } : {}) },
          1,
          50,
        )
      : Promise.resolve({
          items: [] as Awaited<ReturnType<typeof listBacklog>>["items"],
          hasMore: false,
        }),
  ]);

  const spRecord = toStringRecord(sp);
  const spForPagination: Record<string, string> = Object.fromEntries(
    Object.entries(spRecord).filter(([k]) => k !== "page"),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">backlog</h1>
        <div className="text-xs text-dim">
          {total} item{total === 1 ? "" : "s"}
        </div>
      </div>

      <ProjectTabs sp={sp} activeProject={filter.project} />

      <div className="sticky top-12 z-10 bg-bg/95 backdrop-blur">
        <FilterBar filter={filter} facets={facets} />
      </div>

      <SortBar sp={sp} activeSort={sort} activeSortOrder={sortOrder} />

      <AddItemForm defaultProject={filter.project ?? "code2wiki"} />

      {showBlockedBanner && blocked.items.length > 0 && (
        <section className="space-y-2 rounded border border-warn/40 bg-warn/5 p-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase text-warn">
              blocked, needs operator review
            </h2>
            <span className="text-[10px] text-dim">
              {blocked.items.length} item{blocked.items.length === 1 ? "" : "s"}
            </span>
          </div>
          <p className="text-[11px] text-dim">
            The bot auto-blocked these after repeated push failures (commits
            kept getting rebased away). Inspect the item, then reopen it or
            archive it.
          </p>
          <BacklogTable items={blocked.items} />
        </section>
      )}

      <BacklogTable items={items} />

      {items.length === 0 && total === 0 && (
        <div className="rounded border border-line bg-panel p-6 text-center text-sm text-dim">
          no items match the current filter, try clearing it or{" "}
          <Link href="/backlog" className="text-accent hover:underline">
            reset
          </Link>
        </div>
      )}

      <Pagination
        page={page}
        hasMore={hasMore}
        count={items.length}
        searchParams={spForPagination}
        basePath="/backlog"
        itemLabel="items"
      />
    </div>
  );
}

function ProjectTabs({
  sp,
  activeProject,
}: {
  sp: SP;
  activeProject?: string;
}) {
  const tabs: Array<{ label: string; value: string | undefined }> = [
    { label: "all", value: undefined },
    ...KNOWN_PROJECTS.map((p) => ({ label: p, value: p })),
  ];

  return (
    <div className="-mx-1 flex flex-wrap gap-x-1 gap-y-1 overflow-x-auto px-1 text-xs">
      {tabs.map(({ label, value }) => {
        const active = value === activeProject;
        return (
          <Link
            key={label}
            href={backlogHref(sp, { project: value ?? "" })}
            className={
              active
                ? "rounded bg-accent/20 px-3 py-1 font-bold text-accent"
                : "rounded px-3 py-1 text-dim hover:text-ink"
            }
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

const SORT_COLS: Array<{ key: BacklogSort; label: string }> = [
  { key: "priority", label: "priority" },
  { key: "created_at", label: "created" },
  { key: "updated_at", label: "updated" },
  { key: "severity", label: "severity" },
];

function SortBar({
  sp,
  activeSort,
  activeSortOrder,
}: {
  sp: SP;
  activeSort: BacklogSort;
  activeSortOrder: BacklogSortOrder;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs text-dim">
      <span>sort:</span>
      {SORT_COLS.map(({ key, label }) => {
        const isActive = key === activeSort;
        const nextOrder = isActive && activeSortOrder === "asc" ? "desc" : "asc";
        const orderIndicator = isActive ? (activeSortOrder === "asc" ? " ↑" : " ↓") : "";
        return (
          <Link
            key={key}
            href={backlogHref(sp, { sort: key, order: nextOrder })}
            className={
              isActive
                ? "rounded bg-panel px-2 py-0.5 text-ink"
                : "rounded px-2 py-0.5 hover:text-ink"
            }
          >
            {label}
            {orderIndicator}
          </Link>
        );
      })}
    </div>
  );
}

function FilterBar({
  filter,
  facets,
}: {
  filter: BacklogFilter & { activeStatus: BacklogStatus | "all" };
  facets: { projects: string[]; categories: string[] };
}) {
  return (
    <form
      method="get"
      className="grid grid-cols-2 gap-2 rounded border border-line bg-panel p-3 sm:grid-cols-3 lg:grid-cols-6"
    >
      <input
        type="text"
        name="q"
        defaultValue={filter.q ?? ""}
        placeholder="search title/description"
        className="col-span-2 rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-dim sm:col-span-3 lg:col-span-2"
      />
      <select
        name="project"
        defaultValue={filter.project ?? ""}
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
      >
        <option value="">all projects</option>
        {[
          ...KNOWN_PROJECTS,
          ...facets.projects.filter(
            (p) => !(KNOWN_PROJECTS as readonly string[]).includes(p),
          ),
        ].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        name="category"
        defaultValue={filter.category ?? ""}
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
      >
        <option value="">all categories</option>
        {BACKLOG_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select
        name="severity"
        defaultValue={filter.severity ?? ""}
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
      >
        <option value="">all severities</option>
        {BACKLOG_SEVERITIES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select
        name="status"
        defaultValue={filter.activeStatus}
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
      >
        <option value="open">open</option>
        <option value="in-progress">in-progress</option>
        <option value="done">done</option>
        <option value="blocked">blocked</option>
        <option value="archived">archived</option>
        <option value="all">all statuses</option>
      </select>
      <input
        type="date"
        name="since"
        defaultValue={
          filter.createdSince
            ? filter.createdSince.toISOString().slice(0, 10)
            : ""
        }
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        title="created since"
      />
      <input
        type="date"
        name="until"
        defaultValue={
          filter.createdUntil
            ? filter.createdUntil.toISOString().slice(0, 10)
            : ""
        }
        className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        title="created until"
      />
      <button
        type="submit"
        className="rounded bg-accent/20 px-3 py-1 text-xs font-bold text-accent hover:bg-accent/30"
      >
        Apply
      </button>
      <Link
        href="/backlog"
        className="rounded bg-bg px-3 py-1 text-center text-xs text-dim hover:text-ink"
      >
        Reset
      </Link>
    </form>
  );
}
