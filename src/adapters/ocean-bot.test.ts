import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OceanBotAdapter, isOceanBotOnly, BOT_SELF_PREFIX } from "./ocean-bot.js";
import { Code2wikiAdapter } from "./code2wiki.js";
import { git } from "../util/git.js";

async function mkRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-obot-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "CLAUDE.md"), "# code2wiki test repo\n");
  await fs.writeFile(path.join(repo, "package.json"), '{"name":"test"}\n');
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function mkBotAdapter(rootDir: string) {
  return new OceanBotAdapter({
    rootDir,
    memoryDir: path.join(rootDir, "memory"),
  });
}

function mkC2wAdapter(rootDir: string) {
  return new Code2wikiAdapter({
    rootDir,
    memoryDir: path.join(rootDir, "memory"),
  });
}

/** Helper: stage + commit a set of files (relative paths under rootDir),
 *  creating parent dirs as needed. */
async function commitFiles(
  rootDir: string,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<void> {
  for (const f of files) {
    const abs = path.join(rootDir, f.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content);
  }
  await git(rootDir, ["add", "."]);
  await git(rootDir, ["commit", "-q", "-m", message]);
}

describe("isOceanBotOnly (ownership decision rule)", () => {
  it("returns true for an all-ocean-bot diff", () => {
    expect(
      isOceanBotOnly([
        "tools/ocean-bot/src/runner.ts",
        "tools/ocean-bot/dashboard/app/page.tsx",
      ]),
    ).toBe(true);
  });

  it("returns false for a cross-cutting diff (mix of c2w + ocean-bot)", () => {
    expect(
      isOceanBotOnly([
        "tools/ocean-bot/src/runner.ts",
        "apps/dashboard/src/app/page.tsx",
      ]),
    ).toBe(false);
  });

  it("returns false for a c2w-only diff", () => {
    expect(isOceanBotOnly(["src/core/parsers/cfml.ts"])).toBe(false);
  });

  it("returns false for an empty file list (no signal)", () => {
    expect(isOceanBotOnly([])).toBe(false);
  });

  it("uses the shared BOT_SELF_PREFIX constant", () => {
    expect(BOT_SELF_PREFIX).toBe("tools/ocean-bot/");
  });
});

describe("OceanBotAdapter, identity", () => {
  it("exposes name='ocean-bot' + the shared repo paths", async () => {
    const repo = await mkRepo();
    try {
      const a = mkBotAdapter(repo);
      expect(a.name).toBe("ocean-bot");
      expect(a.rootDir).toBe(repo);
      expect(a.claudeMdPath).toBe(path.join(repo, "CLAUDE.md"));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("OceanBotAdapter, tightening", () => {
  it("surfaces TODOs in tools/ocean-bot/ source files only", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "tools/ocean-bot/src/runner.ts",
            content: "// TODO: extract claim helper\nconst x = 1;\n",
          },
        ],
        "bot: wip",
      );
      const cands = await mkBotAdapter(repo).tightening();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/tools\/ocean-bot\/src\/runner\.ts/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODOs in c2w source files (they belong to the c2w adapter)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "src/core/util/slug.ts",
            content: "// TODO: trim trailing dashes\nconst x = 1;\n",
          },
        ],
        "c2w: wip",
      );
      const cands = await mkBotAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("on a cross-cutting commit, only the ocean-bot file surfaces (mirror of the c2w bot-self test)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "src.ts",
            content: "// TODO: c2w hit (the c2w adapter handles this)\nconst a = 1;\n",
          },
          {
            path: "tools/ocean-bot/src/runner.ts",
            content: "// TODO: bot hit (the ocean-bot adapter handles this)\nconst b = 2;\n",
          },
        ],
        "mixed",
      );
      const botCands = await mkBotAdapter(repo).tightening();
      expect(botCands).toHaveLength(1);
      expect(botCands[0]?.summary).toMatch(/tools\/ocean-bot\/src\/runner\.ts/);
      expect(botCands[0]?.summary).not.toMatch(/^Resolve TODO\/FIXME in src\.ts/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("excludes test files inside tools/ocean-bot/ (fixture strings are not actionable)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "tools/ocean-bot/src/runner.test.ts",
            content: "// fixture: '// TODO: extract'\nconst x = 1;\n",
          },
        ],
        "bot: tests",
      );
      const cands = await mkBotAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("finds TODO in a single-line JSDoc comment inside ocean-bot source (/** TODO: ... */)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "tools/ocean-bot/src/runner.ts",
            content: "/** TODO: document this function */\nfunction foo() {}\n",
          },
        ],
        "bot: wip",
      );
      const cands = await mkBotAdapter(repo).tightening();
      expect(cands.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores 'todo' in a string literal inside ocean-bot source (taskId prefix / regex fragment)", async () => {
    // Pins the comment-anchored TIGHTENING_RE: a source file containing the
    // word in a string or descriptive comment is not an actionable item. The
    // self-match class hit 3× (6534dd8, d7beb73, a7902ae) because the old
    // whole-word regex matched string literals and prose mentions.
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          {
            path: "tools/ocean-bot/src/adapters/code2wiki.ts",
            content:
              "const taskId = `todo:${path}`;\n" +
              '// Contains "todo"/"fixme" labels for taskId prefixes.\n' +
              "const x = 1;\n",
          },
        ],
        "bot: wip",
      );
      const cands = await mkBotAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("OceanBotAdapter, gapClosure (ownership-filtered)", () => {
  it("surfaces gaps from a pure-ocean-bot commit", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [{ path: "tools/ocean-bot/src/runner.ts", content: "const x = 1;\n" }],
        "bot: fix claim race\n\nDid NOT verify: concurrent claim race against a real second runner",
      );
      const cands = await mkBotAdapter(repo).gapClosure();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/concurrent claim race/);
      expect(cands[0]?.summary).toMatch(/ocean-bot commit/);
      expect(cands[0]?.taskId).toMatch(/^gap:ocean-bot:/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores cross-cutting commits (c2w owns those gaps)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          { path: "tools/ocean-bot/src/runner.ts", content: "const x = 1;\n" },
          { path: "apps/dashboard/src/app/page.tsx", content: "export default function () { return null; }\n" },
        ],
        "mixed change\n\nDeferred: implement the per-project Stripe price split",
      );
      const cands = await mkBotAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores c2w-only commits", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [{ path: "src/core/parsers/cfml.ts", content: "export const x = 1;\n" }],
        "parser: BOM\n\nSkipped: deep nesting case in <cffunction>",
      );
      const cands = await mkBotAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter (post-split), ownership-aware queues", () => {
  it("gapClosure ignores pure-ocean-bot commits (now owned by OceanBotAdapter)", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [{ path: "tools/ocean-bot/src/runner.ts", content: "const x = 1;\n" }],
        "bot: fix\n\nDid NOT verify: a thing the bot might still get wrong",
      );
      const cands = await mkC2wAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("gapClosure still surfaces cross-cutting commits", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          { path: "tools/ocean-bot/src/runner.ts", content: "const x = 1;\n" },
          { path: "src/core/util/slug.ts", content: "export const x = 1;\n" },
        ],
        "mixed change\n\nDeferred: implement the Notion block-level diff",
      );
      const cands = await mkC2wAdapter(repo).gapClosure();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/Notion block-level diff/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("refactor ignores pure-ocean-bot commits with 3+ TS files", async () => {
    const repo = await mkRepo();
    try {
      await commitFiles(
        repo,
        [
          { path: "tools/ocean-bot/src/a.ts", content: "export const a = 1;\n" },
          { path: "tools/ocean-bot/src/b.ts", content: "export const b = 1;\n" },
          { path: "tools/ocean-bot/src/c.ts", content: "export const c = 1;\n" },
        ],
        "bot: big refactor",
      );
      const cands = await mkC2wAdapter(repo).refactor();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("OceanBotAdapter, push + preflight + visual + classifier", () => {
  it("pushTarget is always main", async () => {
    const repo = await mkRepo();
    try {
      expect(mkBotAdapter(repo).pushTarget("main")).toBe("main");
      expect(mkBotAdapter(repo).pushTarget("feature/foo")).toBe("main");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("preflightCommands are scoped to tools/ocean-bot", async () => {
    const repo = await mkRepo();
    try {
      const cmds = mkBotAdapter(repo).preflightCommands();
      expect(cmds.every((c) => c.includes("cd tools/ocean-bot &&"))).toBe(true);
      expect(cmds.some((c) => c.includes("npm test"))).toBe(true);
      expect(cmds.some((c) => c.includes("npm run typecheck"))).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("classifyDanger trips rule 11 on ANY ocean-bot edit (whole adapter is bot self-mod)", async () => {
    const repo = await mkRepo();
    try {
      const reasons = mkBotAdapter(repo).classifyDanger({
        files: ["tools/ocean-bot/src/runner.ts"],
        added: 3,
        removed: 1,
        patch: "+const y = 2;",
      });
      expect(reasons.map((r) => r.ruleId)).toContain(11);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("visualSurfaces returns [] for non-dashboard diffs", async () => {
    const repo = await mkRepo();
    try {
      const out = await mkBotAdapter(repo).visualSurfaces({
        files: ["tools/ocean-bot/src/runner.ts"],
        added: 5,
        removed: 0,
        patch: "",
      });
      expect(out).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("visualSurfaces returns desktop + mobile when OCEAN_BOT_DASHBOARD_URL is set and dashboard touched", async () => {
    const repo = await mkRepo();
    const orig = process.env["OCEAN_BOT_DASHBOARD_URL"];
    process.env["OCEAN_BOT_DASHBOARD_URL"] = "http://localhost:4321";
    try {
      const out = await mkBotAdapter(repo).visualSurfaces({
        files: ["tools/ocean-bot/dashboard/app/page.tsx"],
        added: 1,
        removed: 0,
        patch: "",
      });
      expect(out).toHaveLength(2);
      expect(out.find((s) => s.viewport === "desktop")).toBeDefined();
      expect(out.find((s) => s.viewport === "mobile")).toBeDefined();
    } finally {
      if (orig === undefined) delete process.env["OCEAN_BOT_DASHBOARD_URL"];
      else process.env["OCEAN_BOT_DASHBOARD_URL"] = orig;
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("roadmap + selfLearning + creative are intentionally empty (host project owns those)", async () => {
    const repo = await mkRepo();
    try {
      const a = mkBotAdapter(repo);
      expect(await a.roadmap()).toEqual([]);
      expect(await a.selfLearning()).toEqual([]);
      expect(await a.creative()).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("OceanBotAdapter, backlog appendix in refactor()", () => {
  async function mkRepoWithBotRefactorCommit(rootDir: string): Promise<void> {
    await commitFiles(
      rootDir,
      [
        { path: "tools/ocean-bot/src/a.ts", content: "export const a = 1;\n" },
        { path: "tools/ocean-bot/src/b.ts", content: "export const b = 1;\n" },
        { path: "tools/ocean-bot/src/c.ts", content: "export const c = 1;\n" },
      ],
      "bot: big refactor",
    );
  }

  it("appendix present when open ids exist", async () => {
    const repo = await mkRepo();
    try {
      await mkRepoWithBotRefactorCommit(repo);
      const a = new OceanBotAdapter({
        rootDir: repo,
        memoryDir: path.join(repo, "memory"),
        listOpenBacklogIds: async () => [
          { id: "fix-scout-timeout", title: "Fix scout timeout on slow Claude" },
          { id: "health-sweep-stuck", title: "Health sweep stuck loop fix" },
        ],
      });
      const cands = await a.refactor();
      expect(cands).toHaveLength(1);
      expect(cands[0]!.summary).toMatch(/Currently open backlog items:/);
      expect(cands[0]!.summary).toMatch(/fix-scout-timeout: Fix scout timeout on slow Claude/);
      expect(cands[0]!.summary).toMatch(/health-sweep-stuck: Health sweep stuck loop fix/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("appendix absent when list is empty", async () => {
    const repo = await mkRepo();
    try {
      await mkRepoWithBotRefactorCommit(repo);
      const a = new OceanBotAdapter({
        rootDir: repo,
        memoryDir: path.join(repo, "memory"),
        listOpenBacklogIds: async () => [],
      });
      const cands = await a.refactor();
      expect(cands).toHaveLength(1);
      expect(cands[0]!.summary).not.toMatch(/Currently open backlog items:/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("list truncated to 20 when stub returns more", async () => {
    const repo = await mkRepo();
    try {
      await mkRepoWithBotRefactorCommit(repo);
      const items = Array.from({ length: 25 }, (_, i) => ({
        id: `item-${i}`,
        title: `Task ${i}`,
      }));
      const a = new OceanBotAdapter({
        rootDir: repo,
        memoryDir: path.join(repo, "memory"),
        listOpenBacklogIds: async () => items,
      });
      const cands = await a.refactor();
      expect(cands).toHaveLength(1);
      const bulletLines = cands[0]!.summary
        .split("\n")
        .filter((l) => /^- item-\d+:/.test(l));
      expect(bulletLines).toHaveLength(20);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
