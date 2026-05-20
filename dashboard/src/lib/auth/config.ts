// Edge-safe Auth.js config. Single-user invariant enforced in
// middleware via OCEAN_USER_ID env match (GitHub numeric ID as string).

import GitHub from "next-auth/providers/github";
import type { NextAuthConfig } from "next-auth";

const authConfig: NextAuthConfig = {
  providers: [GitHub],
  pages: { signIn: "/sign-in" },
  session: { strategy: "jwt" },
  callbacks: {
    jwt({ token, account, profile }) {
      // Persist GitHub numeric id into the JWT so middleware can
      // gate by OCEAN_USER_ID without a DB round-trip.
      if (account?.provider === "github" && profile) {
        const id = (profile as { id?: number | string }).id;
        if (id !== undefined) token.githubId = String(id);
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.githubId === "string") {
        (session.user as { githubId?: string }).githubId = token.githubId;
      }
      return session;
    },
    authorized({ auth }) {
      // Dev-only bypass for local screenshotting, must NEVER be set
      // in production. Combined NODE_ENV check belt-and-braces.
      if (
        process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] === "1" &&
        process.env["NODE_ENV"] !== "production"
      ) {
        return true;
      }
      // Single-user gate: GitHub id MUST match.
      const expected = process.env["OCEAN_USER_ID"];
      if (!expected) return false;
      const ghId = (auth?.user as { githubId?: string } | undefined)?.githubId;
      return ghId === expected;
    },
  },
};

export default authConfig;
