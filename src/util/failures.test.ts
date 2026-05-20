import { describe, it, expect } from "vitest";
import {
  parseTscOutput,
  parseVitestOutput,
  summarizeFailures,
} from "./failures.js";

describe("parseTscOutput", () => {
  it("parses single TS error line", () => {
    const out = parseTscOutput(
      "src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.",
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("typecheck");
    expect(out[0]?.file).toBe("src/foo.ts");
    expect(out[0]?.label).toContain("TS2304");
  });

  it("parses multiple errors and dedupes by label", () => {
    const out = parseTscOutput(
      [
        "src/a.ts(1,1): error TS2304: Cannot find name 'x'.",
        "src/b.ts(2,1): error TS2304: Cannot find name 'y'.",
        "src/a.ts(1,1): error TS2304: Cannot find name 'x'.", // dup
      ].join("\n"),
    );
    expect(out).toHaveLength(2);
  });

  it("ignores non-error lines (build banner, warnings)", () => {
    const out = parseTscOutput(
      [
        "> tsc --noEmit",
        "warning: experimental flag",
        "src/foo.ts(12,5): error TS2304: Cannot find name 'bar'.",
      ].join("\n"),
    );
    expect(out).toHaveLength(1);
  });

  it("returns empty for clean output", () => {
    expect(parseTscOutput("")).toEqual([]);
    expect(parseTscOutput("clean build\n")).toEqual([]);
  });
});

describe("parseVitestOutput", () => {
  it("extracts FAIL lines from vitest output", () => {
    const out = parseVitestOutput(
      [
        " RUN  v2.1.9",
        " × src/foo.test.ts > sums two numbers 12ms",
        "   AssertionError: expected 3 to equal 4",
        " Test Files  1 failed (1)",
      ].join("\n"),
    );
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]?.kind).toBe("test");
    expect(out[0]?.context).toMatch(/AssertionError/);
  });

  it("captures path from test name", () => {
    const out = parseVitestOutput(" × src/foo.test.ts > does the thing");
    expect(out[0]?.file).toBe("src/foo.test.ts");
  });

  it("returns empty when only passing tests appear", () => {
    const out = parseVitestOutput(
      [" ✓ src/foo.test.ts (3)", " Test Files  1 passed (1)"].join("\n"),
    );
    expect(out).toEqual([]);
  });

  it("dedupes identical failure labels", () => {
    const repeated = [
      " × src/a.test.ts > fails",
      " × src/a.test.ts > fails",
    ].join("\n");
    expect(parseVitestOutput(repeated)).toHaveLength(1);
  });
});

describe("summarizeFailures", () => {
  it("returns empty string for no failures", () => {
    expect(summarizeFailures([])).toBe("");
  });

  it("includes failure count + label + truncated context", () => {
    const s = summarizeFailures([
      {
        kind: "test",
        label: "src/foo.test.ts > does X",
        context: "line1\nline2\nline3",
      },
    ]);
    expect(s).toMatch(/1 failure/);
    expect(s).toContain("does X");
    expect(s).toContain("line1");
  });

  it("truncates above maxBytes and reports remainder", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      kind: "test" as const,
      label: `failure ${i}`,
      context: "x".repeat(200),
    }));
    const s = summarizeFailures(many, 500);
    expect(s).toMatch(/truncated/);
  });
});
