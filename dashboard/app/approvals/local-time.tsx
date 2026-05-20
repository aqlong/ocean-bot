"use client";

import { useEffect, useState } from "react";

/**
 * Render a server-serialized ISO timestamp in BROWSER-LOCAL time + tz.
 *
 * Server components don't know the user's locale or timezone, so they
 * serialize timestamps as ISO-8601 strings and let this client
 * component format on the device. The first render (SSR) emits the
 * raw ISO so the HTML is deterministic; on hydration we replace with
 * the locale-aware string. The two-pass pattern avoids the React
 * hydration-mismatch warning that fires when SSR text ≠ client text.
 *
 * Formats:
 *   - "full" (default, original): "Sat May 10 · 11:42:30 AM PDT".
 *     Weekday + date + seconds + tz, for headers + dense detail rows.
 *   - "compact": "May 10, 11:42 AM PDT". Month + day + minute + tz,
 *     for row chips where horizontal space is scarce.
 *   - "relative": "2d ago" / "47s ago". Time since the timestamp; no
 *     absolute value. Useful when paired with a separate absolute
 *     display.
 *   - "compact-with-relative": "May 10, 11:42 AM PDT (2d ago)". Both
 *     pieces inline, separated by parens. Operator gets the absolute
 *     for unambiguity + the relative for at-a-glance staleness.
 *   - "time": "11:42:30 AM". Time-only with seconds, no date or tz.
 *     For compact live-indicators like AutoRefreshIndicator where the
 *     wall-clock context is obvious and tz clutter would dominate.
 *
 * `tooltip` (optional): override the title-attr text. Default is the
 * raw ISO so an operator can hover-then-copy. Set to null to omit the
 * tooltip entirely.
 */
export type LocalTimeFormat =
  | "full"
  | "compact"
  | "time"
  | "relative"
  | "compact-with-relative";

const FULL_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
};

const COMPACT_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
};

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
};

export function LocalTime({
  iso,
  format = "full",
  tooltip,
}: {
  iso: string;
  format?: LocalTimeFormat;
  tooltip?: string | null;
}) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!hydrated) {
    // Pre-hydration: emit the raw ISO so SSR + CSR match exactly.
    // No flicker, same characters until hydration completes.
    return <time dateTime={iso}>{iso}</time>;
  }

  const date = new Date(iso);
  let display = "";
  if (format === "full") {
    display = new Intl.DateTimeFormat(undefined, FULL_FORMAT).format(date);
  } else if (format === "compact") {
    display = new Intl.DateTimeFormat(undefined, COMPACT_FORMAT).format(date);
  } else if (format === "relative") {
    display = timeAgo(date);
  } else if (format === "time") {
    display = new Intl.DateTimeFormat(undefined, TIME_FORMAT).format(date);
  } else if (format === "compact-with-relative") {
    const abs = new Intl.DateTimeFormat(undefined, COMPACT_FORMAT).format(date);
    display = `${abs} (${timeAgo(date)})`;
  }
  return (
    <time dateTime={iso} title={resolveTitleAttr(tooltip, iso)}>
      {display}
    </time>
  );
}

/**
 * Resolve the `title` attribute for the rendered <time>. Exported so the
 * three-state contract is testable directly: a future refactor swapping
 * `=== null` for `=== undefined` (or `??` for `||`) would still typecheck
 * but silently break the "indicator with no hover tooltip" use case
 * AutoRefreshIndicator relies on.
 *
 *   - `null`         → no tooltip (caller explicitly opted out).
 *   - omitted (undef)→ raw ISO so the operator can hover-copy.
 *   - string         → use it verbatim (empty string passes through, so
 *                       an explicit `tooltip=""` does NOT fall back to ISO).
 */
export function resolveTitleAttr(
  tooltip: string | null | undefined,
  iso: string,
): string | undefined {
  if (tooltip === null) return undefined;
  return tooltip ?? iso;
}

/** Pure helper for the relative-time pieces. Exported so server-side
 *  surfaces that can't render the full <LocalTime> client component
 *  can still show "2d ago"-style text deterministically on the server.
 *  Server-rendered relative time WILL differ from browser by a few
 *  seconds; that's fine for a glance-time signal. */
export function timeAgo(d: Date | string): string {
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 0) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
