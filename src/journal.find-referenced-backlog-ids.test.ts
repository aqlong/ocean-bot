// Pure unit tests for findReferencedBacklogIds. No DB needed; the
// helper is a string-in / string-array-out matcher used by the
// receive-side backlog auto-close path. Kept in a separate file from
// journal.test.ts because that file gates the whole describe on
// OCEAN_BOT_TEST_DATABASE_URL (integration tests) and these tests
// must run on every `npm test` invocation.

import { describe, it, expect } from "vitest";
import { findReferencedBacklogIds } from "./journal.js";

describe("findReferencedBacklogIds (kebab-case-id-safe match)", () => {
  it("returns [] for empty message", () => {
    expect(findReferencedBacklogIds("", ["svc-2-add-dep"])).toEqual([]);
  });

  it("returns [] for empty id list", () => {
    expect(findReferencedBacklogIds("some commit body", [])).toEqual([]);
  });

  it("matches an id present in the message body", () => {
    const msg = `feat(parser): ship the thing\n\nCloses svc-2-add-dep.`;
    expect(findReferencedBacklogIds(msg, ["svc-2-add-dep"])).toEqual([
      "svc-2-add-dep",
    ]);
  });

  it("matches multiple ids in one message", () => {
    const msg = `Body references svc-2-add-dep and also svc-3-parser-mvc-webapi here.`;
    const result = findReferencedBacklogIds(msg, [
      "svc-2-add-dep",
      "svc-3-parser-mvc-webapi",
      "svc-9-end-to-end-smoke-fixture",
    ]);
    expect(result.sort()).toEqual(
      ["svc-2-add-dep", "svc-3-parser-mvc-webapi"].sort(),
    );
  });

  it("REJECTS substring match (svc-1 inside svc-10)", () => {
    // This is the load-bearing case. The May 2026 svc-* series had
    // ids svc-1, svc-2, ..., svc-10. A naive substring match
    // would falsely close svc-1 whenever svc-10 appears in a
    // commit body. Explicit lookarounds in the regex prevent this.
    const msg = `Closes svc-10 only.`;
    expect(findReferencedBacklogIds(msg, ["svc-1", "svc-10"])).toEqual([
      "svc-10",
    ]);
  });

  it("treats hyphen as part of the id (not a word boundary)", () => {
    // JS \b treats `-` as non-word, so \b fires AT the hyphen --
    // which would falsely match `svc-1` inside `svc-10`. Our
    // implementation uses explicit lookarounds with [\w-] to keep
    // hyphenated tokens whole.
    const msg = `mention of svc-1-stuff`;
    expect(findReferencedBacklogIds(msg, ["svc-1"])).toEqual([]);
  });

  it("matches at the start of the message (no left context)", () => {
    const msg = `svc-2-add-dep is the focus here.`;
    expect(findReferencedBacklogIds(msg, ["svc-2-add-dep"])).toEqual([
      "svc-2-add-dep",
    ]);
  });

  it("matches at the end of the message (no right context)", () => {
    const msg = `Closes svc-2-add-dep`;
    expect(findReferencedBacklogIds(msg, ["svc-2-add-dep"])).toEqual([
      "svc-2-add-dep",
    ]);
  });

  it("deduplicates when the same id appears multiple times", () => {
    const msg = `svc-2-add-dep on line one\nsvc-2-add-dep on line two`;
    expect(findReferencedBacklogIds(msg, ["svc-2-add-dep"])).toEqual([
      "svc-2-add-dep",
    ]);
  });

  it("survives ids with regex special chars (defensive escaping)", () => {
    // Current id format is kebab-case-no-specials, but the helper
    // escapes [.*+?^${}()|[]\\] so a future id format change can't
    // accidentally break matching by interpreting parens as regex
    // groups, etc.
    const ids = ["weird.id.with.dots", "id+with+plus"];
    const msg = `references weird.id.with.dots and id+with+plus here.`;
    expect(findReferencedBacklogIds(msg, ids).sort()).toEqual(ids.sort());
  });

  it("REJECTS partial-prefix match (mentioning the bare prefix alone)", () => {
    // Operator might write `svc bug fix` in a commit body without
    // intending to close `svc-2-add-dep`. The match must require
    // the FULL id, not a prefix.
    expect(
      findReferencedBacklogIds("svc bug fix", ["svc-2-add-dep"]),
    ).toEqual([]);
  });

  it("REJECTS id wrapped in alphanumerics (no left/right boundary)", () => {
    // `xsvc-2-add-depy` should NOT match `svc-2-add-dep`.
    expect(
      findReferencedBacklogIds("xsvc-2-add-depy", ["svc-2-add-dep"]),
    ).toEqual([]);
  });

  it("matches when id is surrounded by punctuation", () => {
    const cases = [
      `(svc-2-add-dep)`,
      `"svc-2-add-dep"`,
      `[svc-2-add-dep]`,
      `svc-2-add-dep.`,
      `svc-2-add-dep,`,
      `\`svc-2-add-dep\``,
    ];
    for (const msg of cases) {
      expect(findReferencedBacklogIds(msg, ["svc-2-add-dep"])).toEqual([
        "svc-2-add-dep",
      ]);
    }
  });
});
