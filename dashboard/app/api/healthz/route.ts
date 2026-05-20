import { NextResponse } from "next/server";

// Liveness + deployment-identity endpoint. Public route, no auth, so
// external uptime monitors and the deploy-wait script can hit a clean
// 200 without an Auth.js session. Modeled on apps/dashboard's
// /api/healthz; kept lean (no debug branch, the ocean-bot dashboard
// doesn't carry the same env-slot surface).
//
// MUST be excluded from middleware.ts's matcher or the Auth.js gate
// 302s the route into /sign-in before this handler ever runs.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
  const deploymentId = process.env["RAILWAY_DEPLOYMENT_ID"] ?? "local";
  const env = process.env["RAILWAY_ENVIRONMENT_NAME"] ?? "local";
  // Build SHA fallback: Railway sets RAILWAY_GIT_COMMIT_SHA on
  // GitHub-source services; upload-based deploys stamp BUILD_SHA via
  // `railway variables --set BUILD_SHA=…` before `railway up`.
  const buildSha =
    process.env["RAILWAY_GIT_COMMIT_SHA"] ??
    process.env["BUILD_SHA"] ??
    null;

  return NextResponse.json({
    ok: true,
    deploymentId,
    env,
    buildSha,
    ts: new Date().toISOString(),
  });
}
