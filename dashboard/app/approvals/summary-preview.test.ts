import { describe, it, expect } from "vitest";
import { summaryPreview } from "./summary-preview";

describe("summaryPreview", () => {
  it("strips the CLAUDE.md preamble and returns the first body line", () => {
    const input = [
      "CLAUDE.md sections most relevant for this task: Where things live.",
      "",
      "Backlog (chore): Operator: register Craft and Ship LLC as Atlassian Marketplace partner",
    ].join("\n");
    expect(summaryPreview(input)).toBe(
      "Backlog (chore): Operator: register Craft and Ship LLC as Atlassian Marketplace partner",
    );
  });

  it("handles multi-line preamble + multi-line body", () => {
    const input = [
      "CLAUDE.md sections most relevant for this task:",
      "Default code-change workflow, Active design work.",
      "",
      "Backlog (feature): Parser: skip methods whose ONLY executable line returns a literal",
      "second body line that should NOT appear in the preview",
    ].join("\n");
    const preview = summaryPreview(input);
    expect(preview).toContain("Parser: skip methods");
    expect(preview).not.toContain("CLAUDE.md");
    expect(preview).not.toContain("second body line");
  });

  it("falls back gracefully when no \\n\\n divider is present", () => {
    const input = "Simple single-line task description";
    expect(summaryPreview(input)).toBe("Simple single-line task description");
  });

  it("does NOT strip when the preamble doesn't start with CLAUDE.md (defensive)", () => {
    // If the prompt happens to have \n\n but the head isn't a CLAUDE.md
    // hint, we should NOT lose the head. Trade-off: in this case, we
    // keep the first line of whatever's at the top.
    const input = [
      "Operator note: this task is sensitive",
      "",
      "Body: implement the thing",
    ].join("\n");
    expect(summaryPreview(input)).toBe("Operator note: this task is sensitive");
  });

  it("truncates long previews with an ellipsis at a word boundary", () => {
    const longLine =
      "Backlog (feature): " +
      "implement the very important and quite lengthy feature that "
        .repeat(20)
        .trim();
    const preview = summaryPreview(longLine, 100);
    expect(preview.length).toBeLessThanOrEqual(101); // 100 + ellipsis
    expect(preview.endsWith("…")).toBe(true);
    // Word boundary: the char before "…" should be a letter, not a space.
    const beforeEllipsis = preview.slice(-2, -1);
    expect(beforeEllipsis).toMatch(/[a-zA-Z]/);
  });

  it("hard-cuts when no late-slice word boundary exists", () => {
    // A pathological case: one giant token. Should still produce an
    // ellipsis-terminated string within maxChars+1.
    const input = "x".repeat(500);
    const preview = summaryPreview(input, 50);
    expect(preview.length).toBeLessThanOrEqual(51);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("handles empty / null / whitespace-only inputs", () => {
    expect(summaryPreview("")).toBe("(no task summary)");
    expect(summaryPreview(null)).toBe("(no task summary)");
    expect(summaryPreview(undefined)).toBe("(no task summary)");
    expect(summaryPreview("   ")).toBe("(no task summary)");
    expect(summaryPreview("\n\n\n")).toBe("(no task summary)");
  });

  it("trims surrounding whitespace from the picked line", () => {
    const input = [
      "CLAUDE.md sections most relevant for this task: x.",
      "",
      "   Backlog (chore): leading spaces   ",
    ].join("\n");
    expect(summaryPreview(input)).toBe("Backlog (chore): leading spaces");
  });

  it("preserves an inline-only task with no preamble", () => {
    // Creative-improvement audit format: one long line, no preamble.
    const input =
      "Creative-improvement audit: read CLAUDE.md, scan recent commits, propose ONE small high-leverage improvement and ship it";
    expect(summaryPreview(input, 500)).toBe(input);
  });
});
