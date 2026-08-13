import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Regression guard for the project's no-em-dash style rule (U+2014).
//
// The Python pre-commit check (tools/scripts/strip-em-dashes.py in the
// origin monorepo) deliberately excludes the ocean-bot subtree, because
// edits to the bot are treated as higher-risk and routed through review
// rather than through automated rewriting. The consequence is that nothing
// enforced the rule here: the bot core had accumulated 23 em dashes across
// 9 files while the sibling dashboard, which has had this exact guard for
// months, had zero.
//
// This mirrors dashboard/src/em-dash.test.ts. Scope is the bot's own
// authored source: src/ and scripts/. node_modules, dist, and build output
// are vendored or generated.
//
// The character is referenced by codepoint so this file does not contain
// the literal character and cannot trip its own check.

const EM_DASH = String.fromCodePoint(0x2014);

const BOT_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const SCAN_ROOTS = ["src", "scripts"];

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "dist"]);

const SCANNED_EXT = /\.(ts|tsx|mjs|sh|sql)$/;

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true, recursive: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SCANNED_EXT.test(entry.name)) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(BOT_ROOT, abs);
    if (rel.split(path.sep).some((part) => EXCLUDED_DIRS.has(part))) continue;
    out.push(abs);
  }
  return out;
}

describe("em-dash hygiene", () => {
  it("scans a plausible number of files", async () => {
    // Guards the guard. A walker that silently returned nothing (wrong
    // root, changed fs API) would make the check below pass vacuously.
    // This is not hypothetical: the origin repo's Python checker scanned
    // zero files in every worktree session for months, because its skip
    // list matched absolute paths.
    const all: string[] = [];
    for (const sub of SCAN_ROOTS) {
      all.push(...(await listSourceFiles(path.join(BOT_ROOT, sub))));
    }
    expect(all.length).toBeGreaterThan(30);
  });

  it("no src/ or scripts/ file contains U+2014", async () => {
    const all: string[] = [];
    for (const sub of SCAN_ROOTS) {
      all.push(...(await listSourceFiles(path.join(BOT_ROOT, sub))));
    }

    const violations: string[] = [];
    for (const file of all) {
      const content = await fs.readFile(file, "utf-8");
      if (content.includes(EM_DASH)) {
        violations.push(path.relative(BOT_ROOT, file));
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `Em dash (U+2014) found in ${violations.length} file(s):\n  ` +
            `${violations.join("\n  ")}\n` +
            `Fix: replace with a comma, colon, semicolon, or a new sentence.`
        : "",
    ).toEqual([]);
  });
});
