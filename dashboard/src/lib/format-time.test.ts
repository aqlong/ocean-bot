import { describe, expect, it } from "vitest";
import { formatDuration, durationTone } from "./format-time";

describe("formatDuration", () => {
  it("formats milliseconds for sub-second durations", () => {
    expect(formatDuration(100)).toBe("100ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("formats seconds for durations under 1 minute", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(30_000)).toBe("30s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("formats m:ss for durations under 1 hour", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_599_000)).toBe("59m 59s");
  });

  it("formats h:mm:ss for durations 1 hour or longer", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(5_425_000)).toBe("1h 30m 25s");
    expect(formatDuration(86_399_000)).toBe("23h 59m 59s");
  });
});

describe("durationTone", () => {
  it('returns "text-good" for durations ≤5s', () => {
    expect(durationTone(0)).toBe("text-good");
    expect(durationTone(5000)).toBe("text-good");
  });

  it('returns "text-ink" for durations 5s < x ≤30s', () => {
    expect(durationTone(6000)).toBe("text-ink");
    expect(durationTone(30_000)).toBe("text-ink");
  });

  it('returns "text-warn" for durations 30s < x ≤2m', () => {
    expect(durationTone(31_000)).toBe("text-warn");
    expect(durationTone(120_000)).toBe("text-warn");
  });

  it('returns "text-bad" for durations >2m', () => {
    expect(durationTone(121_000)).toBe("text-bad");
    expect(durationTone(3_600_000)).toBe("text-bad");
  });
});
