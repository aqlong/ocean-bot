// Project → GitHub "owner/repo" mapping. Used by commit-reach to ask
// GitHub whether a failed run's commit actually landed via another
// channel (e.g. a manual `git push` from the operator after the bot's
// own push-step failed).
//
// Defaults cover today's only adapter. Override via env for forks /
// future projects:
//   OCEAN_BOT_PROJECT_REPOS=code2wiki=craftandship/code2wiki,foo=acme/foo

export function repoForProject(project: string): string | null {
  const map: Record<string, string> = { code2wiki: "craftandship/code2wiki" };
  const override = process.env["OCEAN_BOT_PROJECT_REPOS"];
  if (override) {
    for (const pair of override.split(",")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const repo = pair.slice(eq + 1).trim();
      if (name && repo.includes("/")) map[name] = repo;
    }
  }
  return map[project] ?? null;
}
