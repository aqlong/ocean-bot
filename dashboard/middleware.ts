// Root-level middleware.ts. Next.js only picks up middleware from
// src/middleware.ts when the project uses src/app/, our app/ is at
// the root, so middleware must be at root too. Critical for the auth
// gate to actually run.

import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import authConfig from "@/lib/auth/config";

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  // Dev-only bypass, mirrors the check in authConfig.authorized so the
  // middleware doesn't redirect when there's no real session but bypass
  // is enabled. ONLY active when NODE_ENV != production (the
  // authConfig.authorized check enforces the same guard).
  if (
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] === "1" &&
    process.env["NODE_ENV"] !== "production"
  ) {
    return NextResponse.next();
  }
  // Auth.js sets req.auth from the JWT cookie. The single-user gate
  // lives in authConfig.authorized, by the time we get here, either
  // authorized returned true (req.auth populated) or false (req.auth
  // null + we redirect to sign-in).
  if (!req.auth) {
    const signInUrl = new URL("/sign-in", req.nextUrl.origin);
    signInUrl.searchParams.set("from", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  return NextResponse.next();
});

export const config = {
  // Gate everything except static assets, the sign-in page, the
  // Auth.js callback routes (which must be reachable when unauthed),
  // and /api/healthz (public liveness endpoint, uptime monitors and
  // the deploy-wait script need a clean 200 without a session cookie).
  matcher: [
    "/((?!_next/static|_next/image|favicon|sign-in|api/auth|api/healthz|health).*)",
  ],
};
