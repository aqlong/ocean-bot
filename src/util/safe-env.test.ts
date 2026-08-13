import { describe, it, expect } from "vitest";
import { buildSafeChildEnv } from "./safe-env";

describe("buildSafeChildEnv", () => {
  it("drops the explicit denylist keys (DB url + worker secret + Stripe secrets)", () => {
    const env = {
      OCEAN_BOT_DATABASE_URL: "postgres://...",
      WORKER_TRIGGER_SECRET: "ac230...",
      STRIPE_SECRET_KEY: "sk_live_...",
      STRIPE_WEBHOOK_SECRET: "whsec_...",
      AUTH_SECRET: "auth-secret",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN ...",
      GITHUB_WEBHOOK_SECRET: "ghwh-...",
      RAILWAY_TOKEN: "rt-...",
      NOTION_API_TOKEN: "secret_...",
      CONFLUENCE_API_TOKEN: "atatt...",
      // Keepers
      PATH: "/usr/bin",
      HOME: "/Users/op",
    };
    const out = buildSafeChildEnv(env);
    expect(out["OCEAN_BOT_DATABASE_URL"]).toBeUndefined();
    expect(out["WORKER_TRIGGER_SECRET"]).toBeUndefined();
    expect(out["STRIPE_SECRET_KEY"]).toBeUndefined();
    expect(out["STRIPE_WEBHOOK_SECRET"]).toBeUndefined();
    expect(out["AUTH_SECRET"]).toBeUndefined();
    expect(out["GITHUB_APP_PRIVATE_KEY"]).toBeUndefined();
    expect(out["GITHUB_WEBHOOK_SECRET"]).toBeUndefined();
    expect(out["RAILWAY_TOKEN"]).toBeUndefined();
    expect(out["NOTION_API_TOKEN"]).toBeUndefined();
    expect(out["CONFLUENCE_API_TOKEN"]).toBeUndefined();
    expect(out["PATH"]).toBe("/usr/bin");
    expect(out["HOME"]).toBe("/Users/op");
  });

  it("drops pattern-matching keys (*_SECRET, *_PASSWORD, *_TOKEN, *_PRIVATE_KEY)", () => {
    const env = {
      MY_SERVICE_SECRET: "x",
      DB_PASSWORD: "y",
      API_TOKEN: "z",
      RSA_PRIVATE_KEY: "-----BEGIN ...",
      // Lone "SECRET" / "PASSWORD" / "TOKEN" suffixes-as-whole-key
      SECRET: "lone-secret",
      PASSWORD: "lone-pw",
      TOKEN: "lone-token",
      // Non-matching keys stay
      MY_PUBLIC_URL: "https://example.com",
    };
    const out = buildSafeChildEnv(env);
    expect(out["MY_SERVICE_SECRET"]).toBeUndefined();
    expect(out["DB_PASSWORD"]).toBeUndefined();
    expect(out["API_TOKEN"]).toBeUndefined();
    expect(out["RSA_PRIVATE_KEY"]).toBeUndefined();
    expect(out["SECRET"]).toBeUndefined();
    expect(out["PASSWORD"]).toBeUndefined();
    expect(out["TOKEN"]).toBeUndefined();
    expect(out["MY_PUBLIC_URL"]).toBe("https://example.com");
  });

  it("allowlists ANTHROPIC_API_KEY despite *_KEY pattern overlap (c2w product needs it)", () => {
    // *_PRIVATE_KEY is denied, but plain *_KEY isn't in our patterns.
    // ANTHROPIC_API_KEY is also explicitly allowlisted as belt-and-suspenders.
    const env = { ANTHROPIC_API_KEY: "sk-ant-..." };
    const out = buildSafeChildEnv(env);
    expect(out["ANTHROPIC_API_KEY"]).toBe("sk-ant-...");
  });

  it("allowlists DEEPSEEK_API_KEY (c2w product needs it for DeepSeek backend)", () => {
    const env = { DEEPSEEK_API_KEY: "sk-ds-..." };
    const out = buildSafeChildEnv(env);
    expect(out["DEEPSEEK_API_KEY"]).toBe("sk-ds-...");
  });

  // GITHUB_TOKEN and GH_TOKEN are caught by the *_TOKEN pattern. They
  // are NOT on the explicit denylist but are structurally equivalent to
  // a repo-write credential; keeping them in the subprocess env would
  // let a prompt-injected task use `gh api` / `git push` against
  // arbitrary repos. On the operator's Mac, `gh` reads from the system
  // keychain so the CLI works without these env vars. This test pins
  // the behavior so a future "allowlist GH_TOKEN for CI" change is
  // an explicit decision, not a silent drift.
  it("GITHUB_TOKEN and GH_TOKEN are denied by *_TOKEN pattern; ANTHROPIC_API_KEY and DEEPSEEK_API_KEY survive", () => {
    const env = {
      GITHUB_TOKEN: "ghp_...",
      GH_TOKEN: "ghp_...",
      ANTHROPIC_API_KEY: "sk-ant-...",
      DEEPSEEK_API_KEY: "sk-ds-...",
      PATH: "/usr/bin",
    };
    const out = buildSafeChildEnv(env);
    expect(out["GITHUB_TOKEN"]).toBeUndefined();
    expect(out["GH_TOKEN"]).toBeUndefined();
    expect(out["ANTHROPIC_API_KEY"]).toBe("sk-ant-...");
    expect(out["DEEPSEEK_API_KEY"]).toBe("sk-ds-...");
    expect(out["PATH"]).toBe("/usr/bin");
  });

  it("respects extraDenyKeys override", () => {
    const env = { CUSTOM_THING: "value", PATH: "/usr/bin" };
    const out = buildSafeChildEnv(env, { extraDenyKeys: ["CUSTOM_THING"] });
    expect(out["CUSTOM_THING"]).toBeUndefined();
    expect(out["PATH"]).toBe("/usr/bin");
  });

  it("respects extraAllowKeys override (beats pattern denial)", () => {
    // *_TOKEN is denied by pattern; but if caller explicitly allows it,
    // it stays.
    const env = { LEGITIMATE_TOKEN: "value" };
    const out = buildSafeChildEnv(env, { extraAllowKeys: ["LEGITIMATE_TOKEN"] });
    expect(out["LEGITIMATE_TOKEN"]).toBe("value");
  });

  it("does not mutate the input env", () => {
    const env = { OCEAN_BOT_DATABASE_URL: "x", PATH: "/usr/bin" };
    const snapshot = { ...env };
    buildSafeChildEnv(env);
    expect(env).toEqual(snapshot);
  });

  it("drops undefined values (process.env can contain them under TS strict)", () => {
    const env = {
      DEFINED: "x",
      UNDEFINED: undefined,
    } as NodeJS.ProcessEnv;
    const out = buildSafeChildEnv(env);
    expect(out["DEFINED"]).toBe("x");
    expect("UNDEFINED" in out).toBe(false);
  });
});
