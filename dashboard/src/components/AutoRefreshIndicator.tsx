import { LocalTime } from "../../app/approvals/local-time";

/**
 * Server component that renders a "updates every Ns · last: HH:MM:SS"
 * indicator with a pulsing dot. The render timestamp is captured at
 * server-render time, so it updates automatically on each Next.js
 * revalidation without any client-side JS.
 *
 * The pulse animation is pure CSS (Tailwind animate-pulse), no
 * client component needed.
 */
export function AutoRefreshIndicator({ intervalSec }: { intervalSec: number }) {
  const renderTime = new Date().toISOString();
  return (
    <div className="flex items-center gap-1.5 text-xs text-dim">
      <span
        className="h-1.5 w-1.5 rounded-full bg-good animate-pulse"
        aria-hidden="true"
      />
      <span>updates every {intervalSec}s</span>
      <span aria-hidden="true">·</span>
      <span>
        last: <LocalTime iso={renderTime} format="time" tooltip={null} />
      </span>
    </div>
  );
}
