# ocean-bot

[![CI](https://github.com/aqlong/ocean-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/aqlong/ocean-bot/actions/workflows/ci.yml)

An autonomous continuous-development agent. It runs Claude Code on a tick loop against a real repository, decides what to work on, does the work, then decides whether the result is safe to push. Budget caps, a danger classifier, and a Postgres journal keep it from being a liability while unattended.

Extracted from a private monorepo where it does real work driving improvements into a production codebase. This is engineering shared for inspection, not a packaged framework. Expect to read code more than configuration.

`ARCHITECTURE.md` covers the design reasoning: why the classifier is regex-first, why budget tracking is observational rather than predictive, and which production failures motivated the recovery machinery.

I write about the engineering behind this at [aaronlongnion.substack.com](https://aaronlongnion.substack.com).

## What one tick does

Default interval is 180 seconds. Each tick runs at most one task, under a lock so ticks cannot overlap:

1. **Take the lock.** If a previous tick is still running, skip immediately.
2. **Check for drift.** If the running build no longer matches the checked-out commit, schedule a restart rather than act on stale code.
3. **Check the operator gates.** Paused from the dashboard, or backing off after a rate limit: skip.
4. **Self-heal.** Sweep phantom run rows and stale-open backlog items left by a prior crash.
5. **Push anything already approved** in a previous tick. This runs before the budget gate on purpose: shipping an approved commit is a `git push`, and should not be held hostage by a token budget it does not spend.
6. **Check the budget** against rolling Claude Code transcript usage over 5-hour and 7-day windows.
7. **Yield to the human.** If an interactive Claude session is running, skip, so the bot and the operator are never in the same repo at once.
8. **Pick the highest-leverage task** across every enabled project's queues.
9. **Refuse a dirty tree.** If the working copy has uncommitted changes, skip rather than build on top of someone's half-finished edit.
10. **Scout risky work.** Long or complex tasks get a cheap Haiku scope check, and a Sonnet resolver triages any warnings into proceed, skip, block, or escalate.
11. **Run it.** Spawn `claude -p`, stream the JSONL events, track token spend, enforce tool-use and output-token caps.
12. **Gate the result.** Run preflight commands, classify the resulting diff, then push, hold for approval, or block.
13. **Journal everything** to Postgres and release the lock in a `finally`, so a throw mid-tick cannot strand it.

It is meant to be left running for days, surviving operator git operations, network blips, API failures, and OS-triggered restarts.

## Architecture highlights

**The classifier runs on the diff, after the work.** This is the opposite of a permission prompt. The bot writes code and commits locally first; `src/classifier.ts` then inspects the resulting diff and `src/push.ts` decides whether it may leave the machine. Nothing is gated before Claude runs, because the thing worth judging is the diff, not the intention.

**Danger rules are tiered, not flat.** Of the 11 rules, 7 are CRITICAL (`CRITICAL_RULE_IDS` in `src/classifier.ts`: publisher edits, audit-log edits, schema changes, payment code, credential-like paths, destructive git commands, and the bot editing itself). A CRITICAL hit always routes the run to await-approval, whatever the approval mode says. The other 4 are advisory: they are recorded on the run and surfaced in the dashboard, but they do not block. A flat rule list meant every advisory hit demanded a human, and the predictable result was rubber-stamping. Splitting the tiers is what made unattended auto-push safe enough to leave on.

**Regex-first, not LLM-first.** The classifier is deterministic pattern matching over the diff. It is cheaper, faster, reproducible, and debuggable, and it cannot be talked out of a verdict by the diff it is inspecting. An LLM asked "is this dangerous?" fails all four of those properties on the exact input where it matters most.

**Budget is observational, not predictive.** `src/budget.ts` parses Claude Code transcripts from `~/.claude/projects/*/*.jsonl`, attributes each session as bot or interactive using a ledger the runner writes at spawn time, and sums real tokens over 5-hour and 7-day rolling windows to return `ok`, `wait`, or `stop`. No estimation, so no drift between what the bot thinks it spent and what it actually spent. Optional per-project sub-caps bound a single runaway project without partitioning the global pool.

**The boot wrapper handles stale builds.** launchd invokes `scripts/ocean-bot-launch.sh`, not `node dist/index.js`. On each restart the wrapper pins to `main`, refuses to start on divergence, rebuilds `dist/` when any source file is newer, and stamps the built commit into `dist/.built-from-sha`. The tick loop compares that stamp against `HEAD` and stops if they diverge mid-run. Without this, a restart could silently resume executing a build that no longer matches the code in the tree.

**It assumes it will crash.** `src/health-sweep.ts` runs every tick to close run rows orphaned by a kill or a laptop sleep, reopen stale-open backlog items, and detect stuck loops. `src/phantom-cleanup.ts` handles rows whose process is provably gone. The operator should not be the thing that notices the bot broke.

**Adapters make projects pluggable.** `src/adapters/types.ts` defines the `ProjectAdapter` interface: which queues a project exposes, how to score candidates, what preflight commands to run, and how to classify danger. Adding a project is one file; two reference adapters ship here.

**Single-user dashboard.** A Next.js app in `dashboard/` shows runs, approvals, budget, and health, and lets the operator approve, pause, retune caps, or tick on demand. Auth is GitHub OAuth gated to one user id.

## Layout

```
src/
  index.ts              tick loop, gates, signal handling
  config.ts             ~/.ocean-bot/config.json loader
  queue.ts              cross-project leverage scoring
  classifier.ts         11 danger rules, CRITICAL vs advisory tiers
  push.ts               preflight, decidePush, pushToTarget
  budget.ts             transcript parser, rolling-window caps
  runner.ts             claude -p spawn, stream-json parsing, caps
  scout.ts              cheap pre-run scope check
  scout-resolver.ts     triage of scope warnings into 4 verdicts
  model-select.ts       per-task model tier selection
  drift.ts              stale-build and branch-divergence detection
  health-sweep.ts       per-tick self-healing and stuck-loop detection
  phantom-cleanup.ts    reclaims run rows whose process is gone
  approval-mode.ts      resolves effective approval mode
  visual-inspect.ts     screenshot diffing for UI changes
  journal.ts            Postgres event sink
  db/{schema,index}.ts  Drizzle schema, lazy pool
  adapters/
    types.ts            ProjectAdapter interface
    code2wiki.ts        reference adapter
    ocean-bot.ts        the bot's adapter for its own repo
  util/                 git, logging, ulid, env scrubbing, id matching
scripts/
  ocean-bot-launch.sh   boot wrapper: pin main, pull, rebuild, stamp SHA
  install-launchd.sh    register as a macOS LaunchAgent
  install-logrotate.sh  sibling agent, daily log rotation
  *.test.sh             bash harnesses for the two installers
dashboard/              Next.js operator dashboard
drizzle/                SQL migrations
```

## Running it

```bash
git clone https://github.com/aqlong/ocean-bot.git
cd ocean-bot
npm install
npm run build
```

It needs Postgres. Apply the migrations in order:

```bash
createdb ocean_bot
for f in drizzle/*.sql; do psql -d ocean_bot -v ON_ERROR_STOP=1 -f "$f"; done
```

To register as a macOS LaunchAgent, the production deployment mode:

```bash
mkdir -p ~/.config/ocean-bot && touch ~/.config/ocean-bot/env
chmod 600 ~/.config/ocean-bot/env
# add OCEAN_BOT_DATABASE_URL and any other secrets to that file
./scripts/install-launchd.sh
```

The plist deliberately carries no secrets. They live in `~/.config/ocean-bot/env` (mode 0600), which Node 20.6+ loads via `--env-file`. Restart after code changes with:

```bash
launchctl kickstart -k gui/$UID/com.craftandship.ocean-bot
```

## Configuration

`~/.ocean-bot/config.json`. Anything omitted falls back to `DEFAULT_CONFIG` in `src/config.ts`:

```json
{
  "tickIntervalSec": 180,
  "globalApprovalMode": "auto",
  "projects": [
    {
      "name": "ocean-bot",
      "rootDir": "/path/to/your-project",
      "memoryDir": "/path/to/.claude/projects/your-project/memory",
      "enabled": true
    }
  ],
  "caps": {
    "fiveHrInput": 2500000,
    "fiveHrOutput": 500000,
    "sevenDInput": 17500000,
    "sevenDOutput": 3500000,
    "warnRatio": 0.9
  }
}
```

Notes that are easy to get wrong:

- `projects[].name` is not a free-form label. `buildAdapters` in `src/index.ts` switches on it to construct the adapter, and only `code2wiki` and `ocean-bot` are wired today. An unrecognised name yields no adapter and the project is silently ignored.
- `enabled` must be `true` or the project is skipped before an adapter is even built.
- `globalApprovalMode` is `auto` by default. CRITICAL classifier hits still route to await-approval; set `manual` to require approval for every push.
- `warnRatio` is the fraction of a cap at which the gate degrades from `ok` to `wait`, so the bot backs off before it hits the wall rather than stopping dead at it.

## Tests

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit
```

78 of the 625 tests here are integration tests against a real Postgres, so they are gated on an env var and skip cleanly when it is absent. To run everything:

```bash
createdb ocean_bot_test
for f in drizzle/*.sql; do psql -d ocean_bot_test -v ON_ERROR_STOP=1 -f "$f"; done
OCEAN_BOT_TEST_DATABASE_URL=postgres://you@localhost:5432/ocean_bot_test npm test
```

CI attaches a Postgres service and then asserts the skip count is zero, so a green check means the database-backed tests actually ran rather than quietly skipping. The dashboard has its own suite (`cd dashboard && npm test`) under the same gate, and CI builds it with no database configured at all to keep the build from depending on runtime infrastructure.

The two installer scripts have bash harnesses that also run in CI:

```bash
bash scripts/ocean-bot-launch.test.sh
bash scripts/install-logrotate.test.sh
```

## Status and limitations

It works, it runs unattended, and it ships real commits. It is also single-operator software with sharp edges worth naming:

- **macOS and launchd only.** Nothing is portable to systemd or a container without work; the boot wrapper and both installers assume launchctl.
- **The tick orchestrator has no direct tests.** The individual pieces are well covered, but `src/index.ts`, which wires them in order, is verified only through its parts.
- **`claude -p` is the execution model.** The bot shells out to the CLI and parses its event stream, so it inherits that interface's stability.
- **Adapters are compiled in.** Adding a project means writing a file and rebuilding, not dropping in a plugin.
- **The dashboard assumes one user.** Auth is a single GitHub id compared against an env var. It is a control panel, not a multi-tenant product.

## License

MIT.
