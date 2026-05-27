/**
 * Format a duration in milliseconds into a human-readable string.
 * Thresholds: <1s shows ms, <1m shows seconds, <1h shows m:ss, ≥1h shows h:mm:ss.
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);

  if (totalSeconds < 1) {
    return `${ms}ms`;
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

/**
 * Resolve a Tailwind color class for a duration, used to visually
 * distinguish quick / normal / slow runs.
 *
 * - ≤5s: "text-good" (fast, green)
 * - ≤30s: "text-ink" (normal, default text)
 * - ≤2m: "text-warn" (slow, yellow)
 * - >2m: "text-bad" (very slow, red)
 */
export function durationTone(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds <= 5) return "text-good";
  if (totalSeconds <= 30) return "text-ink";
  if (totalSeconds <= 120) return "text-warn";
  return "text-bad";
}
