import { describe, it, expect, beforeEach, vi } from "vitest";
import { isCommitOnRemote, _clearCommitReachCache } from "./commit-reach";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("isCommitOnRemote", () => {
  beforeEach(() => {
    _clearCommitReachCache();
  });

  it("returns true when GitHub compare reports ahead", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { status: "ahead" }));
    const on = await isCommitOnRemote(
      "abcdef1234567",
      "main",
      "craftandship/code2wiki",
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(on).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = fetch.mock.calls[0]?.[0] as string;
    expect(url).toContain("/repos/craftandship/code2wiki/compare/");
    expect(url).toContain("abcdef1234567...main");
  });

  it("returns true when GitHub compare reports identical", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "identical" }));
    const on = await isCommitOnRemote("c61952b1234", "main", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(on).toBe(true);
  });

  it("returns false when status is behind or diverged", async () => {
    for (const status of ["behind", "diverged"]) {
      _clearCommitReachCache();
      const fetch = vi.fn().mockResolvedValue(jsonResponse(200, { status }));
      const on = await isCommitOnRemote("deadbee1234", "main", "owner/repo", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(on).toBe(false);
    }
  });

  it("returns false on 404 (private repo, unknown commit)", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(404, { message: "Not Found" }));
    const on = await isCommitOnRemote("abcdef1234", "main", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(on).toBe(false);
  });

  it("returns false on network error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("ENETDOWN"));
    const on = await isCommitOnRemote("abcdef1234", "main", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(on).toBe(false);
  });

  it("short-circuits on invalid input without calling fetch", async () => {
    const fetch = vi.fn();
    const a = await isCommitOnRemote("", "main", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const b = await isCommitOnRemote("abc", "main", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const c = await isCommitOnRemote("abcdef1234", "", "owner/repo", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const d = await isCommitOnRemote("abcdef1234", "main", "", {
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(c).toBe(false);
    expect(d).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caches positive answers for 1h", async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "ahead" }));

    const opts = {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now,
    };
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    nowMs += 30 * 60 * 1000;
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    expect(fetch).toHaveBeenCalledTimes(1);

    nowMs += 31 * 60 * 1000;
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caches negative answers for only ~1m", async () => {
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "diverged" }));

    const opts = {
      fetch: fetch as unknown as typeof globalThis.fetch,
      now,
    };
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    nowMs += 30 * 1000;
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    expect(fetch).toHaveBeenCalledTimes(1);

    nowMs += 31 * 1000;
    await isCommitOnRemote("abcdef1234", "main", "owner/repo", opts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cache key separates by repo and branch", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { status: "ahead" }));
    const opts = { fetch: fetch as unknown as typeof globalThis.fetch };
    await isCommitOnRemote("abcdef1234", "main", "a/b", opts);
    await isCommitOnRemote("abcdef1234", "main", "c/d", opts);
    await isCommitOnRemote("abcdef1234", "staging", "a/b", opts);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
