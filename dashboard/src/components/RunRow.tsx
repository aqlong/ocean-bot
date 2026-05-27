import Link from "next/link";
import { cx } from "@/lib/cx";
import { LocalTime } from "./local-time";
import { ProjectChip } from "@/components/ProjectChip";
import { computeRunRowDisplay } from "./run-row-display";

export interface RunRowProps {
  id: string;
  project: string;
  queue: string;
  taskSummary: string;
  status: string;
  startedAt: Date;
  dangerLevel: string | null;
  outOfBandShipped?: boolean;
  outcome?: "shipped" | "shipped-noop";
}

export function RunRow({ run }: { run: RunRowProps }) {
  const display = computeRunRowDisplay(run);
  return (
    <Link
      href={`/runs/${run.id}`}
      className="flex items-center justify-between gap-3 rounded border border-line bg-panel p-3 text-sm hover:border-accent"
    >
      <div className="min-w-0 flex-1">
        <div className={cx("truncate", display.taskColor)}>
          {run.taskSummary}
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-dim">
          <ProjectChip project={run.project} />
          <span>· {run.queue} ·</span>
          <LocalTime
            iso={run.startedAt.toISOString()}
            format="compact-with-relative"
          />
          {run.dangerLevel === "super-dangerous" && (
            <span>· ⚠ super-dangerous</span>
          )}
        </div>
      </div>
      <div
        className={cx(
          "flex shrink-0 items-center gap-1.5 text-xs",
          display.statusColor,
        )}
      >
        {display.kind === "noop" ? (
          <>
            <span>{display.mainLabel}</span>
            <span className="rounded border border-line/60 px-1 py-0.5 text-[10px] uppercase tracking-wide text-dim">
              {display.badge}
            </span>
          </>
        ) : (
          display.label
        )}
      </div>
    </Link>
  );
}
