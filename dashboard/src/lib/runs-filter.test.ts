import { describe, expect, it } from "vitest";
import { buildRunsFilter, parsePage, parseSince } from "./runs-filter";

// Frozen reference instant for deterministic since-window math.
// 2026-05-18T16:00:00.000Z chosen to match local-time.test.ts so the
// two suites can be cross-referenced when reading.
const FIXED_NOW = new Date("2026-05-18T16:00:00.000Z").getTime();

describe("parseSince", () => {
  it("returns undefined for empty / undefined / unrecognized values", () => {
    expect(parseSince(undefined, FIXED_NOW)).toBeUndefined();
    expect(parseSince("", FIXED_NOW)).toBeUndefined();
    expect(parseSince("garbage", FIXED_NOW)).toBeUndefined();
    expect(parseSince("2d", FIXED_NOW)).toBeUndefined(); // 2d isn't in the closed dropdown
  });

  it("translates '1d' to a Date exactly 24 hours before now", () => {
    const d = parseSince("1d", FIXED_NOW);
    expect(d?.getTime()).toBe(FIXED_NOW - 24 * 60 * 60 * 1000);
  });

  it("translates '7d' to a Date exactly 7 days before now", () => {
    const d = parseSince("7d", FIXED_NOW);
    expect(d?.getTime()).toBe(FIXED_NOW - 7 * 24 * 60 * 60 * 1000);
  });

  it("translates '30d' to a Date exactly 30 days before now", () => {
    const d = parseSince("30d", FIXED_NOW);
    expect(d?.getTime()).toBe(FIXED_NOW - 30 * 24 * 60 * 60 * 1000);
  });

  it("uses Date.now() when no explicit `now` is supplied (smoke check)", () => {
    // Don't pin to the exact ms; just confirm the result is within a
    // generous window of "right around now minus 1d". Defends against
    // an accidental refactor that drops the default-param.
    const before = Date.now();
    const d = parseSince("1d");
    const after = Date.now();
    expect(d?.getTime()).toBeGreaterThanOrEqual(before - 24 * 3600_000);
    expect(d?.getTime()).toBeLessThanOrEqual(after - 24 * 3600_000);
  });
});

describe("parsePage", () => {
  it("returns 1 for undefined / empty / non-numeric / NaN inputs", () => {
    expect(parsePage(undefined)).toBe(1);
    expect(parsePage("")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage("NaN")).toBe(1);
  });

  it("returns 1 for '0' and negative integers (1-indexed contract)", () => {
    expect(parsePage("0")).toBe(1);
    expect(parsePage("-1")).toBe(1);
    expect(parsePage("-100")).toBe(1);
  });

  it("returns the parsed integer for positive numeric strings", () => {
    expect(parsePage("1")).toBe(1);
    expect(parsePage("2")).toBe(2);
    expect(parsePage("17")).toBe(17);
  });

  it("floors decimal page values via parseInt", () => {
    // parseInt("3.7", 10) === 3; we deliberately don't round.
    expect(parsePage("3.7")).toBe(3);
    expect(parsePage("1.999")).toBe(1);
  });
});

describe("buildRunsFilter", () => {
  it("returns an all-undefined filter and page=1 for empty search params", () => {
    const out = buildRunsFilter({}, FIXED_NOW);
    expect(out.filter.project).toBeUndefined();
    expect(out.filter.queue).toBeUndefined();
    expect(out.filter.status).toBeUndefined();
    expect(out.filter.since).toBeUndefined();
    expect(out.page).toBe(1);
  });

  it("coerces empty-string params to undefined (so ?project= doesn't filter on '')", () => {
    const out = buildRunsFilter(
      { project: "", queue: "", status: "" },
      FIXED_NOW,
    );
    expect(out.filter.project).toBeUndefined();
    expect(out.filter.queue).toBeUndefined();
    expect(out.filter.status).toBeUndefined();
  });

  it("passes through non-empty project / queue / status verbatim", () => {
    const out = buildRunsFilter(
      { project: "code2wiki", queue: "roadmap", status: "shipped" },
      FIXED_NOW,
    );
    expect(out.filter.project).toBe("code2wiki");
    expect(out.filter.queue).toBe("roadmap");
    expect(out.filter.status).toBe("shipped");
  });

  it("wires since through parseSince with the injected `now`", () => {
    const out = buildRunsFilter({ since: "7d" }, FIXED_NOW);
    expect(out.filter.since?.getTime()).toBe(
      FIXED_NOW - 7 * 24 * 60 * 60 * 1000,
    );
  });

  it("wires page through parsePage (clamps '0' to 1)", () => {
    expect(buildRunsFilter({ page: "0" }, FIXED_NOW).page).toBe(1);
    expect(buildRunsFilter({ page: "3" }, FIXED_NOW).page).toBe(3);
    expect(buildRunsFilter({ page: "-2" }, FIXED_NOW).page).toBe(1);
  });

  it("ignores unknown search-param keys", () => {
    // A crafted URL with foo=bar should not leak into the filter shape.
    const out = buildRunsFilter(
      { foo: "bar", baz: "qux", project: "ocean-bot" },
      FIXED_NOW,
    );
    expect(out.filter.project).toBe("ocean-bot");
    expect(Object.keys(out.filter).sort()).toEqual([
      "project",
      "queue",
      "since",
      "status",
    ]);
  });
});
