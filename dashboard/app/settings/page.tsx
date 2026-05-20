import { botStateFlags } from "@/lib/queries";
import {
  pauseBot,
  resumeBot,
  setGlobalApprovalMode,
} from "../approvals/actions";
import { setOutputTokenCaps, setMaxToolUses } from "./actions";
import { cx } from "@/lib/cx";

export const dynamic = "force-dynamic";
export const revalidate = 5;

// Mirror src/index.ts DEFAULT_OUTPUT_TOKEN_CAPS. The bot is the source of
// truth at runtime; this constant only powers the placeholder text in
// the form. If the bot's defaults change, update both.
const DEFAULT_OUTPUT_TOKEN_CAPS = {
  haiku: 8000,
  sonnet: 16000,
  opus: 32000,
} as const;

// Mirror src/runner.ts DEFAULT_MAX_TOOL_USES. Same source-of-truth note
// as above; bump in both places when the bot's default changes.
const DEFAULT_MAX_TOOL_USES = 200;

function readCap(
  flags: Record<string, unknown>,
  tier: keyof typeof DEFAULT_OUTPUT_TOKEN_CAPS,
): number | null {
  const v = (flags["output_token_caps"] as Record<string, unknown> | undefined)?.[tier];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export default async function Settings() {
  const flags = await botStateFlags();
  const paused = flags["paused"] === true;
  const mode =
    typeof flags["global_approval_mode"] === "string"
      ? (flags["global_approval_mode"] as string)
      : "manual";
  const haikuCap = readCap(flags, "haiku");
  const sonnetCap = readCap(flags, "sonnet");
  const opusCap = readCap(flags, "opus");
  const maxToolUsesRaw = flags["max_tool_uses"];
  const maxToolUses =
    typeof maxToolUsesRaw === "number" &&
    Number.isFinite(maxToolUsesRaw) &&
    maxToolUsesRaw > 0
      ? maxToolUsesRaw
      : null;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-bold">settings</h1>

      <section className="rounded border border-line bg-panel p-4">
        <div className="mb-2 text-sm text-dim">bot status</div>
        <div className="mb-3 text-ink">
          {paused ? "⏸ paused" : "🟢 running"}
        </div>
        {paused ? (
          <form action={resumeBot}>
            <button
              type="submit"
              className="rounded bg-good/20 px-3 py-1.5 text-xs font-bold text-good hover:bg-good/30"
            >
              Resume
            </button>
          </form>
        ) : (
          <form action={pauseBot}>
            <button
              type="submit"
              className="rounded bg-warn/20 px-3 py-1.5 text-xs font-bold text-warn hover:bg-warn/30"
            >
              Pause
            </button>
          </form>
        )}
      </section>

      <section className="rounded border border-line bg-panel p-4">
        <div className="mb-1 text-sm text-dim">output token caps</div>
        <div className="mb-3 text-[10px] text-dim">
          forwarded to claude as <code>--max-tokens N</code>. blank = use default.
        </div>
        <form action={setOutputTokenCaps} className="space-y-2">
          {(["haiku", "sonnet", "opus"] as const).map((tier) => (
            <label key={tier} className="flex items-center gap-3 text-xs text-ink">
              <span className="w-16 font-bold">{tier}</span>
              <input
                type="number"
                name={tier}
                min={1}
                step={1}
                defaultValue={
                  tier === "haiku"
                    ? haikuCap ?? ""
                    : tier === "sonnet"
                      ? sonnetCap ?? ""
                      : opusCap ?? ""
                }
                placeholder={String(DEFAULT_OUTPUT_TOKEN_CAPS[tier])}
                className="w-32 rounded border border-line bg-bg px-2 py-1 text-ink"
              />
              <span className="text-dim">
                default {DEFAULT_OUTPUT_TOKEN_CAPS[tier]}
              </span>
            </label>
          ))}
          <button
            type="submit"
            className="rounded bg-accent/20 px-3 py-1.5 text-xs font-bold text-accent hover:bg-accent/30"
          >
            Save caps
          </button>
        </form>
      </section>

      <section className="rounded border border-line bg-panel p-4">
        <div className="mb-1 text-sm text-dim">tool-use cap per run</div>
        <div className="mb-3 text-[10px] text-dim">
          claude is SIGTERM&apos;d after this many <code>tool_use</code> events.
          catches runaway grep / read storms. blank = use default.
        </div>
        <form action={setMaxToolUses} className="space-y-2">
          <label className="flex items-center gap-3 text-xs text-ink">
            <span className="w-16 font-bold">cap</span>
            <input
              type="number"
              name="max_tool_uses"
              min={1}
              step={1}
              defaultValue={maxToolUses ?? ""}
              placeholder={String(DEFAULT_MAX_TOOL_USES)}
              className="w-32 rounded border border-line bg-bg px-2 py-1 text-ink"
            />
            <span className="text-dim">default {DEFAULT_MAX_TOOL_USES}</span>
          </label>
          <button
            type="submit"
            className="rounded bg-accent/20 px-3 py-1.5 text-xs font-bold text-accent hover:bg-accent/30"
          >
            Save cap
          </button>
        </form>
      </section>

      <section className="rounded border border-line bg-panel p-4">
        <div className="mb-3 text-sm text-dim">global approval mode</div>
        <div className="space-y-2">
          {(["manual", "auto-with-visual", "auto"] as const).map((m) => (
            <form key={m} action={setGlobalApprovalMode}>
              <input type="hidden" name="mode" value={m} />
              <button
                type="submit"
                className={cx(
                  "w-full rounded border px-3 py-2 text-left text-xs",
                  mode === m
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-line bg-bg text-dim hover:text-ink",
                )}
              >
                <span className="font-bold">{m}</span>
                <span className="block text-[10px] text-dim">
                  {modeDescription(m)}
                </span>
              </button>
            </form>
          ))}
        </div>
      </section>
    </div>
  );
}

function modeDescription(m: string): string {
  if (m === "manual") return "every run requires approval before push";
  if (m === "auto") return "preflight green → push automatically";
  if (m === "auto-with-visual")
    return "auto except when visual reviewer flags a regression";
  return "";
}
