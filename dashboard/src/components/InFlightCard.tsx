"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ProjectChip } from "@/components/ProjectChip";

// Hero card that replaces "is the bot busy?" inference with a glance.
// Three visual states driven entirely by /api/bot/in-flight:
//   running:  green pulse, elapsed + expected, optional cancel
//   awaiting: amber border, count + link
//   idle:     gray, "next tick in Xs" + "Tick now" button
//
// Mobile is the primary surface: layout stays under one viewport height
// at 320px wide. Tailwind's `sm:` breakpoint splits two-column-on-desktop
// from stacked-on-phone.

type RunningRun = {
  runId: string;
  project: string | null;
  queue: string | null;
  taskSummary: string | null;
  model: string | null;
  startedAt: string;
  elapsedMs: number;
  expectedTotalMs: number;
  childPid: number | null;
};

type InFlight =
  | { state: "running"; run: RunningRun }
  | { state: "awaiting"; awaitingCount: number }
  | {
      state: "idle";
      lastTickEndedAt: string | null;
      nextTickAt: string | null;
      intervalSec: number | null;
    };

const POLL_MS = 3000;

export function InFlightCard({
  cancelEnabled = false,
}: {
  cancelEnabled?: boolean;
}) {
  const [data, setData] = useState<InFlight | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await fetch("/api/bot/in-flight", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as InFlight;
        if (!cancelled) setData(j);
      } catch {
        // ignore, next poll retries
      }
    }
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Re-render every second so elapsed counters tick smoothly without
  // hitting the API.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  async function postAction(path: string, confirm?: string): Promise<void> {
    if (confirm && !window.confirm(confirm)) return;
    setMsg(null);
    startTransition(async () => {
      try {
        const r = await fetch(path, { method: "POST" });
        const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
        if (j.ok) setMsg("ok");
        else setMsg(j.error ?? `error: HTTP ${r.status}`);
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e));
      }
    });
  }

  if (!data) {
    return (
      <div className="rounded border border-line bg-panel px-4 py-3 text-sm text-dim">
        loading bot status …
      </div>
    );
  }

  if (data.state === "running") {
    // Wall-clock elapsed: trust startedAt over serverElapsed so the
    // counter ticks smoothly between polls without drift accumulation.
    const startedMs = Date.parse(data.run.startedAt);
    const elapsedMs = Number.isFinite(startedMs)
      ? Math.max(0, now - startedMs)
      : data.run.elapsedMs;
    const pct = Math.min(100, Math.round((elapsedMs / data.run.expectedTotalMs) * 100));
    const overdue = elapsedMs > data.run.expectedTotalMs;
    return (
      <div className="overflow-hidden rounded border border-good/40 bg-good/5">
        <div className="flex items-center gap-2 border-b border-good/20 px-4 py-2 text-xs uppercase tracking-wider text-good">
          <PulseDot />
          <span>running</span>
          {data.run.model && <span className="text-dim">· {data.run.model}</span>}
        </div>
        <div className="space-y-2 px-4 py-3">
          <div className="break-words text-sm text-ink">
            {data.run.taskSummary ?? "(task summary not stamped)"}
          </div>
          <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-dim">
            {data.run.project ? (
              <ProjectChip project={data.run.project} />
            ) : (
              <span>?</span>
            )}
            <span>· {data.run.queue ?? "?"} · started {formatDuration(elapsedMs)} ago</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded bg-line">
            <div
              className={`h-full ${overdue ? "bg-warn" : "bg-good"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-dim">
            <span>
              {formatDuration(elapsedMs)} elapsed · expect{" "}
              ~{formatDuration(data.run.expectedTotalMs)}
              {overdue && <span className="ml-1 text-warn">(over budget)</span>}
            </span>
            <Link href={`/runs/${data.run.runId}`} className="hover:text-ink">
              view run →
            </Link>
          </div>
          {cancelEnabled && data.run.childPid !== null && (
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  postAction(
                    "/api/bot/cancel",
                    "Cancel this run? The spawn's tokens will be wasted.",
                  )
                }
                className="rounded border border-bad/40 px-3 py-1 text-xs text-bad hover:bg-bad/10 disabled:opacity-50"
              >
                cancel run
              </button>
              {msg && <span className="text-xs text-dim">{msg}</span>}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (data.state === "awaiting") {
    return (
      <div className="overflow-hidden rounded border border-warn/40 bg-warn/5">
        <div className="flex items-center gap-2 border-b border-warn/20 px-4 py-2 text-xs uppercase tracking-wider text-warn">
          <span>⏳</span>
          <span>awaiting decision</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="text-sm text-ink">
            {data.awaitingCount} run{data.awaitingCount === 1 ? "" : "s"} waiting
            for your call
          </div>
          <Link
            href="/approvals"
            className="rounded border border-warn/40 px-3 py-1 text-xs text-warn hover:bg-warn/10"
          >
            review →
          </Link>
        </div>
      </div>
    );
  }

  // idle
  const nextTickMs = data.nextTickAt ? Date.parse(data.nextTickAt) - now : null;
  const sinceLastMs = data.lastTickEndedAt
    ? Math.max(0, now - Date.parse(data.lastTickEndedAt))
    : null;
  const nextLabel =
    nextTickMs === null
      ? "next tick: scheduled"
      : nextTickMs <= 0
        ? "next tick: any second now"
        : `next tick in ${formatDuration(nextTickMs)}`;
  return (
    <div className="overflow-hidden rounded border border-line bg-panel">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs uppercase tracking-wider text-dim">
        <span>⚪</span>
        <span>idle</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="text-sm text-ink">
          {nextLabel}
          {sinceLastMs !== null && (
            <span className="ml-2 text-xs text-dim">
              (last tick ended {formatDuration(sinceLastMs)} ago)
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => postAction("/api/bot/tick-now")}
            className="rounded border border-accent/40 px-3 py-1 text-xs text-accent hover:bg-accent/10 disabled:opacity-50"
          >
            tick now
          </button>
          {msg && <span className="text-xs text-dim">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

function PulseDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-good/60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-good" />
    </span>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs === 0 ? `${m}m` : `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

