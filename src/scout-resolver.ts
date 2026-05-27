// Scout-resolver. Runs AFTER scout flags scopeWarnings on a task, BEFORE
// the bot defaults to await-approval. Asks sonnet to triage: can the bot
// proceed autonomously, should this be skipped, or does the operator
// genuinely need to weigh in?
//
// The scout (scout.ts) is conservative-by-design, its job is to flag
// risk cheaply with haiku. Most of the time the warnings it produces
// are technical scope questions ("which file does this CFML change
// belong in?") that a smarter model can resolve without operator input.
// Without this resolver every scout-flagged task lands on /approvals,
// putting the operator in the loop for decisions the bot should be
// making. The resolver replaces that default routing with a triage
// pass that ONLY escalates when the decision is genuinely executive
// (pricing, product direction, brand, customer-facing legal, anything
// outside the bot's mandate).
//
// Design choices, in order of importance:
//
//   1. Fail-safe to escalate. Any parse error / timeout / unexpected
//      output routes to await-approval. The operator is more annoyed
//      by a missed safety net than by an extra approval click.
//   2. Sonnet, not opus. The triage decision is "executive-level
//      vs. technical", well within sonnet's competence. Opus would
//      cost 3x for no quality lift here.
//   3. Module-level FIFO cache (same shape as scout's), keyed on
//      sha256(description + warnings) so re-picks of the same task
//      don't pay twice within a bot process lifetime.
//   4. Pure parsing split out so tests can drive every branch with a
//      synthetic spawn. Default spawnFn invokes claude --model sonnet
//      with the JSON-only prompt.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { log } from "./util/log.js";
import { buildSafeChildEnv } from "./util/safe-env.js";

const RESOLVER_TIMEOUT_MS = 90 * 1000;
const RESOLVER_CACHE_MAX = 64;

export type ResolverVerdict = "proceed" | "skip" | "escalate" | "block";

export interface ScoutResolution {
  verdict: ResolverVerdict;
  /** Short human-readable rationale. Shown on the run row + dashboard. */
  explanation: string;
  /** When verdict='proceed', the resolver MAY rewrite the task description
   *  to bake in its disambiguation (e.g., narrow the file scope, add
   *  acceptance criteria). When unset or empty, the main run uses the
   *  original description. */
  clarifiedScope?: string;
  /** When verdict='proceed' AND the warnings reveal a concrete pass/fail
   *  check (`npm test` exits 0, audit verify passes, specific file emits
   *  expected output), the resolver writes the criterion here. The runner
   *  then spawns `claude -p "/goal <criteria> or stop after <N> turns\n\n<prompt>"`
   *  instead of the plain prompt, so Anthropic's per-turn evaluator
   *  catches "shipped a half-done task" misses on uncertain runs. Skip
   *  for routine clarifications, the cost of an extra evaluator-Haiku
   *  call per turn isn't worth it. */
  acceptanceCriteria?: string;
}

/** Turn cap baked into the /goal condition for scout-uncertain runs.
 *  Anthropic docs note achieved/cleared goals don't restore on
 *  --resume, but active goals carry over with counters reset, so the
 *  bot's 24h resume window doesn't fight this. 5 turns is empirically
 *  the right balance: small fixes finish in 2-3 turns, but legitimate
 *  multi-file work needs a bit of headroom. The cap composes with the
 *  process-level timeout, output-token cap, and tool-use cap. */
export const DEFAULT_GOAL_TURN_CAP = 5;

/** Pure: when resolution.verdict === 'proceed' AND acceptanceCriteria is set,
 *  return a /goal-wrapped prompt with the turn cap baked into the
 *  condition itself (per Anthropic docs, the turn cap is a Claude-internal
 *  stop expressed inside the /goal text). Otherwise return the input
 *  prompt unchanged.
 *
 *  Composition order matters: this MUST run AFTER any clarifiedScope
 *  rewrite of the task description, the resolver rewrites the task body
 *  (inside the /goal envelope) and the wrapper sits outside.
 */
export function applyGoalWrapper(
  prompt: string,
  resolution: ScoutResolution,
  turnCap: number = DEFAULT_GOAL_TURN_CAP,
): string {
  if (resolution.verdict !== "proceed") return prompt;
  if (!resolution.acceptanceCriteria) return prompt;
  return `/goal ${resolution.acceptanceCriteria} or stop after ${turnCap} turns\n\n${prompt}`;
}

export interface ResolverOutcome {
  /** Parsed verdict when claude returned valid JSON, else null. */
  result: ScoutResolution | null;
  /** Populated on timeout / non-zero exit / unparseable output. */
  failure: string | null;
  /** True when served from cache. */
  cached: boolean;
}

export interface ResolverSpawnResult {
  stdout: string;
  exitCode: number;
  timedOut: boolean;
}

export type ResolverSpawn = (prompt: string) => Promise<ResolverSpawnResult>;

export interface ResolveScoutScopeInputs {
  description: string;
  /** Warnings the scout flagged. The resolver triages each one. */
  scopeWarnings: string[];
  /** cwd for the claude spawn (so it can resolve project context). */
  cwd: string;
  /** Injectable spawner for tests. Default invokes the real claude CLI. */
  spawnFn?: ResolverSpawn;
}

/** Hash used as the cache key. The (description, warnings) tuple is the
 *  natural key: two runs of the same task with the same flagged risks
 *  should produce the same verdict. */
export function hashResolverInput(
  description: string,
  scopeWarnings: string[],
): string {
  const payload = JSON.stringify({ description, scopeWarnings });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

const cache = new Map<string, ResolverOutcome>();

/** Test-only: reset the cache between cases. */
export function clearResolverCache(): void {
  cache.clear();
}

/** Pure: extract a ScoutResolution from arbitrary claude text output.
 *  Tries a ```json fenced block first, then falls back to the first
 *  balanced { ... } block. Returns null if no candidate parses with
 *  the required shape. */
export function parseResolverResponse(text: string): ScoutResolution | null {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);

  for (const raw of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;
    const verdict = obj["verdict"];
    const explanation = obj["explanation"];
    const clarifiedScope = obj["clarifiedScope"];
    if (
      verdict !== "proceed" &&
      verdict !== "skip" &&
      verdict !== "escalate" &&
      verdict !== "block"
    ) {
      continue;
    }
    if (typeof explanation !== "string" || explanation.trim() === "") continue;
    const out: ScoutResolution = {
      verdict,
      explanation: explanation.trim(),
    };
    if (typeof clarifiedScope === "string" && clarifiedScope.trim() !== "") {
      out.clarifiedScope = clarifiedScope.trim();
    }
    const acceptanceCriteria = obj["acceptanceCriteria"];
    // acceptanceCriteria only makes sense on proceed verdicts. The
    // prompt instructs the model to omit it otherwise, but be defensive:
    // a skip/escalate/block with stray criteria would just confuse the
    // dashboard's gate event.
    if (
      verdict === "proceed" &&
      typeof acceptanceCriteria === "string" &&
      acceptanceCriteria.trim() !== ""
    ) {
      out.acceptanceCriteria = acceptanceCriteria.trim();
    }
    return out;
  }
  return null;
}

export function buildResolverPrompt(
  description: string,
  scopeWarnings: string[],
): string {
  return [
    "You are a triage scout for an autonomous coding bot. The bot's first-",
    "pass scout flagged scope warnings on the task below. Your job: decide",
    "whether the bot can proceed autonomously, should skip, or must escalate",
    "to a human operator. Respond with ONE JSON object and nothing else.",
    "Do NOT do the task. Do NOT read files. Do NOT use any tools.",
    "",
    "Output JSON shape (exact keys):",
    '{ "verdict": "proceed" | "skip" | "escalate" | "block",',
    '  "explanation": "<one short sentence>",',
    '  "clarifiedScope": "<optional rewritten task description, only if verdict=\\"proceed\\" AND clarification helps>",',
    '  "acceptanceCriteria": "<optional concrete pass/fail check, only if verdict=\\"proceed\\" AND a measurable success condition is obvious>"',
    "}",
    "",
    "Decision rubric (apply in order):",
    "",
    "  1. BLOCK iff the task requires an OPERATOR ACTION the bot literally",
    "     cannot perform: browser-based authentication, manual form",
    "     submission on a third-party portal, accepting a partner /",
    "     terms-of-service agreement, real-money credit-card entry, paid-",
    "     API key generation that requires a web console, manual install",
    "     of a desktop GUI app, or a physical-world action (mail, phone,",
    "     in-person). These tasks have no DECISION for the operator to",
    "     make on a dashboard, they have an ACTION to perform externally.",
    "     Routing them to /approvals would create cards with no",
    "     ship/skip/block decision the operator can meaningfully make.",
    "     BLOCK marks the backlog item as status='blocked' with the",
    "     reason; operator does the action externally then reopens or",
    "     archives the item.",
    "",
    "  2. ESCALATE iff the task is genuinely an executive DECISION the",
    "     operator must weigh in on: pricing, billing, brand / naming,",
    "     customer-facing legal copy, product direction (what feature to",
    "     build next), or any decision requiring external knowledge the",
    "     bot can't infer from the codebase. ALSO escalate for irrever-",
    "     sible operations the operator owns (force-push, secret rotation,",
    "     paid-API key changes that the bot COULD technically do but",
    "     shouldn't without sign-off). These should be uncommon.",
    "",
    "  3. SKIP iff the task is fundamentally underspecified in a way the",
    "     codebase can't resolve, OR the warnings reveal a dependency that",
    "     isn't ready (e.g., 'depends on feature X being merged first'),",
    "     OR the task is no-longer-relevant given recent commits.",
    "",
    "  4. PROCEED for everything else, including technical scope questions",
    "     (which file does this belong in?), edge-case ambiguity (what's",
    "     the exact regex?), framework convention questions, and 'this",
    "     looks bigger than it reads'-style scout caution. The bot's main",
    "     run uses opus/sonnet and can handle ambiguity. Default to PROCEED",
    "     when in doubt: the operator can always revert a bad ship.",
    "",
    "Bot capabilities reminder (for the BLOCK vs PROCEED boundary): the",
    "bot CAN run gh CLI (set/list secrets + variables, trigger workflows,",
    "view runs, generic gh api), railway CLI (set env vars, run commands,",
    "redeploy), openssl (generate random tokens), curl + the standard",
    "shell. The bot CANNOT use a web browser, log into third-party",
    "portals, submit external forms, accept terms-of-service in a UI,",
    "or perform any action requiring a graphical interface. Title-prefix",
    "'Operator:' is historical, not authoritative; judge by the action,",
    "not the prefix.",
    "",
    "If verdict='proceed' AND the warnings reveal a concrete narrowing",
    "(e.g., 'Java parser is out of scope, CFML only' or 'skip the framework-",
    "hook edge case for v1'), write a tightened task description in",
    "clarifiedScope. The bot's main run will use this instead of the",
    "original. Leave clarifiedScope unset if no rewrite is needed.",
    "",
    "ACCEPTANCE CRITERIA rubric (acceptanceCriteria field):",
    "",
    "  Emit acceptanceCriteria ONLY when ALL of the following hold:",
    "    a. verdict === 'proceed' (skip / escalate / block never set it).",
    "    b. The warnings or task description reveal a CONCRETE PASS/FAIL",
    "       check the bot can verify autonomously after each turn (e.g.,",
    "       'npm test exits 0', 'audit verify --require-signed passes',",
    "       'the new test file exists and asserts X', 'the regex no longer",
    "       hangs on input <fixture>'). The check must be observable from",
    "       command output or file state, not a subjective judgment.",
    "    c. The risk reads as 'might ship a half-done task' rather than",
    "       'might pick the wrong file'. Per-turn evaluation catches the",
    "       former; clarifiedScope alone catches the latter.",
    "",
    "  When set, the bot wraps the main prompt with",
    "    /goal <criteria> or stop after 5 turns",
    "  so Anthropic's per-turn evaluator (Haiku) judges progress between",
    "  turns. The 5-turn cap is a Claude-internal stop, you don't need to",
    "  add a separate turn limit.",
    "",
    "  SKIP acceptanceCriteria for routine clarifications: framework",
    "  convention questions, file-scope narrowing (clarifiedScope already",
    "  handles those), trivial fixes that finish in one turn. The",
    "  evaluator adds ~168 Haiku tokens per turn; only worth paying when",
    "  the bot is genuinely uncertain whether it will finish the task.",
    "",
    "  Phrase the criterion as ONE sentence stating the success condition",
    "  affirmatively (what must be true), not as a checklist or list of",
    "  steps. Example: 'Validator emits no em-dash false-positive on the",
    "  fixture in src/core/feedback/examples-emdash.test.ts and the full",
    "  suite passes.' NOT a multi-item checklist.",
    "",
    "Bot capabilities (relevant when deciding proceed vs escalate):",
    "  The bot CAN run these from a shell without operator help:",
    "    - gh secret set / gh variable set (GitHub repo secrets + variables)",
    "    - gh workflow run / gh api (trigger CI; arbitrary GitHub API calls)",
    "    - railway variables --set (Railway service env vars via CLI)",
    "    - openssl rand (generate AUTH_SECRET / random keys / tokens)",
    "  Tasks that consist ENTIRELY of work doable via the tools above",
    "  should resolve PROCEED, including when the task narrates them as",
    "  'operator must paste...' or similar.",
    "",
    "  The bot CANNOT do these; escalate if the task requires any:",
    "    - Browser-only flows: Stripe dashboard, Anthropic console,",
    "      Railway web UI for non-CLI ops, OAuth app registration,",
    "      App Store / Marketplace submission consoles.",
    "    - Logging into the operator's personal accounts (email, Slack,",
    "      bank, paid SaaS dashboards the operator owns in a browser).",
    "    - Anything requiring a credential only the operator can produce",
    "      (live API keys not already in the env, signed PEMs, etc.).",
    "",
    "  Operator-prefix note: the 'Operator:' prefix on a task title is",
    "  HISTORICAL. It pre-dates the bot's gh CLI + openssl access.",
    "  Do NOT auto-escalate solely because the title starts with 'Operator:';",
    "  judge by what the task actually requires. A task that needs BOTH",
    "  shell-doable work AND a browser-only step still escalates, because",
    "  the browser step blocks the whole task.",
    "",
    "Task description:",
    description,
    "",
    "Scout warnings:",
    ...scopeWarnings.map((w, i) => `  ${i + 1}. ${w}`),
  ].join("\n");
}

export async function resolveScoutScope(
  input: ResolveScoutScopeInputs,
): Promise<ResolverOutcome> {
  const key = hashResolverInput(input.description, input.scopeWarnings);
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };

  const spawnFn =
    input.spawnFn ?? ((prompt) => defaultResolverSpawn(prompt, input.cwd));
  const prompt = buildResolverPrompt(input.description, input.scopeWarnings);

  let outcome: ResolverOutcome;
  try {
    const r = await spawnFn(prompt);
    if (r.timedOut) {
      outcome = mkOutcome(
        null,
        `resolver timed out after ${RESOLVER_TIMEOUT_MS / 1000}s`,
      );
    } else if (r.exitCode !== 0) {
      outcome = mkOutcome(null, `resolver exited ${r.exitCode}`);
    } else {
      const parsed = parseResolverResponse(r.stdout);
      outcome = parsed
        ? mkOutcome(parsed, null)
        : mkOutcome(null, "resolver output did not contain parseable JSON");
    }
  } catch (e) {
    outcome = mkOutcome(null, e instanceof Error ? e.message : String(e));
  }

  storeInCache(key, outcome);
  return outcome;
}

/** Fail-safe: when the resolver couldn't produce a verdict, default to
 *  escalate so the operator sees the original scout warnings and can
 *  triage manually. Callers wire this at the index.ts decision point;
 *  putting it in a named helper here keeps that branch obvious. */
export function fallbackOnFailure(failure: string): ScoutResolution {
  return {
    verdict: "escalate",
    explanation: `resolver failed (${failure}); escalating to operator per fail-safe default`,
  };
}

function mkOutcome(
  result: ScoutResolution | null,
  failure: string | null,
): ResolverOutcome {
  return { result, failure, cached: false };
}

function storeInCache(key: string, outcome: ResolverOutcome): void {
  if (cache.size >= RESOLVER_CACHE_MAX) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, outcome);
}

function defaultResolverSpawn(
  prompt: string,
  cwd: string,
): Promise<ResolverSpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn("claude", ["-p", prompt, "--model", "sonnet"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...buildSafeChildEnv(process.env), OCEAN_BOT_SCOUT_RESOLVER: "1" },
    });
    let stdout = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("scout_resolver.timeout, killing claude");
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 2000);
    }, RESOLVER_TIMEOUT_MS);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf-8");
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, exitCode: timedOut ? 124 : code ?? 0, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      log.warn("scout_resolver.spawn_error", { err: err.message });
      resolve({ stdout, exitCode: -1, timedOut: false });
    });
  });
}
