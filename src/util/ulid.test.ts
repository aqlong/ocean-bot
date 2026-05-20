import { describe, it, expect } from "vitest";
import { ulid } from "./ulid.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{24}$/;

describe("ulid", () => {
  it("returns 24-character Crockford base32", () => {
    const id = ulid();
    expect(id).toMatch(CROCKFORD);
    expect(id).toHaveLength(24);
  });

  it("produces unique ids across a tight loop", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(ulid());
    expect(set.size).toBe(1000);
  });

  it("is lexicographically sortable by time", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_800_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it("two ids generated in the same millisecond still differ (random tail)", () => {
    const t = Date.now();
    const a = ulid(t);
    const b = ulid(t);
    expect(a).not.toBe(b);
    // Time prefix (first 10 chars) is identical.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
  });

  it("differs in the time prefix for timestamps a millisecond apart", () => {
    const t = Date.parse("2026-05-11T12:00:00Z");
    const a = ulid(t);
    const b = ulid(t + 1);
    // The 10-char time prefix advances when ms advances.
    expect(a.slice(0, 10)).not.toBe(b.slice(0, 10));
  });

  it("time prefix is monotonic across many adjacent timestamps", () => {
    const base = Date.parse("2026-05-11T12:00:00Z");
    const prefixes = Array.from({ length: 50 }, (_, i) =>
      ulid(base + i).slice(0, 10),
    );
    // Strictly non-decreasing.
    for (let i = 1; i < prefixes.length; i++) {
      const prev = prefixes[i - 1];
      const cur = prefixes[i];
      if (prev === undefined || cur === undefined) throw new Error("undef");
      expect(prev <= cur).toBe(true);
    }
  });
});
