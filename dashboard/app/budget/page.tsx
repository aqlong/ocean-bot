import { budgetState, fiveHrWindowStart } from "@/lib/queries";
import { LocalTime } from "@/components/local-time";
import { cx } from "@/lib/cx";

export const dynamic = "force-dynamic";
export const revalidate = 10;

interface ProjectGate {
  project: string;
  gate?: "ok" | "wait" | "stop";
  worstRatio?: number;
  reason?: string;
  subCaps?: {
    fiveHrInput: number;
    fiveHrOutput: number;
    sevenDInput: number;
    sevenDOutput: number;
  };
  fiveHr?: { inputTokens: number; outputTokens: number };
  sevenD?: { inputTokens: number; outputTokens: number };
}

interface BudgetSnapshot {
  gate?: "ok" | "wait" | "stop";
  worstRatio?: number;
  reason?: string;
  caps?: {
    fiveHrInput: number;
    fiveHrOutput: number;
    sevenDInput: number;
    sevenDOutput: number;
  };
  fiveHr?: { inputTokens: number; outputTokens: number };
  sevenD?: { inputTokens: number; outputTokens: number };
  /** Per-dimension reset times (Unix ms). Both 5hr dimensions reset at the
   *  same time; both 7d dimensions reset at the same time. */
  dimensionResets?: {
    fiveHrInput: number;
    fiveHrOutput: number;
    sevenDInput: number;
    sevenDOutput: number;
  };
  /** Per-project sub-cap gates. Populated when caps.perProject is
   *  configured; absent (or empty record) means the single-pool gate is
   *  the only one in effect. */
  perProject?: Record<string, ProjectGate>;
}

export default async function Budget() {
  const [snap, windowStart] = await Promise.all([
    budgetState() as Promise<BudgetSnapshot | null>,
    fiveHrWindowStart(),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">budget</h1>

      {snap ? (
        <section className="rounded border border-line bg-panel p-4">
          <div className="mb-2 text-sm text-dim">last bot tick (gate decision)</div>
          <div className="text-ink">
            gate: <span className={cx("font-bold", gateColor(snap.gate))}>{snap.gate}</span>
            {typeof snap.worstRatio === "number" &&
              ` · worst ratio: ${Math.round(snap.worstRatio * 100)}%`}
          </div>
          {snap.reason && <div className="text-xs text-dim">{snap.reason}</div>}
        </section>
      ) : (
        <section className="rounded border border-line bg-panel p-4 text-sm text-dim">
          no bot tick has run yet, values appear after the first tick
        </section>
      )}

      <FiveHrWindow start={windowStart} resetMs={snap?.dimensionResets?.fiveHrInput} />

      <section className="grid gap-3 sm:grid-cols-2">
        <BudgetBar
          label="5hr input"
          used={snap?.fiveHr?.inputTokens ?? 0}
          cap={snap?.caps?.fiveHrInput ?? 0}
          resetMs={snap?.dimensionResets?.fiveHrInput}
        />
        <BudgetBar
          label="5hr output"
          used={snap?.fiveHr?.outputTokens ?? 0}
          cap={snap?.caps?.fiveHrOutput ?? 0}
          resetMs={snap?.dimensionResets?.fiveHrOutput}
        />
        <BudgetBar
          label="7d input"
          used={snap?.sevenD?.inputTokens ?? 0}
          cap={snap?.caps?.sevenDInput ?? 0}
          resetMs={snap?.dimensionResets?.sevenDInput}
        />
        <BudgetBar
          label="7d output"
          used={snap?.sevenD?.outputTokens ?? 0}
          cap={snap?.caps?.sevenDOutput ?? 0}
          resetMs={snap?.dimensionResets?.sevenDOutput}
        />
      </section>

      <PerProjectSection perProject={snap?.perProject} />
    </div>
  );
}

function PerProjectSection({
  perProject,
}: {
  perProject?: Record<string, ProjectGate>;
}) {
  const entries = perProject ? Object.entries(perProject) : [];
  if (entries.length === 0) return null;
  return (
    <section className="space-y-3">
      <div className="text-sm text-dim">
        per-project sub-caps (share × global)
      </div>
      {entries.map(([name, pg]) => (
        <ProjectCard key={name} name={name} pg={pg} />
      ))}
    </section>
  );
}

function ProjectCard({ name, pg }: { name: string; pg: ProjectGate }) {
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="font-bold text-ink">{name}</div>
        <div className="text-xs">
          gate:{" "}
          <span className={cx("font-bold", gateColor(pg.gate))}>
            {pg.gate ?? "?"}
          </span>
          {typeof pg.worstRatio === "number" &&
            ` · ${Math.round(pg.worstRatio * 100)}%`}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <BudgetBar
          label="5hr input"
          used={pg.fiveHr?.inputTokens ?? 0}
          cap={pg.subCaps?.fiveHrInput ?? 0}
        />
        <BudgetBar
          label="5hr output"
          used={pg.fiveHr?.outputTokens ?? 0}
          cap={pg.subCaps?.fiveHrOutput ?? 0}
        />
        <BudgetBar
          label="7d input"
          used={pg.sevenD?.inputTokens ?? 0}
          cap={pg.subCaps?.sevenDInput ?? 0}
        />
        <BudgetBar
          label="7d output"
          used={pg.sevenD?.outputTokens ?? 0}
          cap={pg.subCaps?.sevenDOutput ?? 0}
        />
      </div>
      {pg.reason && <div className="mt-2 text-xs text-dim">{pg.reason}</div>}
    </div>
  );
}

function BudgetBar({
  label,
  used,
  cap,
  resetMs,
}: {
  label: string;
  used: number;
  cap: number;
  resetMs?: number;
}) {
  const ratio = cap > 0 ? used / cap : 0;
  const pct = Math.min(100, ratio * 100);
  const color =
    ratio >= 1 ? "bg-bad" : ratio >= 0.9 ? "bg-warn" : "bg-good";
  return (
    <div className="rounded border border-line bg-panel p-3">
      <div className="mb-1 flex justify-between text-xs text-dim">
        <span>{label}</span>
        <span>
          {used.toLocaleString()} / {cap.toLocaleString()}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-bg">
        <div className={cx("h-full", color)} style={{ width: `${pct}%` }} />
      </div>
      {resetMs && (
        <div className="mt-2 text-[10px] text-dim">
          resets <LocalTime iso={new Date(resetMs).toISOString()} format="relative" />
        </div>
      )}
    </div>
  );
}

function gateColor(gate?: string): string {
  if (gate === "ok") return "text-good";
  if (gate === "wait") return "text-warn";
  if (gate === "stop") return "text-bad";
  return "text-dim";
}

function FiveHrWindow({
  start,
  resetMs,
}: {
  start: Date | null;
  resetMs?: number;
}) {
  if (!start) {
    return (
      <section className="rounded border border-line bg-panel p-4 text-sm text-dim">
        5hr window: no active window
      </section>
    );
  }
  return (
    <section className="rounded border border-line bg-panel p-4 text-sm">
      <div className="text-dim">5hr window</div>
      <div className="mt-1 flex flex-col gap-0.5 text-ink sm:flex-row sm:gap-3">
        <span>
          started <LocalTime iso={start.toISOString()} format="relative" />
        </span>
        {resetMs && (
          <span className="text-dim">
            resets <LocalTime iso={new Date(resetMs).toISOString()} format="relative" />
          </span>
        )}
      </div>
    </section>
  );
}
