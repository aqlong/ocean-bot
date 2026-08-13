// Safe env scrubber for child claude subprocesses.
//
// The bot's runner / scout / scout-resolver each spawn `claude -p` and
// inherit the operator's full process.env via `{ ...process.env, ... }`.
// That env carries secrets claude doesn't need:
//
//   - OCEAN_BOT_DATABASE_URL: claude has no business reading the bot's
//     Postgres directly. A prompt-injected task description could trick
//     claude into `psql $OCEAN_BOT_DATABASE_URL -c "DROP TABLE ..."` or
//     exfil rows.
//   - WORKER_TRIGGER_SECRET: claude doesn't trigger workers; only the
//     bot's daemon does. Pass-through would let prompt injection
//     forward the secret to an external endpoint.
//   - STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET (if present): same
//     reasoning.
//   - AUTH_SECRET / GITHUB_APP_PRIVATE_KEY: belt-and-braces.
//   - Anything matching common credential-suffix patterns we haven't
//     enumerated yet (*_TOKEN, *_PASSWORD).
//
// HOME, PATH, USER, etc. are NOT in the allowlist; they pass through
// because they are not on any denylist. The allowlist only applies when
// a key would OTHERWISE be denied by a pattern (e.g. ANTHROPIC_API_KEY
// survives the *_KEY catch-all). ANTHROPIC_API_KEY is kept because
// c2w's src/core/llm/client.ts can be exercised by claude during
// npm-test runs that use the real LLM client path (rare, but
// legitimate). Removing it would be a behavior change worth opt-in.
//
// Threat model: the bot's main runner is the highest-risk surface
// because tool_use includes Bash (claude can shell out). Scout +
// scout-resolver use `-p` without tools, so the env-leak risk is
// reduced there (claude only outputs JSON to stdout), but we apply
// the same scrubbing for defense-in-depth.

const DEFAULT_DENYLIST_KEYS = [
  // Bot-private DB. Claude reading/writing the bot's Postgres would
  // bypass the journal abstraction entirely.
  "OCEAN_BOT_DATABASE_URL",
  // Worker-trigger gate; not relevant to a claude session.
  "WORKER_TRIGGER_SECRET",
  // Stripe secrets, even on the bot machine where they shouldn't exist.
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID_STARTER",
  // Auth.js secret + GitHub App private key; bot host typically lacks
  // these but defense-in-depth.
  "AUTH_SECRET",
  "AUTH_GITHUB_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  // Railway API token (allows pushing to the dashboard service).
  "RAILWAY_TOKEN",
  // Notion / Confluence publisher secrets (claude shouldn't need to
  // hit those APIs; the c2w product code does, via its own auth path).
  "NOTION_API_TOKEN",
  "CONFLUENCE_API_TOKEN",
];

// Denylist patterns: anything matching these suffixes is dropped even
// if not on the explicit denylist. Catches future-added secrets the
// operator forgets to enumerate here.
const DEFAULT_DENYLIST_PATTERNS = [
  /^(.+_)?(SECRET|PASSWORD)$/,
  // Tokens are noisy (USER_TOKEN, CSRF_TOKEN), but the suffix is a
  // strong "this is sensitive" signal. Block by default; opt in via
  // the allowlist if any specific TOKEN env is genuinely needed.
  //
  // NOTE: this pattern also strips GITHUB_TOKEN and GH_TOKEN, which the
  // `gh` CLI reads for authentication. On the operator's Mac, `gh` uses
  // the system keychain (run `gh auth status` to confirm), so the CLI
  // works in claude subprocesses without either env var. If the bot ever
  // runs in GitHub Actions (where GITHUB_TOKEN is auto-injected), add
  // "GH_TOKEN" or "GITHUB_TOKEN" to extraAllowKeys at the spawn site,
  // or move them to DEFAULT_ALLOWLIST_KEYS after weighing the prompt-
  // injection risk (a token with repo write access is a meaningful
  // exfil vector if a task description is compromised).
  /^(.+_)?TOKEN$/,
  /^(.+_)?PRIVATE_KEY$/,
];

// Allowlist patterns: keys matching these are always kept, even if
// the denylist would drop them. ANTHROPIC_API_KEY is the load-bearing
// case (c2w product code reads it for real-LLM extraction). The bot's
// own attribution stamp (OCEAN_BOT_RUN_ID) is passed in explicitly by
// the runner, no need to allowlist.
const DEFAULT_ALLOWLIST_KEYS = ["ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"];

export interface SafeEnvOptions {
  /** Extra keys to drop, in addition to the defaults. */
  extraDenyKeys?: string[];
  /** Extra keys to keep, overriding pattern denials. */
  extraAllowKeys?: string[];
}

/**
 * Return a new env object with sensitive keys removed, suitable for
 * `child_process.spawn`'s `env` option. Pure: doesn't mutate the input.
 *
 * Algorithm:
 *   1. Start from input env.
 *   2. Drop keys on the explicit denylist (extraDenyKeys + DEFAULT_DENYLIST_KEYS).
 *   3. Drop keys matching denylist patterns UNLESS allowlisted.
 *   4. Return the remaining map.
 */
export function buildSafeChildEnv(
  inputEnv: NodeJS.ProcessEnv,
  opts: SafeEnvOptions = {},
): NodeJS.ProcessEnv {
  const denyKeys = new Set<string>([
    ...DEFAULT_DENYLIST_KEYS,
    ...(opts.extraDenyKeys ?? []),
  ]);
  const allowKeys = new Set<string>([
    ...DEFAULT_ALLOWLIST_KEYS,
    ...(opts.extraAllowKeys ?? []),
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inputEnv)) {
    if (value === undefined) continue;
    if (allowKeys.has(key)) {
      out[key] = value;
      continue;
    }
    if (denyKeys.has(key)) continue;
    if (DEFAULT_DENYLIST_PATTERNS.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}
