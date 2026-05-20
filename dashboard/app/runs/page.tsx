import { listRuns } from "@/lib/queries";
import { annotateFailedRuns } from "@/lib/reclassify";
import { KNOWN_PROJECTS } from "@/lib/projects";
import { buildRunsFilter } from "@/lib/runs-filter";
import { RunRow } from "@/components/RunRow";
import { Pagination } from "@/components/Pagination";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const RUN_STATUSES = [
  "shipped",
  "awaiting-approval",
  "failed",
  "rejected",
  "running",
  "blocked",
] as const;

const SINCE_OPTIONS = [
  { label: "all time", value: "" },
  { label: "last 24h", value: "1d" },
  { label: "last 7 days", value: "7d" },
  { label: "last 30 days", value: "30d" },
] as const;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const sp = await searchParams;
  const { filter, page } = buildRunsFilter(sp);

  const { runs: rawRuns, hasMore } = await listRuns(filter, page);
  const runs = await annotateFailedRuns(rawRuns);

  // Strip the page param from searchParams when building filter-only
  // URLs for the Pagination component (it injects page itself).
  const spForPagination: Record<string, string> = Object.fromEntries(
    Object.entries(sp).filter(([k]) => k !== "page"),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-sm text-dim">runs</h1>
      </div>

      <FilterForm sp={sp} />

      <div className="space-y-2">
        {runs.length === 0 ? (
          <div className="rounded border border-line bg-panel p-4 text-sm text-dim">
            no runs match the current filters
          </div>
        ) : (
          runs.map((r) => <RunRow key={r.id} run={r} />)
        )}
      </div>

      <Pagination
        page={page}
        hasMore={hasMore}
        count={runs.length}
        searchParams={spForPagination}
      />
    </div>
  );
}

// GET form so filters survive without any client JS. Each input's
// defaultValue is pre-populated from the current URL searchParams so
// the operator sees what's active at a glance.
function FilterForm({ sp }: { sp: Record<string, string> }) {
  return (
    <form
      method="get"
      action="/runs"
      className="flex flex-wrap items-end gap-2 rounded border border-line bg-panel p-3 text-xs"
    >
      <label className="flex flex-col gap-1">
        <span className="text-dim">project</span>
        <select
          name="project"
          defaultValue={sp["project"] ?? ""}
          className="rounded border border-line bg-bg px-2 py-1 text-ink focus:border-accent focus:outline-none"
        >
          <option value="">all</option>
          {KNOWN_PROJECTS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-dim">queue</span>
        <input
          type="text"
          name="queue"
          defaultValue={sp["queue"] ?? ""}
          placeholder="any"
          className="w-28 rounded border border-line bg-bg px-2 py-1 text-ink placeholder:text-dim/50 focus:border-accent focus:outline-none"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-dim">status</span>
        <select
          name="status"
          defaultValue={sp["status"] ?? ""}
          className="rounded border border-line bg-bg px-2 py-1 text-ink focus:border-accent focus:outline-none"
        >
          <option value="">all</option>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-dim">since</span>
        <select
          name="since"
          defaultValue={sp["since"] ?? ""}
          className="rounded border border-line bg-bg px-2 py-1 text-ink focus:border-accent focus:outline-none"
        >
          {SINCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded border border-accent/40 px-3 py-1 text-accent hover:bg-accent/10"
      >
        filter
      </button>

      {/* Clear link only shown when any filter is active. */}
      {(sp["project"] || sp["queue"] || sp["status"] || sp["since"]) && (
        <a href="/runs" className="px-1 py-1 text-dim hover:text-ink">
          clear
        </a>
      )}
    </form>
  );
}
