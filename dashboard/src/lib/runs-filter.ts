import type { RunsFilter } from "./queries";

// Pure helpers for translating /runs URL search params into a typed
// RunsFilter + page number. Lives in src/lib (not app/runs/page.tsx) so
// the parsing contract is testable without spinning up Next.js and so
// the page component is a thin orchestration layer over data + view.

/**
 * Translate the `?since=` URL param into an exclusive lower-bound Date.
 *
 * Contract:
 *   - undefined / empty / unrecognized string → undefined (no filter)
 *   - "1d"  → 24 hours before `now`
 *   - "7d"  → 7  days before `now`
 *   - "30d" → 30 days before `now`
 *
 * `now` defaults to Date.now() but is injectable for deterministic
 * tests. Unrecognized strings deliberately fall through to undefined
 * rather than erroring; the `since` UI is a closed dropdown so any
 * unknown value can only arrive via hand-edited URL and the safe
 * fallback (show all runs) preserves the operator's flow.
 */
export function parseSince(
  s: string | undefined,
  now: number = Date.now(),
): Date | undefined {
  if (!s) return undefined;
  if (s === "1d") return new Date(now - 24 * 60 * 60 * 1000);
  if (s === "7d") return new Date(now - 7 * 24 * 60 * 60 * 1000);
  if (s === "30d") return new Date(now - 30 * 24 * 60 * 60 * 1000);
  return undefined;
}

/**
 * Translate the `?page=` URL param into a 1-indexed page number.
 *
 * Contract:
 *   - undefined / empty / non-numeric / "0" / negative → 1
 *   - positive integer string → that integer
 *   - "3.7" → 3 (parseInt floor)
 *
 * The minimum is 1, never 0; the page query already does `Math.max(1, page)`
 * on the offset side but pinning the parser here keeps the UI's "page N"
 * label aligned with the actual offset slice.
 */
export function parsePage(s: string | undefined): number {
  const raw = parseInt(s ?? "1", 10);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return raw;
}

/**
 * Build the full {filter, page} pair the /runs page hands to listRuns().
 *
 * Empty-string params (e.g. `?project=`) coerce to undefined so they
 * don't accidentally filter against an empty string column (which would
 * always return zero rows). Unknown keys are ignored.
 */
export function buildRunsFilter(
  sp: Record<string, string>,
  now: number = Date.now(),
): { filter: RunsFilter; page: number } {
  return {
    filter: {
      project: sp["project"] || undefined,
      queue: sp["queue"] || undefined,
      status: sp["status"] || undefined,
      since: parseSince(sp["since"], now),
    },
    page: parsePage(sp["page"]),
  };
}
