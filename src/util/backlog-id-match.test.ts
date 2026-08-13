// Pure unit tests for the kebab-case-safe whole-token matcher shared
// between the send-side ship-gate (runner.ensureBacklogIdFooter) and the
// receive-side auto-close (journal.findReferencedBacklogIds). Existing
// integration tests at both call sites still pass; these focus on the
// predicate's edge cases independent of either consumer.

import { describe, it, expect } from "vitest";
import { isBacklogIdReferenced } from "./backlog-id-match.js";

describe("isBacklogIdReferenced (shared whole-token matcher)", () => {
  it("returns false for empty message", () => {
    expect(isBacklogIdReferenced("", "svc-1")).toBe(false);
  });

  it("returns false for empty id", () => {
    expect(isBacklogIdReferenced("some body text", "")).toBe(false);
  });

  it("matches a bare token", () => {
    expect(isBacklogIdReferenced("Closes svc-1 today", "svc-1")).toBe(
      true,
    );
  });

  it("matches at start of string", () => {
    expect(isBacklogIdReferenced("svc-1 mentioned first", "svc-1")).toBe(
      true,
    );
  });

  it("matches at end of string", () => {
    expect(isBacklogIdReferenced("Closes svc-1", "svc-1")).toBe(true);
  });

  it("REJECTS substring inside a longer kebab id (svc-1 vs svc-10)", () => {
    // The load-bearing case. ADR-042 incident: svc-1 was silently
    // matched inside svc-10. Both call sites depend on this.
    expect(isBacklogIdReferenced("ship svc-10 work", "svc-1")).toBe(
      false,
    );
  });

  it("REJECTS id wrapped in alphanumerics", () => {
    expect(isBacklogIdReferenced("xsvc-1y", "svc-1")).toBe(false);
  });

  it("REJECTS id followed by a hyphen-suffix", () => {
    // JS \b would falsely match here because - is non-word; the
    // lookahead [\w-] is what blocks this case.
    expect(isBacklogIdReferenced("see svc-1-extra notes", "svc-1")).toBe(
      false,
    );
  });

  it("REJECTS id preceded by a hyphen-prefix", () => {
    expect(isBacklogIdReferenced("see foo-svc-1 notes", "svc-1")).toBe(
      false,
    );
  });

  it("matches when surrounded by punctuation", () => {
    for (const msg of [
      "(svc-1)",
      "[svc-1]",
      `"svc-1"`,
      "`svc-1`",
      "svc-1.",
      "svc-1,",
      "svc-1:",
      "svc-1;",
    ]) {
      expect(isBacklogIdReferenced(msg, "svc-1")).toBe(true);
    }
  });

  it("matches across newlines", () => {
    expect(isBacklogIdReferenced("line one\nsvc-1\nline three", "svc-1"))
      .toBe(true);
  });

  it("escapes regex special chars in the id (defensive)", () => {
    // Current id format is kebab-no-specials but the helper must not
    // interpret a future id format change as regex metacharacters.
    expect(isBacklogIdReferenced("ref weird.id.with.dots", "weird.id.with.dots"))
      .toBe(true);
    // Period should be literal, not "any char": "weirdXid" must NOT match.
    expect(isBacklogIdReferenced("weirdXidXwithXdots", "weird.id.with.dots"))
      .toBe(false);
  });

  it("matches multi-segment kebab ids whole", () => {
    expect(
      isBacklogIdReferenced(
        "feat: ship svc-2-add-dep parser bits.",
        "svc-2-add-dep",
      ),
    ).toBe(true);
  });

  it("REJECTS partial prefix of a multi-segment kebab id", () => {
    expect(
      isBacklogIdReferenced("ship the svc-2-add-dep-extra step", "svc-2-add-dep"),
    ).toBe(false);
  });
});
