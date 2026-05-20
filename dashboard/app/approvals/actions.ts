"use server";

import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  applyApproval,
  setStateValue,
  isValidApprovalAction,
  isValidMode,
  isAuthBypassedForDev,
} from "@/lib/approval-ops";

async function requireOcean(): Promise<void> {
  if (isAuthBypassedForDev()) return;
  const session = await auth();
  const ghId = (session?.user as { githubId?: string } | undefined)?.githubId;
  if (!ghId || ghId !== process.env["OCEAN_USER_ID"]) {
    throw new Error("forbidden");
  }
}

export async function approveRun(runId: string, formData: FormData): Promise<void> {
  await requireOcean();
  const raw = String(formData.get("action") ?? "");
  if (!isValidApprovalAction(raw)) {
    throw new Error(`invalid action: ${raw}`);
  }
  await applyApproval(runId, raw);
  revalidatePath("/approvals");
  revalidatePath("/");
  revalidatePath(`/runs/${runId}`);
}

export async function pauseBot(): Promise<void> {
  await requireOcean();
  await setStateValue("paused", true);
  revalidatePath("/");
  revalidatePath("/settings");
}

export async function resumeBot(): Promise<void> {
  await requireOcean();
  await setStateValue("paused", false);
  revalidatePath("/");
  revalidatePath("/settings");
}

export async function setGlobalApprovalMode(formData: FormData): Promise<void> {
  await requireOcean();
  const mode = String(formData.get("mode") ?? "");
  if (!isValidMode(mode)) {
    throw new Error(`invalid mode: ${mode}`);
  }
  await setStateValue("global_approval_mode", mode);
  revalidatePath("/settings");
}
