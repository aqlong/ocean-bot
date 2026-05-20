import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProjectAdapter, DiffSummary, DangerReason } from "./adapters/types.js";

// Mock the git util so pushToTarget tests can drive first-push failure +
// dirty-tree branches without spawning real processes. decidePush is pure
// and unaffected.
const { gitMock, isCleanMock } = vi.hoisted(() => ({
  gitMock: vi.fn(),
  isCleanMock: vi.fn(),
}));
vi.mock("./util/git.js", () => ({
  git: gitMock,
  isClean: isCleanMock,
}));

const { decidePush, pushToTarget } = await import("./push.js");

function mkAdapter(over: Partial<ProjectAdapter> = {}): ProjectAdapter {
  return {
    name: "stub",
    rootDir: "/tmp",
    claudeMdPath: "/tmp/CLAUDE.md",
    memoryDir: "/tmp/memory",
    backlog: async () => [],
    bugFix: async () => [],
    gapClosure: async () => [],
    tightening: async () => [],
    roadmap: async () => [],
    selfLearning: async () => [],
    refactor: async () => [],
    creative: async () => [],
    pushTarget: () => "main",
    classifyDanger: () => [],
    preflightCommands: () => [],
    visualSurfaces: async () => [],
    ...over,
  };
}

const safeDiff: DiffSummary = { files: ["src/foo.ts"], added: 5, removed: 2, patch: "" };

describe("decidePush", () => {
  it("pushes when auto + safe + preflight green", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto",
    });
    expect(d.action).toBe("push");
  });

  it("blocks when preflight failed regardless of approval mode", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: {
        ok: false,
        failures: [{ command: "npm test", exitCode: 1, tailLog: "fail" }],
      },
      approvalMode: "auto",
    });
    expect(d.action).toBe("block");
    expect(d.reason).toMatch(/Preflight failed/);
  });

  it("requires approval when manual even if safe", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "manual",
    });
    expect(d.action).toBe("await-approval");
    expect(d.reason).toMatch(/manual/);
  });

  it("requires approval when classifier flags super-dangerous, even on auto", () => {
    const dangerReasons: DangerReason[] = [
      { ruleId: 8, explanation: "touched .env" },
    ];
    const d = decidePush({
      adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto",
    });
    expect(d.action).toBe("await-approval");
    expect(d.dangerReasons.length).toBe(1);
  });

  // ---- Severity-aware auto-approve (2026-05-16). ---------------------
  // Critical rules (1,2,3,4,8,10,11) still block under auto; advisory
  // rules (5,6,7,9) are logged but auto-pushed. Operator decision: "auto-
  // approve everything except critical issues I need to handle".

  it("pushes under auto when ONLY advisory rules fire (rule 6 large diff)", () => {
    const dangerReasons: DangerReason[] = [
      { ruleId: 6, explanation: "Diff too large for auto-review: 11 files" },
    ];
    const d = decidePush({
      adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto",
    });
    expect(d.action).toBe("push");
    // Advisory reasons still surface on the run (dashboard renders them)
    expect(d.dangerReasons.length).toBe(1);
    expect(d.reason).toMatch(/advisory hits ignored.*#6/);
  });

  it("pushes under auto when ONLY advisory rules fire (rule 9 CI workflow)", () => {
    const dangerReasons: DangerReason[] = [
      { ruleId: 9, explanation: "CI workflow change: .github/workflows/ci.yml" },
    ];
    const d = decidePush({
      adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto",
    });
    expect(d.action).toBe("push");
  });

  it("blocks under auto when critical + advisory both fire (critical wins)", () => {
    const dangerReasons: DangerReason[] = [
      { ruleId: 6, explanation: "large diff" }, // advisory
      { ruleId: 2, explanation: "audit edit" }, // critical
    ];
    const d = decidePush({
      adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto",
    });
    expect(d.action).toBe("await-approval");
    expect(d.reason).toMatch(/Critical classifier hit/);
    expect(d.reason).toMatch(/#2/);
    // Advisory rule should not appear in the critical-list reason text.
    expect(d.reason).not.toMatch(/#6/);
  });

  it("blocks each critical rule independently under auto", () => {
    for (const ruleId of [1, 2, 3, 4, 8, 10, 11]) {
      const dangerReasons: DangerReason[] = [
        { ruleId, explanation: `rule ${ruleId} fired` },
      ];
      const d = decidePush({
        adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
        diff: safeDiff,
        preflight: { ok: true, failures: [] },
        approvalMode: "auto",
      });
      expect(d.action, `rule ${ruleId} should block`).toBe("await-approval");
    }
  });

  it("pushes each advisory rule independently under auto", () => {
    for (const ruleId of [5, 6, 7, 9]) {
      const dangerReasons: DangerReason[] = [
        { ruleId, explanation: `rule ${ruleId} fired` },
      ];
      const d = decidePush({
        adapter: mkAdapter({ classifyDanger: () => dangerReasons }),
        diff: safeDiff,
        preflight: { ok: true, failures: [] },
        approvalMode: "auto",
      });
      expect(d.action, `rule ${ruleId} should push`).toBe("push");
    }
  });

  it("manual mode still blocks even on safe + no danger (severity split is a no-op for manual)", () => {
    const d = decidePush({
      adapter: mkAdapter({
        classifyDanger: () => [{ ruleId: 6, explanation: "advisory" }],
      }),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "manual",
    });
    expect(d.action).toBe("await-approval");
    expect(d.reason).toMatch(/manual/);
  });

  it("requires approval on auto-with-visual when visual flagged regression", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto-with-visual",
      visualVerdict: "regression",
    });
    expect(d.action).toBe("await-approval");
    expect(d.reason).toMatch(/visual/);
  });

  it("pushes on auto-with-visual when visual is ok", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto-with-visual",
      visualVerdict: "ok",
    });
    expect(d.action).toBe("push");
  });

  it("pushes on auto-with-visual when visual was skipped (non-UI diff)", () => {
    const d = decidePush({
      adapter: mkAdapter(),
      diff: safeDiff,
      preflight: { ok: true, failures: [] },
      approvalMode: "auto-with-visual",
      visualVerdict: "skipped",
    });
    expect(d.action).toBe("push");
  });
});

describe("pushToTarget rebase fallback dirty-tree guard", () => {
  beforeEach(() => {
    gitMock.mockReset();
    isCleanMock.mockReset();
  });

  it("bails out cleanly when first push fails and the tree is dirty", async () => {
    // First call: the initial `git push` returns non-zero (remote ahead).
    gitMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "Updates were rejected because the remote contains work...",
    });
    // Tree is dirty by the time we reach the rebase fallback.
    isCleanMock.mockResolvedValueOnce(false);

    const res = await pushToTarget(mkAdapter(), "feat/x");

    expect(res.pushed).toBe(false);
    expect(res.reason).toMatch(/local tree dirty/);
    expect(res.reason).toMatch(/operator action required/);
    // No fetch, no rebase attempted, exactly the first push call.
    expect(gitMock).toHaveBeenCalledTimes(1);
    const firstCall = gitMock.mock.calls[0]![1] as string[];
    expect(firstCall[0]).toBe("push");
  });
});
