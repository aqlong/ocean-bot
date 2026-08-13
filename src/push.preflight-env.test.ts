import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ProjectAdapter } from "./adapters/types.js";
import { runPreflight } from "./push.js";

// End-to-end regression test for the preflight subprocess env scrub.
//
// runPreflight runs the project's own preflight commands (`npm test`,
// `npm run typecheck`) through `bash -lc`. Those commands are arbitrary
// project-controlled shell, and before the fix they inherited the bot's
// full environment: the bot's Postgres URL, Stripe keys, the GitHub App
// private key. runShell now builds the child env through
// buildSafeChildEnv, so secrets are dropped before the subprocess starts.
//
// safe-env.test.ts covers buildSafeChildEnv as a pure function. It does not
// cover the WIRING, which is the part that was actually broken and the part
// a refactor can silently undo: deleting the `env:` option from the spawn
// call passes every unit test in this repo while restoring the leak. These
// tests spawn a real subprocess and read what it actually received.
//
// Deliberately no mocking of child_process. A mock would assert what we
// passed to spawn, which is a restatement of the implementation rather than
// evidence about the process that runs.

// Distinctive values so a match in the output cannot be a coincidence.
const CANARY = {
  OCEAN_BOT_DATABASE_URL: "postgres://canary:dbsecret111@localhost:5432/x",
  STRIPE_SECRET_KEY: "canary-stripe-222",
  GITHUB_APP_PRIVATE_KEY: "canary-private-key-333",
  SOME_SERVICE_TOKEN: "canary-token-444",
  ADMIN_PASSWORD: "canary-password-555",
  ANTHROPIC_API_KEY: "canary-anthropic-666",
} as const;

function mkAdapter(commands: string[]): ProjectAdapter {
  return {
    name: "stub",
    rootDir: process.cwd(),
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
    preflightCommands: () => commands,
    visualSurfaces: async () => [],
  };
}

/**
 * Ask the subprocess to report only the canary variables, then return what
 * it printed. Preflight retains output only for FAILING commands (tailLog
 * on the failure record), hence the explicit `exit 1`.
 *
 * This echoes six named keys rather than dumping `env`, because tailLog is
 * `combined.slice(-2000)`. A full env dump fits in 2000 characters on a
 * developer laptop and does not on a CI runner, which injects roughly sixty
 * additional variables: the alphabetically early keys scroll out of the
 * tail and the test fails for a reason unrelated to scrubbing. Found by CI
 * on the first run of this file. Echoing named keys is also a stronger
 * assertion, since `<unset>` positively distinguishes "dropped" from
 * "present but truncated away".
 */
async function envSeenByPreflight(): Promise<string> {
  const probe =
    Object.keys(CANARY)
      .map((k) => `echo "${k}=\${${k}:-<unset>}"`)
      .join("; ") + "; exit 1";
  const result = await runPreflight(mkAdapter([probe]));
  expect(result.ok).toBe(false);
  expect(result.failures).toHaveLength(1);
  const log = result.failures[0]?.tailLog ?? "";
  // Guards the probe: if the command itself failed to run, every
  // "not.toContain" assertion below would pass vacuously.
  expect(log).toMatch(/ANTHROPIC_API_KEY=/);
  return log;
}

describe("preflight subprocess env scrubbing", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [k, v] of Object.entries(CANARY)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const k of Object.keys(CANARY)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("does not leak explicitly denylisted secrets into the subprocess", async () => {
    const env = await envSeenByPreflight();
    expect(env).toContain("OCEAN_BOT_DATABASE_URL=<unset>");
    expect(env).toContain("STRIPE_SECRET_KEY=<unset>");
    // The value, not just the key: a partial scrub that kept the value
    // under a different name would still be a leak.
    expect(env).not.toContain("dbsecret111");
    expect(env).not.toContain("canary-stripe-222");
  });

  it("does not leak pattern-matched secrets (_TOKEN / _PASSWORD / _PRIVATE_KEY)", async () => {
    const env = await envSeenByPreflight();
    expect(env).toContain("GITHUB_APP_PRIVATE_KEY=<unset>");
    expect(env).toContain("SOME_SERVICE_TOKEN=<unset>");
    expect(env).toContain("ADMIN_PASSWORD=<unset>");
    expect(env).not.toContain("canary-private-key-333");
    expect(env).not.toContain("canary-token-444");
    expect(env).not.toContain("canary-password-555");
  });

  it("still passes through the allowlisted Anthropic key", async () => {
    // Preflight commands can invoke project code that legitimately needs
    // this. If the scrub over-reached, preflight would fail for reasons
    // that look like flaky tests rather than a config change.
    const env = await envSeenByPreflight();
    expect(env).toContain(`ANTHROPIC_API_KEY=${CANARY.ANTHROPIC_API_KEY}`);
  });

  it("keeps enough of the environment for commands to actually run", async () => {
    // A scrub that dropped PATH would make every preflight command fail
    // with "command not found", which reads as a red tree rather than as
    // a misconfiguration.
    const result = await runPreflight(mkAdapter(["node --version"]));
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("reports a failing command with its exit code and output", async () => {
    const result = await runPreflight(
      mkAdapter(["echo boom-marker >&2; exit 3"]),
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.command).toBe("echo boom-marker >&2; exit 3");
    expect(result.failures[0]?.exitCode).toBe(3);
    expect(result.failures[0]?.tailLog).toContain("boom-marker");
  });

  it("runs every command and collects all failures", async () => {
    const result = await runPreflight(
      mkAdapter(["exit 0", "exit 1", "exit 2"]),
    );
    // An early return on first failure would hide the second one from the
    // operator, who then fixes one thing and waits another tick to see the
    // next.
    expect(result.failures.map((f) => f.exitCode)).toEqual([1, 2]);
  });

  it("is ok when there are no preflight commands", async () => {
    const result = await runPreflight(mkAdapter([]));
    expect(result.ok).toBe(true);
  });
});
