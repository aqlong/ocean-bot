// Parse `npm test` (vitest) + `tsc --noEmit` output into structured
// failure rows. Project-agnostic, works for any repo whose tests run
// under vitest and whose type errors come from tsc. Adapters use this
// to convert "preflight is red" into TaskCandidate prompts.

export interface ParsedFailure {
  kind: "test" | "typecheck";
  /** Short label suitable for the queue picker / dashboard. */
  label: string;
  /** Up to a few lines of context (truncated). */
  context: string;
  /** File path if discoverable; for grouping multiple failures. */
  file?: string;
}

const TS_ERROR_RE =
  /^([a-zA-Z0-9_./-]+\.tsx?)\((\d+),\s*(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/;

const VITEST_FAIL_RE = /^[\s│]*(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?$/;

export function parseTscOutput(stdout: string): ParsedFailure[] {
  const out: ParsedFailure[] = [];
  for (const line of stdout.split("\n")) {
    const m = TS_ERROR_RE.exec(line.trim());
    if (!m) continue;
    const [, file, lineNum, col, code, msg] = m;
    out.push({
      kind: "typecheck",
      label: `${file}:${lineNum}: ${code}`,
      file: file ?? undefined,
      context: `${file}:${lineNum}:${col} ${code} ${msg ?? ""}`.trim(),
    });
  }
  return dedupeByLabel(out);
}

export function parseVitestOutput(stdout: string): ParsedFailure[] {
  const lines = stdout.split("\n");
  const failures: ParsedFailure[] = [];

  // Pattern A: lines starting with "× " (vitest red mark) followed by a
  // file path or test name.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = VITEST_FAIL_RE.exec(line);
    if (!m) continue;
    const rawLabel = (m[1] ?? "").trim();
    if (!rawLabel || rawLabel.length > 200) continue;
    // Skip obvious banner / summary noise.
    if (/^(Test Files|Tests|Errors)\b/.test(rawLabel)) continue;

    const context = lines
      .slice(i, Math.min(lines.length, i + 4))
      .join("\n")
      .slice(0, 800);

    failures.push({
      kind: "test",
      label: rawLabel,
      file: extractPath(rawLabel),
      context,
    });
  }

  return dedupeByLabel(failures);
}

function extractPath(s: string): string | undefined {
  const m = /([a-zA-Z0-9_./-]+\.test\.[tj]sx?)/.exec(s);
  return m?.[1];
}

function dedupeByLabel(rows: ParsedFailure[]): ParsedFailure[] {
  const seen = new Set<string>();
  const out: ParsedFailure[] = [];
  for (const r of rows) {
    if (seen.has(r.label)) continue;
    seen.add(r.label);
    out.push(r);
  }
  return out;
}

/** Group failures into one prompt-ready summary string, limited to
 *  `maxBytes` chars so the LLM prompt doesn't balloon. */
export function summarizeFailures(
  failures: ParsedFailure[],
  maxBytes = 4000,
): string {
  if (failures.length === 0) return "";
  const header = `${failures.length} failure(s):\n`;
  let body = "";
  for (const f of failures) {
    const block = `\n- [${f.kind}] ${f.label}\n  ${f.context.split("\n").join("\n  ")}\n`;
    if ((header + body + block).length > maxBytes) {
      body += `\n(truncated — ${failures.length - countShown(body)} more)\n`;
      break;
    }
    body += block;
  }
  return header + body;
}

function countShown(body: string): number {
  return (body.match(/\n- \[/g) ?? []).length;
}
