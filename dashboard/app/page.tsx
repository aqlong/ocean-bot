import Link from "next/link";
import {
  summaryToday,
  summaryWeek,
  recentRuns,
  budgetState,
  botStateFlags,
  pausedState,
  failedRunsWithCommitSinceMin,
  lastShippedByProject,
  type LastShippedRow,
} from "@/lib/queries";
import { driftSnapshot, type DriftSnapshot } from "@/lib/health-queries";
import {
  annotateFailedRuns,
  applyOutOfBandShipped,
} from "@/lib/reclassify";
import { cx } from "@/lib/cx";
import { LocalTime } from "../src/components/local-time";
import { InFlightCard } from "@/components/InFlightCard";
import { ProjectChip } from "@/components/ProjectChip";
import { RunRow } from "@/components/RunRow";
import { AutoRefreshIndicator } from "@/components/AutoRefreshIndicator";

export const dynamic = "force-dynamic";
export const revalidate = 5; // auto-refresh approximation

export default async function Overview() {
  const [
    todayRaw,
    weekRaw,
    rawRuns,
    todayFailed,
    weekFailed,
    budget,
    flags,
    pause,
    drift,
    byProject,
  ] = await Promise.all([
    summaryToday(),
    summaryWeek(),
    recentRuns(8),
    failedRunsWithCommitSinceMin(24 * 60),
    failedRunsWithCommitSinceMin(7 * 24 * 60),
    budgetState() as Promise<null | {
      gate: "ok" | "wait" | "stop";
      worstRatio: number;
      reason?: string;
    }>,
    botStateFlags(),
    pausedState(),
    driftSnapshot(),
    lastShippedByProject(5),
  ]);

  // Reclassify failed runs whose commit IS on origin/{branch}: the
  // bot's push-step failed, but the operator pushed the commit by
  // hand. Adjust counters + tag the run rows so the badge reads
  // "shipped (out-of-band)" instead of just "failed."
  const [todayAdj, weekAdj, runs] = await Promise.all([
    annotateFailedRuns(todayFailed),
    annotateFailedRuns(weekFailed),
    annotateFailedRuns(rawRuns),
  ]);
  const todayOob = todayAdj.filter((r) => r.outOfBandShipped).length;
  const weekOob = weekAdj.filter((r) => r.outOfBandShipped).length;
  const today = applyOutOfBandShipped(todayRaw, todayOob);
  const week = applyOutOfBandShipped(weekRaw, weekOob);

  const paused = flags["paused"] === true;
  const gate = budget?.gate ?? "ok";

  const cancelEnabled = process.env["OCEAN_BOT_CANCEL_ENABLED"] === "1";

  return (
    <div className="space-y-6">
      {drift?.drift && <DriftBanner drift={drift} />}
      <InFlightCard cancelEnabled={cancelEnabled} />
      {pause.paused && <PausedBanner pausedSince={pause.pausedSince} />}
      <StatusBar paused={paused} gate={gate} budget={budget} />
      <div className="flex justify-end">
        <AutoRefreshIndicator intervalSec={5} />
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="today shipped" value={today.shipped} tone="good" />
        <Stat label="today awaiting" value={today.awaitingApproval} tone="warn" />
        <Stat label="today failed" value={today.failed} tone="bad" />
        <Stat label="today total" value={today.total} />
        <Stat label="7d shipped" value={week.shipped} tone="good" />
        <Stat label="7d awaiting" value={week.awaitingApproval} tone="warn" />
        <Stat label="7d failed" value={week.failed} tone="bad" />
        <Stat label="7d total" value={week.total} />
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between text-sm text-dim">
          <span>recent runs</span>
          <Link href="/approvals" className="hover:text-ink">
            approvals →
          </Link>
        </div>
        <div className="space-y-2">
          {runs.length === 0 && (
            <div className="rounded border border-line bg-panel p-4 text-sm text-dim">
              no runs yet, bot is either booting, paused, or budget-throttled
            </div>
          )}
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </div>
        <div className="mt-2 text-right text-xs">
          <Link href="/runs" className="text-dim hover:text-ink">
            older →
          </Link>
        </div>
      </section>

      <ByProjectSection byProject={byProject} />
    </div>
  );
}

function ByProjectSection({
  byProject,
}: {
  byProject: Record<string, LastShippedRow[]>;
}) {
  const projects = Object.keys(byProject).sort();
  if (projects.length === 0) return null;
  return (
    <section>
      <div className="mb-2 text-sm text-dim">by project (last 5 shipped)</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard
            key={project}
            project={project}
            rows={byProject[project] ?? []}
          />
        ))}
      </div>
    </section>
  );
}

function ProjectCard({
  project,
  rows,
}: {
  project: string;
  rows: LastShippedRow[];
}) {
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="mb-2">
        <ProjectChip project={project} />
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-dim">no shipped runs yet</div>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/runs/${r.id}`}
                className="block truncate text-sm text-ink hover:text-accent"
                title={r.taskSummary}
              >
                {r.taskSummary}
              </Link>
              <div className="text-xs text-dim">
                {r.commitSha.slice(0, 7)} ·{" "}
                <LocalTime
                  iso={r.startedAt.toISOString()}
                  format="compact-with-relative"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DriftBanner({ drift }: { drift: DriftSnapshot }) {
  // Drift means dist/.built-from-sha doesn't match the repo's HEAD, the
  // running JS is from a different commit than the code on disk. Operator
  // must restart the bot; the launchd wrapper will re-pull + re-build +
  // re-stamp on next launch. See docs/ocean-bot.md.
  const builtShort = drift.builtFromSha?.slice(0, 7) ?? "?";
  const headShort = drift.headSha?.slice(0, 7) ?? "?";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
      <span className="text-lg leading-none">⚠️</span>
      <span className="font-bold">Stale, restart needed</span>
      <span className="text-bad/80">
        running {builtShort} · HEAD is {headShort}
        {drift.reason ? ` (${drift.reason})` : ""}
      </span>
      <Link
        href="/health"
        className="ml-auto underline decoration-bad/40 hover:decoration-bad"
      >
        Details on /health →
      </Link>
    </div>
  );
}

function PausedBanner({ pausedSince }: { pausedSince: Date | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
      <span className="text-lg leading-none">⏸</span>
      <span className="font-bold">Bot is paused</span>
      {pausedSince && (
        <span className="text-warn/80">
          (since <LocalTime iso={pausedSince.toISOString()} />)
        </span>
      )}
      <Link
        href="/settings"
        className="ml-auto underline decoration-warn/40 hover:decoration-warn"
      >
        Resume in /settings →
      </Link>
    </div>
  );
}

function StatusBar({
  paused,
  gate,
  budget,
}: {
  paused: boolean;
  gate: "ok" | "wait" | "stop";
  budget: null | { worstRatio: number; reason?: string };
}) {
  let icon = "🟢";
  let label = "running";
  if (paused) {
    icon = "⏸";
    label = "user-paused";
  } else if (gate === "stop") {
    icon = "🟡";
    label = `budget-paused: ${budget?.reason ?? "at cap"}`;
  } else if (gate === "wait") {
    icon = "🟡";
    label = `budget-warning: ${budget?.reason ?? "near cap"}`;
  }
  const pct = budget?.worstRatio
    ? `${Math.min(100, Math.round(budget.worstRatio * 100))}%`
    : null;

  return (
    <div className="flex items-center gap-3 rounded border border-line bg-panel px-4 py-3">
      <span className="text-xl">{icon}</span>
      <div className="flex-1">
        <div className="text-sm text-ink">{label}</div>
        {pct && <div className="text-xs text-dim">bot budget: {pct} of cap</div>}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn" | "bad";
}) {
  const color =
    tone === "good"
      ? "text-good"
      : tone === "warn"
        ? "text-warn"
        : tone === "bad"
          ? "text-bad"
          : "text-ink";
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="text-xs text-dim">{label}</div>
      <div className={cx("text-2xl font-bold", color)}>{value}</div>
    </div>
  );
}


