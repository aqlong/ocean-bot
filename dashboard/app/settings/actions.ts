"use server";

import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { setStateValue, isAuthBypassedForDev } from "@/lib/approval-ops";

async function requireOcean(): Promise<void> {
  if (isAuthBypassedForDev()) return;
  const session = await auth();
  const ghId = (session?.user as { githubId?: string } | undefined)?.githubId;
  if (!ghId || ghId !== process.env["OCEAN_USER_ID"]) {
    throw new Error("forbidden");
  }
}

const TIERS = ["haiku", "sonnet", "opus"] as const;
type Tier = (typeof TIERS)[number];

function parseTierField(formData: FormData, tier: Tier): number | null {
  const raw = String(formData.get(tier) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

export async function setOutputTokenCaps(formData: FormData): Promise<void> {
  await requireOcean();
  const next: Record<string, number> = {};
  for (const t of TIERS) {
    const v = parseTierField(formData, t);
    if (v !== null) next[t] = v;
  }
  await setStateValue("output_token_caps", next);
  revalidatePath("/settings");
}

/** Persist the per-run cap on tool_use events. Blank input clears the
 *  override so the bot falls back to its DEFAULT_MAX_TOOL_USES constant.
 *  Negative / zero / non-numeric input is rejected by skipping the write
 *  (resolveMaxToolUses() in src/index.ts re-applies the same guard, so a
 *  typo can't disable the cap entirely). */
export async function setMaxToolUses(formData: FormData): Promise<void> {
  await requireOcean();
  const raw = String(formData.get("max_tool_uses") ?? "").trim();
  if (raw === "") {
    await setStateValue("max_tool_uses", null);
    revalidatePath("/settings");
    return;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    revalidatePath("/settings");
    return;
  }
  await setStateValue("max_tool_uses", Math.floor(n));
  revalidatePath("/settings");
}
