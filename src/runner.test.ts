import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireLock,
  releaseLock,
  isInteractiveClaudeRunning,
  sessionPathFromSessionId,
  extractSessionAttribution,
  classifyNoopRun,
  buildSpawnArgs,
  shouldKillForToolUseCap,
  shouldKillForOutputTokenCap,
  extractOutputTokensDelta,
  DEFAULT_MAX_TOOL_USES,
  pickResumeSessionId,
  RESUME_TTL_MS,
  runTask,
} from "./runner.js";
import { git, isClean } from "./util/git.js";

describe("buildSpawnArgs", () => {
  const base = {
    runId: "r1",
    prompt: "do the thing",
    cwd: "/x",
    sessionsLogPath: "/x/sessions.jsonl",
  };

  it("no model, no cap → bare args", () => {
    expect(buildSpawnArgs(base)).toEqual([
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  // 2026-05-16: --max-tokens was reverted from buildSpawnArgs because
  // the claude CLI has no such flag (--help confirms; passing it makes
  // claude exit 1 immediately). The field stays on the inputs type so
  // future code can enforce caps via a different mechanism (post-hoc
  // budget tracking or --max-budget-usd as a proxy). These tests pin
  // the revert: outputTokenCap MUST NOT produce a --max-tokens arg.
  it("does NOT pass --max-tokens for any tier (claude has no such flag)", () => {
    expect(buildSpawnArgs({ ...base, model: "haiku", outputTokenCap: 8000 }))
      .not.toContain("--max-tokens");
    expect(buildSpawnArgs({ ...base, model: "sonnet", outputTokenCap: 16000 }))
      .not.toContain("--max-tokens");
    expect(buildSpawnArgs({ ...base, model: "opus", outputTokenCap: 32000 }))
      .not.toContain("--max-tokens");
  });

  it("--model still passes through normally", () => {
    expect(buildSpawnArgs({ ...base, model: "haiku" })[
      buildSpawnArgs({ ...base, model: "haiku" }).indexOf("--model") + 1
    ]).toBe("haiku");
    expect(buildSpawnArgs({ ...base, model: "sonnet" })[
      buildSpawnArgs({ ...base, model: "sonnet" }).indexOf("--model") + 1
    ]).toBe("sonnet");
    expect(buildSpawnArgs({ ...base, model: "opus" })[
      buildSpawnArgs({ ...base, model: "opus" }).indexOf("--model") + 1
    ]).toBe("opus");
  });

  // Chunk 5/5 of ai-usage-opt: resumeSessionId, when provided by the
  // tick, surfaces as `--resume <id>` so claude reuses the prior
  // transcript and prompt cache.
  it("does NOT pass --resume when resumeSessionId is omitted (fresh session)", () => {
    expect(buildSpawnArgs(base)).not.toContain("--resume");
  });

  it("emits --resume <id> when resumeSessionId is set", () => {
    const args = buildSpawnArgs({ ...base, resumeSessionId: "uuid-abc" });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("uuid-abc");
    // Resume flag must precede -p so claude's option parser sees it
    // before the prompt argv is consumed.
    expect(args.indexOf("--resume")).toBeLessThan(args.indexOf("-p"));
  });

  it("composes --resume alongside --model + prompt without losing either", () => {
    const args = buildSpawnArgs({
      ...base,
      model: "opus",
      resumeSessionId: "uuid-xyz",
    });
    expect(args).toEqual([
      "--resume",
      "uuid-xyz",
      "-p",
      "do the thing",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "opus",
    ]);
  });
});

describe("pickResumeSessionId (per-project resume gate, chunk 5/5 ai-usage-opt)", () => {
  const NOW = 1_700_000_000_000;

  it("returns undefined when no record exists", () => {
    expect(pickResumeSessionId(null, NOW)).toBeUndefined();
  });

  it("returns the session id when the record is fresh", () => {
    expect(
      pickResumeSessionId(
        { sessionId: "sess-1", observedAt: NOW - 1000 },
        NOW,
      ),
    ).toBe("sess-1");
  });

  it("returns undefined when the record is older than the TTL", () => {
    expect(
      pickResumeSessionId(
        { sessionId: "sess-1", observedAt: NOW - RESUME_TTL_MS - 1 },
        NOW,
      ),
    ).toBeUndefined();
  });

  it("treats observedAt exactly at TTL boundary as still resumable", () => {
    expect(
      pickResumeSessionId(
        { sessionId: "sess-1", observedAt: NOW - RESUME_TTL_MS },
        NOW,
      ),
    ).toBe("sess-1");
  });

  it("rejects empty session id (defensive against bad state writes)", () => {
    expect(
      pickResumeSessionId({ sessionId: "", observedAt: NOW }, NOW),
    ).toBeUndefined();
  });

  it("honors a caller-supplied ttlMs override", () => {
    expect(
      pickResumeSessionId(
        { sessionId: "sess-1", observedAt: NOW - 5_000 },
        NOW,
        1_000,
      ),
    ).toBeUndefined();
  });
});

describe("shouldKillForToolUseCap (tool-use cap, chunk 2/5 ai-usage-opt)", () => {
  it("default cap is 200 tool_use events per run", () => {
    expect(DEFAULT_MAX_TOOL_USES).toBe(200);
  });

  it("does not fire at or below the cap (off-by-one guard)", () => {
    expect(shouldKillForToolUseCap(0, 200)).toBe(false);
    expect(shouldKillForToolUseCap(199, 200)).toBe(false);
    expect(shouldKillForToolUseCap(200, 200)).toBe(false);
  });

  it("fires exactly once on the 201st event vs the default cap", () => {
    // Synthesize 201 sequential tool_use events. The cap fires on the
    // 201st increment, mirroring the streaming-loop's check after each
    // onEvent call.
    let toolUses = 0;
    const firedAt: number[] = [];
    let killed = false;
    for (let i = 0; i < 201; i++) {
      toolUses++;
      if (!killed && shouldKillForToolUseCap(toolUses, DEFAULT_MAX_TOOL_USES)) {
        killed = true;
        firedAt.push(toolUses);
      }
    }
    expect(killed).toBe(true);
    expect(firedAt).toEqual([201]);
  });

  it("honors per-task override (e.g. 5 for a debug task)", () => {
    expect(shouldKillForToolUseCap(5, 5)).toBe(false);
    expect(shouldKillForToolUseCap(6, 5)).toBe(true);
  });
});

describe("shouldKillForOutputTokenCap (output-token cap, Approach A post-hoc SIGTERM)", () => {
  it("returns false when cap is undefined (callers may legitimately omit it)", () => {
    expect(shouldKillForOutputTokenCap(0, undefined)).toBe(false);
    expect(shouldKillForOutputTokenCap(1_000_000, undefined)).toBe(false);
  });

  it("returns false when cap is 0 or negative (no enforcement)", () => {
    expect(shouldKillForOutputTokenCap(50, 0)).toBe(false);
    expect(shouldKillForOutputTokenCap(50, -1)).toBe(false);
  });

  it("does not fire at or below the cap (off-by-one guard)", () => {
    expect(shouldKillForOutputTokenCap(0, 100)).toBe(false);
    expect(shouldKillForOutputTokenCap(99, 100)).toBe(false);
    expect(shouldKillForOutputTokenCap(100, 100)).toBe(false);
  });

  it("fires the first time the running total strictly exceeds the cap", () => {
    expect(shouldKillForOutputTokenCap(101, 100)).toBe(true);
    expect(shouldKillForOutputTokenCap(8001, 8000)).toBe(true);
  });
});

describe("extractOutputTokensDelta (per-event stream-json parser)", () => {
  // Field shape captured 2026-05-16 from `claude -p --output-format stream-json
  // --verbose`: assistant.message.usage.output_tokens carries the per-turn
  // delta. budget.ts:parseLine confirms the same shape on the on-disk
  // transcript and sumRows accumulates them, i.e. semantics are delta + sum.

  it("pulls output_tokens from a real-shaped assistant event", () => {
    const evt = {
      type: "assistant",
      message: {
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 29046,
          cache_read_input_tokens: 0,
          output_tokens: 42,
          service_tier: "standard",
        },
      },
    };
    expect(extractOutputTokensDelta(evt)).toBe(42);
  });

  it("returns null for non-assistant event types", () => {
    expect(extractOutputTokensDelta({ type: "system" })).toBeNull();
    expect(extractOutputTokensDelta({ type: "tool_use" })).toBeNull();
    // The `result` event carries cumulative usage at evt.usage.output_tokens,
    // intentionally NOT accumulated here, the result event fires after the
    // run has already finished (too late for post-hoc SIGTERM enforcement).
    expect(
      extractOutputTokensDelta({
        type: "result",
        usage: { output_tokens: 999 },
      }),
    ).toBeNull();
  });

  it("returns null when the assistant event has no usage block", () => {
    expect(
      extractOutputTokensDelta({
        type: "assistant",
        message: { role: "assistant" },
      }),
    ).toBeNull();
    expect(extractOutputTokensDelta({ type: "assistant" })).toBeNull();
  });

  it("returns null when output_tokens is missing or non-finite", () => {
    expect(
      extractOutputTokensDelta({
        type: "assistant",
        message: { usage: {} },
      }),
    ).toBeNull();
    expect(
      extractOutputTokensDelta({
        type: "assistant",
        message: { usage: { output_tokens: "nope" } },
      }),
    ).toBeNull();
    expect(
      extractOutputTokensDelta({
        type: "assistant",
        message: { usage: { output_tokens: Number.NaN } },
      }),
    ).toBeNull();
  });
});

describe("runTask, output-token cap end-to-end (Approach A post-hoc SIGTERM)", () => {
  // Mocks the claude CLI via claudeBinPath. The fake script traps SIGTERM
  // and exits 143 (`128 + 15`), the standard convention. The runner's
  // stream-loop should accumulate output_tokens across two assistant
  // events (50 + 60 = 110), exceed the cap of 100, and SIGTERM the proc
  // before it reaches its long-sleep tail.
  let tmp: string;
  let binPath: string;
  let sessionsLogPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-token-cap-"));
    binPath = path.join(tmp, "claude");
    sessionsLogPath = path.join(tmp, "sessions.jsonl");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeFakeClaude(script: string): Promise<void> {
    await fs.writeFile(binPath, script);
    await fs.chmod(binPath, 0o755);
  }

  it("SIGTERMs and surfaces tokenCapHit when accumulated output > cap (the boundary)", async () => {
    // Two assistant deltas (50, 60) total 110. Cap is 100, so the second
    // event crosses the threshold and the loop kills. The fake binary is
    // Python because bash's `wait` does NOT interrupt on a non-SIGCHLD
    // signal even with a trap installed (verified empirically: SIGTERM
    // arrived during `wait`, trap stayed queued until the background
    // sleep finished naturally 10s later). Python's signal handler
    // interrupts time.sleep immediately, so SIGTERM → handler → sys.exit
    // takes single-digit ms.
    await writeFakeClaude(
      [
        "#!/usr/bin/env python3",
        "import signal, sys, time, json",
        "def handler(signum, frame):",
        "    sys.exit(143)",
        "signal.signal(signal.SIGTERM, handler)",
        `print(json.dumps({"type":"assistant","message":{"usage":{"output_tokens":50}}}), flush=True)`,
        "time.sleep(0.1)",
        `print(json.dumps({"type":"assistant","message":{"usage":{"output_tokens":60}}}), flush=True)`,
        // Long sleep, the runner must SIGTERM us before it elapses.
        "time.sleep(10)",
        `print("NEVER")`,
      ].join("\n"),
    );

    const result = await runTask({
      runId: "r-token-cap-boundary",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      outputTokenCap: 100,
      timeoutMs: 30_000,
      claudeBinPath: binPath,
    });

    // (a) SIGTERM fires at the cap boundary, flag set + tokens accumulated.
    expect(result.tokenCapHit).toBe(true);
    expect(result.outputTokens).toBe(110);
    // (b) Exit reflects token-cap-overage, not a timeout. Timeout uses
    // exitCode 124 (set in the close handler when timedOut is true); a
    // token-cap SIGTERM trap exits 143 and the close handler passes that
    // through unchanged.
    expect(result.exitCode).not.toBe(124);
    expect(result.exitCode).toBe(143);
    // Sanity: cap was hit fast, well under the timeout walltime.
    expect(result.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it("does NOT fire tokenCapHit when total output stays under the cap", async () => {
    // Two deltas of 10 each (total 20) under a cap of 100. The script
    // exits cleanly on its own; no SIGTERM should be sent. Trailing
    // sleep gives the runner's async data handler time to finish parsing
    // both events before the pipe closes (otherwise `close` resolves the
    // promise while line #2 is still mid-await on appendEvent).
    await writeFakeClaude(
      [
        "#!/bin/bash",
        "trap 'echo TRAPPED >&2; exit 143' TERM",
        `echo '{"type":"assistant","message":{"usage":{"output_tokens":10}}}'`,
        "sleep 0.05",
        `echo '{"type":"assistant","message":{"usage":{"output_tokens":10}}}'`,
        "sleep 0.2",
        "exit 0",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "r-token-cap-under",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      outputTokenCap: 100,
      timeoutMs: 30_000,
      claudeBinPath: binPath,
    });

    expect(result.tokenCapHit).toBe(false);
    expect(result.outputTokens).toBe(20);
    expect(result.exitCode).toBe(0);
  }, 20_000);
});

describe("acquireLock / releaseLock", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-lock-"));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("acquires a fresh lock", async () => {
    expect(await acquireLock(tmp)).toBe(true);
  });

  it("refuses to acquire a fresh (non-stale) held lock", async () => {
    expect(await acquireLock(tmp)).toBe(true);
    expect(await acquireLock(tmp)).toBe(false);
  });

  it("releases the lock so it can be re-acquired", async () => {
    expect(await acquireLock(tmp)).toBe(true);
    await releaseLock(tmp);
    expect(await acquireLock(tmp)).toBe(true);
  });

  it("takes over a stale lock (>5 min old)", async () => {
    expect(await acquireLock(tmp)).toBe(true);
    // Backdate the lock's mtime by 6 minutes to simulate a stale lock
    // left behind by a crashed prior process. 6 brackets the 5-minute
    // threshold tightly enough that any regression widening LOCK_STALE_MS
    // back toward 10 minutes fails this assertion immediately.
    const lockPath = path.join(tmp, "tick.lock");
    const old = new Date(Date.now() - 6 * 60 * 1000);
    await fs.utimes(lockPath, old, old);
    expect(await acquireLock(tmp)).toBe(true);
  });

  it("refuses to take over a not-yet-stale lock (<5 min old)", async () => {
    // Pins the lower side of LOCK_STALE_MS: a lock backdated to just
    // under the 5-minute threshold must still be honored, so a slow but
    // legitimate tick does not get barged in on by the next wake-up.
    expect(await acquireLock(tmp)).toBe(true);
    const lockPath = path.join(tmp, "tick.lock");
    const fresh = new Date(Date.now() - 4 * 60 * 1000);
    await fs.utimes(lockPath, fresh, fresh);
    expect(await acquireLock(tmp)).toBe(false);
  });

  it("releaseLock when no lock exists is a no-op", async () => {
    await expect(releaseLock(tmp)).resolves.toBeUndefined();
  });
});

describe("isInteractiveClaudeRunning", () => {
  it("returns a boolean (smoke, real ps call, no mock needed)", async () => {
    const result = await isInteractiveClaudeRunning();
    expect(typeof result).toBe("boolean");
  });

  it("tags own processes with OCEAN_BOT_RUN_ID so they are excluded", async () => {
    // With our run id in env, the function must not count our own spawn
    // as an interactive session. We can't inject a fake ps line easily,
    // but we can verify the contract: with a non-empty RUN_ID env var
    // the function still returns a boolean (no throw, no hang).
    const orig = process.env["OCEAN_BOT_RUN_ID"];
    process.env["OCEAN_BOT_RUN_ID"] = "test-run-id-abc123";
    try {
      const result = await isInteractiveClaudeRunning();
      expect(typeof result).toBe("boolean");
    } finally {
      if (orig === undefined) delete process.env["OCEAN_BOT_RUN_ID"];
      else process.env["OCEAN_BOT_RUN_ID"] = orig;
    }
  });
});

describe("sessionPathFromSessionId", () => {
  it("reconstructs the canonical Claude Code transcript path", () => {
    const got = sessionPathFromSessionId(
      "/Users/aqlong/code2wiki",
      "abc-123",
    );
    // ~/.claude/projects/-Users-aqlong-code2wiki/abc-123.jsonl
    expect(got).toBe(
      path.join(
        os.homedir(),
        ".claude",
        "projects",
        "-Users-aqlong-code2wiki",
        "abc-123.jsonl",
      ),
    );
  });

  it("collapses dots in the cwd to dashes (e.g. monorepo subpaths with .)", () => {
    const got = sessionPathFromSessionId(
      "/Users/aqlong/code2wiki/.claude/worktrees/foo",
      "sess-1",
    );
    expect(got).toContain(
      "-Users-aqlong-code2wiki--claude-worktrees-foo",
    );
  });

  it("regression: bug shipped 2026-05-12, sessions.jsonl stayed empty because the legacy code expected session_file/transcript_path fields that Claude no longer emits. Helper produces a deterministic path from cwd + sessionId so attribution works without those fields.", () => {
    const got = sessionPathFromSessionId(
      "/Users/aqlong/code2wiki",
      "test-session",
    );
    expect(got).toMatch(/\.claude\/projects\/[^/]+\/test-session\.jsonl$/);
  });
});

describe("extractSessionAttribution", () => {
  it("reads session_id (snake_case) + cwd from a real system/init event", () => {
    // Captured from `claude -p --output-format stream-json --verbose` on
    // 2026-05-14 (Claude Code 2.1.126). The field the previous code
    // missed: `session_id` (snake_case). Without this, the budget
    // broker sees zero bot-attributed tokens.
    const evt = {
      type: "system",
      subtype: "init",
      cwd: "/private/tmp",
      session_id: "e5ee601e-ac82-4b55-bcee-e59bfd1841e2",
      tools: [],
      model: "claude-opus-4-7",
    };
    const got = extractSessionAttribution(evt, "/this-should-be-ignored");
    expect(got).toBe(
      path.join(
        os.homedir(),
        ".claude",
        "projects",
        "-private-tmp",
        "e5ee601e-ac82-4b55-bcee-e59bfd1841e2.jsonl",
      ),
    );
  });

  it("falls back to camelCase sessionId on init (forward-compat)", () => {
    const evt = {
      type: "system",
      subtype: "init",
      cwd: "/Users/aqlong/code2wiki",
      sessionId: "abc-123",
    };
    const got = extractSessionAttribution(evt, "/unused");
    expect(got).toContain("-Users-aqlong-code2wiki");
    expect(got).toContain("abc-123.jsonl");
  });

  it("falls back to the runner's cwd when init omits cwd", () => {
    const evt = {
      type: "system",
      subtype: "init",
      session_id: "no-cwd-in-event",
    };
    const got = extractSessionAttribution(evt, "/Users/aqlong/code2wiki");
    expect(got).toContain("-Users-aqlong-code2wiki");
    expect(got).toContain("no-cwd-in-event.jsonl");
  });

  it("prefers explicit session_file when present (legacy shape)", () => {
    const evt = {
      type: "system",
      subtype: "init",
      session_file: "/some/exact/path.jsonl",
      session_id: "would-be-reconstructed",
    };
    expect(extractSessionAttribution(evt, "/Users/x")).toBe(
      "/some/exact/path.jsonl",
    );
  });

  it("accepts queue-operation/enqueue as a fallback (transcript-file shape)", () => {
    const evt = {
      type: "queue-operation",
      operation: "enqueue",
      sessionId: "queue-id-1",
    };
    const got = extractSessionAttribution(evt, "/Users/aqlong/code2wiki");
    expect(got).toContain("-Users-aqlong-code2wiki");
    expect(got).toContain("queue-id-1.jsonl");
  });

  it("returns null for non-attribution events (assistant, hook_started, result)", () => {
    expect(extractSessionAttribution({ type: "assistant" }, "/x")).toBeNull();
    expect(
      extractSessionAttribution(
        { type: "system", subtype: "hook_started", session_id: "s" },
        "/x",
      ),
    ).toBeNull();
    expect(extractSessionAttribution({ type: "result" }, "/x")).toBeNull();
  });

  it("returns null when init carries no usable id (defensive)", () => {
    expect(
      extractSessionAttribution(
        { type: "system", subtype: "init", cwd: "/x" },
        "/x",
      ),
    ).toBeNull();
  });
});

describe("classifyNoopRun", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-noop-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test"]);
    await git(repo, ["config", "user.name", "test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "hello");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("clean tree → kind:'clean' (existing noop behavior preserved)", async () => {
    const out = await classifyNoopRun(repo, "01H_RUN_CLEAN");
    expect(out).toEqual({ kind: "clean" });
  });

  it("dirty tree → stashes to orphan ref, marks failed-shaped outcome", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "claude edited but did not commit");
    const out = await classifyNoopRun(repo, "01H_RUN_DIRTY");
    expect(out.kind).toBe("dirty");
    if (out.kind !== "dirty") return; // narrow for ts
    expect(out.ref).toBe("refs/ocean-bot/orphan-edits/01H_RUN_DIRTY");
    expect(out.stashed).toBe(true);
    expect(out.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.changedFiles).toBe(1);
    expect(out.blocker).toContain("uncommitted");
    expect(out.blocker).toContain(out.ref);
    // Tree is clean afterwards so the next tick isn't blocked.
    expect(await isClean(repo)).toBe(true);
    // Operator can still recover the edit from the orphan ref.
    const show = await git(repo, ["show", `${out.ref}:a.txt`]);
    expect(show.stdout).toBe("claude edited but did not commit");
  });
});

// ---------------------------------------------------------------------------
// rate_limit_event stream detection + stderr 429/credits-exhausted detection
// ---------------------------------------------------------------------------

describe("runTask, rate-limit detection via stream-json event", () => {
  let tmp: string;
  let binPath: string;
  let sessionsLogPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-rl-"));
    binPath = path.join(tmp, "claude");
    sessionsLogPath = path.join(tmp, "sessions.jsonl");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeFakeClaude(script: string): Promise<void> {
    await fs.writeFile(binPath, script);
    await fs.chmod(binPath, 0o755);
  }

  it("sets rateLimitHit=true and rateLimitReason='429' when rate_limit_event fires on stdout", async () => {
    // Emits a rate_limit_event then exits non-zero (typical: claude gives up).
    // The runner must surface rateLimitHit even though no SIGTERM was sent.
    await writeFakeClaude(
      [
        "#!/usr/bin/env python3",
        "import json, sys",
        `print(json.dumps({"type":"rate_limit_event","message":"Too many requests"}), flush=True)`,
        "sys.exit(1)",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "rl-event-test",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      timeoutMs: 10_000,
      claudeBinPath: binPath,
    });

    expect(result.rateLimitHit).toBe(true);
    expect(result.rateLimitReason).toBe("429");
    expect(result.exitCode).toBe(1);
  }, 15_000);

  it("does NOT set rateLimitHit when run exits cleanly with no rate-limit events", async () => {
    await writeFakeClaude(
      [
        "#!/bin/bash",
        `echo '{"type":"result","subtype":"success"}'`,
        "exit 0",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "rl-clean-test",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      timeoutMs: 10_000,
      claudeBinPath: binPath,
    });

    expect(result.rateLimitHit).toBe(false);
    expect(result.rateLimitReason).toBeUndefined();
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe("runTask, rate-limit detection via stderr patterns", () => {
  let tmp: string;
  let binPath: string;
  let sessionsLogPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ob-rl-stderr-"));
    binPath = path.join(tmp, "claude");
    sessionsLogPath = path.join(tmp, "sessions.jsonl");
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function writeFakeClaude(script: string): Promise<void> {
    await fs.writeFile(binPath, script);
    await fs.chmod(binPath, 0o755);
  }

  it("sets rateLimitHit=true and reason='429' when stderr contains '429'", async () => {
    await writeFakeClaude(
      [
        "#!/bin/bash",
        "echo 'Error: 429 Too Many Requests' >&2",
        "exit 1",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "rl-stderr-429",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      timeoutMs: 10_000,
      claudeBinPath: binPath,
    });

    expect(result.rateLimitHit).toBe(true);
    expect(result.rateLimitReason).toBe("429");
  }, 15_000);

  it("sets rateLimitReason='credits-exhausted' when stderr matches credits pattern", async () => {
    await writeFakeClaude(
      [
        "#!/bin/bash",
        "echo 'Error: credits exhausted for this billing period' >&2",
        "exit 1",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "rl-stderr-credits",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      timeoutMs: 10_000,
      claudeBinPath: binPath,
    });

    expect(result.rateLimitHit).toBe(true);
    expect(result.rateLimitReason).toBe("credits-exhausted");
  }, 15_000);

  it("sets rateLimitReason='credits-exhausted' when stderr matches 'insufficient_quota'", async () => {
    await writeFakeClaude(
      [
        "#!/bin/bash",
        "echo 'Error: insufficient_quota' >&2",
        "exit 1",
      ].join("\n"),
    );

    const result = await runTask({
      runId: "rl-stderr-quota",
      prompt: "irrelevant",
      cwd: tmp,
      sessionsLogPath,
      timeoutMs: 10_000,
      claudeBinPath: binPath,
    });

    expect(result.rateLimitHit).toBe(true);
    expect(result.rateLimitReason).toBe("credits-exhausted");
  }, 15_000);
});
