import { cx } from "@/lib/cx";
import { projectColor } from "@/lib/projects";

// Single render point for project names across the dashboard. Whenever
// a row / card / header shows a project, it goes through here so the
// per-project color is consistent. Long names truncate inside a fixed
// pill width; the full name stays in the `title` tooltip.
//
// Mobile-friendly: text-xs px-2 py-0.5 is the same height as the small
// status chips in BacklogTable, so a row with multiple chips lines up
// without wrapping at common phone widths.

export function ProjectChip({
  project,
  className,
}: {
  project: string;
  className?: string;
}) {
  return (
    <span
      title={project}
      className={cx(
        "inline-block max-w-[10rem] truncate rounded-full border px-2 py-0.5 align-middle text-xs font-medium",
        projectColor(project),
        className,
      )}
    >
      {project}
    </span>
  );
}
