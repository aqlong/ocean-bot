import { notFound } from "next/navigation";
import { runById, eventsForRun } from "@/lib/queries";
import { annotateFailedRuns } from "@/lib/reclassify";
import { cx } from "@/lib/cx";
import { ProjectChip } from "@/components/ProjectChip";

export const dynamic = "force-dynamic";
export const revalidate = 5;

export default async function RunDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await runById(id);
  if (!run) notFound();
  const events = await eventsForRun(id);
  const [annotated] = await annotateFailedRuns([run]);
  const outOfBandShipped = annotated?.outOfBandShipped === true;
  // A "noop" ship is a `shipped`-status row whose commit_sha is NULL,
  // mirrors the derived `outcome` field surfaced by recentRuns().
  const noop = run.status === "shipped" && run.commitSha === null;

  return (
    <div className="space-y-4">
      <header className="rounded border border-line bg-panel p-4">
        {/* break-words on the long fields, task summaries can be
            200+ chars (the full task prompt's first line) and the
            ulid runId is 26 chars unbreaking. Without this they
            force horizontal scroll on mobile. */}
        <h1 className="break-words text-lg text-ink">{run.taskSummary}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 break-words text-xs text-dim">
          <ProjectChip project={run.project} />
          <span>· {run.queue} · {run.id} · status:</span>
          <StatusTag
            status={run.status}
            outOfBandShipped={outOfBandShipped}
            noop={noop}
          />
          {run.commitSha && <span>· commit {run.commitSha.slice(0, 7)}</span>}
          {run.pushState && <span>· push: {run.pushState}</span>}
        </div>
        <RunConfig metadata={run.metadata} />
        {run.blocker && (
          <div className="mt-2 break-words rounded bg-warn/10 p-2 text-xs text-warn">
            {run.blocker}
          </div>
        )}
      </header>

      <section>
        <h2 className="mb-2 text-sm text-dim">events ({events.length})</h2>
        <div className="space-y-1.5">
          {events.map((e) => (
            <EventRow key={e.id} event={e} />
          ))}
          {events.length === 0 && (
            <div className="rounded border border-line bg-panel p-3 text-xs text-dim">
              no events recorded yet
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RunConfig({ metadata }: { metadata: unknown }) {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  const model = typeof m["model"] === "string" ? (m["model"] as string) : null;
  const cap =
    typeof m["outputTokenCap"] === "number" ? (m["outputTokenCap"] as number) : null;
  if (!model && cap === null) return null;
  return (
    <div className="mt-1 break-words text-xs text-dim">
      {model && <>model: {model}</>}
      {model && cap !== null && " · "}
      {cap !== null && <>--max-tokens: {cap.toLocaleString()}</>}
    </div>
  );
}

function StatusTag({
  status,
  outOfBandShipped,
  noop,
}: {
  status: string;
  outOfBandShipped?: boolean;
  noop?: boolean;
}) {
  if (status === "failed" && outOfBandShipped) {
    return (
      <span className="font-bold text-good">
        shipped (out-of-band)
      </span>
    );
  }
  if (status === "shipped" && noop) {
    return (
      <span className="font-bold text-dim">
        shipped (no commits produced)
      </span>
    );
  }
  const color =
    status === "shipped"
      ? "text-good"
      : status === "awaiting-approval"
        ? "text-warn"
        : status === "failed" || status === "rejected"
          ? "text-bad"
          : "text-dim";
  return <span className={cx("font-bold", color)}>{status}</span>;
}

function EventRow({
  event,
}: {
  event: { id: number; ts: Date; type: string; payload: unknown };
}) {
  const time = new Date(event.ts).toLocaleTimeString();
  return (
    <details className="rounded border border-line bg-panel p-2 text-xs">
      <summary className="cursor-pointer break-words text-ink">
        <span className="mr-2 text-dim">{time}</span>
        <span className="text-accent">{event.type}</span>
        <span className="ml-2 text-dim">{summarize(event.payload)}</span>
      </summary>
      {/* overflow-x-auto on the <pre> so long JSON lines scroll within
          the card instead of forcing the whole page horizontal-scroll. */}
      <pre className="mt-2 max-h-64 overflow-auto rounded bg-bg p-2 text-[10px] text-dim">
        {JSON.stringify(event.payload, null, 2)}
      </pre>
    </details>
  );
}

function summarize(p: unknown): string {
  if (!p || typeof p !== "object") return "";
  const o = p as Record<string, unknown>;
  if (typeof o["kind"] === "string") return o["kind"] as string;
  if (typeof o["type"] === "string") return o["type"] as string;
  return "";
}
