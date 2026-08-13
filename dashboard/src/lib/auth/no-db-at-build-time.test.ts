import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

// Pins the fix for a build-time dependency on runtime infrastructure.
//
// `next build` imports every route module during its "Collecting page data"
// phase. Route modules import @/lib/auth. When that module built its Auth.js
// instance at module scope:
//
//   export const { handlers, auth } = NextAuth({
//     ...authConfig,
//     adapter: DrizzleAdapter(getDb()),   // <- ran on IMPORT
//   })
//
// ...the import itself called getDb(), which throws when
// OCEAN_BOT_DATABASE_URL is unset. So the build failed on any machine
// without a reachable Postgres (fresh clone, CI runner, container build):
//
//   Error: OCEAN_BOT_DATABASE_URL is not set.
//   [Error: Failed to collect page data for /api/bot/cancel]
//
// A lazy proxy cannot fix this: DrizzleAdapter introspects its argument
// immediately (`is(db, PgDatabase)`), so the adapter construction itself has
// to be deferred. src/lib/auth/index.ts now builds the instance on first use.
//
// SCOPE OF THIS FILE. The authoritative check is CI running `next build`
// with no database variables set at all (see .github/workflows/ci.yml,
// "build with no database configured"). That exercises the real property
// end to end. Importing the auth module here instead would only prove that
// vitest can load next-auth, which it cannot: next-auth does a bare
// `import "next/server"` internally and vitest externalizes node_modules,
// so Node's ESM resolver rejects the exports-map subpath.
//
// What this file adds is fast local feedback: a source-level guard that
// fails in milliseconds on `npm test`, before anyone waits on a CI build.

const AUTH_INDEX = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "index.ts",
);

/** Strip comments and string literals so prose about the bug is not scanned. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

/** Lines at indentation zero are module scope; anything nested is inside a body. */
function moduleScopeLines(code: string): string[] {
  return code.split("\n").filter((line) => /^\S/.test(line));
}

describe("auth module defers construction past import", () => {
  it("does not call getDb() at module scope", async () => {
    const code = stripCommentsAndStrings(await fs.readFile(AUTH_INDEX, "utf-8"));
    const offenders = moduleScopeLines(code).filter((l) => l.includes("getDb("));
    expect(
      offenders,
      `getDb() runs at module scope in src/lib/auth/index.ts, so importing ` +
        `this module opens a database connection. That breaks \`next build\` ` +
        `on any machine without a reachable Postgres. Move the call inside ` +
        `the lazy getAuthInstance() factory.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("does not call NextAuth() or DrizzleAdapter() at module scope", async () => {
    const code = stripCommentsAndStrings(await fs.readFile(AUTH_INDEX, "utf-8"));
    const offenders = moduleScopeLines(code).filter(
      (l) => l.includes("NextAuth(") || l.includes("DrizzleAdapter("),
    );
    expect(
      offenders,
      `Auth.js is constructed at module scope. DrizzleAdapter introspects ` +
        `its db argument immediately, so this forces a database connection ` +
        `at import time.\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("still exports the surface app/ imports", async () => {
    const code = await fs.readFile(AUTH_INDEX, "utf-8");
    // app/ consumes exactly these; a refactor that dropped one would fail at
    // runtime in a route handler rather than here.
    for (const name of ["auth", "handlers", "signIn", "signOut"]) {
      expect(
        new RegExp(`export const ${name}\\b`).test(code),
        `missing export: ${name}`,
      ).toBe(true);
    }
  });

  it("guards the guard: the scanner sees real module-scope code", async () => {
    // If stripCommentsAndStrings or moduleScopeLines broke, the assertions
    // above would pass vacuously against an empty list.
    const code = stripCommentsAndStrings(await fs.readFile(AUTH_INDEX, "utf-8"));
    const top = moduleScopeLines(code);
    expect(top.length).toBeGreaterThan(3);
    expect(top.some((l) => l.startsWith("import "))).toBe(true);
    // And the prose in this file's own header mentions getDb() inside a
    // comment; confirm comment-stripping actually removed such text.
    expect(stripCommentsAndStrings("// getDb()\nconst a = 1;")).not.toContain(
      "getDb(",
    );
  });
});
