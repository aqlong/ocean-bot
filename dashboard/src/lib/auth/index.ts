// Node-runtime Auth.js with Drizzle adapter. Imported only from server
// components / route handlers. Middleware imports ../config directly
// (it needs no adapter, so it stays Edge-safe and build-safe).
//
// WHY THE LAZY SINGLETON, instead of the idiomatic
//   export const { handlers, auth } = NextAuth({ ..., adapter: DrizzleAdapter(getDb()) })
//
// DrizzleAdapter introspects its argument the moment it is called
// (`is(db, PgDatabase)` in @auth/drizzle-adapter), so it cannot be handed a
// lazy proxy. At module scope that made `getDb()` run on IMPORT, and getDb
// throws when OCEAN_BOT_DATABASE_URL is unset. Next.js imports every route
// module during the "Collecting page data" phase of `next build`, so the
// build required a reachable Postgres:
//
//   Error: OCEAN_BOT_DATABASE_URL is not set.
//   > Build error occurred
//   [Error: Failed to collect page data for /api/bot/cancel]
//
// That is a build-time dependency on runtime infrastructure: a fresh clone,
// a CI runner, and a container build stage could not compile the app.
// Deferring construction to first use keeps runtime behavior identical (the
// first request builds it) while making the build hermetic. The
// no-db-at-build-time.test.ts case pins this.

import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { getDb } from "../db";
import authConfig from "./config";

type AuthInstance = ReturnType<typeof NextAuth>;

let instance: AuthInstance | null = null;

// No await between the check and the assignment, so concurrent first calls
// cannot interleave and produce two instances.
function getAuthInstance(): AuthInstance {
  if (!instance) {
    instance = NextAuth({
      ...authConfig,
      adapter: DrizzleAdapter(getDb()),
    });
  }
  return instance;
}

export const auth: AuthInstance["auth"] = ((
  ...args: Parameters<AuthInstance["auth"]>
) => getAuthInstance().auth(...args)) as AuthInstance["auth"];

export const handlers: AuthInstance["handlers"] = {
  GET: (req) => getAuthInstance().handlers.GET(req),
  POST: (req) => getAuthInstance().handlers.POST(req),
};

export const signIn: AuthInstance["signIn"] = ((
  ...args: Parameters<AuthInstance["signIn"]>
) => getAuthInstance().signIn(...args)) as AuthInstance["signIn"];

export const signOut: AuthInstance["signOut"] = ((
  ...args: Parameters<AuthInstance["signOut"]>
) => getAuthInstance().signOut(...args)) as AuthInstance["signOut"];
