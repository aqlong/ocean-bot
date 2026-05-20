import { pendingApprovals } from "@/lib/queries";
import { approveRun } from "./actions";
import { cx } from "@/lib/cx";
import { LocalTime } from "./local-time";
import { summaryPreview } from "./summary-preview";
import { ProjectChip } from "@/components/ProjectChip";
import { AutoRefreshIndicator } from "@/components/AutoRefreshIndicator";

export const dynamic = "force-dynamic";
export const revalidate = 5;

export default async function Approvals() {
  const pending = await pendingApprovals();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="text-lg font-bold">approvals</h1>
        <AutoRefreshIndicator intervalSec={5} />
      </div>
      {pending.length === 0 && (
        <div className="rounded border border-line bg-panel p-6 text-center text-sm text-dim">
          all clear, no runs awaiting approval
        </div>
      )}
      {pending.map((run) => (
        <ApprovalCard key={run.id} run={run} />
      ))}
    </div>
  );
}

function ApprovalCard({
  run,
}: {
  run: {
    id: string;
    project: string;
    queue: string;
    taskSummary: string;
    branch: string | null;
    commitSha: string | null;
    dangerLevel: string | null;
    dangerReasons: unknown;
    blocker: string | null;
    startedAt: Date;
  };
}) {
  const reasons = Array.isArray(run.dangerReasons)
    ? (run.dangerReasons as Array<{ ruleId: number; explanation: string }>)
    : [];
  // Collapsed-by-default surface so a page with several pending approvals
  // is scannable. The native <details>/<summary> elements toggle without
  // any client-side JS, keeping this a server component. The summary
  // contains the metadata row + a 2-line preview; the open state reveals
  // the full task prompt, blocker, and danger-reason list.
  const preview = summaryPreview(run.taskSummary);
  const blockerPreview = run.blocker ? truncate(run.blocker, 140) : null;
  return (
    <details className="group rounded border border-line bg-panel">
      <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Metadata row first so the operator-readable identifiers
                stay at a constant position regardless of summary length. */}
            <div className="flex flex-wrap items-center gap-x-1.5 break-all text-xs text-dim">
              <ProjectChip project={run.project} />
              <span>
                · {run.queue} · {run.id.slice(0, 10)}
                {run.commitSha && ` · ${run.commitSha.slice(0, 7)}`} · started
              </span>
              <LocalTime iso={run.startedAt.toISOString()} />
            </div>
            {/* The preview is one stripped sentence (CLAUDE.md preamble
                removed if present). Falls back to a CSS clamp on the
                rest of the prompt if no clean breakpoint exists. */}
            <div className="mt-1 break-words text-sm text-ink">{preview}</div>
            {blockerPreview && (
              <div className="mt-2 break-words rounded bg-warn/10 px-2 py-1 text-xs text-warn">
                {blockerPreview}
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            {run.dangerLevel === "super-dangerous" && (
              <span className="rounded bg-bad/20 px-2 py-0.5 text-xs text-bad">
                super-dangerous
              </span>
            )}
            <span className="select-none text-xs text-dim group-open:hidden">
              show details ▸
            </span>
            <span className="hidden select-none text-xs text-dim group-open:inline">
              hide details ▾
            </span>
          </div>
        </div>
      </summary>

      {/* Open-state body: full task prompt + full blocker + danger reasons.
          pre-wrap preserves the multi-line layout the bot writes; break-
          words guards against an unbroken URL or token blowing the
          width. */}
      <div className="space-y-2 border-t border-line px-4 py-3">
        <section>
          <div className="mb-1 text-xs uppercase tracking-wide text-dim">
            full task prompt
          </div>
          <pre className="whitespace-pre-wrap break-words rounded bg-bg/60 p-2 text-xs text-ink">
            {run.taskSummary}
          </pre>
        </section>
        {run.blocker && (
          <section>
            <div className="mb-1 text-xs uppercase tracking-wide text-dim">
              blocker (full)
            </div>
            <div className="break-words rounded bg-warn/10 p-2 text-xs text-warn">
              {run.blocker}
            </div>
          </section>
        )}
        {reasons.length > 0 && (
          <section>
            <div className="mb-1 text-xs uppercase tracking-wide text-dim">
              classifier hits
            </div>
            <ul className="list-disc space-y-1 pl-5 text-xs text-dim">
              {reasons.map((r, i) => (
                <li key={i}>
                  <span className="text-bad">rule #{r.ruleId}</span> ·{" "}
                  {r.explanation}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* Action buttons live outside the open-state body so the operator
          can Ship / Skip / Block without expanding the card. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <DecisionButton runId={run.id} action="ship" tone="good" label="Ship" />
        <DecisionButton runId={run.id} action="skip" tone="warn" label="Skip" />
        <DecisionButton runId={run.id} action="block" tone="bad" label="Block" />
        <a
          href={`/runs/${run.id}`}
          className="ml-auto rounded border border-line bg-bg px-3 py-1.5 text-xs text-dim hover:text-ink"
        >
          run page →
        </a>
      </div>
    </details>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

function DecisionButton({
  runId,
  action,
  tone,
  label,
}: {
  runId: string;
  action: "ship" | "skip" | "block";
  tone: "good" | "warn" | "bad";
  label: string;
}) {
  const color =
    tone === "good"
      ? "bg-good/20 text-good hover:bg-good/30"
      : tone === "warn"
        ? "bg-warn/20 text-warn hover:bg-warn/30"
        : "bg-bad/20 text-bad hover:bg-bad/30";
  return (
    <form action={approveRun.bind(null, runId)}>
      <input type="hidden" name="action" value={action} />
      <button
        type="submit"
        className={cx("rounded px-3 py-1.5 text-xs font-bold", color)}
      >
        {label}
      </button>
    </form>
  );
}
