// Node-runtime Auth.js with Drizzle adapter. Imported only from server
// components / route handlers. Middleware imports ../config directly.

import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { getDb } from "../db";
import authConfig from "./config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(getDb()),
});
