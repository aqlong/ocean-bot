import { describe, it, expect } from "vitest";
import { buildRunsHref } from "./pagination-href";

describe("buildRunsHref", () => {
  it("returns /runs when no params and page <= 1", () => {
    expect(buildRunsHref({}, 1)).toBe("/runs");
    expect(buildRunsHref({}, 0)).toBe("/runs");
  });

  it("encodes page=N when page > 1", () => {
    expect(buildRunsHref({}, 2)).toBe("/runs?page=2");
    expect(buildRunsHref({}, 7)).toBe("/runs?page=7");
  });

  it("strips an existing page param when target page <= 1", () => {
    expect(buildRunsHref({ page: "5" }, 1)).toBe("/runs");
    expect(buildRunsHref({ page: "5" }, 0)).toBe("/runs");
  });

  it("preserves filter params when paging forward", () => {
    const sp = { status: "shipped", project: "ocean-bot" };
    const href = buildRunsHref(sp, 3);
    expect(href.startsWith("/runs?")).toBe(true);
    const q = new URLSearchParams(href.slice("/runs?".length));
    expect(q.get("status")).toBe("shipped");
    expect(q.get("project")).toBe("ocean-bot");
    expect(q.get("page")).toBe("3");
  });

  it("preserves filters and strips page when navigating to page 1", () => {
    const sp = { status: "shipped", project: "ocean-bot", page: "4" };
    const href = buildRunsHref(sp, 1);
    const q = new URLSearchParams(href.slice("/runs?".length));
    expect(q.get("status")).toBe("shipped");
    expect(q.get("project")).toBe("ocean-bot");
    expect(q.get("page")).toBe(null);
  });

  it("overrides existing page when target page > 1", () => {
    const href = buildRunsHref({ page: "2" }, 5);
    const q = new URLSearchParams(href.slice("/runs?".length));
    expect(q.get("page")).toBe("5");
  });

  it("URL-encodes filter values with special characters", () => {
    const href = buildRunsHref({ queue: "A & B" }, 2);
    expect(href).toContain("queue=A+%26+B");
    const q = new URLSearchParams(href.slice("/runs?".length));
    expect(q.get("queue")).toBe("A & B");
  });

  it("is idempotent: same inputs produce same URL", () => {
    const sp = { status: "shipped", project: "code2wiki" };
    expect(buildRunsHref(sp, 2)).toBe(buildRunsHref(sp, 2));
  });
});
