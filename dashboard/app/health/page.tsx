import type * as React from "react";
import {
  phantomRowCount,
  lastPhantomCleanupRun,
  lastHealthSweep,
  type HealthSweepSnapshot,
  type HealthSweepStuckGroup,
} from "@/lib/queries";
import { driftSnapshot, type DriftSnapshot } from "@/lib/health-queries";
import { LocalTime } from "../approvals/local-time";
import { ProjectChip } from "@/components/ProjectChip";
import { AutoRefreshIndicator } from "@/components/AutoRefreshIndicator";

// Public health surface. Two sections:
//   - Drift: branch + dist + last-build, driven by the bot's per-tick
//     drift state. Red → operator needs to restart the bot (the boot
//     wrapper will re-pull + re-build + re-stamp).
//   - Phantom-row cleanup: count + last-run, driven by the nightly
//     cleanup tick.
//
// No auth: matches /api/healthz. Excluded from the middleware matcher
// so unauthenticated visitors get a clean render.

export const dynamic = "force-dynamic";
export const revalidate = 30;

const STALE_THRESHOLD_MS = 36 * 60 * 60 * 1000; // 1.5x the 24h interval

export default async function HealthPage() {
  const [phantom7d, lastRun, drift, healthSweep] = await Promise.all([
    phantomRowCount(7),
    lastPhantomCleanupRun(),
    driftSnapshot(),
    lastHealthSweep(),
  ]);

  const now = Date.now();
  const sinceMs = lastRun?.ranAt ? now - lastRun.ranAt.getTime() : null;
  const stale = sinceMs === null || sinceMs > STALE_THRESHOLD_MS;
  const phantomBad = phantom7d > 0;

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-xl font-bold text-ink">health</h1>
          <AutoRefreshIndicator intervalSec={30} />
        </div>
        <p className="text-sm text-dim">
          drift + phantom-row cleanup. all three drift rows green means the
          running bot matches the repo; red means restart needed.
        </p>
      </header>

      <DriftSection drift={drift} now={now} />

      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-dim">
          phantom rows
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Metric
            label="phantom rows (last 7d)"
            value={phantom7d}
            tone={phantomBad ? "bad" : "good"}
            hint="rows matching shipped+local+null-commit+null-decision. target: 0."
          />
          <Metric
            label="last cleanup flipped"
            value={lastRun?.flipped ?? 0}
            tone={lastRun ? "good" : "warn"}
            hint={
              lastRun?.ranAt ? (
                <>
                  ran{" "}
                  <LocalTime
                    iso={lastRun.ranAt.toISOString()}
                    format="compact-with-relative"
                  />
                </>
              ) : (
                "cleanup has not run yet"
              )
            }
          />
        </div>
      </section>

      {stale && (
        <div className="rounded border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          {lastRun?.ranAt
            ? `cleanup last ran ${formatAgo(sinceMs ?? 0)} ago, older than the 36h staleness threshold. Bot may not be ticking.`
            : "cleanup has never run on this database. Wait for the first nightly tick or check bot logs."}
        </div>
      )}

      {lastRun && lastRun.runIds.length > 0 && (
        <section>
          <div className="mb-2 text-sm text-dim">
            last cleanup flipped these run ids
          </div>
          <ul className="space-y-1 text-xs text-dim">
            {lastRun.runIds.slice(0, 20).map((id) => (
              <li key={id} className="truncate">
                {id}
              </li>
            ))}
            {lastRun.runIds.length > 20 && (
              <li className="text-dim/70">
                + {lastRun.runIds.length - 20} more
              </li>
            )}
          </ul>
        </section>
      )}

      <HealthSweepSection sweep={healthSweep} now={now} />
    </div>
  );
}

function HealthSweepSection({
  sweep,
  now,
}: {
  sweep: HealthSweepSnapshot | null;
  now: number;
}) {
  if (!sweep) {
    return (
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-dim">
          auto self-checks
        </h2>
        <div className="rounded border border-line bg-panel p-4 text-sm text-dim">
          no health-sweep snapshot yet, bot may be on a pre-sweep build
        </div>
      </section>
    );
  }

  const sinceMs = sweep.ranAt ? now - sweep.ranAt.getTime() : null;
  const sweepStale = sinceMs === null || sinceMs > 30 * 60 * 1000;
  const stuckTotal =
    sweep.stuckNoop.length +
    sweep.stuckPreflight.length +
    sweep.staleApproved.length;

  return (
    <section>
      <h2 className="mb-2 text-sm uppercase tracking-wide text-dim">
        auto self-checks
      </h2>
      <p className="mb-3 text-xs text-dim">
        health-sweep runs every tick. auto-fixes stale-open backlog items;
        flags loops + stuck approvals for operator review. green = nothing
        operator-actionable.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric
          label="stale-open auto-fixed (last sweep)"
          value={sweep.fixedStaleOpen}
          tone={sweep.fixedStaleOpen === 0 ? "good" : "warn"}
          hint={
            sweep.fixedStaleOpen === 0
              ? "no shipped-but-open backlog items found. target: 0."
              : `closed: ${sweep.fixedStaleOpenIds.slice(0, 3).join(", ")}${sweep.fixedStaleOpenIds.length > 3 ? "…" : ""}`
          }
        />
        <Metric
          label="needs operator (loops + stuck)"
          value={stuckTotal}
          tone={stuckTotal === 0 ? "good" : "bad"}
          hint={
            stuckTotal === 0
              ? "no recurring noop / preflight / stale-approved tasks. target: 0."
              : `${sweep.stuckNoop.length} noop loops, ${sweep.stuckPreflight.length} preflight loops, ${sweep.staleApproved.length} stale-approved`
          }
        />
        <Metric
          label="last sweep"
          value={sweep.ranAt ? formatAgo(sinceMs ?? 0) : "-"}
          tone={sweepStale ? "warn" : "good"}
          hint={
            sweep.ranAt ? (
              <>
                at{" "}
                <LocalTime
                  iso={sweep.ranAt.toISOString()}
                  format="compact"
                />
              </>
            ) : (
              "no sweep yet on this database"
            )
          }
        />
      </div>

      {sweepStale && (
        <div className="mt-3 rounded border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          {sweep.ranAt
            ? `sweep last ran ${formatAgo(sinceMs ?? 0)} ago. Expected every tick (~6 min).`
            : "sweep has never run, bot may be on a pre-sweep build"}
        </div>
      )}

      {sweep.stuckNoop.length > 0 && (
        <StuckList
          heading="noop loops (task description likely needs rewrite)"
          groups={sweep.stuckNoop}
        />
      )}
      {sweep.stuckPreflight.length > 0 && (
        <StuckList
          heading="preflight-fail loops (test or task-spec regression)"
          groups={sweep.stuckPreflight}
        />
      )}
      {sweep.staleApproved.length > 0 && (
        <StuckList
          heading="approved but never shipped (push retry failed)"
          groups={sweep.staleApproved}
        />
      )}
    </section>
  );
}

function StuckList({
  heading,
  groups,
}: {
  heading: string;
  groups: HealthSweepStuckGroup[];
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 text-sm text-dim">{heading}</div>
      <ul className="space-y-1 text-xs text-dim">
        {groups.slice(0, 10).map((g) => (
          <li
            key={`${g.project}::${g.taskId}`}
            className="flex flex-wrap items-center gap-x-1.5"
          >
            <span className="truncate text-ink">{g.taskId}</span>
            <ProjectChip project={g.project} />
            <span className="text-warn">×{g.count}</span>
            {g.lastBlocker && (
              <span className="truncate text-dim/70">
                , {g.lastBlocker.slice(0, 60)}
              </span>
            )}
          </li>
        ))}
        {groups.length > 10 && (
          <li className="text-dim/70">+ {groups.length - 10} more</li>
        )}
      </ul>
    </div>
  );
}

function DriftSection({
  drift,
  now,
}: {
  drift: DriftSnapshot | null;
  now: number;
}) {
  // No state row yet: bot hasn't ticked into the drift code, or it's
  // running in dev mode (resolveDriftPaths returned null). Don't pretend
  // we know.
  if (!drift) {
    return (
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-dim">drift</h2>
        <div className="rounded border border-line bg-panel p-4 text-sm text-dim">
          no drift snapshot yet, bot may be booting or running in dev mode
        </div>
      </section>
    );
  }

  const branchOk = !drift.drift && drift.branch === "main";
  const buildOk = !drift.drift;
  const observedSinceMs = drift.observedAt
    ? now - new Date(drift.observedAt).getTime()
    : null;
  const builtAgoMs = drift.builtAt
    ? now - new Date(drift.builtAt).getTime()
    : null;

  return (
    <section>
      <h2 className="mb-2 text-sm uppercase tracking-wide text-dim">drift</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric
          label="branch + drift"
          value={drift.branch ?? "?"}
          tone={branchOk ? "good" : "bad"}
          hint={
            drift.drift
              ? `drift: ${drift.reason ?? "unknown"} (head=${shortSha(drift.headSha)}, built=${shortSha(drift.builtFromSha)})`
              : `✓ synced (head=${shortSha(drift.headSha)})`
          }
        />
        <Metric
          label="build freshness"
          value={shortSha(drift.builtFromSha) ?? "-"}
          tone={buildOk ? "good" : "bad"}
          hint={
            buildOk
              ? "dist matches current HEAD"
              : `stale, restart to rebuild${drift.headSha ? ` to ${shortSha(drift.headSha)}` : ""}`
          }
        />
        <Metric
          label="last successful build"
          value={drift.builtAt ? formatAgo(builtAgoMs ?? 0) : "-"}
          tone={drift.builtAt ? "good" : "warn"}
          hint={
            drift.builtAt
              ? `at ${drift.builtAt} (${shortSha(drift.builtFromSha)})`
              : "no build stamp yet, wrapper has not run"
          }
        />
      </div>
      {drift.drift && (
        <div className="mt-3 rounded border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad">
          ⚠ stale: restart the bot to recover. Wrapper will re-pull + re-build + re-stamp on next launch.
        </div>
      )}
      {observedSinceMs !== null && observedSinceMs > 10 * 60 * 1000 && (
        <div className="mt-3 rounded border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
          drift snapshot is {formatAgo(observedSinceMs)} old, bot may not be ticking
        </div>
      )}
    </section>
  );
}

function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.slice(0, 7);
}

function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number | string;
  tone: "good" | "warn" | "bad";
  hint: React.ReactNode;
}) {
  const color =
    tone === "good" ? "text-good" : tone === "warn" ? "text-warn" : "text-bad";
  // Strings get a smaller font so a 7-char sha or a branch name doesn't
  // overflow the card; numbers keep the chunky 3xl readout.
  const size = typeof value === "number" ? "text-3xl" : "text-xl";
  return (
    <div className="rounded border border-line bg-panel p-4">
      <div className="text-xs text-dim">{label}</div>
      <div className={`${size} font-bold ${color} break-words`}>{value}</div>
      <div className="mt-1 text-xs text-dim">{hint}</div>
    </div>
  );
}

function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
