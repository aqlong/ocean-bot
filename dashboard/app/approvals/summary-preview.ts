// Pure helper: extract a one-line preview from a raw task prompt for
// the /approvals card's collapsed-by-default surface.
//
// The bot's main runner prepends a CLAUDE.md hint preamble + a queue-
// specific framing before the actual task description. A typical
// task-summary string looks like:
//
//   CLAUDE.md sections most relevant for this task: Where things live, ...
//
//   Backlog (chore): Operator: register Craft and Ship LLC as Atlassian
//   Marketplace partner. Operator-only task. 20-min checklist captured ...
//
// Showing the raw preamble in the card's preview wastes vertical space
// on context the operator doesn't need at scan-time. This helper drops
// the preamble + returns the first sentence of the actual task body.
// The full prompt is still available in the card's open-state body.
//
// Algorithm:
//   1. Strip everything up to and including the first \n\n divider
//      (the canonical separator the runner uses between preamble + body).
//   2. From the remaining body, take the first non-empty line.
//   3. Truncate to maxChars with an ellipsis if longer.
// If the input has no \n\n divider (older runs, manual queue entries),
// fall back to the first non-empty line of the input as-is.

const DEFAULT_MAX_CHARS = 240;

export function summaryPreview(
  taskSummary: string | null | undefined,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (!taskSummary) return "(no task summary)";
  const trimmed = taskSummary.trim();
  if (trimmed === "") return "(no task summary)";

  // Step 1: drop the preamble. The runner uses \n\n as the canonical
  // separator between the CLAUDE.md hint preamble and the task body.
  // If the preamble looks like a CLAUDE.md-hint line ("CLAUDE.md
  // sections most relevant for this task: ..."), peel it off; otherwise
  // keep the original.
  let body = trimmed;
  const dividerIdx = body.indexOf("\n\n");
  if (dividerIdx >= 0 && /^CLAUDE\.md/i.test(body.slice(0, dividerIdx))) {
    body = body.slice(dividerIdx + 2).trim();
  }

  // Step 2: first non-empty line.
  const firstLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? body;

  // Step 3: truncate. Cut at a word boundary when possible to avoid
  // mid-word ellipses (operator's eye reads partial words as garbage).
  if (firstLine.length <= maxChars) return firstLine;
  const sliced = firstLine.slice(0, maxChars);
  const lastSpace = sliced.lastIndexOf(" ");
  // Only fall back to word-boundary if we'd be cutting more than 20%
  // off the slice; otherwise leave the hard cut and append the ellipsis.
  if (lastSpace > maxChars * 0.8) {
    return sliced.slice(0, lastSpace).trimEnd() + "…";
  }
  return sliced.trimEnd() + "…";
}
