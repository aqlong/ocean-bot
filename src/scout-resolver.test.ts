import { describe, it, expect, beforeEach } from "vitest";
import {
  buildResolverPrompt,
  clearResolverCache,
  fallbackOnFailure,
  hashResolverInput,
  parseResolverResponse,
  resolveScoutScope,
  type ResolverSpawn,
  type ScoutResolution,
} from "./scout-resolver.js";

beforeEach(() => clearResolverCache());

describe("parseResolverResponse", () => {
  it("parses a fenced JSON block with verdict=proceed", () => {
    const text = '```json\n{ "verdict": "proceed", "explanation": "technical scope" }\n```';
    const r = parseResolverResponse(text);
    expect(r).toEqual({ verdict: "proceed", explanation: "technical scope" });
  });

  it("parses a bare JSON object with verdict=skip", () => {
    const text = 'some prose\n{ "verdict": "skip", "explanation": "dep not ready" }\ntrailing';
    const r = parseResolverResponse(text);
    expect(r).toEqual({ verdict: "skip", explanation: "dep not ready" });
  });

  it("parses verdict=escalate", () => {
    const text = '{ "verdict": "escalate", "explanation": "pricing decision" }';
    const r = parseResolverResponse(text);
    expect(r?.verdict).toBe("escalate");
  });

  it("parses verdict=block (operator-action tasks)", () => {
    const text =
      '{ "verdict": "block", "explanation": "requires browser auth on external portal" }';
    const r = parseResolverResponse(text);
    expect(r?.verdict).toBe("block");
    expect(r?.explanation).toMatch(/browser auth/);
  });

  it("picks up clarifiedScope when present on a proceed verdict", () => {
    const text = JSON.stringify({
      verdict: "proceed",
      explanation: "narrowing scope",
      clarifiedScope: "CFML only; skip Java",
    });
    const r = parseResolverResponse(text);
    expect(r).toEqual({
      verdict: "proceed",
      explanation: "narrowing scope",
      clarifiedScope: "CFML only; skip Java",
    });
  });

  it("drops empty-string clarifiedScope (treated as unset)", () => {
    const text = JSON.stringify({
      verdict: "proceed",
      explanation: "no rewrite needed",
      clarifiedScope: "   ",
    });
    const r = parseResolverResponse(text);
    expect(r).toEqual({ verdict: "proceed", explanation: "no rewrite needed" });
  });

  it("rejects unknown verdict values", () => {
    const text = '{ "verdict": "maybe", "explanation": "hm" }';
    expect(parseResolverResponse(text)).toBeNull();
  });

  it("rejects missing explanation", () => {
    const text = '{ "verdict": "proceed" }';
    expect(parseResolverResponse(text)).toBeNull();
  });

  it("rejects empty-string explanation (would render as a blank dashboard cell)", () => {
    const text = '{ "verdict": "proceed", "explanation": "" }';
    expect(parseResolverResponse(text)).toBeNull();
  });

  it("rejects non-string explanation", () => {
    const text = '{ "verdict": "proceed", "explanation": 42 }';
    expect(parseResolverResponse(text)).toBeNull();
  });

  it("rejects non-JSON output", () => {
    expect(parseResolverResponse("totally not json")).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseResolverResponse("")).toBeNull();
  });

  it("prefers a fenced block over a stray brace later in the text", () => {
    const text = [
      "```json",
      '{ "verdict": "skip", "explanation": "from fence" }',
      "```",
      'and also { "verdict": "proceed", "explanation": "from stray" }',
    ].join("\n");
    const r = parseResolverResponse(text);
    expect(r?.verdict).toBe("skip");
  });

  it("strips whitespace from explanation + clarifiedScope", () => {
    const text = JSON.stringify({
      verdict: "proceed",
      explanation: "  trimmed  ",
      clarifiedScope: "   also trimmed   ",
    });
    expect(parseResolverResponse(text)).toEqual({
      verdict: "proceed",
      explanation: "trimmed",
      clarifiedScope: "also trimmed",
    });
  });
});

describe("buildResolverPrompt", () => {
  it("includes the description + numbered warnings", () => {
    const prompt = buildResolverPrompt("Implement X", [
      "first warning",
      "second warning",
    ]);
    expect(prompt).toContain("Implement X");
    expect(prompt).toContain("1. first warning");
    expect(prompt).toContain("2. second warning");
  });

  it("describes the proceed/skip/escalate/block rubric so the LLM can apply it", () => {
    const prompt = buildResolverPrompt("anything", ["any warning"]);
    expect(prompt).toContain("PROCEED");
    expect(prompt).toContain("SKIP");
    expect(prompt).toContain("ESCALATE");
    expect(prompt).toContain("BLOCK");
    // Pin the bias: escalate is the exception, proceed is the default.
    // (`s` flag because the phrase wraps onto two lines in the prompt.)
    expect(prompt).toMatch(/Default to PROCEED[\s\S]*when in doubt/);
  });

  it("documents the bot capabilities to anchor the BLOCK-vs-PROCEED boundary", () => {
    // The boundary between BLOCK (operator-action) and PROCEED (bot-
    // doable) hinges on what the bot can actually do. The prompt lists
    // bot capabilities explicitly so sonnet doesn't assume the bot
    // can't run gh / railway / openssl. Without this, sonnet has been
    // observed to escalate tasks the bot is fully equipped to handle
    // (the path-2 permission expansion ships made this concrete).
    const prompt = buildResolverPrompt("any", ["any"]);
    expect(prompt).toMatch(/gh CLI/);
    expect(prompt).toMatch(/railway CLI/);
    expect(prompt).toMatch(/CANNOT.*browser/);
  });

  it("instructs the model to omit tool use (sonnet would otherwise read files)", () => {
    const prompt = buildResolverPrompt("any", ["any"]);
    expect(prompt).toMatch(/Do NOT.*tools/i);
  });

  it("enumerates the shell capabilities the bot has so 'Operator:' tasks aren't auto-escalated", () => {
    const prompt = buildResolverPrompt("any", ["any"]);
    // Each capability the bot can use autonomously must be named, so the
    // resolver can tell "operator must paste this secret" from "operator
    // must use the Stripe dashboard."
    expect(prompt).toContain("gh secret set");
    expect(prompt).toContain("gh variable set");
    expect(prompt).toContain("gh workflow run");
    expect(prompt).toContain("gh api");
    expect(prompt).toContain("railway variables --set");
    expect(prompt).toContain("openssl rand");
  });

  it("clarifies that the 'Operator:' prefix is historical and does not auto-route to escalate", () => {
    const prompt = buildResolverPrompt("any", ["any"]);
    // The phrase 'Operator:' must appear (so the model recognizes the
    // prefix) AND the prompt must say something like "historical" / "do
    // NOT auto-escalate" so the model doesn't fall back to the lazy
    // "title starts with Operator → escalate" heuristic.
    expect(prompt).toContain("'Operator:'");
    expect(prompt).toMatch(/historical/i);
    expect(prompt).toMatch(/do NOT auto-escalate/i);
  });

  it("warns that a task needing both shell-doable AND browser-only steps still escalates", () => {
    const prompt = buildResolverPrompt("any", ["any"]);
    // Pin the "browser blocks the whole task" rule so resolver doesn't
    // optimistically split a mixed task into "do the shell part now,
    // escalate the rest later."
    expect(prompt).toMatch(/BOTH[\s\S]*browser[\s\S]*escalate/i);
  });
});

describe("hashResolverInput", () => {
  it("is stable across calls for the same (description, warnings)", () => {
    const a = hashResolverInput("task", ["w1", "w2"]);
    const b = hashResolverInput("task", ["w1", "w2"]);
    expect(a).toBe(b);
  });

  it("changes when warnings change (order-sensitive: that's intentional)", () => {
    const a = hashResolverInput("task", ["w1", "w2"]);
    const b = hashResolverInput("task", ["w2", "w1"]);
    expect(a).not.toBe(b);
  });

  it("changes when description changes", () => {
    const a = hashResolverInput("task-a", ["w"]);
    const b = hashResolverInput("task-b", ["w"]);
    expect(a).not.toBe(b);
  });
});

describe("resolveScoutScope", () => {
  function mkSpawn(stdout: string, opts: Partial<{ exitCode: number; timedOut: boolean }> = {}): ResolverSpawn {
    return async () => ({
      stdout,
      exitCode: opts.exitCode ?? 0,
      timedOut: opts.timedOut ?? false,
    });
  }

  it("returns a proceed verdict from clean JSON output", async () => {
    const r = await resolveScoutScope({
      description: "Implement constant-return filter for CFML",
      scopeWarnings: ["Java parser file mentioned; verify it's in scope"],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "proceed",
          explanation: "scope is CFML-only per description",
          clarifiedScope: "CFML constant-return only; Java is out of scope.",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("proceed");
    expect(r.result?.clarifiedScope).toBeDefined();
    expect(r.failure).toBeNull();
  });

  it("returns a skip verdict when the resolver judges dep-not-ready", async () => {
    const r = await resolveScoutScope({
      description: "Wire feature X into dashboard",
      scopeWarnings: ["depends on feature Y not yet merged"],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "skip",
          explanation: "blocked on feature Y",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("skip");
    expect(r.result?.explanation).toMatch(/blocked/i);
  });

  it("returns an escalate verdict on pricing-decision warnings", async () => {
    const r = await resolveScoutScope({
      description: "Decide new founder-tier price",
      scopeWarnings: ["pricing decision requires operator input"],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "escalate",
          explanation: "pricing is an executive decision",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("escalate");
  });

  it("returns a block verdict for operator-action tasks (browser-auth required)", async () => {
    // The class of warning that motivated the block-vs-escalate split:
    // task requires a browser-based action the bot can't perform, so
    // escalating to /approvals would create cards with no
    // ship/skip/block decision the operator can meaningfully make.
    // The resolver should route these to BLOCK, which marks the
    // backlog item status='blocked' and skips the approvals queue.
    const r = await resolveScoutScope({
      description:
        "Operator: register Craft and Ship LLC as Atlassian Marketplace partner",
      scopeWarnings: [
        "Operator-only task: requires browser auth to Atlassian account",
        "Business/legal decision: operator must read and accept Marketplace Partner Agreement",
        "Not executable: CLAUDE.md explicitly lists browser auth flows as user-only work",
      ],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "block",
          explanation:
            "Requires browser auth on external Atlassian portal and Partner Agreement acceptance; both are operator-only browser actions the bot cannot perform.",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("block");
    expect(r.result?.explanation).toMatch(/browser/);
  });

  it("populates failure (not result) on resolver non-zero exit", async () => {
    const r = await resolveScoutScope({
      description: "task",
      scopeWarnings: ["w"],
      cwd: "/tmp",
      spawnFn: mkSpawn("", { exitCode: 1 }),
    });
    expect(r.result).toBeNull();
    expect(r.failure).toMatch(/exited 1/);
  });

  it("populates failure on resolver timeout", async () => {
    const r = await resolveScoutScope({
      description: "task",
      scopeWarnings: ["w"],
      cwd: "/tmp",
      spawnFn: mkSpawn("", { timedOut: true, exitCode: 124 }),
    });
    expect(r.result).toBeNull();
    expect(r.failure).toMatch(/timed out/);
  });

  it("populates failure when the model returns unparseable text", async () => {
    const r = await resolveScoutScope({
      description: "task",
      scopeWarnings: ["w"],
      cwd: "/tmp",
      spawnFn: mkSpawn("I refuse to JSON today, sorry"),
    });
    expect(r.result).toBeNull();
    expect(r.failure).toMatch(/parseable JSON/);
  });

  it("Operator-prefixed task with gh-CLI-doable work resolves to proceed with clarifiedScope", async () => {
    // Historical 'Operator:' prefix was added before the bot had gh CLI +
    // openssl access. A task that's entirely shell-doable now should
    // resolve PROCEED, with the resolver baking in the concrete shell
    // recipe via clarifiedScope so the main run doesn't redo the analysis.
    const r = await resolveScoutScope({
      description:
        "Operator: rotate AUTH_SECRET on the staging Railway service",
      scopeWarnings: [
        "title starts with 'Operator:' which historically means manual work",
      ],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "proceed",
          explanation:
            "AUTH_SECRET rotation is shell-doable: openssl rand + railway variables --set",
          clarifiedScope:
            "Generate a new 32-byte base64 secret via openssl rand, then run railway variables --set AUTH_SECRET=<value> --service staging. No browser auth required.",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("proceed");
    expect(r.result?.clarifiedScope).toBeDefined();
    expect(r.result?.clarifiedScope?.length ?? 0).toBeGreaterThan(0);
    expect(r.failure).toBeNull();
  });

  it("Operator-prefixed task requiring browser-only auth resolves to escalate", async () => {
    // Stripe dashboard / Anthropic console / OAuth app registration etc.
    // are NOT shell-doable. Even though the resolver no longer auto-
    // escalates on the 'Operator:' prefix, a real browser-only step
    // still routes to escalate.
    const r = await resolveScoutScope({
      description:
        "Operator: create a new Stripe webhook endpoint in the Stripe dashboard and paste the signing secret into Railway",
      scopeWarnings: [
        "title starts with 'Operator:' which historically means manual work",
      ],
      cwd: "/tmp",
      spawnFn: mkSpawn(
        JSON.stringify({
          verdict: "escalate",
          explanation:
            "Stripe dashboard webhook creation requires browser auth; bot can paste via railway variables --set but the webhook itself is browser-only",
        }),
      ),
    });
    expect(r.result?.verdict).toBe("escalate");
    expect(r.result?.explanation).toMatch(/stripe|browser/i);
  });

  it("serves the second call from cache (no re-spawn)", async () => {
    let calls = 0;
    const spawnFn: ResolverSpawn = async () => {
      calls++;
      return {
        stdout: JSON.stringify({
          verdict: "proceed",
          explanation: "ok",
        }),
        exitCode: 0,
        timedOut: false,
      };
    };
    const input = {
      description: "task",
      scopeWarnings: ["w"],
      cwd: "/tmp",
      spawnFn,
    };
    const first = await resolveScoutScope(input);
    expect(first.cached).toBe(false);
    const second = await resolveScoutScope(input);
    expect(second.cached).toBe(true);
    expect(second.result?.verdict).toBe("proceed");
    expect(calls).toBe(1);
  });
});

describe("fallbackOnFailure", () => {
  it("always escalates with the failure reason embedded", () => {
    const r: ScoutResolution = fallbackOnFailure("resolver timed out");
    expect(r.verdict).toBe("escalate");
    expect(r.explanation).toMatch(/resolver timed out/);
  });
});
