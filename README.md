# ocean-bot

An autonomous continuous-development agent that runs Claude on a tick loop, with budget control, dangerous-action classification, and Postgres-journaled state.

Extracted from a private monorepo where it does real work driving improvements into a production codebase. The code is the documentation here. This is engineering shared for inspection, not a polished framework for general use.

## What it does

On every tick (default: ~5 minutes):

1. **Picks the highest-leverage task** from a queued backlog table
2. **Classifies it for danger** against an 11-rule library (mass deletion, force-push to protected branches, secret-pattern exposure)
3. **Checks the budget** against rolling Claude Code transcript usage (5-hour + 7-day windows)
4. **Spawns `claude -p`** with the task in the project's working directory
5. **Streams the response**, parses JSONL events, tracks token spend
6. **Decides whether to push** the resulting commits via a preflight + decidePush pipeline
7. **Journals everything** to Postgres for later inspection

It is designed to be left running for hours or days, surviving operator git operations, network blips, Claude API failures, and OS-triggered restarts.

## Architecture highlights

**Boot wrapper handles stale-dist drift.** The launchd plist invokes `scripts/ocean-bot-launch.sh`, not `node dist/index.js` directly. On each restart the wrapper fetches `origin/main`, refuses to start on divergence (exit 2 produces a loud failure), rebuilds `dist/` if any `src/*.ts` is newer than `dist/index.js`, and stamps the built SHA into `dist/.built-from-sha`. The tick loop reads that SHA and compares it to `git rev-parse HEAD`. If they diverge mid-run, the tick logs `tick.skip stale_dist` and the dashboard shows a "Stale, restart needed" banner. Recovery is a launchd restart, which re-runs the wrapper.

**Budget is observational, not predictive.** `src/budget.ts` parses Claude Code transcripts at `~/.claude/projects/*/*.jsonl`, attributes each session as bot-tagged or interactive (via a session ledger the runner writes at spawn time), sums tokens over 5hr and 7d rolling windows, and returns `ok | wait | stop`. Caps come from config and the dashboard surfaces actual usage so the operator can tune within a day. No estimation, no surprises.

**Classifier is regex-first, not LLM-first.** `src/classifier.ts` has 11 hard rules for super-dangerous actions (`rm -rf`, force-push to protected branches, secret-pattern leakage, mass deletion). A dangerous classification short-circuits before any Claude call. Cheaper, faster, and more debuggable than asking the model "is this dangerous?"

**Adapter pattern for project portability.** `src/adapters/types.ts` defines a `ProjectAdapter` interface (task selection, transcript paths, push targets). Each project ships its own adapter. Adding a new project is a single file.

**Single-user dashboard with GitHub OAuth.** A separate Next.js service at `dashboard/` visualizes runs, lets the operator approve sensitive actions, edit budgets, and tick on demand. Auth is GitHub OAuth gated to a single user ID. See `dashboard/.env.example` for the env shape.

## File structure

```
src/
  index.ts             main tick loop, signal handlers
  config.ts            ~/.ocean-bot/config.json loader
  queue.ts             leverage queue picker
  classifier.ts        11-rule super-dangerous classifier
  budget.ts            Claude Code transcript parser + cap gate
  runner.ts            claude -p spawn + stream-json parser
  push.ts              preflight + decidePush + pushToTarget
  journal.ts           Postgres event sink
  db/{schema,index}.ts Drizzle schema + lazy pool
  adapters/
    types.ts           ProjectAdapter interface
    code2wiki.ts       example adapter
  util/{git,log,ulid}.ts
scripts/
  install-launchd.sh         register as macOS LaunchAgent
  install-logrotate.sh       sibling LaunchAgent: daily 03:00 log rotation
  ocean-bot-launch.sh        boot wrapper (pin main + pull + rebuild + stamp)
  migrate-secrets-to-sidecar.sh
dashboard/                   separate Next.js service
drizzle/                     SQL migrations
```

## Running it

```bash
git clone https://github.com/aqlong/ocean-bot.git
cd ocean-bot
npm install
npm run build
```

To register as a macOS LaunchAgent (the production deployment mode):

```bash
mkdir -p ~/.config/ocean-bot && touch ~/.config/ocean-bot/env
chmod 600 ~/.config/ocean-bot/env
# edit ~/.config/ocean-bot/env to add OCEAN_BOT_DATABASE_URL + other secrets
./scripts/install-launchd.sh
```

The plist deliberately does not carry secrets. They live in `~/.config/ocean-bot/env` (mode 0600) which Node 20.6+ reads via `--env-file=PATH`. Operator-private; never committed.

To restart after code changes:

```bash
launchctl kickstart -k gui/$UID/com.craftandship.ocean-bot
```

## Configuration

Example `~/.ocean-bot/config.json`:

```json
{
  "projects": [
    {
      "name": "your-project",
      "rootDir": "/path/to/your-project",
      "memoryDir": "/path/to/.claude/projects/your-project/memory",
      "adapter": "code2wiki"
    }
  ],
  "tickIntervalMs": 300000,
  "budgetCaps": {
    "fiveHrInput": 2500000,
    "fiveHrOutput": 500000,
    "sevenDInput": 17500000,
    "sevenDOutput": 3500000,
    "warnRatio": 0.9
  }
}
```

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

There are also bash-test harnesses for the install scripts (e.g. `scripts/ocean-bot-launch.test.sh`).

## Status

Extracted from a working production deployment. Not a packaged library; expect to read code more than configuration to understand it. The `code2wiki` adapter shipped here is a real example; other adapters are easy to write following its shape.

## License

MIT.
