// Pure URL builders for pagination links. Extracted so the invariants
// (filter params preserved, page=1 / page<=0 stripped to keep base URL
// clean) survive any future refactor.

export function buildPageHref(
  basePath: string,
  searchParams: Record<string, string>,
  page: number,
): string {
  const p = new URLSearchParams(searchParams);
  if (page <= 1) {
    p.delete("page");
  } else {
    p.set("page", String(page));
  }
  const q = p.toString();
  return q ? `${basePath}?${q}` : basePath;
}

export function buildRunsHref(
  searchParams: Record<string, string>,
  page: number,
): string {
  return buildPageHref("/runs", searchParams, page);
}
