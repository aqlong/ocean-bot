import { describe, it, expect, beforeEach, vi } from "vitest";
import { annotateFailedRuns, applyOutOfBandShipped } from "./reclassify";
import { _clearCommitReachCache } from "./github/commit-reach";

beforeEach(() => {
  _clearCommitReachCache();
});

function mockFetchStatuses(map: Record<string, string>) {
  return vi.fn(async (url: string) => {
    for (const [sha, status] of Object.entries(map)) {
      if (url.includes(`/compare/${sha}`)) {
        return new Response(JSON.stringify({ status }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
    });
  });
}

describe("annotateFailedRuns", () => {
  it("passes non-failed runs through unchanged", async () => {
    const runs = [
      {
        status: "shipped",
        project: "code2wiki",
        branch: "main",
        commitSha: "abcdef1234567",
      },
      {
        status: "awaiting-approval",
        project: "code2wiki",
        branch: "main",
        commitSha: "fedcba9876543",
      },
    ];
    const out = await annotateFailedRuns(runs);
    expect(out[0]?.outOfBandShipped).toBeUndefined();
    expect(out[1]?.outOfBandShipped).toBeUndefined();
  });

  it("ignores failed runs without a commit", async () => {
    const out = await annotateFailedRuns([
      {
        status: "failed",
        project: "code2wiki",
        branch: "main",
        commitSha: null,
      },
    ]);
    expect(out[0]?.outOfBandShipped).toBeUndefined();
  });

  it("ignores failed runs whose project has no repo mapping", async () => {
    const out = await annotateFailedRuns([
      {
        status: "failed",
        project: "unknown-project",
        branch: "main",
        commitSha: "abcdef1234567",
      },
    ]);
    expect(out[0]?.outOfBandShipped).toBeUndefined();
  });
});

describe("applyOutOfBandShipped", () => {
  it("moves N from failed into shipped", () => {
    const t = {
      shipped: 1,
      awaitingApproval: 0,
      running: 0,
      failed: 3,
      rejected: 0,
      total: 4,
    };
    const adjusted = applyOutOfBandShipped(t, 2);
    expect(adjusted.shipped).toBe(3);
    expect(adjusted.failed).toBe(1);
    expect(adjusted.total).toBe(4);
  });

  it("clamps to failed when out-of-band > failed", () => {
    const t = {
      shipped: 0,
      awaitingApproval: 0,
      running: 0,
      failed: 2,
      rejected: 0,
      total: 2,
    };
    const adjusted = applyOutOfBandShipped(t, 10);
    expect(adjusted.failed).toBe(0);
    expect(adjusted.shipped).toBe(2);
  });

  it("ignores negative input", () => {
    const t = {
      shipped: 1,
      awaitingApproval: 0,
      running: 0,
      failed: 2,
      rejected: 0,
      total: 3,
    };
    const adjusted = applyOutOfBandShipped(t, -5);
    expect(adjusted.failed).toBe(2);
    expect(adjusted.shipped).toBe(1);
  });
});

// Integration: stub fetch globally for annotateFailedRuns end-to-end.
// commit-reach calls deps.fetch ?? globalThis.fetch, so we replace
// globalThis.fetch for the duration of this block.
describe("annotateFailedRuns, end-to-end with mocked fetch", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    _clearCommitReachCache();
  });

  it("tags only the run whose commit GitHub reports as on main", async () => {
    globalThis.fetch = mockFetchStatuses({
      c61952b: "ahead",
      "04bdfb3": "ahead",
      deadbee: "diverged",
    }) as unknown as typeof globalThis.fetch;

    const out = await annotateFailedRuns([
      {
        status: "failed",
        project: "code2wiki",
        branch: "main",
        commitSha: "c61952b1234567",
      },
      {
        status: "failed",
        project: "code2wiki",
        branch: "main",
        commitSha: "04bdfb31234567",
      },
      {
        status: "failed",
        project: "code2wiki",
        branch: "main",
        commitSha: "deadbee1234567",
      },
    ]);

    expect(out[0]?.outOfBandShipped).toBe(true);
    expect(out[1]?.outOfBandShipped).toBe(true);
    expect(out[2]?.outOfBandShipped).toBeUndefined();

    globalThis.fetch = origFetch;
  });
});
