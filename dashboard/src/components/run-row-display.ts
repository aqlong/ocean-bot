// Pure display-decision helper for RunRow. Extracted so the visual
// semantics (out-of-band-shipped takes precedence over failed→bad;
// shipped-noop takes precedence over shipped→good; noop dims the task
// summary; statusColor mapping for shipped/awaiting-approval/failed/
// rejected/other) survive refactors. JSX rendering stays in RunRow.tsx.

export type RunRowDisplay =
  | { kind: "oob"; statusColor: string; taskColor: string; label: string }
  | {
      kind: "noop";
      statusColor: string;
      taskColor: string;
      mainLabel: string;
      badge: string;
    }
  | { kind: "raw"; statusColor: string; taskColor: string; label: string };

export interface RunRowDisplayInput {
  status: string;
  outOfBandShipped?: boolean;
  outcome?: "shipped" | "shipped-noop";
}

export function computeRunRowDisplay(input: RunRowDisplayInput): RunRowDisplay {
  const { status, outOfBandShipped, outcome } = input;

  if (status === "failed" && outOfBandShipped === true) {
    return {
      kind: "oob",
      statusColor: "text-good",
      taskColor: "text-ink",
      label: "shipped (out-of-band)",
    };
  }

  if (status === "shipped" && outcome === "shipped-noop") {
    return {
      kind: "noop",
      statusColor: "text-dim",
      taskColor: "text-dim",
      mainLabel: "shipped",
      badge: "no-op",
    };
  }

  const statusColor =
    status === "shipped"
      ? "text-good"
      : status === "awaiting-approval"
        ? "text-warn"
        : status === "failed" || status === "rejected"
          ? "text-bad"
          : "text-dim";

  return {
    kind: "raw",
    statusColor,
    taskColor: "text-ink",
    label: status,
  };
}
