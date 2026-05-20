import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  git,
  isClean,
  currentBranch,
  headSha,
  parseGitDiff,
  commitReachable,
  stashUncommittedToRef,
} from "./git.js";

describe("isClean, untracked files don't count as dirty", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-git-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test"]);
    await git(repo, ["config", "user.name", "test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "hello");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns true on a fresh repo", async () => {
    expect(await isClean(repo)).toBe(true);
  });

  it("returns true when only untracked files exist (dist/, node_modules/)", async () => {
    await fs.mkdir(path.join(repo, "dist"));
    await fs.writeFile(path.join(repo, "dist", "build.js"), "compiled output");
    expect(await isClean(repo)).toBe(true);
  });

  it("returns false when a tracked file is modified", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "different content");
    expect(await isClean(repo)).toBe(false);
  });

  it("returns false when a new file is added to the index", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "new file");
    await git(repo, ["add", "b.txt"]);
    expect(await isClean(repo)).toBe(false);
  });

  it("currentBranch returns the branch name", async () => {
    expect(await currentBranch(repo)).toBe("main");
  });

  it("headSha returns a non-empty sha", async () => {
    const sha = await headSha(repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("commitReachable", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-reach-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test"]);
    await git(repo, ["config", "user.name", "test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "hello");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns true for HEAD reachable from itself", async () => {
    const sha = await headSha(repo);
    expect(await commitReachable(repo, sha, "main")).toBe(true);
  });

  it("returns true for an ancestor reachable from current HEAD", async () => {
    const oldSha = await headSha(repo);
    await fs.writeFile(path.join(repo, "b.txt"), "second");
    await git(repo, ["add", "b.txt"]);
    await git(repo, ["commit", "-q", "-m", "second"]);
    expect(await commitReachable(repo, oldSha, "main")).toBe(true);
  });

  it("returns false for a commit no longer reachable after reset", async () => {
    const firstSha = await headSha(repo);
    await fs.writeFile(path.join(repo, "b.txt"), "second");
    await git(repo, ["add", "b.txt"]);
    await git(repo, ["commit", "-q", "-m", "second"]);
    const secondSha = await headSha(repo);
    // Reset back to the first commit, second commit is now orphaned.
    await git(repo, ["reset", "--hard", firstSha]);
    expect(await commitReachable(repo, secondSha, "main")).toBe(false);
  });

  it("returns false for a sha that doesn't exist in the repo", async () => {
    expect(
      await commitReachable(repo, "0000000000000000000000000000000000000000", "main"),
    ).toBe(false);
  });
});

describe("parseGitDiff", () => {
  it("returns empty for a clean diff", () => {
    const d = parseGitDiff({ code: 0, stdout: "", stderr: "" });
    expect(d.files).toEqual([]);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it("counts adds and removes in hunks", () => {
    const sample = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "+added line",
      "+another added",
      "-removed line",
    ].join("\n");
    const d = parseGitDiff({ code: 0, stdout: sample, stderr: "" });
    expect(d.files).toEqual(["foo.ts"]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });

  it("captures multiple touched files", () => {
    const sample = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "+a",
      "-b",
      "diff --git a/y.ts b/y.ts",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "+c",
    ].join("\n");
    const d = parseGitDiff({ code: 0, stdout: sample, stderr: "" });
    expect(d.files.sort()).toEqual(["x.ts", "y.ts"]);
    expect(d.added).toBe(2);
    expect(d.removed).toBe(1);
  });
});

describe("stashUncommittedToRef", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-stash-"));
    await git(repo, ["init", "-q", "-b", "main"]);
    await git(repo, ["config", "user.email", "test@test"]);
    await git(repo, ["config", "user.name", "test"]);
    await fs.writeFile(path.join(repo, "a.txt"), "hello");
    await git(repo, ["add", "a.txt"]);
    await git(repo, ["commit", "-q", "-m", "init"]);
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("returns {stashed:false} on a clean tree (no-op)", async () => {
    const r = await stashUncommittedToRef(
      repo,
      "refs/ocean-bot/orphan-edits/clean",
    );
    expect(r.stashed).toBe(false);
    expect(r.sha).toBe(null);
    expect(r.changedFiles).toBe(0);
  });

  it("stashes a modified tracked file, resets tree clean, persists ref", async () => {
    await fs.writeFile(path.join(repo, "a.txt"), "modified");
    const refName = "refs/ocean-bot/orphan-edits/run-1";
    const r = await stashUncommittedToRef(repo, refName);
    expect(r.stashed).toBe(true);
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.changedFiles).toBe(1);
    // Working tree resets to HEAD.
    expect(await isClean(repo)).toBe(true);
    const restored = await fs.readFile(path.join(repo, "a.txt"), "utf-8");
    expect(restored).toBe("hello");
    // The ref points at the stash commit, and the stash carries the
    // pre-reset content.
    const ref = await git(repo, ["rev-parse", refName]);
    expect(ref.stdout.trim()).toBe(r.sha);
    const show = await git(repo, ["show", `${refName}:a.txt`]);
    expect(show.stdout).toBe("modified");
  });

  it("counts multiple modified tracked files", async () => {
    await fs.writeFile(path.join(repo, "b.txt"), "second");
    await git(repo, ["add", "b.txt"]);
    await git(repo, ["commit", "-q", "-m", "add b"]);
    await fs.writeFile(path.join(repo, "a.txt"), "mod-a");
    await fs.writeFile(path.join(repo, "b.txt"), "mod-b");
    const r = await stashUncommittedToRef(
      repo,
      "refs/ocean-bot/orphan-edits/run-2",
    );
    expect(r.stashed).toBe(true);
    expect(r.changedFiles).toBe(2);
    expect(await isClean(repo)).toBe(true);
  });

  it("ignores untracked-only state (matches isClean policy)", async () => {
    await fs.writeFile(path.join(repo, "untracked.txt"), "noise");
    const r = await stashUncommittedToRef(
      repo,
      "refs/ocean-bot/orphan-edits/run-3",
    );
    expect(r.stashed).toBe(false);
    // Untracked file is left alone.
    expect(
      await fs.readFile(path.join(repo, "untracked.txt"), "utf-8"),
    ).toBe("noise");
  });
});
