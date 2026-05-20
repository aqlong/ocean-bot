"use client";

import { useState } from "react";
import { createItemAction } from "./actions";
import { BACKLOG_CATEGORIES, BACKLOG_SEVERITIES } from "@/lib/backlog-types";
import { KNOWN_PROJECTS } from "@/lib/projects";

export function AddItemForm({ defaultProject }: { defaultProject: string }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded border border-dashed border-line bg-panel px-3 py-2 text-xs text-dim hover:border-accent hover:text-accent"
      >
        + add backlog item
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        setPending(true);
        try {
          await createItemAction(fd);
          (document.getElementById("title") as HTMLInputElement | null)?.form?.reset();
          setOpen(false);
        } finally {
          setPending(false);
        }
      }}
      className="space-y-2 rounded border border-line bg-panel p-3"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
        <input
          id="title"
          name="title"
          required
          placeholder="title"
          autoFocus
          className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-dim sm:col-span-2 lg:col-span-3"
        />
        <select
          name="project"
          defaultValue={defaultProject}
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
          defaultValue="bug"
          className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        >
          {BACKLOG_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select
          name="severity"
          defaultValue="unspecified"
          title="severity (bug+critical lands at top)"
          className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink"
        >
          {BACKLOG_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={pending}
            className="flex-1 rounded bg-accent/20 px-3 py-1 text-xs font-bold text-accent hover:bg-accent/30 disabled:opacity-50"
          >
            {pending ? "…" : "Add"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded bg-bg px-2 py-1 text-xs text-dim hover:text-ink"
          >
            ✕
          </button>
        </div>
      </div>
      <textarea
        name="description"
        placeholder="description (optional)"
        rows={2}
        className="w-full rounded border border-line bg-bg px-2 py-1 text-xs text-ink placeholder:text-dim"
      />
    </form>
  );
}
