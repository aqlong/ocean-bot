import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Regression guard for a build-time database dependency.
//
// app/layout.tsx renders <BotStatusBadge />, a server component that
// queries ocean_bot_state. That query runs for ANY route Next decides to
// prerender at build time, which makes `next build` open a Postgres
// connection. On a machine without a reachable DB (fresh clone, CI runner,
// container build stage) the build fails outright:
//
//   Error: Failed query: select ... from "ocean_bot_state" ...
//   [cause]: AggregateError { code: 'ECONNREFUSED' }
//   Export encountered an error on /sign-in/page, exiting the build.
//
// That is exactly what happened: every route declared
// `export const dynamic = "force-dynamic"` EXCEPT app/sign-in/page.tsx,
// which was missed because it is the one page with no data of its own.
// It was therefore the only statically prerendered route, and it alone
// dragged the DB-backed layout into build time.
//
// This test pins the invariant rather than the single fix, so adding a
// new page without force-dynamic fails here instead of failing a deploy.
//
// The check is a source scan, not a build. It is deliberately cheap so it
// runs on every `npm test`; a real `next build` costs ~40s and needs a DB.

const APP_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
);

const ROUTE_FILENAMES = new Set(["page.tsx", "route.ts"]);

const EXCLUDED_DIRS = new Set(["node_modules", ".next", "dist"]);

// Documented exemption. The Auth.js catch-all re-exports NextAuth's own
// handlers and has a dynamic `[...nextauth]` segment, so Next always
// server-renders it on demand (confirmed as "f /api/auth/[...nextauth]"
// in the build route table). It renders no layout and touches no DB.
const EXEMPT = new Set(["api/auth/[...nextauth]/route.ts"]);

async function listRouteFiles(): Promise<string[]> {
  const entries = await fs.readdir(APP_ROOT, {
    withFileTypes: true,
    recursive: true,
  });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!ROUTE_FILENAMES.has(entry.name)) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(APP_ROOT, abs);
    if (rel.split(path.sep).some((part) => EXCLUDED_DIRS.has(part))) continue;
    out.push(rel);
  }
  return out.sort();
}

describe("no route is statically prerendered", () => {
  it("finds the route files it is supposed to be guarding", async () => {
    // Guards the guard: a broken walker would make the assertion below
    // pass vacuously against an empty list.
    const files = await listRouteFiles();
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain("sign-in/page.tsx");
    expect(files).toContain("page.tsx");
  });

  it('every route declares export const dynamic = "force-dynamic"', async () => {
    const files = await listRouteFiles();
    const missing: string[] = [];

    for (const rel of files) {
      if (EXEMPT.has(rel.split(path.sep).join("/"))) continue;
      const content = await fs.readFile(path.join(APP_ROOT, rel), "utf-8");
      if (!/export\s+const\s+dynamic\s*=\s*"force-dynamic"/.test(content)) {
        missing.push(rel);
      }
    }

    expect(
      missing,
      missing.length > 0
        ? `These routes would be statically prerendered, which pulls the ` +
            `DB-backed root layout into build time and breaks \`next build\` ` +
            `without a reachable Postgres:\n  ${missing.join("\n  ")}\n` +
            `Fix: add 'export const dynamic = "force-dynamic";' to each.`
        : "",
    ).toEqual([]);
  });

  it("keeps the exemption list honest", async () => {
    // An exemption for a file that no longer exists is stale config that
    // would silently start covering some future route with the same path.
    const files = new Set(
      (await listRouteFiles()).map((f) => f.split(path.sep).join("/")),
    );
    for (const exempt of EXEMPT) {
      expect(files.has(exempt), `stale exemption: ${exempt}`).toBe(true);
    }
  });
});
