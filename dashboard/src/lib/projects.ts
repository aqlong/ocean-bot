// Single source of truth for the project dropdown across /backlog,
// /approvals, and /budget. Adapter `name` keys on the bot side
// (tools/ocean-bot/src/adapters/*) MUST match these strings so the
// dashboard filters line up with the runs the bot actually writes.

export const KNOWN_PROJECTS = [
  "code2wiki",
  "ocean-bot",
  "cas",
  "inference-audit",
] as const;

export type KnownProject = (typeof KNOWN_PROJECTS)[number];

// Per-project color tokens for ProjectChip. The dashboard uses a
// dark-only theme; tailwind.config.ts uses theme.extend so the full
// default palette (blue/purple/amber/emerald) remains available.
// Each entry: text foreground + low-opacity fill + matching border.
export const PROJECT_COLORS: Record<KnownProject, string> = {
  "code2wiki":       "text-blue-300 bg-blue-500/15 border-blue-500/30",
  "ocean-bot":       "text-purple-300 bg-purple-500/15 border-purple-500/30",
  "cas":             "text-amber-300 bg-amber-500/15 border-amber-500/30",
  "inference-audit": "text-emerald-300 bg-emerald-500/15 border-emerald-500/30",
};

export const PROJECT_COLOR_FALLBACK =
  "text-dim bg-line/40 border-line";

export function projectColor(name: string): string {
  return PROJECT_COLORS[name as KnownProject] ?? PROJECT_COLOR_FALLBACK;
}
