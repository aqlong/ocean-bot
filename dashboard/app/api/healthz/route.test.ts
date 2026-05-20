import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "./route";

describe("/api/healthz", () => {
  const ENV_KEYS = [
    "RAILWAY_DEPLOYMENT_ID",
    "RAILWAY_ENVIRONMENT_NAME",
    "RAILWAY_GIT_COMMIT_SHA",
    "BUILD_SHA",
  ];
  let snap: Record<string, string | undefined> = {};
  beforeEach(() => {
    snap = {};
    for (const k of ENV_KEYS) {
      snap[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = snap[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns ok=true with sensible defaults outside Railway", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deploymentId).toBe("local");
    expect(body.env).toBe("local");
    expect(body.buildSha).toBeNull();
    expect(typeof body.ts).toBe("string");
    // ts is a parseable ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
  });

  it("surfaces Railway-injected metadata when present", async () => {
    process.env["RAILWAY_DEPLOYMENT_ID"] = "dep-abc-123";
    process.env["RAILWAY_ENVIRONMENT_NAME"] = "production";
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "deadbeef";
    const res = await GET();
    const body = await res.json();
    expect(body.deploymentId).toBe("dep-abc-123");
    expect(body.env).toBe("production");
    expect(body.buildSha).toBe("deadbeef");
  });

  it("falls back to BUILD_SHA when RAILWAY_GIT_COMMIT_SHA is absent", async () => {
    process.env["BUILD_SHA"] = "fallbacksha";
    const res = await GET();
    const body = await res.json();
    expect(body.buildSha).toBe("fallbacksha");
  });

  it("prefers RAILWAY_GIT_COMMIT_SHA over BUILD_SHA when both are set", async () => {
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "envsha";
    process.env["BUILD_SHA"] = "stampedsha";
    const res = await GET();
    const body = await res.json();
    expect(body.buildSha).toBe("envsha");
  });
});
