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
    expect(findReferencedBacklogIds("", ["dotnet-2-add-dep"])).toEqual([]);
  });

  it("returns [] for empty id list", () => {
    expect(findReferencedBacklogIds("some commit body", [])).toEqual([]);
  });

  it("matches an id present in the message body", () => {
    const msg = `feat(parser): ship the thing\n\nCloses dotnet-2-add-dep.`;
    expect(findReferencedBacklogIds(msg, ["dotnet-2-add-dep"])).toEqual([
      "dotnet-2-add-dep",
    ]);
  });

  it("matches multiple ids in one message", () => {
    const msg = `Body references dotnet-2-add-dep and also dotnet-3-parser-mvc-webapi here.`;
    const result = findReferencedBacklogIds(msg, [
      "dotnet-2-add-dep",
      "dotnet-3-parser-mvc-webapi",
      "dotnet-9-end-to-end-smoke-fixture",
    ]);
    expect(result.sort()).toEqual(
      ["dotnet-2-add-dep", "dotnet-3-parser-mvc-webapi"].sort(),
    );
  });

  it("REJECTS substring match (dotnet-1 inside dotnet-10)", () => {
    // This is the load-bearing case. The May 2026 dotnet-* series had
    // ids dotnet-1, dotnet-2, ..., dotnet-10. A naive substring match
    // would falsely close dotnet-1 whenever dotnet-10 appears in a
    // commit body. Explicit lookarounds in the regex prevent this.
    const msg = `Closes dotnet-10 only.`;
    expect(findReferencedBacklogIds(msg, ["dotnet-1", "dotnet-10"])).toEqual([
      "dotnet-10",
    ]);
  });

  it("treats hyphen as part of the id (not a word boundary)", () => {
    // JS \b treats `-` as non-word, so \b fires AT the hyphen --
    // which would falsely match `dotnet-1` inside `dotnet-10`. Our
    // implementation uses explicit lookarounds with [\w-] to keep
    // hyphenated tokens whole.
    const msg = `mention of dotnet-1-stuff`;
    expect(findReferencedBacklogIds(msg, ["dotnet-1"])).toEqual([]);
  });

  it("matches at the start of the message (no left context)", () => {
    const msg = `dotnet-2-add-dep is the focus here.`;
    expect(findReferencedBacklogIds(msg, ["dotnet-2-add-dep"])).toEqual([
      "dotnet-2-add-dep",
    ]);
  });

  it("matches at the end of the message (no right context)", () => {
    const msg = `Closes dotnet-2-add-dep`;
    expect(findReferencedBacklogIds(msg, ["dotnet-2-add-dep"])).toEqual([
      "dotnet-2-add-dep",
    ]);
  });

  it("deduplicates when the same id appears multiple times", () => {
    const msg = `dotnet-2-add-dep on line one\ndotnet-2-add-dep on line two`;
    expect(findReferencedBacklogIds(msg, ["dotnet-2-add-dep"])).toEqual([
      "dotnet-2-add-dep",
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

  it("REJECTS partial-prefix match (mentioning 'dotnet' alone)", () => {
    // Operator might write `dotnet bug fix` in a commit body without
    // intending to close `dotnet-2-add-dep`. The match must require
    // the FULL id, not a prefix.
    expect(
      findReferencedBacklogIds("dotnet bug fix", ["dotnet-2-add-dep"]),
    ).toEqual([]);
  });

  it("REJECTS id wrapped in alphanumerics (no left/right boundary)", () => {
    // `xdotnet-2-add-depy` should NOT match `dotnet-2-add-dep`.
    expect(
      findReferencedBacklogIds("xdotnet-2-add-depy", ["dotnet-2-add-dep"]),
    ).toEqual([]);
  });

  it("matches when id is surrounded by punctuation", () => {
    const cases = [
      `(dotnet-2-add-dep)`,
      `"dotnet-2-add-dep"`,
      `[dotnet-2-add-dep]`,
      `dotnet-2-add-dep.`,
      `dotnet-2-add-dep,`,
      `\`dotnet-2-add-dep\``,
    ];
    for (const msg of cases) {
      expect(findReferencedBacklogIds(msg, ["dotnet-2-add-dep"])).toEqual([
        "dotnet-2-add-dep",
      ]);
    }
  });
});
