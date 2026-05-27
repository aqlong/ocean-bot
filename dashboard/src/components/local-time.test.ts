import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTitleAttr, timeAgo } from "./local-time";

// LocalTime itself is a thin wrapper over Intl.DateTimeFormat whose
// output is locale-dependent (different on CI vs operator's Mac vs
// Railway server), so we don't assert on the formatted strings.
// The pure helper `timeAgo` is exercised directly here; the component's
// post-hydration render path is covered structurally by tsc.

const FIXED_NOW = new Date("2026-05-18T16:00:00.000Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeAgo", () => {
  it('returns "just now" for future timestamps (clock skew defense)', () => {
    const future = new Date(FIXED_NOW + 5000);
    expect(timeAgo(future)).toBe("just now");
  });

  it("returns seconds for sub-minute deltas", () => {
    expect(timeAgo(new Date(FIXED_NOW - 30_000))).toBe("30s ago");
    expect(timeAgo(new Date(FIXED_NOW - 1000))).toBe("1s ago");
  });

  it("returns minutes for sub-hour deltas", () => {
    expect(timeAgo(new Date(FIXED_NOW - 5 * 60_000))).toBe("5m ago");
    expect(timeAgo(new Date(FIXED_NOW - 59 * 60_000))).toBe("59m ago");
  });

  it("returns hours for sub-day deltas", () => {
    expect(timeAgo(new Date(FIXED_NOW - 3 * 3600_000))).toBe("3h ago");
    expect(timeAgo(new Date(FIXED_NOW - 23 * 3600_000))).toBe("23h ago");
  });

  it("returns days for multi-day deltas", () => {
    expect(timeAgo(new Date(FIXED_NOW - 2 * 86400_000))).toBe("2d ago");
    expect(timeAgo(new Date(FIXED_NOW - 47 * 86400_000))).toBe("47d ago");
  });

  it("accepts an ISO string in addition to a Date", () => {
    const iso = new Date(FIXED_NOW - 5 * 60_000).toISOString();
    expect(timeAgo(iso)).toBe("5m ago");
  });

  it("rounds DOWN (floor) at unit boundaries (defends against accidental round-half-up)", () => {
    // 119 seconds floors to 1m, not 2m. The user-visible contract for
    // "X ago" labels is "at least X has elapsed."
    expect(timeAgo(new Date(FIXED_NOW - 119 * 1000))).toBe("1m ago");
    // 3599 seconds (one second short of an hour) still falls in the
    // minutes bucket; 3600 flips to hours.
    expect(timeAgo(new Date(FIXED_NOW - 3599 * 1000))).toBe("59m ago");
    expect(timeAgo(new Date(FIXED_NOW - 3600 * 1000))).toBe("1h ago");
  });
});

describe("resolveTitleAttr", () => {
  const ISO = "2026-05-18T16:00:00.000Z";

  it("returns undefined when tooltip is explicitly null (AutoRefreshIndicator opt-out)", () => {
    // AutoRefreshIndicator passes tooltip={null} because the indicator is
    // a live "data is fresh" signal, not a copyable timestamp. A future
    // `tooltip === undefined` typo would silently start leaking the ISO.
    expect(resolveTitleAttr(null, ISO)).toBeUndefined();
  });

  it("returns the ISO when tooltip is omitted (default hover-to-copy contract)", () => {
    expect(resolveTitleAttr(undefined, ISO)).toBe(ISO);
  });

  it("returns the caller-supplied string when tooltip is a non-empty string", () => {
    expect(resolveTitleAttr("hover help", ISO)).toBe("hover help");
  });

  it("returns empty string verbatim when tooltip is the empty string (no ISO fallback)", () => {
    // Uses ?? not ||, so falsy-but-defined values pass through. Pin
    // against an accidental swap to || which would silently route ""
    // back to the ISO fallback.
    expect(resolveTitleAttr("", ISO)).toBe("");
  });
});
