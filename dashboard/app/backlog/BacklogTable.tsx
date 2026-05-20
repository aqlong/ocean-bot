"use client";

import { useEffect, useState, useTransition } from "react"; // useEffect: sync items; useState: drag state
import {
  reorderItemsAction,
  updateItemAction,
  updateItemSeverityAction,
  archiveItemAction,
  deleteItemAction,
} from "./actions";
import {
  BACKLOG_CATEGORIES,
  BACKLOG_SEVERITIES,
  BACKLOG_STATUSES,
} from "@/lib/backlog-types";
import { KNOWN_PROJECTS } from "@/lib/projects";
import { cx } from "@/lib/cx";
import { LocalTime } from "../approvals/local-time";
import { ProjectChip } from "@/components/ProjectChip";

interface Row {
  id: string;
  project: string;
  category: string;
  title: string;
  description: string | null;
  priority: number;
  status: string;
  severity: string;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const CAT_COLOR: Record<string, string> = {
  bug: "bg-bad/20 text-bad",
  test: "bg-accent/20 text-accent",
  roadmap: "bg-good/20 text-good",
  refactor: "bg-warn/20 text-warn",
  docs: "bg-dim/20 text-dim",
  chore: "bg-dim/20 text-dim",
  feature: "bg-accent/20 text-accent",
  other: "bg-dim/20 text-dim",
};

const STATUS_COLOR: Record<string, string> = {
  open: "text-ink",
  "in-progress": "text-warn",
  done: "text-good",
  blocked: "text-bad",
  archived: "text-dim",
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "bg-bad/30 text-bad border-bad/40",
  major: "bg-warn/30 text-warn border-warn/40",
  minor: "bg-accent/20 text-accent border-accent/30",
  cosmetic: "bg-dim/20 text-dim border-line",
  unspecified: "bg-panel text-dim border-line",
};

export function BacklogTable({ items }: { items: Row[] }) {
  // Local ordering buffer, drag/arrow updates this immediately for snappy
  // UX, then a server action persists asynchronously.
  const [rows, setRows] = useState(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Re-sync local state with server-delivered items when their ID order
  // genuinely changes (auto-refresh dropped a row, added a new one,
  // someone else reordered). Skip when we're mid-drag, keeping the
  // user's in-progress drag stable matters more than instantaneous sync.
  useEffect(() => {
    if (dragId) return;
    const idMismatch =
      items.length !== rows.length ||
      items.some((it, i) => it.id !== rows[i]?.id);
    if (idMismatch) setRows(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  function persistOrder(next: Row[]): void {
    setRows(next);
    startTransition(async () => {
      await reorderItemsAction(next.map((r) => r.id));
    });
  }

  function moveBy(id: string, delta: number): void {
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [moved] = next.splice(idx, 1);
    if (!moved) return;
    next.splice(target, 0, moved);
    persistOrder(next);
  }

  function onDragStart(id: string): void {
    setDragId(id);
  }
  function onDragOver(e: React.DragEvent, overId: string): void {
    e.preventDefault();
    if (!dragId || dragId === overId) return;
    const fromIdx = rows.findIndex((r) => r.id === dragId);
    const toIdx = rows.findIndex((r) => r.id === overId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...rows];
    const [moved] = next.splice(fromIdx, 1);
    if (!moved) return;
    next.splice(toIdx, 0, moved);
    setRows(next);
  }
  function onDragEnd(): void {
    setDragId(null);
    persistOrder(rows);
  }

  return (
    <ul className="space-y-1">
      {rows.map((row) => (
        <li
          key={row.id}
          draggable
          onDragStart={() => onDragStart(row.id)}
          onDragOver={(e) => onDragOver(e, row.id)}
          onDragEnd={onDragEnd}
          className={cx(
            "group flex items-stretch gap-2 rounded border border-line bg-panel p-2 text-xs",
            dragId === row.id && "opacity-50",
          )}
        >
          <div className="flex shrink-0 flex-col items-center justify-between">
            <button
              type="button"
              onClick={() => moveBy(row.id, -1)}
              className="text-dim hover:text-ink"
              aria-label="move up"
            >
              ▲
            </button>
            <span
              className="cursor-grab select-none text-dim"
              title="drag to reorder"
            >
              ⋮⋮
            </span>
            <button
              type="button"
              onClick={() => moveBy(row.id, 1)}
              className="text-dim hover:text-ink"
              aria-label="move down"
            >
              ▼
            </button>
          </div>
          <ItemBody row={row} />
        </li>
      ))}
    </ul>
  );
}

function ItemBody({ row }: { row: Row }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <form
        action={async (fd) => {
          await updateItemAction(row.id, fd);
          setEditing(false);
        }}
        className="flex flex-1 flex-col gap-2"
      >
        <input
          name="title"
          defaultValue={row.title}
          autoFocus
          className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        />
        <textarea
          name="description"
          defaultValue={row.description ?? ""}
          rows={2}
          className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        />
        <div className="flex flex-wrap gap-2">
          <select
            name="project"
            defaultValue={row.project}
            className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
          >
            {KNOWN_PROJECTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select
            name="category"
            defaultValue={row.category}
            className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
          >
            {BACKLOG_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={row.status}
            className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
          >
            {BACKLOG_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded bg-good/20 px-3 py-1 text-xs font-bold text-good hover:bg-good/30"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded bg-bg px-3 py-1 text-xs text-dim hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cx(
            "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase",
            CAT_COLOR[row.category] ?? CAT_COLOR["other"],
          )}
        >
          {row.category}
        </span>
        <SeverityChipSelect row={row} />
        <span
          className={cx(
            "text-[10px] font-bold uppercase",
            STATUS_COLOR[row.status] ?? "text-dim",
          )}
        >
          {row.status}
        </span>
        <ProjectChip project={row.project} />
        <DateChip
          label="created"
          date={row.createdAt}
        />
        {row.updatedAt.getTime() !== row.createdAt.getTime() && (
          <DateChip label="updated" date={row.updatedAt} />
        )}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="ml-auto text-[10px] text-dim hover:text-ink"
        >
          edit
        </button>
        <ArchiveButton row={row} />
        <DeleteButton row={row} />
      </div>
      {/* break-words on long titles (seeded backlog items can have
          ~200-char single-paragraph titles); min-w-0 on the parent +
          break-words here lets the row body shrink inside flex
          instead of forcing horizontal scroll. */}
      <div className="break-words text-ink">{row.title}</div>
      {row.description && (
        <details className="group">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            {/* Collapsed-by-default: show one-line preview + a show/
                hide affordance. Full description renders below when
                the operator expands. Drag-reorder + chips stay clickable
                because they live outside this <details>. */}
            <div className="flex items-baseline gap-2">
              <span className="line-clamp-1 break-words text-[11px] text-dim">
                {firstLine(row.description)}
              </span>
              <span className="select-none whitespace-nowrap text-[10px] text-dim group-open:hidden">
                show more ▸
              </span>
              <span className="hidden select-none whitespace-nowrap text-[10px] text-dim group-open:inline">
                hide ▾
              </span>
            </div>
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words rounded bg-bg/40 p-2 text-[11px] text-dim">
            {row.description}
          </div>
        </details>
      )}
    </div>
  );
}

/** First non-empty line of a description, for the collapsed-state
 *  preview. Falls back to the raw string if the first split is empty
 *  (shouldn't happen with non-empty descriptions but defensive). */
function firstLine(s: string): string {
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (t.length > 0) return t;
  }
  return s;
}

/** Small chip showing both the absolute timestamp (browser-local +
 *  tz abbreviation) AND the relative time. Replaces the earlier
 *  title-attr-only tooltip which doesn't render consistently across
 *  browsers / OS configs.
 *
 *  Why both visible: the absolute timestamp is unambiguous for audit
 *  / "when did this actually happen" questions, the relative is the
 *  at-a-glance staleness signal. Operator gets both without needing
 *  to hover. */
function DateChip({ label, date }: { label: string; date: Date }) {
  return (
    <span className="text-[10px] text-dim">
      {label}{" "}
      <LocalTime
        iso={date.toISOString()}
        format="compact-with-relative"
      />
    </span>
  );
}

function ArchiveButton({ row }: { row: Row }) {
  return (
    <form action={archiveItemAction.bind(null, row.id)}>
      <button
        type="submit"
        className="text-[10px] text-dim hover:text-warn"
        title="archive"
      >
        archive
      </button>
    </form>
  );
}

function SeverityChipSelect({ row }: { row: Row }) {
  // Chip-styled <select> bound to row.severity. Change fires the server
  // action and re-runs auto-placement under the advisory lock. No
  // "armed" state needed, the layout's AutoRefresh would reset any
  // React-local toggle every 10s.
  const sev = row.severity || "unspecified";
  return (
    <select
      defaultValue={sev}
      onChange={async (e) => {
        const next = e.target.value;
        if (next === sev) return;
        await updateItemSeverityAction(row.id, next);
      }}
      title="severity (changes re-place the row in the queue)"
      className={cx(
        "rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase",
        SEVERITY_COLOR[sev] ?? SEVERITY_COLOR["unspecified"],
      )}
    >
      {BACKLOG_SEVERITIES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}

function DeleteButton({ row }: { row: Row }) {
  // Native confirm(), synchronous, survives the layout's AutoRefresh
  // which would reset any inline "armed" React state every 10s.
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = window.confirm(
          `Delete this backlog item permanently?\n\n${row.title}`,
        );
        if (!ok) return;
        await deleteItemAction(row.id);
      }}
      className="text-[10px] text-dim hover:text-bad"
      title="delete permanently"
    >
      delete
    </button>
  );
}
