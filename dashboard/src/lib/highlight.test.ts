import { describe, expect, it } from "vitest";
import { splitMatches } from "./highlight";

// Tests target splitMatches (pure array, no JSX) because the React
// wrapping in highlightMatches is a thin map over the same result.

describe("splitMatches", () => {
  it("returns the original text in a single-element array when there is no match", () => {
    expect(splitMatches("hello world", "parser")).toEqual(["hello world"]);
  });

  it("splits on a single match, yielding [before, match, after]", () => {
    expect(splitMatches("fix the parser bug", "parser")).toEqual([
      "fix the ",
      "parser",
      " bug",
    ]);
  });

  it("splits on multiple non-overlapping matches", () => {
    expect(splitMatches("parser code and parser tests", "parser")).toEqual([
      "",
      "parser",
      " code and ",
      "parser",
      " tests",
    ]);
  });

  it("escapes special regex characters so they match literally", () => {
    // Without escaping, "foo.bar" would match "fooXbar" via the dot wildcard.
    expect(splitMatches("foo.bar and fooXbar", "foo.bar")).toEqual([
      "",
      "foo.bar",
      " and fooXbar",
    ]);
  });

  it("is case-insensitive, preserving the original casing in matched segments", () => {
    const parts = splitMatches("PARSER and parser and Parser", "parser");
    expect(parts).toEqual(["", "PARSER", " and ", "parser", " and ", "Parser", ""]);
  });

  it("returns [text] unchanged when query is blank or whitespace-only", () => {
    expect(splitMatches("hello", "")).toEqual(["hello"]);
    expect(splitMatches("hello", "   ")).toEqual(["hello"]);
  });
});
