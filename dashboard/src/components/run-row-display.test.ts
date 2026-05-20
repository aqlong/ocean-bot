import { describe, it, expect } from "vitest";
import { computeRunRowDisplay } from "./run-row-display";

describe("computeRunRowDisplay", () => {
  it("classifies status=failed + outOfBandShipped=true as oob (overrides failed→bad)", () => {
    const d = computeRunRowDisplay({
      status: "failed",
      outOfBandShipped: true,
    });
    expect(d.kind).toBe("oob");
    expect(d.statusColor).toBe("text-good");
    expect(d.taskColor).toBe("text-ink");
    if (d.kind === "oob") {
      expect(d.label).toBe("shipped (out-of-band)");
    }
  });

  it("does NOT classify as oob when status=failed + outOfBandShipped is undefined", () => {
    const d = computeRunRowDisplay({ status: "failed" });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-bad");
  });

  it("does NOT classify as oob when status=failed + outOfBandShipped=false (=== true narrow)", () => {
    const d = computeRunRowDisplay({
      status: "failed",
      outOfBandShipped: false,
    });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-bad");
  });

  it("classifies status=shipped + outcome=shipped-noop as noop (overrides shipped→good)", () => {
    const d = computeRunRowDisplay({
      status: "shipped",
      outcome: "shipped-noop",
    });
    expect(d.kind).toBe("noop");
    expect(d.statusColor).toBe("text-dim");
    expect(d.taskColor).toBe("text-dim");
    if (d.kind === "noop") {
      expect(d.mainLabel).toBe("shipped");
      expect(d.badge).toBe("no-op");
    }
  });

  it("treats status=shipped + outcome=shipped (non-noop) as raw shipped", () => {
    const d = computeRunRowDisplay({ status: "shipped", outcome: "shipped" });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-good");
    expect(d.taskColor).toBe("text-ink");
  });

  it("treats plain status=shipped (no outcome) as raw shipped (text-good)", () => {
    const d = computeRunRowDisplay({ status: "shipped" });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-good");
  });

  it("maps status=awaiting-approval to text-warn", () => {
    const d = computeRunRowDisplay({ status: "awaiting-approval" });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-warn");
  });

  it("maps status=rejected to text-bad", () => {
    const d = computeRunRowDisplay({ status: "rejected" });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-bad");
  });

  it("maps unknown statuses (queued/running/etc) to text-dim", () => {
    expect(computeRunRowDisplay({ status: "queued" }).statusColor).toBe(
      "text-dim",
    );
    expect(computeRunRowDisplay({ status: "running" }).statusColor).toBe(
      "text-dim",
    );
    expect(computeRunRowDisplay({ status: "" }).statusColor).toBe("text-dim");
  });

  it("echoes status verbatim in the raw label (catches hardcoded-label regressions)", () => {
    const d = computeRunRowDisplay({ status: "awaiting-approval" });
    if (d.kind === "raw") {
      expect(d.label).toBe("awaiting-approval");
    }
    const d2 = computeRunRowDisplay({ status: "queued" });
    if (d2.kind === "raw") {
      expect(d2.label).toBe("queued");
    }
  });

  it("keeps taskColor=text-ink for oob (so the row reads as a normal shipped row)", () => {
    const d = computeRunRowDisplay({
      status: "failed",
      outOfBandShipped: true,
    });
    expect(d.taskColor).toBe("text-ink");
  });

  it("ignores outcome=shipped-noop when status is not shipped (precedence guard)", () => {
    // A failed+noop shouldn't pretend to be shipped, only the status===shipped path can be noop.
    const d = computeRunRowDisplay({
      status: "failed",
      outcome: "shipped-noop",
    });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-bad");
  });

  it("ignores outOfBandShipped=true when status is not failed (precedence guard)", () => {
    // Only the status===failed path can be oob, flag on a shipped row stays raw shipped.
    const d = computeRunRowDisplay({
      status: "shipped",
      outOfBandShipped: true,
    });
    expect(d.kind).toBe("raw");
    expect(d.statusColor).toBe("text-good");
  });
});
