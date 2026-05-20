import { describe, it, expect } from "vitest";
import { botStatusSnapshot, badgeProps, type BotStatus } from "./bot-status";

// Frozen instant so all age-threshold math is deterministic.
const NOW = new Date("2026-05-19T12:00:00.000Z").getTime();

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

const MIN = 60_000;

describe("botStatusSnapshot: 6 branches", () => {
  // ---- Branch 1: paused ----

  it("paused when global_approval_mode='paused'", () => {
    const r = botStatusSnapshot({ global_approval_mode: "paused" }, NOW);
    expect(r.kind).toBe("paused");
  });

  it("paused when paused=true, surfaces pausedSince", () => {
    const since = ago(2 * 60 * MIN);
    const r = botStatusSnapshot({ paused: true, pausedSince: since }, NOW);
    expect(r.kind).toBe("paused");
    if (r.kind === "paused") expect(r.since).toBe(since);
  });

  // ---- Branch 2: stale-dist ----

  it("stale-dist when drift.drift=true", () => {
    const observedAt = ago(30_000);
    const r = botStatusSnapshot(
      { drift: { drift: true, reason: "sha_mismatch", observedAt } },
      NOW,
    );
    expect(r.kind).toBe("stale-dist");
    if (r.kind === "stale-dist") {
      expect(r.reason).toBe("sha_mismatch");
      expect(r.observedAt).toBe(observedAt);
    }
  });

  it("stale-dist is NOT triggered when drift.drift=false", () => {
    const r = botStatusSnapshot(
      { drift: { drift: false }, tick_meta: { lastEndedAt: ago(2 * MIN) } },
      NOW,
    );
    expect(r.kind).toBe("running");
  });

  // ---- Branch 3: ci-red ----

  it("ci-red when ci_status.red=true", () => {
    const since = ago(5 * MIN);
    const r = botStatusSnapshot({ ci_status: { red: true, since } }, NOW);
    expect(r.kind).toBe("ci-red");
    if (r.kind === "ci-red") expect(r.since).toBe(since);
  });

  it("ci-red skipped silently when ci_status key is absent", () => {
    const r = botStatusSnapshot({ tick_meta: { lastEndedAt: ago(3 * MIN) } }, NOW);
    expect(r.kind).toBe("running");
  });

  it("ci-red skipped when ci_status.red is false", () => {
    const r = botStatusSnapshot(
      { ci_status: { red: false }, tick_meta: { lastEndedAt: ago(3 * MIN) } },
      NOW,
    );
    expect(r.kind).toBe("running");
  });

  // ---- Branch 4: running ----

  it("running when last tick < 6 min ago", () => {
    const lastTickAt = ago(3 * MIN);
    const r = botStatusSnapshot({ tick_meta: { lastEndedAt: lastTickAt } }, NOW);
    expect(r.kind).toBe("running");
    if (r.kind === "running") expect(r.lastTickAt).toBe(lastTickAt);
  });

  it("running at the boundary: exactly 1ms under 6min is running", () => {
    const r = botStatusSnapshot(
      { tick_meta: { lastEndedAt: ago(6 * MIN - 1) } },
      NOW,
    );
    expect(r.kind).toBe("running");
  });

  // ---- Branch 5: idle ----

  it("idle when last tick is 6-15 min ago", () => {
    const lastTickAt = ago(10 * MIN);
    const r = botStatusSnapshot({ tick_meta: { lastEndedAt: lastTickAt } }, NOW);
    expect(r.kind).toBe("idle");
    if (r.kind === "idle") expect(r.lastTickAt).toBe(lastTickAt);
  });

  it("idle at the boundary: exactly 6min is idle", () => {
    const r = botStatusSnapshot(
      { tick_meta: { lastEndedAt: ago(6 * MIN) } },
      NOW,
    );
    expect(r.kind).toBe("idle");
  });

  // ---- Branch 6: no-signal ----

  it("no-signal when tick_meta key is absent", () => {
    const r = botStatusSnapshot({}, NOW);
    expect(r.kind).toBe("no-signal");
  });

  it("no-signal when last tick > 15 min ago", () => {
    const r = botStatusSnapshot(
      { tick_meta: { lastEndedAt: ago(20 * MIN) } },
      NOW,
    );
    expect(r.kind).toBe("no-signal");
  });

  it("no-signal at the boundary: exactly 15min is no-signal", () => {
    const r = botStatusSnapshot(
      { tick_meta: { lastEndedAt: ago(15 * MIN) } },
      NOW,
    );
    expect(r.kind).toBe("no-signal");
  });

  // ---- Precedence ----

  it("paused beats stale-dist", () => {
    const r = botStatusSnapshot(
      { paused: true, drift: { drift: true } },
      NOW,
    );
    expect(r.kind).toBe("paused");
  });

  it("stale-dist beats ci-red", () => {
    const r = botStatusSnapshot(
      { drift: { drift: true }, ci_status: { red: true } },
      NOW,
    );
    expect(r.kind).toBe("stale-dist");
  });

  it("ci-red beats running", () => {
    const r = botStatusSnapshot(
      {
        ci_status: { red: true },
        tick_meta: { lastEndedAt: ago(2 * MIN) },
      },
      NOW,
    );
    expect(r.kind).toBe("ci-red");
  });
});

describe("badgeProps display mapping", () => {
  // Branch: paused
  it("paused: warn pill, ts from since", () => {
    const since = "2026-05-19T10:00:00.000Z";
    const r = badgeProps({ kind: "paused", since });
    expect(r.label).toBe("paused");
    expect(r.colorClass).toBe("bg-warn/20 text-warn border-warn/30");
    expect(r.ts).toBe(since);
  });

  it("paused: ts is null when since is null (no row updatedAt available)", () => {
    const r = badgeProps({ kind: "paused", since: null });
    expect(r.ts).toBeNull();
  });

  // Branch: stale-dist
  it("stale-dist: bad pill, ts from observedAt", () => {
    const observedAt = "2026-05-19T11:30:00.000Z";
    const r = badgeProps({ kind: "stale-dist", reason: "sha_mismatch", observedAt });
    expect(r.label).toBe("stale dist");
    expect(r.colorClass).toBe("bg-bad/20 text-bad border-bad/30");
    expect(r.ts).toBe(observedAt);
  });

  it("stale-dist: ts is null when observedAt is null", () => {
    const r = badgeProps({ kind: "stale-dist", reason: null, observedAt: null });
    expect(r.ts).toBeNull();
  });

  // Branch: ci-red
  it("ci-red: bad pill, ts from since", () => {
    const since = "2026-05-19T09:00:00.000Z";
    const r = badgeProps({ kind: "ci-red", since });
    expect(r.label).toBe("CI red");
    expect(r.colorClass).toBe("bg-bad/20 text-bad border-bad/30");
    expect(r.ts).toBe(since);
  });

  it("ci-red and stale-dist share the same bad palette", () => {
    const a = badgeProps({ kind: "ci-red", since: null });
    const b = badgeProps({ kind: "stale-dist", reason: null, observedAt: null });
    expect(a.colorClass).toBe(b.colorClass);
  });

  // Branch: running
  it("running: good pill, ts from lastTickAt", () => {
    const lastTickAt = "2026-05-19T11:58:00.000Z";
    const r = badgeProps({ kind: "running", lastTickAt });
    expect(r.label).toBe("running");
    expect(r.colorClass).toBe("bg-good/20 text-good border-good/30");
    expect(r.ts).toBe(lastTickAt);
  });

  // Branch: idle
  it("idle: dim pill, ts from lastTickAt", () => {
    const lastTickAt = "2026-05-19T11:50:00.000Z";
    const r = badgeProps({ kind: "idle", lastTickAt });
    expect(r.label).toBe("idle");
    expect(r.colorClass).toBe("bg-dim/20 text-dim border-line");
    expect(r.ts).toBe(lastTickAt);
  });

  it("idle and no-signal share the same dim palette", () => {
    const a = badgeProps({ kind: "idle", lastTickAt: "2026-05-19T11:50:00.000Z" });
    const b = badgeProps({ kind: "no-signal" });
    expect(a.colorClass).toBe(b.colorClass);
  });

  // Branch: no-signal
  it("no-signal: dim pill, ts is always null (no timestamp source)", () => {
    const r = badgeProps({ kind: "no-signal" });
    expect(r.label).toBe("no signal");
    expect(r.colorClass).toBe("bg-dim/20 text-dim border-line");
    expect(r.ts).toBeNull();
  });

  // Coverage: every BotStatus kind is exhaustively handled (no undefined fallthrough).
  it("returns a populated label for every BotStatus.kind", () => {
    const kinds: BotStatus[] = [
      { kind: "paused", since: null },
      { kind: "stale-dist", reason: null, observedAt: null },
      { kind: "ci-red", since: null },
      { kind: "running", lastTickAt: "2026-05-19T11:58:00.000Z" },
      { kind: "idle", lastTickAt: "2026-05-19T11:50:00.000Z" },
      { kind: "no-signal" },
    ];
    for (const s of kinds) {
      const r = badgeProps(s);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.colorClass.length).toBeGreaterThan(0);
    }
  });
});
