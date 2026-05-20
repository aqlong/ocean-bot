import Link from "next/link";
import { buildPageHref } from "./pagination-href";

export function Pagination({
  page,
  hasMore,
  count,
  searchParams,
  basePath = "/runs",
  itemLabel = "items",
}: {
  page: number;
  hasMore: boolean;
  count: number;
  searchParams: Record<string, string>;
  basePath?: string;
  itemLabel?: string;
}) {
  const hasPrev = page > 1;
  if (!hasPrev && !hasMore) return null;

  const countLabel = hasMore ? `${count}+` : String(count);

  return (
    <div className="flex items-center justify-between gap-3 text-xs text-dim">
      {hasPrev ? (
        <Link
          href={buildPageHref(basePath, searchParams, page - 1)}
          className="hover:text-ink"
        >
          ← newer
        </Link>
      ) : (
        <span />
      )}
      <span>
        page {page} · {countLabel} {itemLabel}
      </span>
      {hasMore ? (
        <Link
          href={buildPageHref(basePath, searchParams, page + 1)}
          className="hover:text-ink"
        >
          older →
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}
