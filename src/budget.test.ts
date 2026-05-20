import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  decideBudget,
  decideProjectBudgets,
  parseLine,
  loadUsageRows,
  loadBotSessions,
  appendBotSession,
  resolveCaps,
  DEFAULT_CAPS,
  MAX_20X_REFERENCE,
  type BudgetCaps,
  type UsageRow,
} from "./budget.js";

const NOW = Date.parse("2026-05-11T12:00:00Z");

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    ts: NOW - 60_000,
    sessionPath: "/tmp/session-a.jsonl",
    inputTokens: 1000,
    outputTokens: 200,
    cacheRead: 0,
    cacheWrite: 0,
    model: "claude-sonnet-4-6",
    ...over,
  };
}

const caps: BudgetCaps = {
  fiveHrInput: 10_000,
  fiveHrOutput: 2_000,
  sevenDInput: 70_000,
  sevenDOutput: 14_000,
  warnRatio: 0.9,
};

const botPaths = new Set(["/tmp/session-a.jsonl"]);

describe("decideBudget, gate behavior", () => {
  it("ok when below warn threshold", () => {
    const d = decideBudget({ rows: [row()], botSessionPaths: botPaths, caps, now: NOW });
    expect(d.gate).toBe("ok");
  });

  it("wait when within warn band", () => {
    const d = decideBudget({
      rows: [row({ inputTokens: 9100 })],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.gate).toBe("wait");
  });

  it("stop when 5hr cap reached", () => {
    const d = decideBudget({
      rows: [row({ inputTokens: 11000 })],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.gate).toBe("stop");
    expect(d.reason).toContain("5hr");
  });

  it("stop when 7d cap reached on output", () => {
    const old = row({ ts: NOW - 24 * 60 * 60 * 1000, outputTokens: 15000 });
    const d = decideBudget({
      rows: [old],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.gate).toBe("stop");
    expect(d.reason).toContain("7d");
  });
});

describe("decideBudget, attribution", () => {
  it("ignores rows from non-bot sessions", () => {
    const d = decideBudget({
      rows: [
        row({ sessionPath: "/tmp/interactive.jsonl", inputTokens: 999_999 }),
      ],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.gate).toBe("ok");
    expect(d.fiveHr.inputTokens).toBe(0);
  });

  it("counts rows from any bot session in the set", () => {
    const botSet = new Set(["/tmp/s1.jsonl", "/tmp/s2.jsonl"]);
    const d = decideBudget({
      rows: [
        row({ sessionPath: "/tmp/s1.jsonl", inputTokens: 4000 }),
        row({ sessionPath: "/tmp/s2.jsonl", inputTokens: 4000 }),
      ],
      botSessionPaths: botSet,
      caps,
      now: NOW,
    });
    expect(d.fiveHr.inputTokens).toBe(8000);
  });
});

describe("decideBudget, window boundaries", () => {
  it("rows older than 5hr drop out of 5hr window but stay in 7d", () => {
    const r = row({ ts: NOW - 6 * 60 * 60 * 1000, inputTokens: 50_000 });
    const d = decideBudget({
      rows: [r],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.fiveHr.inputTokens).toBe(0);
    expect(d.sevenD.inputTokens).toBe(50_000);
  });

  it("rows older than 7d drop out entirely", () => {
    const r = row({ ts: NOW - 8 * 24 * 60 * 60 * 1000, inputTokens: 999_999 });
    const d = decideBudget({
      rows: [r],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.fiveHr.inputTokens).toBe(0);
    expect(d.sevenD.inputTokens).toBe(0);
    expect(d.gate).toBe("ok");
  });

  it("computes nextResetMs from oldest in-window row", () => {
    const r = row({ ts: NOW - 4 * 60 * 60 * 1000, inputTokens: 11_000 });
    const d = decideBudget({
      rows: [r],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
    });
    expect(d.nextResetMs).toBe(r.ts + 5 * 60 * 60 * 1000);
  });
});

// Chunk 2 of budget-windows-align-with-anthropic-max: decideBudget consumes
// the anchor stamped by journal.setFiveHrWindowStart(). When anchored, the
// 5hr cap counts rows with ts >= anchor (not rows within now-5hr).
describe("decideBudget, 5hr window anchoring", () => {
  it("no-anchor first row: omitted fiveHrWindowStart preserves rolling math (back-compat)", () => {
    const d = decideBudget({
      rows: [row({ ts: NOW - 60_000, inputTokens: 1000 })],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
      // fiveHrWindowStart intentionally omitted
    });
    expect(d.fiveHr.inputTokens).toBe(1000);
    expect(d.fiveHrWindowExpired).toBeUndefined();
  });

  it("mid-window row: rows BEFORE anchor are excluded from 5hr, still count in 7d", () => {
    const anchorTs = NOW - 2 * 60 * 60 * 1000;
    const d = decideBudget({
      rows: [
        row({ ts: NOW - 3 * 60 * 60 * 1000, inputTokens: 5000 }), // before anchor
        row({ ts: NOW - 1 * 60 * 60 * 1000, inputTokens: 1000 }), // after anchor
      ],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
      fiveHrWindowStart: anchorTs,
    });
    expect(d.fiveHr.inputTokens).toBe(1000);
    expect(d.sevenD.inputTokens).toBe(6000);
    // nextResetMs uses anchor + 5hr, not oldest-in-window math
    expect(d.nextResetMs).toBe(anchorTs + 5 * 60 * 60 * 1000);
    expect(d.fiveHrWindowExpired).toBeUndefined();
  });

  it("just-expired: anchor older than 5hr flags fiveHrWindowExpired + falls back to rolling 5hr", () => {
    const expiredAnchor = NOW - 6 * 60 * 60 * 1000; // > 5hr ago
    const d = decideBudget({
      rows: [row({ ts: NOW - 4 * 60 * 60 * 1000, inputTokens: 5000 })],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
      fiveHrWindowStart: expiredAnchor,
    });
    expect(d.fiveHrWindowExpired).toBe(true);
    // Row at NOW-4hr is inside the rolling 5hr fallback
    expect(d.fiveHr.inputTokens).toBe(5000);
  });

  it("anchor-cleared-then-fresh: explicit null anchor + new row matches rolling math", () => {
    const d = decideBudget({
      rows: [row({ ts: NOW - 30 * 60 * 1000, inputTokens: 500 })],
      botSessionPaths: botPaths,
      caps,
      now: NOW,
      fiveHrWindowStart: null,
    });
    expect(d.fiveHr.inputTokens).toBe(500);
    expect(d.fiveHrWindowExpired).toBeUndefined();
    // Rolling nextResetMs still derives from oldest in-window row
    // (only present when ratio > 0; 500/10000 > 0 ⇒ defined)
    expect(d.nextResetMs).toBe(NOW - 30 * 60 * 1000 + 5 * 60 * 60 * 1000);
  });
});

describe("parseLine", () => {
  it("parses an assistant message with usage block", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-11T11:55:00Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 200,
        },
      },
    });
    const r = parseLine(line, "/tmp/x.jsonl");
    expect(r).not.toBeNull();
    expect(r?.inputTokens).toBe(100);
    expect(r?.outputTokens).toBe(50);
    expect(r?.cacheRead).toBe(1000);
    expect(r?.cacheWrite).toBe(200);
    expect(r?.model).toBe("claude-sonnet-4-6");
  });

  it("parses unix-seconds timestamps", () => {
    const line = JSON.stringify({
      ts: 1747000000,
      message: { usage: { input_tokens: 1, output_tokens: 1 } },
    });
    const r = parseLine(line, "/tmp/x.jsonl");
    expect(r?.ts).toBe(1747000000 * 1000);
  });

  it("returns null for non-JSON", () => {
    expect(parseLine("not json", "/tmp/x.jsonl")).toBeNull();
  });

  it("returns null for messages without usage", () => {
    const line = JSON.stringify({ message: { role: "user", content: "hi" } });
    expect(parseLine(line, "/tmp/x.jsonl")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const line = JSON.stringify({
      timestamp: "2026-05-11T11:55:00Z",
      message: { usage: { input_tokens: 5, output_tokens: 5 } },
    });
    const r = parseLine(line, "/tmp/x.jsonl");
    expect(r?.cacheRead).toBe(0);
    expect(r?.model).toBe("unknown");
  });
});

describe("loadUsageRows + bot session attribution (integration)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-budget-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("walks projects/*/conversations recursively + filters by sinceMs", async () => {
    const projDir = path.join(tmp, "claude", "projects", "-Users-x-proj");
    const convDir = path.join(projDir, "conversations");
    await fs.mkdir(convDir, { recursive: true });
    const sessionFile = path.join(convDir, "abc.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2026-05-11T11:55:00Z",
        message: {
          model: "sonnet",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      JSON.stringify({
        timestamp: "2026-05-04T00:00:00Z", // outside 7d
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
    ];
    await fs.writeFile(sessionFile, lines.join("\n") + "\n");
    // Bump mtime so we don't get short-circuited.
    const now = new Date();
    await fs.utimes(sessionFile, now, now);

    const rows = await loadUsageRows({
      claudeProjectsDir: path.join(tmp, "claude", "projects"),
      sinceMs: NOW - 7 * 24 * 60 * 60 * 1000,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.inputTokens).toBe(10);
  });

  it("appendBotSession + loadBotSessions roundtrip", async () => {
    const f = path.join(tmp, "sessions.jsonl");
    await appendBotSession(f, {
      sessionPath: "/tmp/a.jsonl",
      runId: "r1",
      startedAt: NOW,
    });
    await appendBotSession(f, {
      sessionPath: "/tmp/b.jsonl",
      runId: "r2",
      startedAt: NOW + 1000,
    });
    const out = await loadBotSessions(f);
    expect(out.length).toBe(2);
    expect(out[0]?.sessionPath).toBe("/tmp/a.jsonl");
  });

  it("appendBotSession with project field: roundtrip preserves it", async () => {
    const f = path.join(tmp, "sessions-proj.jsonl");
    await appendBotSession(f, {
      sessionPath: "/tmp/c2w.jsonl",
      runId: "r3",
      startedAt: NOW,
      project: "code2wiki",
    });
    const out = await loadBotSessions(f);
    expect(out.length).toBe(1);
    expect(out[0]?.project).toBe("code2wiki");
  });

  it("legacy session line without project field: loadBotSessions returns project='unknown'", async () => {
    const f = path.join(tmp, "sessions-legacy.jsonl");
    // Raw JSON without project field, simulating pre-attribution rows.
    await fs.writeFile(
      f,
      JSON.stringify({ sessionPath: "/tmp/legacy.jsonl", runId: "r-old", startedAt: NOW }) + "\n",
    );
    const out = await loadBotSessions(f);
    expect(out.length).toBe(1);
    expect(out[0]?.project).toBe("unknown");
  });
});

describe("DEFAULT_CAPS", () => {
  it("are present and finite", () => {
    expect(DEFAULT_CAPS.fiveHrInput).toBeGreaterThan(0);
    expect(DEFAULT_CAPS.sevenDInput).toBeGreaterThan(0);
    expect(DEFAULT_CAPS.warnRatio).toBeGreaterThan(0);
    expect(DEFAULT_CAPS.warnRatio).toBeLessThan(1);
  });

  it("MAX_20X_REFERENCE is 2x DEFAULT_CAPS per cap dimension", () => {
    expect(MAX_20X_REFERENCE.fiveHrInput).toBe(DEFAULT_CAPS.fiveHrInput * 2);
    expect(MAX_20X_REFERENCE.fiveHrOutput).toBe(DEFAULT_CAPS.fiveHrOutput * 2);
    expect(MAX_20X_REFERENCE.sevenDInput).toBe(DEFAULT_CAPS.sevenDInput * 2);
    expect(MAX_20X_REFERENCE.sevenDOutput).toBe(DEFAULT_CAPS.sevenDOutput * 2);
  });
});

describe("resolveCaps", () => {
  const cfgCaps: BudgetCaps = {
    fiveHrInput: 1,
    fiveHrOutput: 2,
    sevenDInput: 3,
    sevenDOutput: 4,
    warnRatio: 0.5,
  };
  const stateCaps: BudgetCaps = {
    fiveHrInput: 10,
    fiveHrOutput: 20,
    sevenDInput: 30,
    sevenDOutput: 40,
    warnRatio: 0.7,
  };

  it("state overrides both config and default", () => {
    const r = resolveCaps({ stateCaps, configCaps: cfgCaps, configHasCaps: true });
    expect(r.source).toBe("dashboard");
    expect(r.caps).toEqual(stateCaps);
  });

  it("config.json applies when state is missing AND config supplied caps", () => {
    const r = resolveCaps({ stateCaps: null, configCaps: cfgCaps, configHasCaps: true });
    expect(r.source).toBe("config.json");
    expect(r.caps).toEqual(cfgCaps);
  });

  it("default when neither state nor config supplied caps", () => {
    const r = resolveCaps({ stateCaps: null, configCaps: DEFAULT_CAPS, configHasCaps: false });
    expect(r.source).toBe("default");
    expect(r.caps).toEqual(DEFAULT_CAPS);
  });
});

// ---- decideProjectBudgets: per-project sub-cap gates ----------------------
// 5 cases pin: (1) graceful fallback when perProject is absent;
// (2) configured project with zero usage gets an "ok" row at 0%;
// (3) sub-cap stop when project usage exceeds share*global;
// (4) sub-cap wait when within warnRatio band;
// (5) overlapping 0.6 + 0.6 shares are INDEPENDENT — one project at
//     cap does NOT block the other.

describe("decideProjectBudgets", () => {
  const projectCaps: BudgetCaps = {
    fiveHrInput: 10_000,
    fiveHrOutput: 2_000,
    sevenDInput: 70_000,
    sevenDOutput: 14_000,
    warnRatio: 0.9,
    perProject: {
      "code2wiki": { share: 0.6 },
      "ocean-bot": { share: 0.6 },
    },
  };

  it("returns an empty map when caps.perProject is undefined (graceful fallback)", () => {
    // The grandfather-clause test: configs without perProject behave
    // identically to today's single-pool logic. The picker's
    // excludeProjects derived from this empty map is also empty, so
    // pickNext sees every adapter.
    const out = decideProjectBudgets({
      rowsByProject: new Map([
        ["code2wiki", [row({ inputTokens: 5_000 })]], // would be over 50% of a hypothetical 50% share
      ]),
      caps: { ...projectCaps, perProject: undefined },
      now: NOW,
    });
    expect(out.size).toBe(0);
  });

  it("configured project with no rows gets an 'ok' gate at 0% utilization", () => {
    // Important for the dashboard: even projects with no recent
    // activity must appear in the per-project bars so the operator can
    // see their sub-caps. A regression that skipped zero-row projects
    // would silently hide configured projects from the dashboard.
    const out = decideProjectBudgets({
      rowsByProject: new Map(),
      caps: projectCaps,
      now: NOW,
    });
    expect(out.size).toBe(2);
    const c2w = out.get("code2wiki")!;
    expect(c2w.gate).toBe("ok");
    expect(c2w.worstRatio).toBe(0);
    expect(c2w.subCaps.fiveHrInput).toBe(6_000); // 0.6 * 10_000
    expect(c2w.fiveHr.inputTokens).toBe(0);
  });

  it("returns gate='stop' when a project's usage exceeds its sub-cap share*global", () => {
    // share=0.6 against fiveHrInput=10_000 → sub-cap 6_000.
    // 6_500 tokens > 6_000 → ratio 1.083 → stop.
    const rows = [
      row({ inputTokens: 6_500, sessionPath: "/tmp/c2w-a.jsonl" }),
    ];
    const out = decideProjectBudgets({
      rowsByProject: new Map([["code2wiki", rows]]),
      caps: projectCaps,
      now: NOW,
    });
    const c2w = out.get("code2wiki")!;
    expect(c2w.gate).toBe("stop");
    expect(c2w.worstRatio).toBeGreaterThanOrEqual(1.0);
    expect(c2w.reason).toContain("code2wiki");
  });

  it("returns gate='wait' when usage is within the warn band of the sub-cap", () => {
    // share=0.6 against fiveHrInput=10_000 → sub-cap 6_000.
    // warnRatio=0.9 → wait band starts at 5_400. Use 5_500 → ratio
    // 0.917 → wait (above warnRatio, below 1.0).
    const rows = [
      row({ inputTokens: 5_500, sessionPath: "/tmp/c2w-a.jsonl" }),
    ];
    const out = decideProjectBudgets({
      rowsByProject: new Map([["code2wiki", rows]]),
      caps: projectCaps,
      now: NOW,
    });
    const c2w = out.get("code2wiki")!;
    expect(c2w.gate).toBe("wait");
    expect(c2w.worstRatio).toBeGreaterThanOrEqual(0.9);
    expect(c2w.worstRatio).toBeLessThan(1.0);
  });

  it("overlapping 0.6 + 0.6 shares are independent: one project at cap does not block the other", () => {
    // Load-bearing test for the design intent: shares are not a
    // mutually exclusive partition. code2wiki at its sub-cap (stop)
    // and ocean-bot at zero usage (ok) must both appear with their
    // OWN gates, and the picker (via excludeProjects = stop-projects)
    // gates out only code2wiki while ocean-bot continues.
    const out = decideProjectBudgets({
      rowsByProject: new Map([
        ["code2wiki", [row({ inputTokens: 6_500, sessionPath: "/tmp/c2w.jsonl" })]],
        // ocean-bot has no rows
      ]),
      caps: projectCaps,
      now: NOW,
    });
    expect(out.size).toBe(2);
    expect(out.get("code2wiki")?.gate).toBe("stop");
    expect(out.get("ocean-bot")?.gate).toBe("ok");
    expect(out.get("ocean-bot")?.worstRatio).toBe(0);
  });
});
