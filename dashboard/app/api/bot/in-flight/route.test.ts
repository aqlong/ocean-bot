// Integration smoke for the in-flight route. Same skip pattern as the
// other DB-touching tests: runs end-to-end when a test DB URL is set.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";

const TEST_URL = process.env["OCEAN_BOT_TEST_DATABASE_URL"];
const D = TEST_URL ? describe : describe.skip;

if (TEST_URL) process.env["OCEAN_BOT_DATABASE_URL"] = TEST_URL;

type RouteModule = typeof import("./route");
let route: RouteModule;

beforeAll(async () => {
  if (!TEST_URL) return;
  route = await import("./route");
});

async function truncate(): Promise<void> {
  if (!TEST_URL) return;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: TEST_URL });
  await c.connect();
  await c.query(
    "TRUNCATE ocean_bot_event, ocean_bot_run, ocean_bot_usage, ocean_bot_state RESTART IDENTITY CASCADE;",
  );
  await c.end();
}

D("/api/bot/in-flight", () => {
  beforeEach(truncate);

  it("returns idle by default with 200 status", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("idle");
  });

  it("matches the InFlight discriminated-union shape", async () => {
    const res = await route.GET();
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["state"]).toBe("string");
    expect(["running", "awaiting", "idle"]).toContain(body["state"] as string);
  });
});
