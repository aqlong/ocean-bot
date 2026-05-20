import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Regression guard for the CLAUDE.md code-style rule: no em dashes
// (U+2014) in any authored TypeScript/TSX file under the ocean-bot
// dashboard (src/ + app/).
//
// Mirrors apps/dashboard/src/em-dash.test.ts (cfbc97d) and the OSS-side
// src/em-dash.test.ts (c95bcae). The Python CI check
// (tools/scripts/strip-em-dashes.py) explicitly excludes the
// tools/ocean-bot subtree via SKIP_PATH_FRAGMENTS, so the pre-commit
// hook never sees violations introduced here. Vitest catches them
// during `npm test`, before push.
//
// Scope: tools/ocean-bot/dashboard/{src,app}/**/*.{ts,tsx}. Both
// roots are authored code (vitest.config.ts includes both for tests).
// node_modules, .next, and dist are excluded as vendored / generated.
//
// The character is referenced via a codepoint call so this file does
// not contain the literal character and cannot trip its own check.
// Stdlib-only walker (fs.readdir recursive) so this test adds no new
// dependency to the dashboard package.

const EM_DASH = String.fromCodePoint(0x2014);

const DASHBOARD_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

const SCAN_ROOTS = ["src", "app"];

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "dist"]);

async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(root, {
    withFileTypes: true,
    recursive: true,
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx)$/.test(entry.name)) continue;
    const rel = path.relative(root, path.join(entry.parentPath, entry.name));
    if (rel.split(path.sep).some((part) => EXCLUDED_DIRS.has(part))) continue;
    out.push(path.join(entry.parentPath, entry.name));
  }
  return out;
}

describe("em-dash hygiene", () => {
  it("no tools/ocean-bot/dashboard/{src,app}/**/*.{ts,tsx} file contains U+2014 (run strip-em-dashes.py to fix)", async () => {
    const all: string[] = [];
    for (const sub of SCAN_ROOTS) {
      const root = path.join(DASHBOARD_ROOT, sub);
      const files = await listSourceFiles(root);
      all.push(...files);
    }

    const violations: string[] = [];
    for (const file of all) {
      const content = await fs.readFile(file, "utf-8");
      if (content.includes(EM_DASH)) {
        violations.push(path.relative(DASHBOARD_ROOT, file));
      }
    }

    expect(
      violations,
      violations.length > 0
        ? `Em dash found in ${violations.length} file(s):\n  ${violations.join("\n  ")}\nFix: remove the U+2014 character manually (tools/scripts/strip-em-dashes.py excludes this subtree).`
        : "",
    ).toEqual([]);
  });
});
