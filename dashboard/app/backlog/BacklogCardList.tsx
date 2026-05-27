import { LocalTime } from "@/components/local-time";
import { ProjectChip } from "@/components/ProjectChip";
import { cx } from "@/lib/cx";
import { highlightMatches } from "@/lib/highlight";

interface Row {
  id: string;
  project: string;
  category: string;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  severity: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const CAT_COLOR: Record<string, string> = {
  bug: "bg-bad/20 text-bad",
  test: "bg-accent/20 text-accent",
  roadmap: "bg-good/20 text-good",
  refactor: "bg-warn/20 text-warn",
  docs: "bg-dim/20 text-dim",
  chore: "bg-dim/20 text-dim",
  feature: "bg-accent/20 text-accent",
  other: "bg-dim/20 text-dim",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "bg-bad/30 text-bad border-bad/40",
  major: "bg-warn/30 text-warn border-warn/40",
  minor: "bg-accent/20 text-accent border-accent/30",
  cosmetic: "bg-dim/20 text-dim border-line",
  unspecified: "bg-panel text-dim border-line",
};

const STATUS_COLOR: Record<string, string> = {
  open: "text-ink",
  "in-progress": "text-warn",
  done: "text-good",
  blocked: "text-bad",
  archived: "text-dim",
};

export function BacklogCardList({ items, query = "" }: { items: Row[]; query?: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-2">
      {items.map((row) => (
        <CardItem key={row.id} row={row} query={query} />
      ))}
    </ul>
  );
}

function CardItem({ row, query = "" }: { row: Row; query?: string }) {
  const sev = row.severity || "unspecified";
  const updatedDiffers = row.updatedAt.getTime() !== row.createdAt.getTime();

  return (
    <li className="rounded border border-line bg-panel p-3 text-xs">
      {/* Top row: project + category on left, severity + status on right */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <ProjectChip project={row.project} />
          <span
            className={cx(
              "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
              CAT_COLOR[row.category] ?? CAT_COLOR["other"],
            )}
          >
            {row.category}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className={cx(
              "text-[10px] font-bold uppercase",
              STATUS_COLOR[row.status] ?? "text-dim",
            )}
          >
            {row.status}
          </span>
          <span
            className={cx(
              "rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase",
              SEVERITY_COLOR[sev] ?? SEVERITY_COLOR["unspecified"],
            )}
          >
            {sev}
          </span>
        </div>
      </div>

      {/* Title */}
      <div className="mt-2 break-words font-medium text-ink">{highlightMatches(row.title, query)}</div>

      {/* Date chips */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] text-dim">
        <span>
          created{" "}
          <LocalTime iso={row.createdAt.toISOString()} format="compact-with-relative" />
        </span>
        {updatedDiffers && (
          <span>
            updated{" "}
            <LocalTime iso={row.updatedAt.toISOString()} format="compact-with-relative" />
          </span>
        )}
      </div>

      {/* Description: collapsed by default, first line visible as preview */}
      {row.description && (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            <div className="flex items-baseline gap-2">
              <span className="line-clamp-1 break-words text-[11px] text-dim">
                {highlightMatches(firstLine(row.description), query)}
              </span>
              <span className="select-none whitespace-nowrap text-[10px] text-dim group-open:hidden">
                show more ▸
              </span>
              <span className="hidden select-none whitespace-nowrap text-[10px] text-dim group-open:inline">
                hide ▾
              </span>
            </div>
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words rounded bg-bg/40 p-2 text-[11px] text-dim">
            {highlightMatches(row.description, query)}
          </div>
        </details>
      )}
    </li>
  );
}

function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return s;
}
