# Ocean-bot dashboard

Separate Next.js 15 service that's phone-accessible (Railway-hosted, Auth.js single-user gate). Reads the bot's Postgres tables, surfaces approval cards + budget + recent runs.

## Local dev

```bash
cd tools/ocean-bot/dashboard
cp .env.example .env.local   # fill in the slots
npm install
npm run dev                   # localhost:3002
```

Sign in with your GitHub account. Anyone whose GitHub numeric id doesn't match `OCEAN_USER_ID` gets a 403.

## Deploy

Bring up a Railway project pointing at this directory. Set the 5 env vars from `.env.example`. Auth.js callback URL is `https://<your-domain>/api/auth/callback/github`, register that in the GitHub OAuth App.

## What it shows

| Route | Purpose |
|---|---|
| `/` | overview: today + 7d tallies, recent runs, bot status pill |
| `/approvals` | pending-approval cards with Ship/Skip/Block buttons |
| `/runs/[id]` | full event log for a single run |
| `/budget` | 5hr + 7d window usage vs caps |
| `/settings` | pause/resume the bot; change global approval mode |

## Architecture note

This service is **read-mostly** against the bot's tables. The only writes are:
- `ocean_bot_run` status updates from approve/skip/block actions
- `ocean_bot_state` key/value updates for pause + mode toggles

The bot itself (separate process) is the source of all run creation and event emission. The dashboard never invokes `claude -p` or `git push` directly, those are bot responsibilities, observed via the journal.
