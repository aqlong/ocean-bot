"use server";

import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  archiveBacklogItem,
  createBacklogItem,
  deleteBacklogItem,
  isValidCategory,
  isValidSeverity,
  isValidStatus,
  reorderBacklog,
  updateBacklogItem,
  updateBacklogItemSeverity,
  type BacklogCategory,
  type BacklogSeverity,
  type BacklogStatus,
  type CreateBacklogInput,
  type UpdateBacklogInput,
} from "@/lib/backlog-ops";
import { isAuthBypassedForDev } from "@/lib/approval-ops";

async function requireOcean(): Promise<void> {
  if (isAuthBypassedForDev()) return;
  const session = await auth();
  const ghId = (session?.user as { githubId?: string } | undefined)?.githubId;
  if (!ghId || ghId !== process.env["OCEAN_USER_ID"]) {
    throw new Error("forbidden");
  }
}

function newId(): string {
  // Lightweight ulid-ish stamp: 13 base36 ms + 10 base36 random.
  const t = Date.now().toString(36).toUpperCase().padStart(10, "0");
  let r = "";
  for (let i = 0; i < 14; i++) {
    r += "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Math.floor(Math.random() * 32)];
  }
  return (t + r).slice(0, 24);
}

export async function createItemAction(formData: FormData): Promise<void> {
  await requireOcean();
  const project = String(formData.get("project") ?? "code2wiki").trim();
  const category = String(formData.get("category") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const severityRaw = String(formData.get("severity") ?? "unspecified");
  if (!title) throw new Error("title required");
  if (!isValidCategory(category)) throw new Error(`invalid category: ${category}`);
  if (!isValidSeverity(severityRaw)) {
    throw new Error(`invalid severity: ${severityRaw}`);
  }
  const input: CreateBacklogInput = {
    id: newId(),
    project,
    category,
    title,
    description: description || null,
    severity: severityRaw as BacklogSeverity,
    source: "manual",
  };
  await createBacklogItem(input);
  revalidatePath("/backlog");
}

export async function updateItemSeverityAction(
  id: string,
  severityRaw: string,
): Promise<void> {
  await requireOcean();
  if (!isValidSeverity(severityRaw)) {
    throw new Error(`invalid severity: ${severityRaw}`);
  }
  await updateBacklogItemSeverity(id, severityRaw as BacklogSeverity);
  revalidatePath("/backlog");
}

export async function updateItemAction(
  id: string,
  formData: FormData,
): Promise<void> {
  await requireOcean();
  const patch: UpdateBacklogInput = {};
  const title = formData.get("title");
  if (typeof title === "string") {
    const trimmed = title.trim();
    // Reject empty title rather than silently saving an unreadable row.
    // Leaving title unchanged via FormData absence is still allowed.
    if (trimmed === "") throw new Error("title cannot be empty");
    patch.title = trimmed;
  }
  const description = formData.get("description");
  if (typeof description === "string") patch.description = description.trim();
  const category = formData.get("category");
  if (typeof category === "string" && category) {
    if (!isValidCategory(category)) throw new Error(`invalid category: ${category}`);
    patch.category = category as BacklogCategory;
  }
  const status = formData.get("status");
  if (typeof status === "string" && status) {
    if (!isValidStatus(status)) throw new Error(`invalid status: ${status}`);
    patch.status = status as BacklogStatus;
  }
  const project = formData.get("project");
  if (typeof project === "string" && project) patch.project = project.trim();

  await updateBacklogItem(id, patch);
  revalidatePath("/backlog");
}

export async function reorderItemsAction(orderedIds: string[]): Promise<void> {
  await requireOcean();
  if (!Array.isArray(orderedIds)) throw new Error("orderedIds must be an array");
  await reorderBacklog(orderedIds);
  revalidatePath("/backlog");
}

export async function archiveItemAction(id: string): Promise<void> {
  await requireOcean();
  await archiveBacklogItem(id);
  revalidatePath("/backlog");
}

export async function deleteItemAction(id: string): Promise<void> {
  await requireOcean();
  await deleteBacklogItem(id);
  revalidatePath("/backlog");
}
