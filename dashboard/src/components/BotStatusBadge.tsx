import { Suspense } from "react";
import { fetchBotStatus, badgeProps } from "@/lib/bot-status";
import { LocalTime } from "../../app/approvals/local-time";
import { cx } from "@/lib/cx";

async function BadgeInner() {
  const status = await fetchBotStatus();
  const { label, colorClass, ts } = badgeProps(status);

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase",
        colorClass,
      )}
    >
      <span>{label}</span>
      {ts && (
        <>
          <span className="opacity-50">·</span>
          <LocalTime iso={ts} format="relative" />
        </>
      )}
    </span>
  );
}

export function BotStatusBadge() {
  return (
    <Suspense fallback={null}>
      <BadgeInner />
    </Suspense>
  );
}
