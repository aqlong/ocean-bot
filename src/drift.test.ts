import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./util/git.js";
import { detectDrift, isBotAffectingPath, resolveDriftPaths } from "./drift.js";

describe("detectDrift", () => {
  let repo: string;
  let distDir: string;
  let builtFromShaPath: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-drift-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test"]);
    await git(repo, ["config", "user.name", "test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "hello");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
    distDir = path.join(repo, "tools", "ocean-bot", "dist");
    await fs.mkdir(distDir, { recursive: true });
    builtFromShaPath = path.join(distDir, ".built-from-sha");
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns drift=false when built-from-sha matches HEAD", async () => {
    const head = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(builtFromShaPath, head + "\n");

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.builtFromSha).toBe(head);
    expect(result.headSha).toBe(head);
    expect(result.branch).toBe("main");
    expect(result.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns drift=true reason=sha_mismatch when bot src changes after build", async () => {
    const builtSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(builtFromShaPath, builtSha + "\n");

    // Simulate a commit that DOES touch the bot binary.
    const botSrc = path.join(repo, "tools", "ocean-bot", "src");
    await fs.mkdir(botSrc, { recursive: true });
    await fs.writeFile(path.join(botSrc, "new-feature.ts"), "// feature");
    await git(repo, ["add", "tools/ocean-bot/src/new-feature.ts"]);
    await git(repo, ["commit", "-q", "-m", "bot src change"]);
    const newHead = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect(newHead).not.toBe(builtSha);

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(true);
    expect(result.reason).toBe("sha_mismatch");
    expect(result.builtFromSha).toBe(builtSha);
    expect(result.headSha).toBe(newHead);
  });

  it("downgrades to sha_mismatch_non_bot_paths when only docs/dashboard change", async () => {
    const builtSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(builtFromShaPath, builtSha + "\n");

    // Two commits in paths that DON'T affect the bot binary.
    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "note.md"), "planning");
    await git(repo, ["add", "docs/note.md"]);
    await git(repo, ["commit", "-q", "-m", "docs only"]);

    const dashDir = path.join(repo, "apps", "dashboard", "src", "lib");
    await fs.mkdir(dashDir, { recursive: true });
    await fs.writeFile(path.join(dashDir, "x.test.ts"), "// test pin");
    await git(repo, ["add", "apps/dashboard/src/lib/x.test.ts"]);
    await git(repo, ["commit", "-q", "-m", "dashboard test pin"]);

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(false);
    expect(result.reason).toBe("sha_mismatch_non_bot_paths");
    expect(result.nonBotPaths).toEqual(
      expect.arrayContaining(["docs/note.md", "apps/dashboard/src/lib/x.test.ts"]),
    );
  });

  it("returns drift=false when built is AHEAD of reference (claude's local WIP)", async () => {
    // Synthesize an `origin/main` remote tracking ref, then make a
    // local commit so HEAD is ahead of origin/main. Built-from-sha
    // points at the new local-only commit. Bot is "ahead of origin",
    // not behind. dist is fine, drift must NOT fire.
    // Regression for the bug shipped on 2026-05-16 where the symmetric
    // diff treated local WIP files as "drift" and caused a stale_dist
    // loop on first tick after restart.
    const initialSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    // Pretend `initialSha` is origin/main by creating a fake remote ref.
    await git(repo, ["update-ref", "refs/remotes/origin/main", initialSha]);

    // Local commit AHEAD of origin (claude's WIP-style commit).
    const botSrc = path.join(repo, "tools", "ocean-bot", "src");
    await fs.mkdir(botSrc, { recursive: true });
    await fs.writeFile(path.join(botSrc, "wip.ts"), "// claude wip");
    await git(repo, ["add", "tools/ocean-bot/src/wip.ts"]);
    await git(repo, ["commit", "-q", "-m", "bot run wip"]);
    const newHead = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(builtFromShaPath, newHead + "\n");

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(false);
    expect(result.reason).toBe(null);
    expect(result.builtFromSha).toBe(newHead);
    expect(result.headSha).toBe(newHead);
  });

  it("returns drift=true when a mixed range touches even one bot path", async () => {
    const builtSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(builtFromShaPath, builtSha + "\n");

    await fs.mkdir(path.join(repo, "docs"), { recursive: true });
    await fs.writeFile(path.join(repo, "docs", "x.md"), "doc");
    await git(repo, ["add", "docs/x.md"]);
    await git(repo, ["commit", "-q", "-m", "docs"]);

    const botSrc = path.join(repo, "tools", "ocean-bot", "src");
    await fs.mkdir(botSrc, { recursive: true });
    await fs.writeFile(path.join(botSrc, "tiny.ts"), "// tiny");
    await git(repo, ["add", "tools/ocean-bot/src/tiny.ts"]);
    await git(repo, ["commit", "-q", "-m", "bot src"]);

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(true);
    expect(result.reason).toBe("sha_mismatch");
  });

  it("returns drift=true reason=missing_built_from_sha when the file is absent", async () => {
    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(true);
    expect(result.reason).toBe("missing_built_from_sha");
    expect(result.builtFromSha).toBe(null);
  });

  it("returns drift=true reason=missing_built_from_sha when the file is empty", async () => {
    await fs.writeFile(builtFromShaPath, "");

    const result = await detectDrift(repo, builtFromShaPath);

    expect(result.drift).toBe(true);
    expect(result.reason).toBe("missing_built_from_sha");
  });

  it("returns drift=true reason=head_unreadable when the dir is not a git repo", async () => {
    const notARepo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-drift-norepo-"));
    try {
      await fs.writeFile(
        path.join(notARepo, ".built-from-sha"),
        "0123456789abcdef0123456789abcdef01234567\n",
      );
      const result = await detectDrift(
        notARepo,
        path.join(notARepo, ".built-from-sha"),
      );
      expect(result.drift).toBe(true);
      expect(result.reason).toBe("head_unreadable");
      expect(result.builtFromSha).toBe("0123456789abcdef0123456789abcdef01234567");
      expect(result.headSha).toBe(null);
    } finally {
      await fs.rm(notARepo, { recursive: true, force: true });
    }
  });
});

describe("resolveDriftPaths", () => {
  it("derives repo + sha paths from a dist-leaf dirname", () => {
    const dist = "/Users/foo/code2wiki/tools/ocean-bot/dist";
    const paths = resolveDriftPaths(dist);
    expect(paths).not.toBe(null);
    expect(paths!.repoDir).toBe("/Users/foo/code2wiki");
    expect(paths!.builtFromShaPath).toBe(
      "/Users/foo/code2wiki/tools/ocean-bot/dist/.built-from-sha",
    );
  });

  it("returns null when the dirname is not a dist leaf (dev / tsx)", () => {
    const src = "/Users/foo/code2wiki/tools/ocean-bot/src";
    expect(resolveDriftPaths(src)).toBe(null);
  });
});

describe("isBotAffectingPath", () => {
  it("matches bot src files", () => {
    expect(isBotAffectingPath("tools/ocean-bot/src/index.ts")).toBe(true);
    expect(isBotAffectingPath("tools/ocean-bot/src/adapters/code2wiki.ts")).toBe(true);
    expect(isBotAffectingPath("tools/ocean-bot/scripts/ocean-bot-launch.sh")).toBe(true);
    expect(isBotAffectingPath("tools/ocean-bot/package.json")).toBe(true);
    expect(isBotAffectingPath("tools/ocean-bot/tsconfig.build.json")).toBe(true);
  });

  it("does not match non-bot paths", () => {
    expect(isBotAffectingPath("apps/dashboard/src/lib/foo.ts")).toBe(false);
    expect(isBotAffectingPath("docs/roadmap.md")).toBe(false);
    expect(isBotAffectingPath("src/core/parsers/cfml.ts")).toBe(false);
    expect(isBotAffectingPath(".github/workflows/ci.yml")).toBe(false);
    expect(isBotAffectingPath("CLAUDE.md")).toBe(false);
    expect(isBotAffectingPath("tools/ocean-bot/dashboard/app/page.tsx")).toBe(false);
    expect(isBotAffectingPath("tools/ocean-bot/README.md")).toBe(false);
  });
});
