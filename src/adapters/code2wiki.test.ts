import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Code2wikiAdapter } from "./code2wiki.js";
import { git } from "../util/git.js";

async function mkRepo(): Promise<string> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "ob-c2w-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@t"]);
  await git(repo, ["config", "user.name", "t"]);
  await fs.writeFile(path.join(repo, "CLAUDE.md"), "# code2wiki test repo\n");
  await fs.writeFile(path.join(repo, "package.json"), '{"name":"test","scripts":{"test":"echo no tests","typecheck":"true"}}\n');
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "init"]);
  return repo;
}

function mkAdapter(rootDir: string, opts: { lastCreativeAuditAt?: number } = {}) {
  return new Code2wikiAdapter({
    rootDir,
    memoryDir: path.join(rootDir, "memory"),
    lastCreativeAuditAt: opts.lastCreativeAuditAt,
  });
}

describe("Code2wikiAdapter, identity", () => {
  it("exposes name + paths", async () => {
    const repo = await mkRepo();
    try {
      const a = mkAdapter(repo);
      expect(a.name).toBe("code2wiki");
      expect(a.rootDir).toBe(repo);
      expect(a.claudeMdPath).toBe(path.join(repo, "CLAUDE.md"));
      expect(a.memoryDir).toBe(path.join(repo, "memory"));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

// ----- backlog(), integration test against test Postgres -----------------

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;
process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL ?? "postgres://invalid";

D("Code2wikiAdapter, backlog (DB-backed)", () => {
  beforeEach(async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    await c.query("TRUNCATE ocean_bot_backlog_item RESTART IDENTITY CASCADE;");
    await c.end();
  });

  it("returns empty when no rows exist for this project", async () => {
    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).backlog();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("picks top 3 open items by priority ascending, position-boosted", async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      // Insert 5 rows with priorities 1..5, only top 3 should surface.
      for (let i = 1; i <= 5; i++) {
        await c.query(
          `INSERT INTO ocean_bot_backlog_item
             (id, project, category, title, priority, status)
           VALUES ($1, 'code2wiki', 'bug', $2, $3, 'open')`,
          [`B${i}`, `task ${i}`, i],
        );
      }
    } finally {
      await c.end();
    }

    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).backlog();
      expect(cands.length).toBe(3);
      // Order matches priority ascending.
      expect(cands[0]?.summary).toMatch(/task 1/);
      expect(cands[1]?.summary).toMatch(/task 2/);
      expect(cands[2]?.summary).toMatch(/task 3/);
      // Position-boosted leverage: 85, 83, 81 (+5/+3/+1).
      expect(cands[0]?.leverage).toBe(85);
      expect(cands[1]?.leverage).toBe(83);
      expect(cands[2]?.leverage).toBe(81);
      // taskId carries the row id for dedup.
      expect(cands[0]?.taskId).toBe("backlog:B1");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("excludes done/archived/in-progress (only 'open')", async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      const rows = [
        ["O", "open"],
        ["D", "done"],
        ["A", "archived"],
        ["I", "in-progress"],
      ];
      for (const [id, status] of rows) {
        await c.query(
          `INSERT INTO ocean_bot_backlog_item
             (id, project, category, title, priority, status)
           VALUES ($1, 'code2wiki', 'bug', 'x', 1, $2)`,
          [id, status],
        );
      }
    } finally {
      await c.end();
    }

    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).backlog();
      expect(cands.length).toBe(1);
      expect(cands[0]?.taskId).toBe("backlog:O");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("scopes to this.name (code2wiki), ignores other projects", async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      await c.query(
        `INSERT INTO ocean_bot_backlog_item (id, project, category, title, priority, status)
         VALUES ('CAS', 'cas', 'bug', 'x', 1, 'open'),
                ('OWN', 'code2wiki', 'bug', 'y', 1, 'open')`,
      );
    } finally {
      await c.end();
    }

    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).backlog();
      expect(cands.map((c) => c.taskId)).toEqual(["backlog:OWN"]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("marks long descriptions as complex (routes to opus)", async () => {
    if (!TEST_URL) return;
    const { Client } = await import("pg");
    const c = new Client({ connectionString: TEST_URL });
    await c.connect();
    try {
      const longDesc = "x".repeat(300);
      await c.query(
        `INSERT INTO ocean_bot_backlog_item (id, project, category, title, description, priority, status)
         VALUES ('L', 'code2wiki', 'bug', 'x', $1, 1, 'open')`,
        [longDesc],
      );
    } finally {
      await c.end();
    }

    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).backlog();
      expect(cands[0]?.complex).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, CLAUDE.md section hints", () => {
  // The hint should appear at the top of the prompt so claude reads it before
  // the task body. Empty-hint categories (e.g. "other") skip the prefix line.

  D("backlog rows surface the per-category hint", () => {
    beforeEach(async () => {
      if (!TEST_URL) return;
      const { Client } = await import("pg");
      const c = new Client({ connectionString: TEST_URL });
      await c.connect();
      await c.query("TRUNCATE ocean_bot_backlog_item RESTART IDENTITY CASCADE;");
      await c.end();
    });

    // One row per category that has a non-empty hint, plus "other" which
    // must omit the prefix line entirely.
    const cases: Array<{ category: string; expect: RegExp | null }> = [
      { category: "docs", expect: /Where things live, Code style/ },
      { category: "chore", expect: /Where things live\./ },
      { category: "test", expect: /Code style, Testing/ },
      { category: "bug", expect: /Default code-change workflow, Rigor/ },
      { category: "feature", expect: /Default code-change workflow, Active design work/ },
      { category: "refactor", expect: /Default code-change workflow\./ },
      { category: "roadmap", expect: /Active design work, Honest-completion/ },
      { category: "other", expect: null },
    ];

    for (const tc of cases) {
      it(`category=${tc.category} ${tc.expect ? "prepends hint" : "omits hint"}`, async () => {
        if (!TEST_URL) return;
        const { Client } = await import("pg");
        const c = new Client({ connectionString: TEST_URL });
        await c.connect();
        try {
          await c.query("TRUNCATE ocean_bot_backlog_item RESTART IDENTITY CASCADE;");
          await c.query(
            `INSERT INTO ocean_bot_backlog_item (id, project, category, title, priority, status)
             VALUES ($1, 'code2wiki', $2, 'sample title', 1, 'open')`,
            [`T-${tc.category}`, tc.category],
          );
        } finally {
          await c.end();
        }
        const repo = await mkRepo();
        try {
          const cands = await mkAdapter(repo).backlog();
          expect(cands).toHaveLength(1);
          const s = cands[0]!.summary;
          if (tc.expect) {
            expect(s).toMatch(/^CLAUDE\.md sections most relevant for this task:/);
            expect(s).toMatch(tc.expect);
          } else {
            expect(s).not.toMatch(/^CLAUDE\.md sections most relevant/);
          }
          // Task body is still present regardless.
          expect(s).toMatch(/Backlog \(.+\): sample title/);
        } finally {
          await fs.rm(repo, { recursive: true, force: true });
        }
      });
    }
  });

  it("roadmap queue maps to the roadmap-category hint", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        "- [ ] Implement Notion publisher\n",
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toHaveLength(1);
      expect(cands[0]!.summary).toMatch(
        /^CLAUDE\.md sections most relevant for this task: Active design work, Honest-completion\./,
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("tightening queue maps to the refactor-category hint", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "src.ts"),
        "// TODO: extract this helper\nconst x = 1;\n",
      );
      await git(repo, ["add", "src.ts"]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands.length).toBeGreaterThanOrEqual(1);
      expect(cands[0]!.summary).toMatch(
        /^CLAUDE\.md sections most relevant for this task: Default code-change workflow\./,
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("gap-closure queue maps to the bug-category hint", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "fix bug\n\nDid NOT verify: the rebase path against a concurrent commit",
      ]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands.length).toBeGreaterThanOrEqual(1);
      expect(cands[0]!.summary).toMatch(
        /^CLAUDE\.md sections most relevant for this task: Default code-change workflow, Rigor\./,
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("creative queue (category=other) omits the hint prefix", async () => {
    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo, { lastCreativeAuditAt: 0 }).creative();
      expect(cands).toHaveLength(1);
      expect(cands[0]!.summary).not.toMatch(/^CLAUDE\.md sections most relevant/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, gapClosure", () => {
  it("extracts gaps from recent commit messages", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "fix bug\n\nDid NOT verify: the rebase-on-push path against a real concurrent commit",
      ]);

      const cands = await mkAdapter(repo).gapClosure();
      expect(cands.length).toBeGreaterThanOrEqual(1);
      expect(cands[0]?.queue).toBe("gap-closure");
      expect(cands[0]?.summary).toMatch(/rebase-on-push path/);
      expect(cands[0]?.leverage).toBe(70);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores 'none' gap markers", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "ship feature\n\nGaps: none, observed end-to-end",
      ]);

      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("recognizes Skipped / Memory-only / Deferred markers", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "work\n\nSkipped: the concurrent-claim test\nMemory-only: prod URL\nDeferred: replay v2",
      ]);

      const cands = await mkAdapter(repo).gapClosure();
      const summaries = cands.map((c) => c.summary).join("\n");
      expect(summaries).toMatch(/concurrent-claim test/);
      expect(summaries).toMatch(/prod URL/);
      expect(summaries).toMatch(/replay v2/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores mid-sentence 'did NOT' (no colon, no line anchor)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "fix middleware\n\nthe single-user gate did NOT run on first prod deploy and the dashboard let everyone hit / unauthenticated.",
      ]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects punctuation-only captures (e.g., stray semicolon)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "wip\n\nDeferred: ;",
      ]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects too-short captures (TBD / x / single word with no real content)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      // "TBD" is 3 chars + 3 letters, fails both length≥5 and letters≥4.
      await git(repo, ["commit", "-q", "-m", "wip\n\nSkipped: TBD"]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects capture fragments that start with code punctuation", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "test: 17-case unit test\n\nDeferred: (was 485 | 'src/foo' )",
      ]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("accepts bullet-prefixed gap markers (- Deferred: …)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, [
        "commit",
        "-q",
        "-m",
        "ship\n\n- Deferred: implement Notion block-level diff",
      ]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands.length).toBe(1);
      expect(cands[0]?.summary).toMatch(/Notion block-level diff/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("truncates very long captures to 240 chars", async () => {
    const repo = await mkRepo();
    try {
      const long = "x".repeat(500);
      await fs.writeFile(path.join(repo, "a.txt"), "x");
      await git(repo, ["add", "a.txt"]);
      await git(repo, ["commit", "-q", "-m", `wip\n\nDeferred: ${long}`]);
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands.length).toBe(1);
      // 240-char body cap + ~41-char gap prefix + ~86-char section-hint
      // prefix; <400 still catches a regression that drops the cap (would
      // run to 500+).
      expect(cands[0]?.summary.length).toBeLessThan(400);
      expect(cands[0]?.summary).toMatch(/…$/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("returns empty for a repo with no gap-marker commits", async () => {
    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).gapClosure();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, roadmap", () => {
  it("returns up to 3 unchecked items with position-boosted leverage", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        [
          "# Roadmap",
          "- [ ] First item",
          "- [ ] Second item",
          "- [ ] Third item",
          "- [ ] Fourth item",
          "- [x] Done item",
        ].join("\n"),
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toHaveLength(3);
      expect(cands[0]?.summary).toMatch(/First item/);
      expect(cands[0]?.leverage).toBe(60); // 50 + 10 boost
      expect(cands[1]?.leverage).toBe(57); // 50 + 7 boost
      expect(cands[2]?.leverage).toBe(54); // 50 + 4 boost
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("skips [manual] / [needs-design] / [blocked] / [wip] items", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        [
          "- [ ] [manual] only Ocean can do this",
          "- [ ] [needs-design] not yet specced",
          "- [ ] [BLOCKED] waiting on legal",
          "- [ ] [wip] in flight",
          "- [ ] auto-shippable item",
        ].join("\n"),
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/auto-shippable/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("flags long items as complex (routes to opus + bigger token budget)", async () => {
    const repo = await mkRepo();
    try {
      const longText = "x".repeat(200);
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        `- [ ] ${longText}\n`,
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands[0]?.complex).toBe(true);
      expect(cands[0]?.estTokens).toBe(60_000);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("returns empty when docs/roadmap.md doesn't exist", async () => {
    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("skips items tagged <!-- bot: operator-only -->", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        [
          "- [ ] Land at $495 MRR baseline by week 5 <!-- bot: operator-only -->",
          "- [ ] Onboard 5 at $99/mo founder-tier <!-- bot: operator-only -->",
          "- [ ] Implement Notion publisher",
        ].join("\n"),
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/Notion publisher/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("tolerates whitespace variations in the operator-only marker", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "roadmap.md"),
        [
          "- [ ] item A <!--bot:operator-only-->",
          "- [ ] item B <!--  bot:   operator-only  -->",
          "- [ ] item C <!-- BOT: OPERATOR-ONLY -->",
          "- [ ] item D (bot-eligible)",
        ].join("\n"),
      );
      const cands = await mkAdapter(repo).roadmap();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/item D/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, tightening", () => {
  it("finds TODO / FIXME in files changed in the last week", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "src.ts"),
        "// TODO: extract this helper\nconst x = 1;\n",
      );
      await git(repo, ["add", "src.ts"]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands.length).toBeGreaterThanOrEqual(1);
      expect(cands[0]?.summary).toMatch(/TODO\/FIXME/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODO/FIXME inside test files (*.test.ts fixtures)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "src.test.ts"),
        "// fixture: '// TODO: extract this'\nconst x = 1;\n",
      );
      await git(repo, ["add", "src.test.ts"]);
      await git(repo, ["commit", "-q", "-m", "add test"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODO/FIXME inside the bot's own source (tools/ocean-bot/)", async () => {
    // Pins the bot-self exclusion in tightening(): the bot's adapter source
    // contains TODO/FIXME/XXX as regex literal + summary strings, not as
    // actionable work items. A regression dropping the !startsWith filter
    // would resurface the false-positive loop the bd15be0 fix closed.
    // Path covers the prod bot-self path; sibling test above pins the
    // test-file filter so the two filters can't be conflated.
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "tools", "ocean-bot", "src", "adapters"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(repo, "tools", "ocean-bot", "src", "adapters", "code2wiki.ts"),
        "// FIXME: pattern literal inside the bot itself\nconst x = 1;\n",
      );
      await git(repo, ["add", "tools/ocean-bot"]);
      await git(repo, ["commit", "-q", "-m", "bot: add adapter"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODO/FIXME inside markdown files (docs/*.md prose)", async () => {
    // Pins the JS/TS allowlist in tightening(): .md files are not JS/TS so
    // they never enter the scan, regardless of content (docs use "todo"/"fixme"
    // descriptively and the regex is case-insensitive).
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "docs", "spec.md"),
        "- Unresolved marker comments (`todo`/`fixme`) added but not closed\n",
      );
      await git(repo, ["add", "docs/spec.md"]);
      await git(repo, ["commit", "-q", "-m", "docs: add spec"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODO/FIXME hits inside .gitignore files (filename patterns are not work items)", async () => {
    // Pins the JS/TS allowlist in tightening(): .gitignore is not a JS/TS
    // file so it never enters the scan -- patterns like `TODO.local.md` are
    // legitimate ignore rules, not actionable work items.
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, ".gitignore"),
        "node_modules/\nTODO.local.md\n*.FIXME\n",
      );
      await git(repo, ["add", ".gitignore"]);
      await git(repo, ["commit", "-q", "-m", "chore: update gitignore"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("still flags TODO/FIXME in legitimate source files when bot-self files are also touched", async () => {
    // Mixed-commit case: the bot edits a sibling tools/ocean-bot/ file in
    // the same commit window as a legitimate source TODO. Pins that the
    // bot-self filter scopes per-file, not per-commit -- a regex regression
    // accidentally excluding the entire window would silently lose
    // tightening signal whenever the bot was active.
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "tools", "ocean-bot", "src"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(repo, "src.ts"),
        "// TODO: extract this helper\nconst x = 1;\n",
      );
      await fs.writeFile(
        path.join(repo, "tools", "ocean-bot", "src", "runner.ts"),
        "// TODO: should be ignored (bot-self)\nconst y = 2;\n",
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-q", "-m", "mixed touches"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/src\.ts/);
      expect(cands[0]?.summary).not.toMatch(/runner\.ts/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("scans .mjs source files (ESM helper scripts like tools/pr-summary.mjs)", async () => {
    // Pins the [cm]? prefix in the JS/TS allowlist. .mjs files are real JS
    // sources in this repo (tools/check-key.mjs, tools/pr-summary.mjs,
    // tools/dashboard/server.mjs, apps/dashboard/next.config.mjs,
    // tools/ocean-bot/dashboard/next.config.mjs, scripts/gen-baseline-
    // snapshots.mjs). A regression narrowing the regex back to /\.[jt]sx?$/
    // would silently drop these from the tightening scan.
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "tools"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "tools", "pr-summary.mjs"),
        "// TODO: surface skipped audit entries\nconst x = 1;\n",
      );
      await git(repo, ["add", "tools/pr-summary.mjs"]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.summary).toMatch(/pr-summary\.mjs/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("scans .cjs / .mts / .cts source files (CommonJS + TS module variants)", async () => {
    // Pins the [cm]? prefix from the other three sides: a regex regression
    // matching only .mjs (e.g., /\.m?[jt]sx?$/) would silently drop .cjs +
    // .cts + .mts files. Single test exercises all three to keep the suite
    // tight.
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "legacy.cjs"),
        "// FIXME: migrate to ESM\nmodule.exports = {};\n",
      );
      await fs.writeFile(
        path.join(repo, "lib.mts"),
        "// TODO: split into smaller modules\nexport const x = 1;\n",
      );
      await fs.writeFile(
        path.join(repo, "config.cts"),
        "// XXX: hardcoded for dev only\nexport const port = 3000;\n",
      );
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toHaveLength(3);
      const summaries = cands.map((c) => c.summary).join("\n");
      expect(summaries).toMatch(/legacy\.cjs/);
      expect(summaries).toMatch(/lib\.mts/);
      expect(summaries).toMatch(/config\.cts/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores TODO/FIXME inside *.test.mjs fixtures (test-file filter handles the [cm]? prefix too)", async () => {
    // Pins that the test-file exclusion regex grew its own [cm]? prefix
    // alongside the source allowlist. tools/pr-summary.test.mjs is a real
    // test file in this repo; a regression dropping the [cm]? on the test
    // filter would let it leak in as scanned source whenever its fixture
    // strings happened to match the TODO/FIXME regex.
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "tools"), { recursive: true });
      await fs.writeFile(
        path.join(repo, "tools", "pr-summary.test.mjs"),
        "// fixture: '// TODO: extract this'\nconst x = 1;\n",
      );
      await git(repo, ["add", "tools/pr-summary.test.mjs"]);
      await git(repo, ["commit", "-q", "-m", "add test"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("returns empty when no TODOs in recently-changed files", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(path.join(repo, "clean.ts"), "const x = 1;\n");
      await git(repo, ["add", "clean.ts"]);
      await git(repo, ["commit", "-q", "-m", "clean"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("finds TODO in a single-line JSDoc comment (/** TODO: ... */)", async () => {
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "src.ts"),
        "/** TODO: document this function */\nfunction foo() {}\n",
      );
      await git(repo, ["add", "src.ts"]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands.length).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("ignores 'todo' in a string literal (e.g. taskId prefix `todo:${f}`)", async () => {
    // Pins the comment-anchored TIGHTENING_RE: a source file that uses the
    // word as a string prefix or variable name is not an actionable item. The
    // scanner self-queued itself 3× (6534dd8, d7beb73, a7902ae) until the
    // regex was tightened to require a comment delimiter before the marker.
    const repo = await mkRepo();
    try {
      await fs.writeFile(
        path.join(repo, "scheduler.ts"),
        // Contains "todo" in a string template and in a descriptive comment,
        // but NOT as a //TODO or /* TODO action marker.
        "const taskId = `todo:${path}`;\n" +
          '// Contains "todo"/"fixme" labels for taskId prefixes.\n' +
          "const x = 1;\n",
      );
      await git(repo, ["add", "scheduler.ts"]);
      await git(repo, ["commit", "-q", "-m", "wip"]);
      const cands = await mkAdapter(repo).tightening();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, selfLearning", () => {
  it("reads docs/self-learning.md and surfaces up to 2 unchecked items", async () => {
    const repo = await mkRepo();
    try {
      await fs.mkdir(path.join(repo, "docs"));
      await fs.writeFile(
        path.join(repo, "docs", "self-learning.md"),
        [
          "- [ ] Wire signal #1 edit-back diff",
          "- [ ] Wire signal #2 validator examples",
          "- [ ] Wire signal #3 confidence observation",
        ].join("\n"),
      );
      const cands = await mkAdapter(repo).selfLearning();
      expect(cands).toHaveLength(2);
      expect(cands[0]?.summary).toMatch(/signal #1/);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, creative", () => {
  it("returns a creative-audit candidate when no recent audit", async () => {
    const repo = await mkRepo();
    try {
      const cands = await mkAdapter(repo, { lastCreativeAuditAt: 0 }).creative();
      expect(cands).toHaveLength(1);
      expect(cands[0]?.queue).toBe("creative");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("returns empty when last audit was < 24h ago", async () => {
    const repo = await mkRepo();
    try {
      const recent = Date.now() - 60 * 1000;
      const cands = await mkAdapter(repo, { lastCreativeAuditAt: recent }).creative();
      expect(cands).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, danger classification", () => {
  it("delegates to classifier with code2wiki paths (publishers → rule 1)", async () => {
    const repo = await mkRepo();
    try {
      const reasons = mkAdapter(repo).classifyDanger({
        files: ["src/core/publishers/confluence.ts"],
        added: 5,
        removed: 0,
        patch: "+const x = 1;",
      });
      expect(reasons.map((r) => r.ruleId)).toContain(1);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("flags bot self-modification (rule 11)", async () => {
    const repo = await mkRepo();
    try {
      const reasons = mkAdapter(repo).classifyDanger({
        files: ["tools/ocean-bot/src/queue.ts"],
        added: 3,
        removed: 1,
        patch: "+const y = 2;",
      });
      expect(reasons.map((r) => r.ruleId)).toContain(11);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("returns empty for a safe diff", async () => {
    const repo = await mkRepo();
    try {
      const reasons = mkAdapter(repo).classifyDanger({
        files: ["src/core/util/slug.ts"],
        added: 3,
        removed: 1,
        patch: "+// trim dashes\n",
      });
      expect(reasons).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("Code2wikiAdapter, push + preflight + visual", () => {
  it("pushTarget is always main for code2wiki", async () => {
    const repo = await mkRepo();
    try {
      expect(mkAdapter(repo).pushTarget("main")).toBe("main");
      expect(mkAdapter(repo).pushTarget("feature/foo")).toBe("main");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("preflightCommands runs tests + typecheck", async () => {
    const repo = await mkRepo();
    try {
      const cmds = mkAdapter(repo).preflightCommands();
      expect(cmds).toContain("npm test --silent");
      expect(cmds).toContain("npm run typecheck");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("visualSurfaces returns [] for non-dashboard diffs", async () => {
    const repo = await mkRepo();
    try {
      const out = await mkAdapter(repo).visualSurfaces({
        files: ["src/core/parsers/cfml.ts"],
        added: 5,
        removed: 0,
        patch: "",
      });
      expect(out).toEqual([]);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("visualSurfaces returns [] for dashboard diffs without URL env (opt-in)", async () => {
    const repo = await mkRepo();
    const origUrl = process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"];
    delete process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"];
    try {
      const out = await mkAdapter(repo).visualSurfaces({
        files: ["apps/dashboard/src/app/page.tsx"],
        added: 5,
        removed: 0,
        patch: "",
      });
      expect(out).toEqual([]);
    } finally {
      if (origUrl !== undefined) process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"] = origUrl;
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("visualSurfaces returns desktop + mobile when env is set", async () => {
    const repo = await mkRepo();
    const origUrl = process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"];
    process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"] = "http://localhost:3001";
    try {
      const out = await mkAdapter(repo).visualSurfaces({
        files: ["apps/dashboard/src/app/page.tsx"],
        added: 5,
        removed: 0,
        patch: "",
      });
      expect(out).toHaveLength(2);
      expect(out.find((s) => s.viewport === "desktop")).toBeDefined();
      expect(out.find((s) => s.viewport === "mobile")).toBeDefined();
    } finally {
      if (origUrl === undefined) delete process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"];
      else process.env["OCEAN_BOT_CODE2WIKI_DASHBOARD_URL"] = origUrl;
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
