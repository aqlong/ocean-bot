"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LocalTime } from "../../src/components/local-time";

/**
 * Client-side auto-refresh + last-refreshed clock.
 *
 * Triggers `router.refresh()` every `intervalMs` (default 10s) which
 * re-runs the page's server component fetch WITHOUT a full reload,
 * scroll position + form state survive. The displayed "last refreshed
 * at" timestamp updates every time the server cycle completes (i.e.
 * every interval tick, since router.refresh() returns once the
 * server response lands).
 *
 * The 10s cadence is twice the server-side `revalidate = 5` so we
 * effectively force a re-fetch on every other interval boundary,
 * good enough for an approval queue that doesn't churn faster than
 * one decision every few seconds.
 *
 * The "stop"/"resume" toggle is useful when the operator is actively
 * working on a decision and doesn't want the form re-rendering under
 * their hands.
 */
export function RefreshClock({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [lastRefreshAt, setLastRefreshAt] = useState<Date>(new Date());
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      router.refresh();
      setLastRefreshAt(new Date());
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs, paused]);

  return (
    <div className="flex items-center gap-2 text-xs text-dim">
      <span>
        last refreshed:{" "}
        <LocalTime iso={lastRefreshAt.toISOString()} />
      </span>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        className="rounded border border-line bg-bg px-2 py-0.5 hover:text-ink"
        aria-label={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
        title={paused ? "Resume auto-refresh" : "Pause auto-refresh"}
      >
        {paused ? "▶ resume" : "⏸ pause"}
      </button>
    </div>
  );
}
