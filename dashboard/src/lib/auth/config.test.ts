import { describe, it, expect, beforeEach, afterEach } from "vitest";
import authConfig from "./config";
import type { Session } from "next-auth";

const cb = authConfig.callbacks!;

function mkSession(githubId?: string): Session {
  return {
    user: { name: "x", email: "x@x", image: null, ...(githubId ? { githubId } : {}) },
    expires: new Date(Date.now() + 60000).toISOString(),
  } as unknown as Session;
}

describe("auth gate, single-user invariant", () => {
  const originalEnv = process.env["OCEAN_USER_ID"];

  beforeEach(() => {
    process.env["OCEAN_USER_ID"] = "12345";
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env["OCEAN_USER_ID"];
    else process.env["OCEAN_USER_ID"] = originalEnv;
  });

  it("rejects when OCEAN_USER_ID env is unset", () => {
    delete process.env["OCEAN_USER_ID"];
    expect(cb.authorized!({ auth: mkSession("12345") } as never)).toBe(false);
  });

  it("rejects when session has no githubId", () => {
    expect(cb.authorized!({ auth: mkSession() } as never)).toBe(false);
  });

  it("rejects mismatched githubId", () => {
    expect(cb.authorized!({ auth: mkSession("99999") } as never)).toBe(false);
  });

  it("accepts exact githubId match", () => {
    expect(cb.authorized!({ auth: mkSession("12345") } as never)).toBe(true);
  });

  it("rejects null auth (signed-out user)", () => {
    expect(cb.authorized!({ auth: null } as never)).toBe(false);
  });
});

describe("auth gate, dev bypass", () => {
  const origUserId = process.env["OCEAN_USER_ID"];
  const origBypass = process.env["OCEAN_BOT_DEV_BYPASS_AUTH"];
  const origNodeEnv = process.env["NODE_ENV"];

  afterEach(() => {
    if (origUserId === undefined) delete process.env["OCEAN_USER_ID"];
    else process.env["OCEAN_USER_ID"] = origUserId;
    if (origBypass === undefined) delete process.env["OCEAN_BOT_DEV_BYPASS_AUTH"];
    else process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = origBypass;
    if (origNodeEnv === undefined) delete (process.env as Record<string, string | undefined>)["NODE_ENV"];
    else (process.env as Record<string, string>)["NODE_ENV"] = origNodeEnv;
  });

  it("bypass works in non-production", () => {
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = "1";
    (process.env as Record<string, string>)["NODE_ENV"] = "development";
    delete process.env["OCEAN_USER_ID"];
    expect(cb.authorized!({ auth: null } as never)).toBe(true);
  });

  it("bypass is IGNORED in production (defense-in-depth)", () => {
    process.env["OCEAN_BOT_DEV_BYPASS_AUTH"] = "1";
    (process.env as Record<string, string>)["NODE_ENV"] = "production";
    delete process.env["OCEAN_USER_ID"];
    expect(cb.authorized!({ auth: null } as never)).toBe(false);
  });
});

describe("auth gate, jwt callback persists githubId", () => {
  it("writes githubId to token on first sign-in", () => {
    const token: Record<string, unknown> = {};
    cb.jwt!({
      token,
      account: { provider: "github" },
      profile: { id: 4242 },
    } as never);
    expect(token["githubId"]).toBe("4242");
  });

  it("preserves existing githubId on subsequent calls", () => {
    const token = { githubId: "4242" };
    const out = cb.jwt!({ token, account: null, profile: null } as never);
    expect((out as unknown as Record<string, unknown>)["githubId"]).toBe("4242");
  });

  it("session callback exposes githubId to session.user", () => {
    const session: Session = mkSession();
    const out = cb.session!({ session, token: { githubId: "4242" } } as never);
    const u = (out as Session).user as unknown as { githubId?: string };
    expect(u.githubId).toBe("4242");
  });
});
