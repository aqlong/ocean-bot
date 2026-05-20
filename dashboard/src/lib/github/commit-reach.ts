// Ask GitHub whether a commit SHA is reachable from a remote branch.
// Backstop for the "the bot's push-step failed but the operator pushed
// the same commit manually" case, surfaced 2026-05-12 when 2 runs
// showed up as `failed` while their commits were on origin/main.
//
// Uses the unauthenticated compare API. For public repos we get 60
// requests/IP/hour, which is fine: we only check failed runs that
// render on a page, and the cache below collapses repeats. Private
// repos return 404 without a token, which we treat as "not reachable"
// (conservative, we leave the failure visible).

interface CacheEntry {
  on: boolean;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

// On-main commits don't leave main, so cache hits stay valid for an
// hour. Negative answers re-check sooner so a freshly-pushed commit
// flips within a minute.
const TTL_ON_MS = 60 * 60 * 1000;
const TTL_NOT_ON_MS = 60 * 1000;

export interface IsCommitOnRemoteDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export async function isCommitOnRemote(
  sha: string,
  branch: string,
  repo: string,
  deps: IsCommitOnRemoteDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  if (!sha || !repo || !branch) return false;
  if (sha.length < 7) return false;

  const key = `${repo}|${branch}|${sha}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now()) return cached.on;

  // compare/{base}...{head} → status "ahead"/"identical" means head
  // contains base. We put the run's sha as base and the branch as
  // head, so a positive answer means "branch's history contains sha."
  const url = `https://api.github.com/repos/${repo}/compare/${encodeURIComponent(
    sha,
  )}...${encodeURIComponent(branch)}`;

  let on = false;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (res.ok) {
      const body = (await res.json()) as { status?: string };
      on = body.status === "identical" || body.status === "ahead";
    }
  } catch {
    on = false;
  }

  cache.set(key, { on, expiresAt: now() + (on ? TTL_ON_MS : TTL_NOT_ON_MS) });
  return on;
}

// Test-only: drop the cache so a test can assert call counts.
export function _clearCommitReachCache(): void {
  cache.clear();
}
