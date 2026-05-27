import type { ReactNode } from "react";

/**
 * Split `text` at case-insensitive occurrences of `query`.
 * Returns an array where even-index entries are unmatched segments and
 * odd-index entries are the matched substrings (original casing preserved).
 * Returns `[text]` when `query` is blank or produces no match.
 */
export function splitMatches(text: string, query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [text];
  // Escape regex metacharacters so "foo.bar" only matches the literal
  // dot, not any character (e.g. "fooXbar").
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi"));
}

/**
 * Wrap matched substrings in <mark> elements.
 * Returns a plain string when `query` is blank or there are no matches,
 * so callers that just render `{title}` need no special handling.
 */
export function highlightMatches(text: string, query: string): ReactNode {
  const parts = splitMatches(text, query);
  // Single part means no split occurred (no match).
  if (parts.length === 1) return text;
  // Odd-index entries are the captured matches; even-index are gaps.
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="bg-warn/30 text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
