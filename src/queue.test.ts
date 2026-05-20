import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  pickTop,
  collectCandidates,
  pickNext,
  DEFAULT_PICKER_CTX,
  type PickerContext,
} from "./queue.js";
import type { ProjectAdapter, TaskCandidate, Queue } from "./adapters/types.js";

function mkCandidate(over: Partial<TaskCandidate> = {}): TaskCandidate {
  return {
    summary: "do thing",
    leverage: 30,
    estTokens: 10_000,
    queue: "gap-closure",
    ...over,
  };
}

describe("scoreCandidate, penalties", () => {
  it("base leverage flows through with no penalties", () => {
    const s = scoreCandidate(mkCandidate({ leverage: 40 }), "code2wiki", DEFAULT_PICKER_CTX);
    expect(s.score).toBe(40);
    expect(s.scoreBreakdown).toEqual({ base_leverage: 40 });
  });

  it("applies expensive penalty when estTokens > threshold", () => {
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, estTokens: 100_000 }),
      "code2wiki",
      DEFAULT_PICKER_CTX,
    );
    expect(s.score).toBe(30);
    expect(s.scoreBreakdown["expensive_penalty"]).toBe(-10);
  });

  it("applies caution penalty when dangerHint=caution", () => {
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, dangerHint: "caution" }),
      "code2wiki",
      DEFAULT_PICKER_CTX,
    );
    expect(s.score).toBe(35);
  });

  it("applies super-dangerous penalty when dangerHint=super-dangerous", () => {
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, dangerHint: "super-dangerous" }),
      "code2wiki",
      DEFAULT_PICKER_CTX,
    );
    expect(s.score).toBe(15);
  });

  it("stacks multiple penalties", () => {
    const s = scoreCandidate(
      mkCandidate({
        leverage: 50,
        estTokens: 100_000,
        dangerHint: "super-dangerous",
      }),
      "code2wiki",
      DEFAULT_PICKER_CTX,
    );
    expect(s.score).toBe(50 - 10 - 25);
  });
});

describe("scoreCandidate, diversity guard", () => {
  it("penalizes a candidate matching the dominant recent queue", () => {
    const ctx: PickerContext = {
      ...DEFAULT_PICKER_CTX,
      recentQueues: ["roadmap", "roadmap", "roadmap"],
    };
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, queue: "roadmap" }),
      "code2wiki",
      ctx,
    );
    expect(s.score).toBe(25);
  });

  it("does not penalize when recent queues are mixed", () => {
    const ctx: PickerContext = {
      ...DEFAULT_PICKER_CTX,
      recentQueues: ["roadmap", "gap-closure", "roadmap"],
    };
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, queue: "roadmap" }),
      "code2wiki",
      ctx,
    );
    expect(s.score).toBe(40);
  });

  it("does not penalize a different queue from the dominant", () => {
    const ctx: PickerContext = {
      ...DEFAULT_PICKER_CTX,
      recentQueues: ["roadmap", "roadmap", "roadmap"],
    };
    const s = scoreCandidate(
      mkCandidate({ leverage: 40, queue: "gap-closure" }),
      "code2wiki",
      ctx,
    );
    expect(s.score).toBe(40);
  });
});

describe("pickNext, dedup against active taskIds", () => {
  it("excludes candidates whose taskId is in the per-project exclude set", async () => {
    const adapter = makeStubAdapter({
      "bug-fix": [
        mkCandidate({ queue: "bug-fix", leverage: 85, taskId: "bug:x" }),
      ],
      "gap-closure": [
        mkCandidate({ queue: "gap-closure", leverage: 70, taskId: "gap:y" }),
      ],
    });
    const exclude = new Map([["stub", new Set(["bug:x"])]]);
    const pick = await pickNext({
      adapters: [adapter],
      ctx: DEFAULT_PICKER_CTX,
      excludeTaskIdsByProject: exclude,
    });
    expect(pick?.taskId).toBe("gap:y");
  });

  it("returns null when every candidate's taskId is excluded", async () => {
    const adapter = makeStubAdapter({
      "bug-fix": [mkCandidate({ leverage: 85, taskId: "bug:x" })],
    });
    const exclude = new Map([["stub", new Set(["bug:x"])]]);
    const pick = await pickNext({
      adapters: [adapter],
      ctx: DEFAULT_PICKER_CTX,
      excludeTaskIdsByProject: exclude,
    });
    expect(pick).toBeNull();
  });

  it("scopes exclude set per-project (not cross-project)", async () => {
    const a1 = makeStubAdapter({
      "bug-fix": [mkCandidate({ leverage: 60, taskId: "bug:shared" })],
    });
    Object.assign(a1, { name: "p1" });
    const a2 = makeStubAdapter({
      "bug-fix": [mkCandidate({ leverage: 80, taskId: "bug:shared" })],
    });
    Object.assign(a2, { name: "p2" });
    const exclude = new Map([["p1", new Set(["bug:shared"])]]);
    const pick = await pickNext({
      adapters: [a1, a2],
      ctx: DEFAULT_PICKER_CTX,
      excludeTaskIdsByProject: exclude,
    });
    expect(pick?.project).toBe("p2");
  });

  it("regression: a recently no-op'd roadmap task gets filtered (token-burn loop fix)", async () => {
    // Mirrors the 2026-05-13 prod scenario: a single high-leverage roadmap
    // pick was re-picked across 5 consecutive ticks, each producing a no-op
    // shipped run. recentlyNoopTaskIds() now feeds the same exclude map
    // that the picker honors here.
    const adapter = makeStubAdapter({
      roadmap: [
        mkCandidate({
          queue: "roadmap",
          leverage: 80,
          taskId: "roadmap:linkedin-cf-shops",
        }),
        mkCandidate({
          queue: "roadmap",
          leverage: 60,
          taskId: "roadmap:other",
        }),
      ],
    });
    const exclude = new Map([
      ["stub", new Set(["roadmap:linkedin-cf-shops"])],
    ]);
    const pick = await pickNext({
      adapters: [adapter],
      ctx: DEFAULT_PICKER_CTX,
      excludeTaskIdsByProject: exclude,
    });
    expect(pick?.taskId).toBe("roadmap:other");
  });

  it("no exclude map = vanilla behavior", async () => {
    const adapter = makeStubAdapter({
      "bug-fix": [mkCandidate({ leverage: 85, taskId: "bug:x" })],
    });
    const pick = await pickNext({
      adapters: [adapter],
      ctx: DEFAULT_PICKER_CTX,
    });
    expect(pick?.taskId).toBe("bug:x");
  });
});

describe("pickTop", () => {
  it("returns null on empty input", () => {
    expect(pickTop([])).toBeNull();
  });

  it("picks the highest scored", () => {
    const cands = [
      scoreCandidate(mkCandidate({ leverage: 10 }), "p", DEFAULT_PICKER_CTX),
      scoreCandidate(mkCandidate({ leverage: 50 }), "p", DEFAULT_PICKER_CTX),
      scoreCandidate(mkCandidate({ leverage: 30 }), "p", DEFAULT_PICKER_CTX),
    ];
    expect(pickTop(cands)?.score).toBe(50);
  });
});

describe("collectCandidates", () => {
  it("flattens all seven queue methods", async () => {
    const adapter = makeStubAdapter({
      "bug-fix": [mkCandidate({ queue: "bug-fix", leverage: 85 })],
      "gap-closure": [mkCandidate({ queue: "gap-closure", leverage: 40 })],
      roadmap: [mkCandidate({ queue: "roadmap", leverage: 20 })],
      creative: [mkCandidate({ queue: "creative", leverage: 5 })],
    });
    const cs = await collectCandidates(adapter);
    expect(cs.map((c) => c.queue).sort()).toEqual([
      "bug-fix",
      "creative",
      "gap-closure",
      "roadmap",
    ]);
  });

  it("bug-fix candidates carry the highest base leverage", async () => {
    const adapter = makeStubAdapter({
      "bug-fix": [mkCandidate({ queue: "bug-fix", leverage: 85 })],
      "gap-closure": [mkCandidate({ queue: "gap-closure", leverage: 70 })],
      roadmap: [mkCandidate({ queue: "roadmap", leverage: 50 })],
    });
    const cs = await collectCandidates(adapter);
    const top = [...cs].sort((a, b) => b.leverage - a.leverage)[0];
    expect(top?.queue).toBe("bug-fix");
  });

  it("tolerates a queue method that rejects", async () => {
    const adapter = makeStubAdapter({
      "gap-closure": [mkCandidate({ leverage: 40 })],
      roadmap: "throw",
    });
    const cs = await collectCandidates(adapter);
    expect(cs.length).toBe(1);
  });

  it("overwrites adapter-supplied queue tag with the source queue", async () => {
    const adapter = makeStubAdapter({
      "gap-closure": [mkCandidate({ queue: "creative" })], // lying queue tag
    });
    const cs = await collectCandidates(adapter);
    expect(cs[0]?.queue).toBe("gap-closure");
  });
});

// ----------------------------------------------------------------------

function makeStubAdapter(
  src: Partial<Record<Queue, TaskCandidate[] | "throw">>,
): ProjectAdapter {
  const wrap =
    (q: Queue): (() => Promise<TaskCandidate[]>) =>
    async () => {
      const v = src[q];
      if (v === "throw") throw new Error("nope");
      return v ?? [];
    };
  return {
    name: "stub",
    rootDir: "/tmp",
    claudeMdPath: "/tmp/CLAUDE.md",
    memoryDir: "/tmp/memory",
    backlog: wrap("backlog"),
    bugFix: wrap("bug-fix"),
    gapClosure: wrap("gap-closure"),
    tightening: wrap("tightening"),
    roadmap: wrap("roadmap"),
    selfLearning: wrap("self-learning"),
    refactor: wrap("refactor"),
    creative: wrap("creative"),
    pushTarget: () => "main",
    classifyDanger: () => [],
    preflightCommands: () => [],
    visualSurfaces: async () => [],
  };
}
