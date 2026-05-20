import { describe, it, expect, beforeEach } from "vitest";
import {
  scoutTask,
  parseScoutResponse,
  buildScoutPrompt,
  hashDescription,
  clearScoutCache,
  SCOUT_DESCRIPTION_THRESHOLD,
  type ScoutSpawn,
  type ScoutSpawnResult,
} from "./scout.js";

function mkSpawn(stdout: string, opts: Partial<ScoutSpawnResult> = {}): ScoutSpawn {
  return async () => ({ stdout, exitCode: 0, timedOut: false, ...opts });
}

function countingSpawn(stdout: string): { fn: ScoutSpawn; calls: number } {
  const state = { calls: 0 };
  const fn: ScoutSpawn = async () => {
    state.calls++;
    return { stdout, exitCode: 0, timedOut: false };
  };
  return {
    fn,
    get calls() {
      return state.calls;
    },
  };
}

describe("SCOUT_DESCRIPTION_THRESHOLD", () => {
  it("is 1500 (per ai-usage-opt chunk 4/5 spec)", () => {
    expect(SCOUT_DESCRIPTION_THRESHOLD).toBe(1500);
  });
});

describe("buildScoutPrompt", () => {
  it("instructs claude not to use tools and to return JSON", () => {
    const p = buildScoutPrompt("do thing X");
    expect(p).toMatch(/JSON/);
    expect(p).toMatch(/do NOT use any tools/i);
    expect(p).toContain("do thing X");
  });

  it("names the three required JSON keys", () => {
    const p = buildScoutPrompt("x");
    expect(p).toContain("model");
    expect(p).toContain("estimatedTurns");
    expect(p).toContain("scopeWarnings");
  });
});

describe("parseScoutResponse", () => {
  it("extracts JSON from a ```json fenced block (haiku's preferred shape)", () => {
    const text = [
      "Sure, here's my analysis:",
      "```json",
      JSON.stringify({
        model: "sonnet",
        estimatedTurns: 12,
        scopeWarnings: [],
      }),
      "```",
    ].join("\n");
    expect(parseScoutResponse(text)).toEqual({
      model: "sonnet",
      estimatedTurns: 12,
      scopeWarnings: [],
    });
  });

  it("falls back to a bare brace block when haiku omits the fence", () => {
    const text = `Result:\n${JSON.stringify({
      model: "opus",
      estimatedTurns: 40,
      scopeWarnings: ["scope unclear"],
    })}\n`;
    expect(parseScoutResponse(text)).toEqual({
      model: "opus",
      estimatedTurns: 40,
      scopeWarnings: ["scope unclear"],
    });
  });

  it("floors fractional estimatedTurns and clamps to >=0", () => {
    const text = `{"model":"haiku","estimatedTurns":3.9,"scopeWarnings":[]}`;
    expect(parseScoutResponse(text)?.estimatedTurns).toBe(3);
    const neg = `{"model":"haiku","estimatedTurns":-5,"scopeWarnings":[]}`;
    expect(parseScoutResponse(neg)?.estimatedTurns).toBe(0);
  });

  it("trims and drops empty-string warnings", () => {
    const text = `{"model":"sonnet","estimatedTurns":5,"scopeWarnings":["  bad  ", "", "ok"]}`;
    expect(parseScoutResponse(text)?.scopeWarnings).toEqual(["bad", "ok"]);
  });

  it("returns null for non-JSON output", () => {
    expect(parseScoutResponse("just some prose without any json")).toBeNull();
  });

  it("rejects invalid model values", () => {
    const text = `{"model":"gpt4","estimatedTurns":5,"scopeWarnings":[]}`;
    expect(parseScoutResponse(text)).toBeNull();
  });

  it("rejects missing keys", () => {
    expect(parseScoutResponse(`{"model":"haiku","scopeWarnings":[]}`)).toBeNull();
    expect(
      parseScoutResponse(`{"model":"haiku","estimatedTurns":5}`),
    ).toBeNull();
    expect(
      parseScoutResponse(`{"estimatedTurns":5,"scopeWarnings":[]}`),
    ).toBeNull();
  });

  it("rejects non-string entries in scopeWarnings", () => {
    const text = `{"model":"haiku","estimatedTurns":5,"scopeWarnings":[1,2]}`;
    expect(parseScoutResponse(text)).toBeNull();
  });
});

describe("hashDescription", () => {
  it("is deterministic and case-sensitive", () => {
    expect(hashDescription("abc")).toBe(hashDescription("abc"));
    expect(hashDescription("abc")).not.toBe(hashDescription("ABC"));
  });

  it("returns a 16-char hex prefix", () => {
    expect(hashDescription("anything")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("scoutTask", () => {
  beforeEach(() => {
    clearScoutCache();
  });

  it("returns parsed result + hasScopeWarnings=false when warnings empty", async () => {
    const stdout = `\`\`\`json
${JSON.stringify({ model: "sonnet", estimatedTurns: 8, scopeWarnings: [] })}
\`\`\``;
    const out = await scoutTask({
      description: "small well-scoped task",
      cwd: "/x",
      spawnFn: mkSpawn(stdout),
    });
    expect(out.result).toEqual({
      model: "sonnet",
      estimatedTurns: 8,
      scopeWarnings: [],
    });
    expect(out.hasScopeWarnings).toBe(false);
    expect(out.failure).toBeNull();
    expect(out.cached).toBe(false);
  });

  it("decision logic: warnings array non-empty → hasScopeWarnings=true (routes to approval upstream)", async () => {
    const stdout = JSON.stringify({
      model: "opus",
      estimatedTurns: 80,
      scopeWarnings: [
        "ambiguous acceptance criteria",
        "touches schema migration (dangerous)",
      ],
    });
    const out = await scoutTask({
      description: "very long open-ended ambiguous task description ".repeat(40),
      cwd: "/x",
      spawnFn: mkSpawn(stdout),
    });
    expect(out.hasScopeWarnings).toBe(true);
    expect(out.result?.scopeWarnings).toHaveLength(2);
    expect(out.failure).toBeNull();
  });

  it("caches by hash(description): re-call with same description does not re-spawn", async () => {
    const stdout = JSON.stringify({
      model: "haiku",
      estimatedTurns: 3,
      scopeWarnings: [],
    });
    const counter = countingSpawn(stdout);
    const description = "same task";
    const first = await scoutTask({
      description,
      cwd: "/x",
      spawnFn: counter.fn,
    });
    const second = await scoutTask({
      description,
      cwd: "/x",
      spawnFn: counter.fn,
    });
    expect(counter.calls).toBe(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  it("does NOT cross-hit cache for different descriptions", async () => {
    const stdout = JSON.stringify({
      model: "haiku",
      estimatedTurns: 1,
      scopeWarnings: [],
    });
    const counter = countingSpawn(stdout);
    await scoutTask({ description: "task A", cwd: "/x", spawnFn: counter.fn });
    await scoutTask({ description: "task B", cwd: "/x", spawnFn: counter.fn });
    expect(counter.calls).toBe(2);
  });

  it("surfaces timeout as a failure (cached so we don't re-burn on re-pick)", async () => {
    const out = await scoutTask({
      description: "task that timed out",
      cwd: "/x",
      spawnFn: mkSpawn("", { exitCode: 124, timedOut: true }),
    });
    expect(out.result).toBeNull();
    expect(out.hasScopeWarnings).toBe(false);
    expect(out.failure).toMatch(/timed out/);
  });

  it("surfaces non-zero exit as a failure", async () => {
    const out = await scoutTask({
      description: "task that crashed",
      cwd: "/x",
      spawnFn: mkSpawn("", { exitCode: 1 }),
    });
    expect(out.result).toBeNull();
    expect(out.failure).toMatch(/exited 1/);
  });

  it("surfaces unparseable output as a failure (haiku ignored the format ask)", async () => {
    const out = await scoutTask({
      description: "task with prose response",
      cwd: "/x",
      spawnFn: mkSpawn("Sure, I'll think about that. (No JSON returned.)"),
    });
    expect(out.result).toBeNull();
    expect(out.failure).toMatch(/parseable JSON/);
    expect(out.hasScopeWarnings).toBe(false);
  });

  it("caches failures too: re-pick of a known-bad description doesn't re-burn the scout budget", async () => {
    const counter = countingSpawn("nothing parseable");
    await scoutTask({
      description: "broken task",
      cwd: "/x",
      spawnFn: counter.fn,
    });
    await scoutTask({
      description: "broken task",
      cwd: "/x",
      spawnFn: counter.fn,
    });
    expect(counter.calls).toBe(1);
  });
});
